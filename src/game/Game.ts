/**
 * 游戏编排：输入（帆位/蓄力/发射）、冷却、扇面预览、命中结算（含 debuff）、
 * 船体碰撞、击沉计数与波次、补给拾取、Game Over 与 R 重开。
 * 移植自旧 js/main.js 的玩法段。
 *
 * 与基座的关系：玩家的运动由这里的街机模型驱动（见 GameShip 头注释），
 * 基座的 BuoyantBody/ShipController 对主船保持停用；波高来自 OceanSampler，
 * 相机由基座 CameraDirector 的 boat 模式继续追踪 ship.object —— 它只读
 * transform，不关心谁在写。战斗音效挂基座 AudioSystem 的合成总线。
 *
 * 阶段 B2：玩家船型来自 Shipyard 的 25 船表（开始门选择，localStorage 持久化），
 * 属性由 ships.json 经 computeStats 映射；有真实模型的 4 艘本阶段用基座
 * glTF 船模按船长缩放代替，其余用程序化生成（挂在基座 object 下做子节点，
 * glTF 模型隐藏——App 的尾迹/浪花/相机锚点不变）。
 */

import * as THREE from 'three/webgpu';
import type { Ship } from '../scene/Ship';
import type { AssetLoader } from '../scene/AssetLoader';
import type { ShipController } from '../physics/ShipController';
import type { AudioSystem } from '../audio';
import { GameShip, DEBUFF_DEFS, type WaveHeightAt } from './GameShip';
import { Combat, type HitTarget, type Cannonball } from './Combat';
import { EnemyFleet } from './EnemyFleet';
import { GameHud, ENEMY_HP_BAR_TIME, dmgFontSize } from './GameHud';
import { makeFanViz, updateFanViz } from './FanViz';
import { Supplies } from './Supplies';
import {
  buildShip,
  getShipDef,
  resolveShipId,
  BASE_LENGTH,
  type ShipStats,
} from './Shipyard';
import { FEEL } from './PlayerConfig';

/** 基座 glTF 船模归一化后的船长（米），缩放真实模型船型时以此为基准。 */
const BASE_MODEL_LENGTH = 27;

// ---- 船只碰撞（椭圆碰撞体 + 撞击伤害），旧 js/main.js 同名单元 ----
const COLLISION_MIN_SPEED = 3; // 相对速度低于此值不计伤害
const COLLISION_DAMAGE_MUL = 4; // 伤害 = (相对速度 - 阈值) × 系数
const COLLISION_COOLDOWN = 1.0; // 同一对船的伤害结算冷却
const COLLISION_GRIDS = 40; // 粗筛距离（27m 船体，按旧版 12 × lengthScale 放大）

export interface GameOptions {
  scene: THREE.Scene;
  uiRoot: HTMLElement;
  camera: THREE.PerspectiveCamera;
  /** 基座加载好的主船（视觉归一化完成，object 在场景根）。 */
  player: Ship;
  assets: AssetLoader;
  /** 基座的玩家船控制器；游戏接管期间保持停用。 */
  controls: ShipController;
  /** 基座音频系统（战斗音效走它的合成总线，音量滑杆即生效）。 */
  audio: AudioSystem;
  /** 25 船属性表（ships.json 映射完成；加载失败时各项为 FALLBACK_STATS）。 */
  shipStats: Record<number, ShipStats>;
  heightAt: WaveHeightAt;
}

export class Game {
  private readonly player: GameShip;
  private readonly playerBase: Ship;
  private readonly combat: Combat;
  private readonly fleet: EnemyFleet;
  private readonly hud: GameHud;
  private readonly audio: AudioSystem;
  private supplies: Supplies | null = null;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly heightAt: WaveHeightAt;
  private readonly abort = new AbortController();

  private readonly fanL: THREE.Mesh;
  private readonly fanR: THREE.Mesh;
  private readonly fanBow: THREE.Mesh;

  /** 玩家程序化外观（选真实模型船型时为 null，帆面鼓动由基座 Ship 负责）。 */
  private playerVisual: { group: THREE.Group; setSailAmount(amount: number): void } | null = null;

