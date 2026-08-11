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
  buildFigurehead,
  getShipDef,
  resolveShipId,
  resolveCustomization,
  BASE_LENGTH,
  type ShipDef,
  type ShipCustomization,
  type ShipStats,
} from './Shipyard';
import { loadShipModel, instantiateShip, SHIP_MODELS } from './ModelShips';
import { Minimap } from './Minimap';
import { Compass, type CompassMark } from './Compass';
import { FEEL } from './PlayerConfig';
import { ISLAND } from '../scene/Seafloor';
import type { Terrain } from './terrain/Terrain';

/** 基座 glTF 船模归一化后的船长（米），缩放真实模型船型时以此为基准。 */
const BASE_MODEL_LENGTH = 27;

/** 射角档位（上抛初速 vy，m/s）：低平射 ↔ 高抛射。 */
const ELEVATION_STEPS = [2, 4, 5.5, 7.5, 9.5, 12, 14] as const;
/** 水平射角上限（弧度）：舷炮 ±57°，艏炮 ±20°。 */
const AZIMUTH_MAX = 1.0;
const AZIMUTH_MAX_BOW = 0.35;

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
  /** 开炮镜头后坐（App 注入，驱动 CameraDirector）。 */
  onCannonFire: () => void;
  /** 25 船属性表（ships.json 映射完成；加载失败时各项为 FALLBACK_STATS）。 */
  shipStats: Record<number, ShipStats>;
  /** 同屏敌船基准数（Panel 滑杆，1~6）。 */
  enemyDensity: number;
  /** 自定义海域地形（null = 默认迷雾岛海域）。 */
  terrain: Terrain | null;
  /** 基座天气：大雨（rain 且有一定强度）时灭火、不新附着火、全船减速。 */
  isRaining: () => boolean;
  /** 下雪（arctic）：轻度减速，不灭火。 */
  isSnowing: () => boolean;
  heightAt: WaveHeightAt;
}

export class Game {
  private readonly player: GameShip;
  private readonly playerBase: Ship;
  private readonly combat: Combat;
  private readonly fleet: EnemyFleet;
  private readonly hud: GameHud;
  private readonly audio: AudioSystem;
  private readonly minimap: Minimap;
  private readonly compass: Compass;
  private readonly onCannonFire: () => void;
  /** 罗盘标记复用池（每 2 帧重建引用，不新建对象）。 */
  private readonly compassMarks: CompassMark[] = [];
  private readonly compassMarkPool: CompassMark[] = [];
  private supplies: Supplies | null = null;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly heightAt: WaveHeightAt;
  private readonly isRaining: () => boolean;
  private readonly isSnowing: () => boolean;
  private readonly terrain: Terrain | null;
  private readonly abort = new AbortController();

  private readonly fanL: THREE.Mesh;
  private readonly fanR: THREE.Mesh;
  private readonly fanBow: THREE.Mesh;

  /** 玩家帆面外观回调（程序化/精致模型的鼓收帆；基座 glTF 时为 null）。 */
  private playerSail: ((amount: number) => void) | null = null;
  /** 挂在基座 ship.object 下的定制外观子节点（换模型时整体替换）。 */
  private playerVisualNode: THREE.Object3D | null = null;
  /** 精致模型异步换装防串号：快速切换时旧请求后到账不得覆盖新选择。 */
  private visualToken = 0;

  private touchThrottle = 0; // 触屏摇杆帆量（-1 ~ 1，0 = 不接管）
  private touchRudder = 0; // 触屏摇杆转向（-1 ~ 1）

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
  // 满装填：装填结束后再等 PRIME_TIME 秒进入满装填（射程更远伤害更高），开火消耗
  private primeL = 0;
  private primeR = 0;
  private primeBow = 0;
  private gameOverT = 0;
  private gameOverShown = false;
  private time = 0;
  private mmFrame = 0;

  /** 沉船音效每艘只响一次。 */
  private readonly sinkSounded = new WeakSet<GameShip>();

