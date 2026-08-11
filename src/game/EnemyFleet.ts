/**
 * 敌方 AI 船队：远处生成、按 archetype 分型行为、被击沉后延迟补充，难度随波次提升。
 * 移植自旧 js/enemy.js（B2 换成 Shipyard 程序化生成；B4 加 archetype）。
 *
 * 四种分型（rollArchetype 按权重，带波次门槛）：
 *   战船 warship    —— 旧版行为：接近 → 环绕 → 舷侧齐射
 *   袭击艇 raider   —— 小快船，血少速快，冲进 15~25m 扫射，太近就拉开
 *   战列舰 battleship —— 血厚炮多，慢，45~70m 远距离齐射；波次 ≥2 才出现
 *   武装商船 merchant —— 不进攻，玩家接近就背向全帆逃跑；击沉掉双倍战利品
 */

import * as THREE from 'three/webgpu';
import { GameShip, type WaveHeightAt } from './GameShip';
import { buildShip, getShipDef, buildPartsFor, hullMulFor, BASE_LENGTH } from './Shipyard';
import type { Combat } from './Combat';

const ENEMY_HULL = 0x3a3f4a; // 深灰船体
const ENEMY_SAIL = 0x9e3030; // 暗红帆，辨识度

/** AI 循环的复用向量（每艘敌船每帧都在这条路径上）。 */
const _toP = new THREE.Vector3();
const _starboard = new THREE.Vector3();

export type EnemyArchetype = 'warship' | 'raider' | 'battleship' | 'merchant';

interface ArchetypeSpec {
  /** Shipyard SHIP_DEFS id 池。 */
  pool: readonly number[];
  hpMul: number;
  speedMul: number;
  turnRate: number;
  /** 开火参数（merchant 不开火）。 */
  fireRange: number;
  fireCooldown: readonly [number, number];
  fireCount: number;
  fireSpeed: number;
  fireSpread: number;
  fireDamageMul: number;
  /** 出现所需最小波次。 */
  minWave: number;
  weight: number;
  mapColor: string;
  label: string;
}

export const ARCHETYPES: Record<EnemyArchetype, ArchetypeSpec> = {
  warship: {
    pool: [9, 10, 11, 15, 20],
    hpMul: 1, speedMul: 1, turnRate: 0.55,
    fireRange: 52, fireCooldown: [4.5, 7], fireCount: 3, fireSpeed: 26, fireSpread: 0.14, fireDamageMul: 1,
    minWave: 1, weight: 0.35,
    mapColor: '#e0483e', label: '敌船',
  },
  raider: {
    pool: [5, 13, 14],
    hpMul: 0.5, speedMul: 1.4, turnRate: 0.85,
    fireRange: 30, fireCooldown: [1.6, 2.8], fireCount: 2, fireSpeed: 30, fireSpread: 0.18, fireDamageMul: 0.5,
    minWave: 1, weight: 0.35,
    mapColor: '#e8862e', label: '袭击艇',
  },
  battleship: {
    pool: [16, 17],
    hpMul: 2, speedMul: 0.7, turnRate: 0.4,
    fireRange: 70, fireCooldown: [5, 7.5], fireCount: 5, fireSpeed: 30, fireSpread: 0.1, fireDamageMul: 1,
    minWave: 2, weight: 0.1,
    mapColor: '#8a1f1a', label: '战列舰',
  },
  merchant: {
    pool: [6, 9],
    hpMul: 1, speedMul: 1.0, turnRate: 0.6,
    fireRange: 0, fireCooldown: [0, 0], fireCount: 0, fireSpeed: 0, fireSpread: 0, fireDamageMul: 0,
    minWave: 1, weight: 0.2,
    mapColor: '#ffd76e', label: '商船',
  },
};

export interface FleetHooks {
  onEnemySunk(ship: GameShip): void;
  onWaveUp(wave: number): void;
}

/** 程序化船是 +Z 船头，转到 GameShip 容器（+X 船头约定）下要 yaw +π/2。 */
function wrapEnemyVisual(
  defId: number,
  sailColor = ENEMY_SAIL,
): { group: THREE.Group; mast: THREE.Object3D | null; sails: THREE.Mesh[] } {
  const def = getShipDef(defId);
  const visual = buildShip(def.spec, { hullColor: ENEMY_HULL, sailColor });
  visual.setSailAmount(0.9); // 敌船恒近满帆
  const container = new THREE.Group();
  visual.group.rotation.y = Math.PI / 2;
  container.add(visual.group);
  const sails: THREE.Mesh[] = [];
  visual.group.traverse((o) => {
    const sail = o.userData.sail as { mesh: THREE.Mesh } | undefined;
    if (sail) sails.push(sail.mesh);
  });
  return { group: container, mast: visual.masts[0] ?? null, sails };
}