  private state: 'playing' | 'over' = 'playing';
  private kills = 0;
  private loot = 0; // 战利品（宝箱）计数
  private sailAmount = 0; // 帆量连续值：-ASTERN_MAX(倒车) ~ 1(满帆)
  private asternHoldT = 0; // S 按住且帆量为 0 的持续时间（超 ASTERN_HOLD 进入倒车）
  private cooldownL = 0;
  private cooldownR = 0;
  private cooldownBow = 0;
  private chargeL: number | null = null; // 蓄力进度秒数（null = 未按住）
  private chargeR: number | null = null;
  private chargeBow: number | null = null;
  private gameOverT = 0;
  private gameOverShown = false;
  private time = 0;

  private readonly keys = new Set<string>();
  private readonly collisionCooldowns = new Map<string, number>();
  private cidCounter = 0;

  constructor(options: GameOptions) {
    this.camera = options.camera;
    this.heightAt = options.heightAt;
    this.audio = options.audio;
    this.playerBase = options.player;

    // 游戏接管主船：基座的力模型控制器保持停用，浮力由 GameShip 自己采样。
    options.controls.setEnabled(false);
    options.controls.setKeyboardEnabled(false);

    // ---- 所选船型：属性（ships.json 映射） + 外观 ----
    const def = getShipDef(resolveShipId());
    const stats = options.shipStats[def.id];
    const lengthScale = def.spec.length / BASE_LENGTH;
    this.player = new GameShip(options.player.object, {
      maxHp: stats.hp,
      maxSpeed: stats.maxSpeed,
      turnRate: stats.turnRate,
      cannons: stats.cannons,
      lengthScale,
    });
    if (def.model) {
      // 有真实模型的船型：B2 先用基座 glTF 按船长缩放（精致模型 B3 进 public 管线）
      this.playerBase.setModelVisible(true);
      this.playerBase.setModelScale(def.spec.length / BASE_MODEL_LENGTH);
      this.player.baseY = 0; // glTF 模型设计水线即在 y=0
    } else {
      // 程序化船型：+Z 船头，转到容器的 +X 约定下；基座 glTF 隐藏
      this.playerBase.setModelVisible(false);
      const visual = buildShip(def.spec);
      visual.group.rotation.y = Math.PI / 2;
      this.playerBase.object.add(visual.group);
      this.playerVisual = visual;
      this.player.baseY = 0.55 * lengthScale;
    }
    this.player.revive();

    this.combat = new Combat(options.scene, this.heightAt);
    this.combat.onSplash = () => this.audio.playSplash(0.7);
    this.fleet = new EnemyFleet(options.scene, this.combat);
    this.hud = new GameHud(options.uiRoot);

    this.fanL = makeFanViz(options.scene);
    this.fanR = makeFanViz(options.scene);
    this.fanBow = makeFanViz(options.scene);

    // 漂浮补给：模型异步到，到了才开始撒布
    void Supplies.load(options.scene, options.assets, this.heightAt, this.player).then((s) => {
      this.supplies = s;
    });

    const { signal } = this.abort;
    window.addEventListener('keydown', this.onKeyDown, { signal });
    window.addEventListener('keyup', this.onKeyUp, { signal });
    window.addEventListener('blur', this.onBlur, { signal });
    window.addEventListener('mousedown', this.onMouseDown, { signal });
    window.addEventListener('mouseup', this.onMouseUp, { signal });
    window.addEventListener('contextmenu', this.onContextMenu, { signal });

    this.begin();

    // 调试/自动化钩子（截图验证与后续测试用）。
    (window as unknown as { __game: Game }).__game = this;
  }

  /** 玩家纵向航速（带符号），给 App 的尾迹/音响用。 */
  get playerSpeed(): number {
    return this.player.speed;
  }

  /** 出航：初始 60% 帆，两艘敌船。 */
  private begin(): void {
    this.setSail(0.6);
    this.fleet.spawnOne(this.player.position);
    this.fleet.spawnOne(this.player.position);
  }