  /** 射角档位（上抛初速 vy）：7 档，默认第 3 档 = 旧手感 5.5。 */
  private elevationStep = 2;
  /** 水平射角（弧度，正 = 偏向船头）：蓄力时鼠标左右移动调节，每舷/艏炮独立记忆。 */
  private azimuthL = 0;
  private azimuthR = 0;
  private azimuthBow = 0;

  private readonly keys = new Set<string>();
  private readonly collisionCooldowns = new Map<string, number>();
  private cidCounter = 0;

  /** 主循环复用容器：每帧重建引用，不重建对象（基座的性能政策是逐帧零分配）。 */
  private readonly shipList: GameShip[] = [];
  private readonly targets: HitTarget[] = [];
  private readonly targetPool: HitTarget[] = [];
  private readonly scratch = new THREE.Vector3();

  constructor(options: GameOptions) {
    this.camera = options.camera;
    this.heightAt = options.heightAt;
    this.audio = options.audio;
    this.isRaining = options.isRaining;
    this.isSnowing = options.isSnowing;
    this.playerBase = options.player;

    // 游戏接管主船：基座的力模型控制器保持停用，浮力由 GameShip 自己采样。
    options.controls.setEnabled(false);
    options.controls.setKeyboardEnabled(false);

    // ---- 所选船型：属性（ships.json 映射） + 外观（含精致模型/染色/船首像） ----
    const def = getShipDef(resolveShipId());
    const stats = options.shipStats[def.id];
    this.player = new GameShip(options.player.object, {
      maxHp: stats.hp,
      maxSpeed: stats.maxSpeed,
      turnRate: stats.turnRate,
      cannons: stats.cannons,
      lengthScale: def.spec.length / BASE_LENGTH,
    });
    this.applyPlayerVisual(def, resolveCustomization(), options.assets);
    this.player.revive();

    this.combat = new Combat(options.scene, this.heightAt);
    this.combat.onSplash = () => this.audio.playSplash(0.7);
    this.fleet = new EnemyFleet(options.scene, this.combat);
    this.fleet.densityCap = options.enemyDensity;
    this.hud = new GameHud(options.uiRoot);
    this.minimap = new Minimap(options.uiRoot);
    this.compass = new Compass(options.uiRoot);
    this.onCannonFire = options.onCannonFire;

    // ---- 自定义海域：地形入场 + 出生点/活动范围/小地图轮廓 ----
    this.terrain = options.terrain;
    if (this.terrain) {
      const terrain = this.terrain;
      options.scene.add(terrain.mesh);
      const range = (Math.min(terrain.sizeX, terrain.sizeZ) / 2) * 0.92;
      const limits = { cx: terrain.center.x, cz: terrain.center.z, r: range };
      this.player.limitCX = limits.cx;
      this.player.limitCZ = limits.cz;
      this.player.limitR = limits.r;
      this.fleet.limits = limits;
      this.player.position.copy(terrain.findSpawn()); // revive 之后再摆位
      this.minimap.setTerrain(
        terrain.makeMinimapImage(),
        terrain.center.x,
        terrain.center.z,
        terrain.sizeX,
        terrain.sizeZ,
      );
    }

    this.fanL = makeFanViz(options.scene);
    this.fanR = makeFanViz(options.scene);
    this.fanBow = makeFanViz(options.scene);

    // 漂浮补给：模型异步到，到了才开始撒布；自定义海域只撒在水里
    void Supplies.load(
      options.scene,
      options.assets,
      this.heightAt,
      this.player,
      this.terrain ? (x, z) => this.terrain!.heightWorld(x, z) < -2 : null,
    ).then((s) => {
      this.supplies = s;
    });

    const { signal } = this.abort;
    window.addEventListener('keydown', this.onKeyDown, { signal });
    window.addEventListener('keyup', this.onKeyUp, { signal });
    window.addEventListener('blur', this.onBlur, { signal });
    window.addEventListener('mousedown', this.onMouseDown, { signal });
    window.addEventListener('mouseup', this.onMouseUp, { signal });
    window.addEventListener('contextmenu', this.onContextMenu, { signal });
    // 蓄力期间滚轮调射角：capture 阶段拦截，boat 相机的滚轮缩放（冒泡阶段
    // 挂在 canvas 上）被 stopPropagation 挡掉；未蓄力时完全放行。
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false, signal });
    // 蓄力期间鼠标左右移动调水平射角（此时相机拖拽环视已被 chaseDragFilter 抑制）
    window.addEventListener('mousemove', this.onAimMove, { signal });

    this.begin();

    // 调试/自动化钩子（截图验证与后续测试用）。
    (window as unknown as { __game: Game }).__game = this;
  }

  /** 玩家纵向航速（带符号），给 App 的尾迹/音响用。 */
  get playerSpeed(): number {
    return this.player.speed;
  }

  /** 任一火炮正在蓄力：CameraDirector 用它抑制 boat 模式的拖拽环视。 */
  get isCharging(): boolean {
    return this.chargeL !== null || this.chargeR !== null || this.chargeBow !== null;
  }

  /**
   * 玩家外观解析：精致模型（勾选且有货）→ 基座 glTF 缩放（有货未勾选）→ 程序化。
   * 三条路径都把外观作为 +Z 船头的子节点挂进基座 ship.object（yaw +π/2 对齐
   * +X 约定），染色与船首像在子节点上统一处理。
   */
  private applyPlayerVisual(
    def: ShipDef,
    custom: ShipCustomization,
    assets: AssetLoader,
  ): void {
    const token = ++this.visualToken;
    // 定制染色存的是 '#rrggbb' 字符串，材质与实例化都要数值
    const parseHex = (v: string | null): number | undefined =>
      v === null ? undefined : Number.parseInt(v.slice(1), 16);
    const tint = {
      hull: parseHex(custom.hullColor),
      sail: parseHex(custom.sailColor),
    };
    const hasTint = tint.hull !== undefined || tint.sail !== undefined;

    const mount = (
      node: THREE.Object3D,
      sailSetter: ((amount: number) => void) | null,
      lengthScale: number,
      baseY: number,
    ): void => {
      if (token !== this.visualToken) return; // 后到的旧请求丢弃
      if (this.playerVisualNode) {
        this.playerBase.object.remove(this.playerVisualNode);
        this.playerVisualNode = null;
      }
      // +Z 船头 → 容器 +X 约定
      node.rotation.y = Math.PI / 2;
      this.playerBase.object.add(node);
      this.playerVisualNode = node;
      this.playerSail = sailSetter;
      this.player.lengthScale = lengthScale;
      this.player.hitRadius = 3.4 * lengthScale;
      this.player.baseY = baseY;

      // 船首像：挂船头 +Z 端水线上方，按船长比例
      if (custom.figurehead !== 'none') {
        const fh = buildFigurehead(custom.figurehead);
        fh.scale.setScalar(lengthScale);
        fh.position.set(0, 1.05 * lengthScale, lengthScale * BASE_LENGTH * 0.46);
        node.add(fh);
      }
      this.playerSail?.(Math.max(0, this.sailAmount));
    };

    if (custom.fancy && def.model) {
      // 精致模型：先程序化占位（模型按需异步加载），到了再换装；
      // 物理尺度按模型目标船长（旧版同规则）
      this.mountProcedural(def, custom, mount);
      void loadShipModel(assets, def.model).then((template) => {
        if (!template || token !== this.visualToken) return; // 失败留用程序化
        this.playerBase.setModelVisible(false);
        const inst = instantiateShip(template, hasTint ? tint : null);
        const targetLength = SHIP_MODELS[def.model!]?.targetLength ?? def.spec.length;
        mount(inst.group, inst.setSailAmount, targetLength / BASE_LENGTH, 0);
      });
      return;
    }
    this.mountProcedural(def, custom, mount);
  }

  /** 非精致路径：有真实模型的船型用基座 glTF 缩放，否则程序化生成。 */
  private mountProcedural(
    def: ShipDef,
    custom: ShipCustomization,
    mount: (
      node: THREE.Object3D,
      sailSetter: ((amount: number) => void) | null,
      lengthScale: number,
      baseY: number,
    ) => void,
  ): void {
    if (def.model) {
      // 基座 glTF 按船长缩放；染色对 glTF 不适用（贴图船），船首像照挂
      this.playerBase.setModelVisible(true);
      this.playerBase.setModelScale(def.spec.length / BASE_MODEL_LENGTH);
      const holder = new THREE.Group(); // 船首像的 +Z 挂载层
      mount(holder, null, def.spec.length / BASE_LENGTH, 0);
      return;
    }
    this.playerBase.setModelVisible(false);
    const parseHex = (v: string | null): number | null =>
      v === null ? null : Number.parseInt(v.slice(1), 16);
    const visual = buildShip(def.spec, {
      sailColor: parseHex(custom.sailColor),
      hullColor: parseHex(custom.hullColor),
    });
    mount(
      visual.group,
      (a) => visual.setSailAmount(a),
      def.spec.length / BASE_LENGTH,
      0.55 * (def.spec.length / BASE_LENGTH),
    );
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
    if (this.terrain) this.player.position.copy(this.terrain.findSpawn());
    this.kills = 0;
    this.loot = 0;
    this.cooldownL = this.cooldownR = this.cooldownBow = 0;
    this.primeL = this.primeR = this.primeBow = 0;
    this.chargeL = this.chargeR = this.chargeBow = null;
    this.collisionCooldowns.clear();
    this.state = 'playing';
    this.gameOverT = 0;
    this.gameOverShown = false;
    this.hud.hideGameOver();
    this.audio.playRestart();
    this.begin();
  }

  update(dt: number): void {
    this.time += dt;
    const player = this.player;
    // 大雨：灭火 + 不新附着火（onHit 的 skipFire）+ 全船减速
    const raining = this.isRaining();
    // 雨天大减速、雪天小减速
    const weatherSpeedMul = raining ? 0.9 : this.isSnowing() ? 0.95 : 1;
    this.fleet.weatherSpeedMul = weatherSpeedMul;

    // 任意死因（炮火/撞击/着火）都进 Game Over
    if (this.state === 'playing' && player.sinking) {
      this.state = 'over';
      this.gameOverT = 0;
      this.audio.playGameOver();
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
      // 触屏摇杆：纵轴直接映射帆量（下推到底进倒车）
      if (this.touchThrottle !== 0) {
        this.setSail(
          this.touchThrottle >= 0 ? this.touchThrottle : this.touchThrottle * FEEL.ASTERN_MAX,
        );
      }

      const targetSpeed = this.sailAmount * player.maxSpeed * player.speedMul * weatherSpeedMul;
      player.speed += (targetSpeed - player.speed) * Math.min(1, dt * 1.2);
      let turn = 0;
      if (this.keys.has('KeyA')) turn += 1; // A = 左转
      if (this.keys.has('KeyD')) turn -= 1;
      turn -= this.touchRudder; // 摇杆右推 = 右转
      // 舵是翼面：舵效 ∝ 航速（低速几乎转不动），倒车时舵效反向
      const speedRatio = Math.min(1, Math.abs(player.speed) / player.maxSpeed);
      const rudderEff =
        FEEL.RUDDER_MIN_EFF + (1 - FEEL.RUDDER_MIN_EFF) * Math.pow(speedRatio, FEEL.RUDDER_CURVE);
      const rudderDir = player.speed < -0.3 ? -1 : 1;
      const weatherTurnMul = raining ? 0.85 : 1; // 雨天操控略钝
      player.heading += turn * player.turnRate * rudderEff * rudderDir * weatherTurnMul * dt;
    }

    // ---- 蓄力进度推进 + 扇面预览 ----
    if (this.chargeL !== null) this.chargeL += dt;
    if (this.chargeR !== null) this.chargeR += dt;
    if (this.chargeBow !== null) this.chargeBow += dt;
    updateFanViz(this.fanL, this.chargeL, -1, player, this.heightAt, this.elevationVy, this.azimuthL);
    updateFanViz(this.fanR, this.chargeR, 1, player, this.heightAt, this.elevationVy, this.azimuthR);
    updateFanViz(this.fanBow, this.chargeBow, 0, player, this.heightAt, this.elevationVy, this.azimuthBow);

    // ---- 冷却 ----
    this.cooldownL = Math.max(0, this.cooldownL - dt);
    this.cooldownR = Math.max(0, this.cooldownR - dt);
    this.cooldownBow = Math.max(0, this.cooldownBow - dt);

    // 航行氛围声：船体嘎吱（随速概率）+ 满帆兜风
    if (this.state === 'playing' && !player.sinking) {
      const spd = Math.abs(player.speed);
      if (spd > 2 && Math.random() < dt * spd * 0.02) this.audio.playCreak();
      if (
        this.sailAmount > 0.95 &&
        spd > player.maxSpeed * 0.7 &&
        Math.random() < dt * 0.15
      ) {
        this.audio.playSailGust();
      }
    }
    // 满装填计时：冷却归零后开始累积（开火时清零）；
    // 蓄满的沿叮一声就绪提示（每舷+艏炮独立，首局出航的首次蓄满也会提示）
    const canDing = this.state === 'playing' && !player.sinking;
    const primeStep = (prime: number, cooldown: number): number => {
      if (cooldown > 0) return prime;
      const next = Math.min(FEEL.PRIME_TIME, prime + dt);
      if (canDing && prime < FEEL.PRIME_TIME && next >= FEEL.PRIME_TIME) this.audio.playReady();
      return next;
    };
    this.primeL = primeStep(this.primeL, this.cooldownL);
    this.primeR = primeStep(this.primeR, this.cooldownR);
    this.primeBow = primeStep(this.primeBow, this.cooldownBow);

    // ---- 实体更新 ----
    player.update(dt, this.heightAt);
    this.fleet.update(dt, player, this.heightAt, {
      onEnemySunk: (e) => {
        this.kills += 1;
        // 武装商船：击沉掉双倍战利品
        if (e.archetype === 'merchant') {
          this.loot += 2;
          this.hud.floatText('+2 战利品');
        }
      },
      onWaveUp: () => {
        // 波次提升，HUD 每帧自动刷新
      },
    });
    // 自定义海域：地形避浅（玩家与敌船同一规则——水深不足就往深水里推）
    if (this.terrain) {
      this.keepInDeepWater(player);
      for (const e of this.fleet.enemies) this.keepInDeepWater(e);
    }
    this.resolveShipCollisions();

    // ---- 补给 ----
    this.supplies?.update(dt, this.time, (event) => {
      this.combat.splash(event.position);
      this.audio.playPickup();
      this.audio.playSplash(0.4); // 小水花（拾取/漏水级，非炮弹级）
      if (event.kind === 'repair') {
        player.hp = Math.min(player.maxHp, player.hp + (this.supplies?.repairAmount ?? 10));
        this.hud.floatText('+10 修复');
      } else {
        this.loot += 1;
        this.hud.floatText('+1 战利品');
      }
    });

    // ---- 命中判定（targets 复用池：每帧重建引用，不新建包装对象） ----
    const targets = this.targets;
    targets.length = 0;
    let pool = this.targetPool[0];
    if (!pool) pool = this.targetPool[0] = { ship: player, isPlayer: true };
    pool.ship = player;
    targets.push(pool);
    const enemies = this.fleet.enemies;
    for (let i = 0; i < enemies.length; i++) {
      let wrap = this.targetPool[i + 1];
      if (!wrap) wrap = this.targetPool[i + 1] = { ship: enemies[i], isPlayer: false };
      wrap.ship = enemies[i];
      targets.push(wrap);
    }
    this.combat.update(dt, targets, this.onHit);

    // 沉船冒泡与 debuff 粒子共用的船列表（复用数组）
    const ships = this.shipList;
    ships.length = 0;
    ships.push(player);
    for (const e of enemies) ships.push(e);

    // ---- 沉船冒泡（沉船音效每艘一次） + 着火噼啪开关 ----
    let anyFire = false;
    for (const s of ships) {
      if (s.sinking && !s.dead && !this.sinkSounded.has(s)) {
        this.sinkSounded.add(s);
        this.audio.playSink();
      }
      if (!s.sinking && s.debuff.fire > 0) anyFire = true;
      if (!s.sinking || s.dead) continue;
      if (Math.random() < dt * 8) {
        const pos = this.scratch.copy(s.position);
        pos.x += (Math.random() - 0.5) * 4;
        pos.z += (Math.random() - 0.5) * 4;
        pos.y = this.heightAt(pos.x, pos.z);
        this.combat.bubbles(pos); // Burst 构造时拷贝坐标，复用向量安全
      }
    }
    this.audio.setFireBurning(anyFire);

    // ---- debuff 粒子：着火冒火焰、漏水舷侧冒水花；大雨浇灭所有着火 ----
    for (const s of ships) {
      if (s.sinking || s.dead) continue;
      if (raining && s.debuff.fire > 0) {
        s.debuff.fire = 0;
        if (s === player) this.hud.floatText('大雨浇灭了火焰');
      }
      if (s.debuff.fire > 0 && Math.random() < dt * 10) {
        const pos = this.scratch.copy(s.position);
        pos.x += (Math.random() - 0.5) * 2;
        pos.z += (Math.random() - 0.5) * 2;
        pos.y += 1.5;
        this.combat.firePuff(pos);
      }
      if (s.debuff.leak > 0 && Math.random() < dt * 1.5) {
        const pos = this.scratch.copy(s.position);
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
      {
        l: this.primeL >= FEEL.PRIME_TIME,
        r: this.primeR >= FEEL.PRIME_TIME,
        bow: this.primeBow >= FEEL.PRIME_TIME,
      },
      this.kills,
      this.fleet.wave,
      this.loot,
      this.elevationDegrees,
      this.azimuthDegrees,
      this.chargeL !== null || this.chargeR !== null || this.chargeBow !== null,
    );
    this.hud.updateEnemyHpBars(dt, this.fleet.enemies, this.camera);
    if ((this.mmFrame & 3) === 0) {
      this.minimap.draw(player, this.fleet.enemies, this.supplies); // 小地图 ~15fps 节流
    }
    // 罗盘隔帧（刻度 + 方位标记）
    if ((this.mmFrame & 1) === 0) this.drawCompass();
    this.mmFrame++;
  }

  /** 罗盘数据装配（复用池，零分配）与绘制。 */
  private drawCompass(): void {
    const marks = this.compassMarks;
    marks.length = 0;
    const pool = this.compassMarkPool;
    const pp = this.player.position;
    const bearing = (x: number, z: number): number => Math.atan2(x - pp.x, -(z - pp.z));
    let n = 0;
    const push = (b: number, color: string, kind: CompassMark['kind']): void => {
      let m = pool[n];
      if (!m) m = pool[n] = { bearing: 0, color: '', kind: 'dot' };
      m.bearing = b;
      m.color = color;
      m.kind = kind;
      n++;
      marks.push(m);
    };
    for (const e of this.fleet.enemies) {
      if (!e.sinking) push(bearing(e.position.x, e.position.z), e.mapColor, 'tri');
    }
    if (this.supplies) {
      for (const item of this.supplies.items) {
        if (!item.active) continue;
        push(
          bearing(item.object.position.x, item.object.position.z),
          item.kind === 'loot' ? '#ffd76e' : '#b5854a',
          'dot',
        );
      }
    }
    // 陆地方向：自定义海域指区域中心，默认海域指迷雾岛
    const land = this.terrain ? this.terrain.center : ISLAND;
    push(bearing(land.x, land.z), '#5a9a6a', 'sq');
    this.compass.draw(this.player.heading, marks);
  }

  /** 触屏摇杆输入（throttle/rudder 各 -1..1；0 = 松开不接管）。 */
  setTouchInput(throttle: number, rudder: number): void {
    this.touchThrottle = THREE.MathUtils.clamp(throttle, -1, 1);
    this.touchRudder = THREE.MathUtils.clamp(rudder, -1, 1);
  }

  /** 触屏开炮按钮：按住蓄力、松开发射，与 Q/E 同路径。 */
  touchFire(side: 'L' | 'R', down: boolean): void {
    if (down) this.startCharge(side);
    else this.releaseCharge(side);
  }

  /** Panel 敌船密度滑杆：调低不杀现有敌船（只是不再补员），调高立即补。 */
  setEnemyDensity(n: number): void {
    this.fleet.densityCap = Math.round(THREE.MathUtils.clamp(n, 1, 6));
  }

  /**
   * 地形避浅：水深 < 1.2m 就沿高度梯度往深水推（梯度方向即更深方向），
   * 并衰减航速。比圆形世界边界柔和，船是"被水推回去"而不是撞墙。
   */
  private keepInDeepWater(ship: GameShip): void {
    const terrain = this.terrain!;
    const p = ship.position;
    const h = terrain.heightWorld(p.x, p.z);
    if (h < -1.2) return;
    const g = 6;
    const gx = terrain.heightWorld(p.x + g, p.z) - terrain.heightWorld(p.x - g, p.z);
    const gz = terrain.heightWorld(p.x, p.z + g) - terrain.heightWorld(p.x, p.z - g);
    const len = Math.hypot(gx, gz);
    const push = (h + 1.2) * 1.5;
    if (len < 1e-4) {
      // 平顶上没有梯度：沿来路退
      p.x -= Math.sin(ship.heading) * push;
      p.z -= Math.cos(ship.heading) * push;
    } else {
      p.x -= (gx / len) * push;
      p.z -= (gz / len) * push;
    }
    ship.speed *= 0.55;
  }

  dispose(): void {
    this.abort.abort();
    this.hud.dispose();
    this.minimap.dispose();
    this.compass.dispose();
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

  /** 当前射角的上抛初速（vy）。 */
  get elevationVy(): number {
    return ELEVATION_STEPS[this.elevationStep];
  }

  /** 显示用的名义射角（按舷炮基准初速 40 折算）。 */
  get elevationDegrees(): number {
    return Math.round(THREE.MathUtils.radToDeg(Math.atan(this.elevationVy / FEEL.BROADSIDE_SPEED)));
  }

  /** 显示用的水平射角（度；正 = 偏船头）。显示当前正在蓄力那舷的值。 */
  get azimuthDegrees(): number {
    const v =
      this.chargeL !== null ? this.azimuthL
        : this.chargeR !== null ? this.azimuthR
          : this.chargeBow !== null ? this.azimuthBow
            : this.azimuthL;
    return Math.round(THREE.MathUtils.radToDeg(v));
  }

  /** 蓄力中鼠标左右移动 = 调水平射角（偏船头/船尾扫射）。 */
  private readonly onAimMove = (e: MouseEvent): void => {
    const d = e.movementX * 0.0025; // 弧度/像素
    if (this.chargeL !== null) this.azimuthL = THREE.MathUtils.clamp(this.azimuthL + d, -AZIMUTH_MAX, AZIMUTH_MAX);
    if (this.chargeR !== null) this.azimuthR = THREE.MathUtils.clamp(this.azimuthR + d, -AZIMUTH_MAX, AZIMUTH_MAX);
    if (this.chargeBow !== null) this.azimuthBow = THREE.MathUtils.clamp(this.azimuthBow + d, -AZIMUTH_MAX_BOW, AZIMUTH_MAX_BOW);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    const charging = this.chargeL !== null || this.chargeR !== null || this.chargeBow !== null;
    if (!charging) return;
    e.preventDefault();
    e.stopPropagation();
    // 滚轮上推（deltaY<0）= 抬高射角
    const delta = e.deltaY < 0 ? 1 : -1;
    this.elevationStep = THREE.MathUtils.clamp(
      this.elevationStep + delta,
      0,
      ELEVATION_STEPS.length - 1,
    );
  };

  // ------------------------------------------------------------------ 火炮

  /** 帆位连续设置（倒车为负值；破帆时上限被压低）。 */
  private setSail(v: number): void {
    this.sailAmount = THREE.MathUtils.clamp(v, -FEEL.ASTERN_MAX, this.player.sailCap);
    // 倒车时帆面按收帆显示
    this.playerSail?.(Math.max(0, this.sailAmount));
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
    // 满装填加成：初速/射程与伤害同时提升，开火后消耗
    const primed = side < 0 ? this.primeL >= FEEL.PRIME_TIME : this.primeR >= FEEL.PRIME_TIME;
    const primeS = primed ? FEEL.PRIME_SPEED_MUL : 1;
    const primeD = primed ? FEEL.PRIME_DAMAGE_MUL : 1;
    this.combat.fireBroadside(this.player, side, {
      speed: FEEL.BROADSIDE_SPEED * (0.6 + 0.9 * p) * primeS, // 初速/射程随蓄力
      spread: 0.05,
      fromPlayer: true, // 炮数取 ship.cannons
      damageMul: (0.7 + 0.8 * p) * primeD, // 伤害随蓄力
      vy: this.elevationVy, // 射角（蓄力期间滚轮调节）
      azimuth: side < 0 ? this.azimuthL : this.azimuthR, // 水平射角（鼠标左右）
    });
    this.audio.playCannon();
    this.onCannonFire();
    if (side < 0) {
      this.cooldownL = FEEL.RELOAD_TIME;
      this.primeL = 0;
    } else {
      this.cooldownR = FEEL.RELOAD_TIME;
      this.primeR = 0;
    }
  }

  /** 艏炮：单发、弹道平直；小船（炮数 ≤2）伤害 ×1.5 补偿。 */
  private fireBow(power: number): void {
    if (this.player.sinking) return;
    const p = Math.min(1, power);
    const primed = this.primeBow >= FEEL.PRIME_TIME;
    this.combat.fireBowShot(this.player, {
      speed: FEEL.BOW_SPEED * (0.6 + 0.9 * p) * (primed ? FEEL.PRIME_SPEED_MUL : 1),
      damageMul:
        (0.7 + 0.8 * p) * (this.player.cannons <= 2 ? 1.5 : 1) * (primed ? FEEL.PRIME_DAMAGE_MUL : 1),
      vy: this.elevationVy,
      azimuth: this.azimuthBow,
    });
    this.audio.playCannon();
    this.onCannonFire();
    this.cooldownBow = FEEL.BOW_RELOAD;
    this.primeBow = 0;
  }

  // ------------------------------------------------------------------ 命中与碰撞

  private readonly onHit = (ball: Cannonball, target: HitTarget): void => {
    const base = target.isPlayer ? 12 : 20;
    const dmg = base * (ball.damageMul ?? 1);
    this.audio.playHit();
    const sunk = target.ship.takeDamage(dmg);
    if (target.isPlayer) this.hud.hitFlash(); // 受击红晕
    if (!target.isPlayer && ball.fromPlayer) {
      // 玩家造成的伤害：白字漂浮 + 敌船血条
      target.ship.hurtT = ENEMY_HP_BAR_TIME;
      this.hud.floatTextAt(`-${Math.round(dmg)}`, target.ship.position, this.camera, {
        color: '#ffffff',
        size: dmgFontSize(dmg),
      });
    }
    if (!sunk) {
      // 大雨天不新附着火
      for (const key of target.ship.rollDebuffs(this.isRaining())) {
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
    const ships = this.shipList;
    ships.length = 0;
    if (!this.player.sinking && !this.player.dead) ships.push(this.player);
    for (const e of this.fleet.enemies) if (!e.sinking && !e.dead) ships.push(e);
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
            this.audio.playCollision(); // 厚重撞击声，区别于炮击命中
            a.takeDamage(dmgA);
            b.takeDamage(dmgB);
            if (a === this.player || b === this.player) this.hud.hitFlash();
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