export class EnemyFleet {
  readonly enemies: GameShip[] = [];
  wave = 1;
  killsThisWave = 0;
  weatherSpeedMul = 1; // 由 Game 每帧写入：雨天全船减速
  /** 风对帆的倍率（Game 每帧可用的环境查询；敌船 AI 不抢风，只吃倍率）。 */
  windMulFor: (heading: number) => number = () => 1;
  /** 可航水域校验（Game 注入：地面高度 < -3m）；null = 不校验（兼容旧行为）。 */
  isNavigable: ((x: number, z: number) => boolean) | null = null;
  /** 同屏敌船基准数（Panel 滑杆，1~6）。 */
  densityCap = 2;
  /** 自定义海域的活动范围（Game 注入）；null = 默认圆形世界。 */
  limits: { cx: number; cz: number; r: number } | null = null;

  private readonly scene: THREE.Scene;
  private readonly combat: Combat;
  private readonly respawnTimers: number[] = [];

  constructor(scene: THREE.Scene, combat: Combat) {
    this.scene = scene;
    this.combat = combat;
  }

  get targetCount(): number {
    return Math.min(this.densityCap + (this.wave - 1), 6);
  }

  private rollArchetype(): EnemyArchetype {
    const candidates = (Object.keys(ARCHETYPES) as EnemyArchetype[]).filter(
      (k) => ARCHETYPES[k].minWave <= this.wave,
    );
    const total = candidates.reduce((s, k) => s + ARCHETYPES[k].weight, 0);
    let roll = Math.random() * total;
    for (const k of candidates) {
      roll -= ARCHETYPES[k].weight;
      if (roll <= 0) return k;
    }
    return 'warship';
  }

  spawnOne(playerPos: THREE.Vector3): void {
    const archetype = this.rollArchetype();
    const spec = ARCHETYPES[archetype];
    const defId = spec.pool[Math.floor(Math.random() * spec.pool.length)];
    const def = getShipDef(defId);
    const lengthScale = def.spec.length / BASE_LENGTH;

    const angle = Math.random() * Math.PI * 2;
    const dist = 150 + Math.random() * 90;
    // 出生点水域校验：重抽至多 20 次；仍不中则环形扫描找最近可航点
    let sx = playerPos.x + Math.cos(angle) * dist;
    let sz = playerPos.z + Math.sin(angle) * dist;
    if (this.isNavigable) {
      const nav = this.isNavigable;
      let found = nav(sx, sz);
      for (let i = 0; i < 19 && !found; i++) {
        const a2 = Math.random() * Math.PI * 2;
        const d2 = 150 + Math.random() * 90;
        sx = playerPos.x + Math.cos(a2) * d2;
        sz = playerPos.z + Math.sin(a2) * d2;
        found = nav(sx, sz);
      }
      if (!found) {
        // 兜底：渐扩环扫（自定义海域玩家贴岸时 150~240m 环带可能全是陆地）
        for (let r = 160; r <= 480 && !found; r += 40) {
          for (let i = 0; i < 16 && !found; i++) {
            const a3 = (i / 16) * Math.PI * 2;
            const tx = playerPos.x + Math.cos(a3) * r;
            const tz = playerPos.z + Math.sin(a3) * r;
            if (nav(tx, tz)) {
              sx = tx;
              sz = tz;
              found = true;
            }
          }
        }
      }
    }
    const hullHp = Math.round((50 + this.wave * 15) * 2.5 * spec.hpMul * hullMulFor(defId)); // 基底 ×2.5：拉长战斗，让 debuff 有时间发酵
    const vis = wrapEnemyVisual(defId);
    const ship = new GameShip(vis.group, {
      maxHp: hullHp,
      maxSpeed: (6.5 + this.wave * 0.4) * spec.speedMul,
      turnRate: spec.turnRate,
      cannons: spec.fireCount,
      lengthScale,
      parts: buildPartsFor(defId, hullHp), // 敌船同规则挂部件（帆装毁了自然变慢）
    });
    ship.mastVisual = vis.mast;
    ship.sailMeshes = vis.sails; // 帆面爬火/烧焦用
    ship.archetype = archetype;
    ship.mapColor = spec.mapColor;
    // 程序化船体的吃水：比旧版略抬，防大浪穿模透过甲板
    ship.baseY = 0.55 * lengthScale;
    ship.position.set(sx, 0, sz);
    ship.heading = angle + Math.PI; // 大致朝玩家
    ship.orbitDir = Math.random() < 0.5 ? 1 : -1;
    ship.cooldown = 2 + Math.random() * 3;
    if (this.limits) {
      ship.limitCX = this.limits.cx;
      ship.limitCZ = this.limits.cz;
      ship.limitR = this.limits.r;
    }
    this.scene.add(ship.object);
    this.enemies.push(ship);
  }