  /** R 重开：原地复位，不刷新页面。 */
  private restart(): void {
    this.fleet.reset();
    this.player.revive();
    this.kills = 0;
    this.loot = 0;
    this.cooldownL = this.cooldownR = this.cooldownBow = 0;
    this.chargeL = this.chargeR = this.chargeBow = null;
    this.collisionCooldowns.clear();
    this.state = 'playing';
    this.gameOverT = 0;
    this.gameOverShown = false;
    this.hud.hideGameOver();
    this.begin();
  }

  update(dt: number): void {
    this.time += dt;
    const player = this.player;

    // 任意死因（炮火/撞击/着火）都进 Game Over
    if (this.state === 'playing' && player.sinking) {
      this.state = 'over';
      this.gameOverT = 0;
    }

    // ---- 玩家操控（旧版手感：帆量连续、舵效随速） ----
    if (this.state === 'playing' && !player.sinking) {
      // 帆位连续化：按住 W 匀速升帆 / S 匀速降帆；降到 0 后 S 再按 ASTERN_HOLD 秒进入倒车
      if (this.keys.has('KeyW')) {
        this.asternHoldT = 0;
        this.setSail(this.sailAmount + dt * FEEL.SAIL_RATE);
      } else if (this.keys.has('KeyS')) {
        if (this.sailAmount > 0) {
          this.setSail(this.sailAmount - dt * FEEL.SAIL_RATE);
        } else {
          this.asternHoldT += dt;
          if (this.asternHoldT > FEEL.ASTERN_HOLD) {
            this.setSail(this.sailAmount - dt * FEEL.SAIL_RATE);
          }
        }
      } else {
        this.asternHoldT = 0;
      }

      const targetSpeed = this.sailAmount * player.maxSpeed * player.speedMul; // debuff 乘区
      player.speed += (targetSpeed - player.speed) * Math.min(1, dt * 1.2);
      let turn = 0;
      if (this.keys.has('KeyA')) turn += 1; // A = 左转
      if (this.keys.has('KeyD')) turn -= 1;
      // 舵是翼面：舵效 ∝ 航速（低速几乎转不动），倒车时舵效反向
      const speedRatio = Math.min(1, Math.abs(player.speed) / player.maxSpeed);
      const rudderEff =
        FEEL.RUDDER_MIN_EFF + (1 - FEEL.RUDDER_MIN_EFF) * Math.pow(speedRatio, FEEL.RUDDER_CURVE);
      const rudderDir = player.speed < -0.3 ? -1 : 1;
      player.heading += turn * player.turnRate * rudderEff * rudderDir * dt;
    }

    // ---- 蓄力进度推进 + 扇面预览 ----
    if (this.chargeL !== null) this.chargeL += dt;
    if (this.chargeR !== null) this.chargeR += dt;
    if (this.chargeBow !== null) this.chargeBow += dt;
    updateFanViz(this.fanL, this.chargeL, -1, player, this.heightAt);
    updateFanViz(this.fanR, this.chargeR, 1, player, this.heightAt);
    updateFanViz(this.fanBow, this.chargeBow, 0, player, this.heightAt);

    // ---- 冷却 ----
    this.cooldownL = Math.max(0, this.cooldownL - dt);
    this.cooldownR = Math.max(0, this.cooldownR - dt);
    this.cooldownBow = Math.max(0, this.cooldownBow - dt);

    // ---- 实体更新 ----
    player.update(dt, this.heightAt);
    this.fleet.update(dt, player, this.heightAt, {
      onEnemySunk: () => {
        this.kills += 1;
      },
      onWaveUp: () => {
        // 波次提升，HUD 每帧自动刷新
      },
    });
    this.resolveShipCollisions();

    // ---- 补给 ----
    this.supplies?.update(dt, this.time, (event) => {
      this.combat.splash(event.position);
      this.audio.playPickup();
      if (event.kind === 'repair') {
        player.hp = Math.min(player.maxHp, player.hp + (this.supplies?.repairAmount ?? 10));
        this.hud.floatText('+10 修复');
      } else {
        this.loot += 1;
        this.hud.floatText('+1 战利品');
      }
    });

    // ---- 命中判定 ----
    const targets: HitTarget[] = [{ ship: player, isPlayer: true }];
    for (const e of this.fleet.enemies) targets.push({ ship: e, isPlayer: false });
    this.combat.update(dt, targets, this.onHit);

    // ---- 沉船冒泡 ----
    for (const s of [player, ...this.fleet.enemies]) {
      if (!s.sinking || s.dead) continue;
      if (Math.random() < dt * 8) {
        const pos = s.position.clone();
        pos.x += (Math.random() - 0.5) * 4;
        pos.z += (Math.random() - 0.5) * 4;
        pos.y = this.heightAt(pos.x, pos.z);
        this.combat.bubbles(pos);
      }
    }

    // ---- debuff 粒子：着火冒火焰、漏水舷侧冒水花 ----
    for (const s of [player, ...this.fleet.enemies]) {
      if (s.sinking || s.dead) continue;
      if (s.debuff.fire > 0 && Math.random() < dt * 10) {
        const pos = s.position.clone();
        pos.x += (Math.random() - 0.5) * 2;
        pos.z += (Math.random() - 0.5) * 2;
        pos.y += 1.5;
        this.combat.firePuff(pos);
      }
      if (s.debuff.leak > 0 && Math.random() < dt * 1.5) {
        const pos = s.position.clone();
        pos.x += (Math.random() - 0.5) * 3;
        pos.z += (Math.random() - 0.5) * 3;
        pos.y = this.heightAt(pos.x, pos.z) + 0.1;
        this.combat.splash(pos);
      }
    }

    // ---- 游戏结束：沉船动画播一会儿再弹遮罩 ----
    if (this.state === 'over') {
      this.gameOverT += dt;
      if (this.gameOverT > 3.2 && !this.gameOverShown) {
        this.gameOverShown = true;
        this.hud.showGameOver(this.kills, this.fleet.wave);
      }
    }

    // ---- HUD ----
    this.hud.update(
      player,
      this.sailAmount,
      { l: this.cooldownL, r: this.cooldownR, bow: this.cooldownBow },
      { broadside: FEEL.RELOAD_TIME, bow: FEEL.BOW_RELOAD },
      this.kills,
      this.fleet.wave,
      this.loot,
    );
    this.hud.updateEnemyHpBars(dt, this.fleet.enemies, this.camera);
  }