  update(dt: number, player: GameShip, heightAt: WaveHeightAt, hooks: FleetHooks): void {
    // ---- 补充新船 ----
    for (let i = this.respawnTimers.length - 1; i >= 0; i--) {
      this.respawnTimers[i] -= dt;
      if (this.respawnTimers[i] <= 0) {
        this.respawnTimers.splice(i, 1);
        this.spawnOne(player.position);
      }
    }
    // 手数存活数，不为它每帧 filter 出一个新数组
    let aliveCount = 0;
    for (const e of this.enemies) if (!e.sinking) aliveCount++;
    if (aliveCount + this.respawnTimers.length < this.targetCount) {
      this.respawnTimers.push(5 + Math.random() * 4);
    }

    // ---- 每艘船的 AI ----
    const pp = player.position;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.update(dt, heightAt);

      // 沉船动画播完：移除 + 计数 + 升波
      if (e.dead) {
        this.scene.remove(e.object);
        this.enemies.splice(i, 1);
        this.killsThisWave += 1;
        if (this.killsThisWave >= 4) {
          this.killsThisWave = 0;
          this.wave += 1;
          hooks.onWaveUp(this.wave);
        }
        hooks.onEnemySunk(e);
        continue;
      }
      if (e.sinking) continue;
      if (player.sinking) {
        e.speed = Math.max(0, e.speed - dt * 2);
        continue;
      }

      // 模块级复用向量：每艘敌船每帧都在这条路径上，堆分配一分都不该花
      const toP = _toP.subVectors(pp, e.position);
      const dist = toP.length();
      const angleToP = Math.atan2(toP.x, toP.z);
      const spec = ARCHETYPES[e.archetype];

      // ---- 期望航向与航速（分型行为） ----
      let desired: number;
      let speedTarget: number;
      switch (e.archetype) {
        case 'raider':
          // 冲近身扫射：>28m 接近，<15m 拉开，中间环绕
          if (dist > 28) desired = angleToP;
          else if (dist < 15) desired = angleToP + Math.PI * 0.9;
          else desired = angleToP + e.orbitDir * Math.PI * 0.5;
          speedTarget = e.maxSpeed;
          break;
        case 'battleship':
          // 远程站撸：>70m 接近，<45m 拉开，中间环绕
          if (dist > 70) desired = angleToP;
          else if (dist < 45) desired = angleToP + e.orbitDir * Math.PI * 0.75;
          else desired = angleToP + e.orbitDir * Math.PI * 0.5;
          speedTarget = dist > 45 ? e.maxSpeed : e.maxSpeed * 0.6;
          break;
        case 'merchant':
          // 不进攻：玩家进 130m 就背向全帆逃跑，否则慢速巡航
          if (dist < 130) {
            desired = angleToP + Math.PI;
            speedTarget = e.maxSpeed;
          } else {
            desired = e.heading; // 保持航向
            speedTarget = e.maxSpeed * 0.45;
          }
          break;
        default:
          // 战船：远则接近，近则环绕；太近则稍微拉开
          if (dist > 55) desired = angleToP;
          else if (dist < 26) desired = angleToP + e.orbitDir * Math.PI * 0.75;
          else desired = angleToP + e.orbitDir * Math.PI * 0.5;
          speedTarget = dist > 20 ? e.maxSpeed : e.maxSpeed * 0.55;
          break;
      }
      e.turnToward(desired, dt);
      // 与玩家同一惯性模型：加速 τ≈4s、减速 τ≈6s（敌船不划桨）
      const eTarget = speedTarget * e.speedMul * this.weatherSpeedMul * this.windMulFor(e.heading);
      const eRate = eTarget > e.speed ? 1 / 4 : 1 / 6;
      e.speed += (eTarget - e.speed) * Math.min(1, dt * eRate);

      // ---- 开火：舷侧大致对准玩家且进入射程（merchant 不开火） ----
      if (spec.fireCount === 0) continue;
      e.cooldown -= dt;
      if (e.cooldown <= 0 && dist < spec.fireRange) {
        const starboard = _starboard.set(-Math.cos(e.heading), 0, Math.sin(e.heading)); // 与 Combat 舷侧约定一致
        const dot = starboard.dot(toP.normalize()); // toP 到此用完，原地归一化即可
        if (Math.abs(dot) > 0.72) {
          this.combat.fireBroadside(e, dot > 0 ? 1 : -1, {
            count: spec.fireCount,
            speed: spec.fireSpeed,
            spread: spec.fireSpread,
            fromPlayer: false,
            damageMul: spec.fireDamageMul,
          });
          e.cooldown = spec.fireCooldown[0] + Math.random() * (spec.fireCooldown[1] - spec.fireCooldown[0]);
        } else {
          e.cooldown = 0.5; // 没对准就稍后再试
        }
      }
    }
  }

  /** 重开一局时清空。 */
  reset(): void {
    for (const e of this.enemies) this.scene.remove(e.object);
    this.enemies.length = 0;
    this.respawnTimers.length = 0;
    this.wave = 1;
    this.killsThisWave = 0;
  }
}