  dispose(): void {
    this.abort.abort();
    this.hud.dispose();
  }

  // ------------------------------------------------------------------ 输入

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
    if (e.code === 'KeyR' && this.state === 'over' && this.gameOverShown) {
      this.restart();
      return;
    }
    if (this.state !== 'playing' || e.repeat) return;
    // 帆位连续化：W/S 在主循环里按按住时长处理，此处不响应离散按键
    if (e.code === 'KeyQ') this.startCharge('L');
    if (e.code === 'KeyE') this.startCharge('R');
    if (e.code === 'Space') {
      e.preventDefault();
      this.startCharge('bow');
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    if (e.code === 'KeyQ') this.releaseCharge('L');
    if (e.code === 'KeyE') this.releaseCharge('R');
    if (e.code === 'Space') this.releaseCharge('bow');
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    // 切出窗口时丢掉 keyup，蓄力不能卡在半开状态
    this.chargeL = this.chargeR = this.chargeBow = null;
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (this.state !== 'playing') return;
    if (e.button === 0) this.startCharge('L');
    if (e.button === 2) this.startCharge('R');
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.releaseCharge('L');
    if (e.button === 2) this.releaseCharge('R');
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  // ------------------------------------------------------------------ 火炮

  /** 帆位连续设置（倒车为负值；破帆时上限被压低）。 */
  private setSail(v: number): void {
    this.sailAmount = THREE.MathUtils.clamp(v, -FEEL.ASTERN_MAX, this.player.sailCap);
    // 倒车时帆面按收帆显示
    this.playerVisual?.setSailAmount(Math.max(0, this.sailAmount));
  }

  /** 按住蓄力、松开发射；冷却未结束时按住不开始蓄力。 */
  private startCharge(which: 'L' | 'R' | 'bow'): void {
    if (this.state !== 'playing' || this.player.sinking) return;
    if (which === 'L' && this.cooldownL <= 0 && this.chargeL === null) this.chargeL = 0;
    if (which === 'R' && this.cooldownR <= 0 && this.chargeR === null) this.chargeR = 0;
    if (which === 'bow' && this.cooldownBow <= 0 && this.chargeBow === null) this.chargeBow = 0;
  }

  private releaseCharge(which: 'L' | 'R' | 'bow'): void {
    if (which === 'L' && this.chargeL !== null) {
      this.fireCharged(-1, this.chargeL / FEEL.CHARGE_TIME);
      this.chargeL = null;
    }
    if (which === 'R' && this.chargeR !== null) {
      this.fireCharged(1, this.chargeR / FEEL.CHARGE_TIME);
      this.chargeR = null;
    }
    if (which === 'bow' && this.chargeBow !== null) {
      this.fireBow(this.chargeBow / FEEL.CHARGE_TIME);
      this.chargeBow = null;
    }
  }

  private fireCharged(side: -1 | 1, power: number): void {
    if (this.player.sinking) return;
    const p = Math.min(1, power);
    this.combat.fireBroadside(this.player, side, {
      speed: FEEL.BROADSIDE_SPEED * (0.6 + 0.9 * p), // 初速/射程随蓄力
      spread: 0.05,
      fromPlayer: true, // 炮数取 ship.cannons
      damageMul: 0.7 + 0.8 * p, // 伤害随蓄力
    });
    this.audio.playCannon();
    if (side < 0) this.cooldownL = FEEL.RELOAD_TIME;
    else this.cooldownR = FEEL.RELOAD_TIME;
  }

  /** 艏炮：单发、弹道平直；小船（炮数 ≤2）伤害 ×1.5 补偿。 */
  private fireBow(power: number): void {
    if (this.player.sinking) return;
    const p = Math.min(1, power);
    this.combat.fireBowShot(this.player, {
      speed: FEEL.BOW_SPEED * (0.6 + 0.9 * p),
      damageMul: (0.7 + 0.8 * p) * (this.player.cannons <= 2 ? 1.5 : 1),
    });
    this.audio.playCannon();
    this.cooldownBow = FEEL.BOW_RELOAD;
  }

  // ------------------------------------------------------------------ 命中与碰撞

  private readonly onHit = (ball: Cannonball, target: HitTarget): void => {
    const base = target.isPlayer ? 12 : 20;
    const dmg = base * (ball.damageMul ?? 1);
    this.audio.playHit();
    const sunk = target.ship.takeDamage(dmg);
    if (!target.isPlayer && ball.fromPlayer) {
      // 玩家造成的伤害：白字漂浮 + 敌船血条
      target.ship.hurtT = ENEMY_HP_BAR_TIME;
      this.hud.floatTextAt(`-${Math.round(dmg)}`, target.ship.position, this.camera, {
        color: '#ffffff',
        size: dmgFontSize(dmg),
      });
    }
    if (!sunk) {
      // TODO(B3 天气)：大雨中（weather.fireOut）不附加着火
      for (const key of target.ship.rollDebuffs(false)) {
        // 敌船中 debuff：头上飘字；玩家中 debuff：HUD 图标表达（hud.update）
        if (!target.isPlayer) {
          this.hud.floatTextAt(`敌船${DEBUFF_DEFS[key].label}！`, target.ship.position, this.camera);
        }
      }
    }
    // 玩家被打沉由 update 里的 player.sinking 检查统一接管（含着火致死）
  };

  /** 椭圆碰撞体 + 撞击伤害，旧 js/main.js resolveShipCollisions 直译。 */
  private resolveShipCollisions(): void {
    const ships = [this.player, ...this.fleet.enemies].filter((s) => !s.sinking && !s.dead);
    for (let i = 0; i < ships.length; i++) {
      for (let j = i + 1; j < ships.length; j++) {
        const a = ships[i];
        const b = ships[j];
        let dx = b.position.x - a.position.x;
        let dz = b.position.z - a.position.z;
        let dist = Math.hypot(dx, dz);
        if (dist > COLLISION_GRIDS) continue; // 粗筛

        // 椭圆有效半径：沿连线方向取极径
        const effR = (s: GameShip): number => {
          const la = 4.0 * (s.lengthScale || 1);
          const lb = 1.35 * (s.lengthScale || 1);
          const fx = Math.sin(s.heading);
          const fz = Math.cos(s.heading);
          const cosT = dist > 0.001 ? (dx * fx + dz * fz) / dist : 1;
          const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
          return (la * lb) / Math.sqrt(lb * lb * cosT * cosT + la * la * sinT * sinT);
        };
        const pen = effR(a) + effR(b) - dist;
        if (pen <= 0) continue;

        if (dist < 0.001) {
          dx = 1;
          dz = 0;
          dist = 1;
        }
        const nx = dx / dist;
        const nz = dz / dist;

        // 撞击前的相对速度（用于伤害结算）
        const vax = Math.sin(a.heading) * a.speed;
        const vaz = Math.cos(a.heading) * a.speed;
        const vbx = Math.sin(b.heading) * b.speed;
        const vbz = Math.cos(b.heading) * b.speed;
        const relSpeed = Math.hypot(vbx - vax, vbz - vaz);

        // 位置分离（各推一半）
        a.position.x -= (nx * pen) / 2;
        a.position.z -= (nz * pen) / 2;
        b.position.x += (nx * pen) / 2;
        b.position.z += (nz * pen) / 2;

        // 消掉沿法向的速度分量，切向保留
        for (const s of [a, b]) {
          const fDotN = Math.sin(s.heading) * nx + Math.cos(s.heading) * nz;
          s.speed *= Math.max(0.2, 1 - fDotN * fDotN);
        }

        // 撞击伤害（同对 1s 冷却）；撞击方承伤 ×0.5，被撞方 ×1.5
        if (relSpeed > COLLISION_MIN_SPEED) {
          if (!a.cid) a.cid = ++this.cidCounter;
          if (!b.cid) b.cid = ++this.cidCounter;
          const key = a.cid < b.cid ? `${a.cid}:${b.cid}` : `${b.cid}:${a.cid}`;
          if (this.time - (this.collisionCooldowns.get(key) ?? -9) > COLLISION_COOLDOWN) {
            this.collisionCooldowns.set(key, this.time);
            const dmg = (relSpeed - COLLISION_MIN_SPEED) * COLLISION_DAMAGE_MUL;
            const speedA = Math.abs(a.speed);
            const speedB = Math.abs(b.speed);
            let dmgA = dmg;
            let dmgB = dmg;
            if (Math.abs(speedA - speedB) >= 0.5) {
              if (speedA > speedB) {
                dmgA = dmg * 0.5;
                dmgB = dmg * 1.5;
              } else {
                dmgA = dmg * 1.5;
                dmgB = dmg * 0.5;
              }
            }
            const mid = new THREE.Vector3(
              (a.position.x + b.position.x) / 2,
              a.position.y + 1,
              (a.position.z + b.position.z) / 2,
            );
            this.combat.explosion(mid); // 木屑+硝烟
            this.audio.playHit();
            a.takeDamage(dmgA);
            b.takeDamage(dmgB);
            // 玩家造成的撞击伤害：敌船飘白字 + 亮血条
            for (const [s, d] of [
              [a, dmgA],
              [b, dmgB],
            ] as const) {
              if (s !== this.player) {
                s.hurtT = ENEMY_HP_BAR_TIME;
                this.hud.floatTextAt(`-${Math.round(d)}`, s.position, this.camera, {
                  color: '#ffffff',
                  size: dmgFontSize(d),
                });
              }
            }
            // 玩家撞沉同样由 update 的 player.sinking 检查接管
          }
        }
      }
    }
  }
}
