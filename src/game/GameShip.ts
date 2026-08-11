/**
 * 游戏船实体：旧 js/ship.js 的运动学模型（航向/航速 + 四点浮力采样 + 沉船动画），
 * 外观换成基座加载的 glTF（scene/Ship.ts 归一化后的 dutch_ship_medium）。
 *
 * 为什么不用基座的 BuoyantBody + ShipController：那是力/力矩积分模型
 * （推力、二次阻力、舵面升力），手感由 MAX_THRUST/DRAG_* 决定，与旧版的
 * 「帆量 → 目标速度一阶逼近、舵效 ∝ 航速^1.5」街机模型是两套参数体系；
 * 任务要求手感参数照抄旧版，所以运动模型整体移植，基座只贡献外观与
 * OceanSampler 的波高场。
 *
 * 朝向约定：内部沿用旧版 heading（forward = (sinθ, 0, cosθ)，从 +Z 起算）。
 * 基座模型的船头是本地 +X（见 scene/Ship.ts 的 forwardLocal），写出姿态时
 * 做一次性换算：
 *   rotation.order 'YXZ'
 *   rotation.y = heading - π/2   （Ry(φ)·+X = (sinθ, 0, cosθ)）
 *   rotation.z = -pitch          （+X 船头，Rz 正 = 抬艏；旧 pitch 负 = 抬艏）
 *   rotation.x = roll            （Rx 正 = 桅杆倒向右舷 +Z，与旧版视觉一致）
 */

import * as THREE from 'three/webgpu';

const WORLD_LIMIT = 760; // 活动范围半径（远岛在 ~700m 外），超出会被挡回

export type WaveHeightAt = (x: number, z: number) => number;

export type DebuffKind = 'fire' | 'leak' | 'sail';

/** 命中 debuff 数值表（独立判定，重复触发刷新时间，沉船时清除）。旧 js/ship.js 同表。 */
export const DEBUFF_DEFS = {
  fire: { chance: 0.15, duration: 8, dps: 2, label: '着火' }, // 持续掉血
  leak: { chance: 0.15, duration: 20, speedMul: 0.7, damageTakenMul: 1.25, label: '漏水' }, // 减速+易伤
  sail: { chance: 0.2, duration: 15, maxSail: 0.5, speedMul: 0.6, label: '破帆' }, // 帆量上限+减速
} as const;

// ---------------------------------------------------------------- 部件血量

/**
 * 部件种类。船体（hull）不是部件——它就是 ship.hp 本身，归零沉船；
 * 部件是挂在船上的可毁结构，毁损效果本局内持久（区别于临时 debuff）。
 * sails 与 oars 互斥：日式/桨帆船型用 oars（毁损掉极速），其余用 sails（毁损压帆量上限）。
 */
export type PartKind = 'sails' | 'oars' | 'rudder' | 'mast';

export interface PartSpec {
  kind: PartKind;
  maxHp: number;
}

export interface ShipPart extends PartSpec {
  hp: number;
}

export const PART_INFO: Record<PartKind, { label: string; icon: string; brokenText: string }> = {
  sails: { label: '帆装', icon: '⛵', brokenText: '帆装被摧毁！' },
  oars: { label: '船桨', icon: '🛶', brokenText: '船桨被摧毁！' },
  rudder: { label: '船舵', icon: '🎯', brokenText: '船舵被摧毁！' },
  mast: { label: '桅杆', icon: '🎋', brokenText: '桅杆折断！' },
};

/** 帆装毁损后的永久帆量上限。 */
export const SAILS_BROKEN_CAP = 0.4;
/** 船桨毁损后的极速倍率。 */
export const OARS_BROKEN_SPEED_MUL = 0.5;
/** 船舵毁损后的舵效倍率。 */
export const RUDDER_BROKEN_TURN_MUL = 0.35;

export interface GameShipOptions {
  maxHp: number;
  maxSpeed: number;
  turnRate: number;
  cannons: number;
  /**
   * 相对旧版基准船长（9m）的倍数。基座船模归一化到 27m，即 lengthScale = 3；
   * 浮力采样臂、命中半径、艏炮出膛点都由它派生。
   */
  lengthScale: number;
  /** 部件配置（Shipyard.buildPartsFor 生成）；空/缺省 = 无部件（岸防炮等）。 */
  parts?: PartSpec[];
}

export class GameShip {
  /** 纯变换节点，浮力/朝向都直接写在它上面；必须在场景根下（position 即世界坐标）。 */
  readonly object: THREE.Object3D;

  maxHp: number;
  hp: number;
  maxSpeed: number;
  turnRate: number;
  cannons: number;
  lengthScale: number;
  hitRadius: number;

  heading = 0; // 旧版约定：forward = (sin, 0, cos)
  speed = 0;
  pitch = 0; // 浮力俯仰（平滑后），负 = 抬艏
  roll = 0; // 浮力横摇（平滑后），正 = 桅杆倒向右舷
  baseY = 0; // 基座模型设计水线即在 y=0，不再额外抬干舷

  sinking = false;
  sinkT = 0;
  sinkDir = 1;
  dead = false; // 沉船动画播完，可移除

  hurtT = 0; // 被玩家攻击后血条显示剩余秒数（Game 驱动）
  cid = 0; // 碰撞结算冷却用的配对 id（Game 分配）

  /** 各 debuff 剩余秒数。 */
  readonly debuff: Record<DebuffKind, number> = { fire: 0, leak: 0, sail: 0 };

  /** 部件血量（结构性毁损，本局内持久；修理桶可修）。 */
  readonly parts: ShipPart[] = [];
  /**
   * 桅杆毁损的视觉节点（程序化船的第一根桅杆；精致/glTF 模型为 null 只做数值）。
   * 由 Game/EnemyFleet 在外观生成后挂入。
   */
  mastVisual: THREE.Object3D | null = null;

  /** 活动范围：默认原点周围 WORLD_LIMIT；自定义海域时由 Game 改为区域中心。 */
  limitCX = 0;
  limitCZ = 0;
  limitR = WORLD_LIMIT;

  /** AI 附加状态（敌船用，玩家忽略）。 */
  orbitDir: 1 | -1 = 1;
  cooldown = 0;
  /** 敌船分型（玩家恒为 'warship'，不影响任何逻辑）。 */
  archetype: 'warship' | 'raider' | 'battleship' | 'merchant' = 'warship';
  /** 小地图上的点颜色。 */
  mapColor = '#e0483e';

  private readonly scratchForward = new THREE.Vector3();

  constructor(object: THREE.Object3D, opts: GameShipOptions) {
    this.object = object;
    this.object.rotation.order = 'YXZ';
    this.maxHp = opts.maxHp;
    this.hp = opts.maxHp;
    this.maxSpeed = opts.maxSpeed;
    this.turnRate = opts.turnRate;
    this.cannons = opts.cannons;
    this.lengthScale = opts.lengthScale;
    this.hitRadius = 3.4 * opts.lengthScale;
    for (const p of opts.parts ?? []) this.parts.push({ ...p, hp: p.maxHp });
  }

  get position(): THREE.Vector3 {
    return this.object.position;
  }

  get forward(): THREE.Vector3 {
    return this.scratchForward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /** 速度乘区（漏水 ×0.7、破帆 ×0.6、船桨毁损 ×0.5，乘法叠加）。 */
  get speedMul(): number {
    let m = 1;
    if (this.debuff.leak > 0) m *= DEBUFF_DEFS.leak.speedMul;
    if (this.debuff.sail > 0) m *= DEBUFF_DEFS.sail.speedMul;
    if (this.partDestroyed('oars')) m *= OARS_BROKEN_SPEED_MUL;
    return m;
  }

  /** 帆量上限（破帆压 50% 为临时；帆装毁损压 40% 为本局持久，取严）。 */
  get sailCap(): number {
    const partCap = this.partDestroyed('sails') ? SAILS_BROKEN_CAP : 1;
    const debuffCap = this.debuff.sail > 0 ? DEBUFF_DEFS.sail.maxSail : 1;
    return Math.min(partCap, debuffCap);
  }

  /** 舵效乘区（船舵毁损 ×0.35）。 */
  get turnMul(): number {
    return this.partDestroyed('rudder') ? RUDDER_BROKEN_TURN_MUL : 1;
  }

  /** 部件是否已毁损（无该部件 = false）。 */
  partDestroyed(kind: PartKind): boolean {
    const p = this.parts.find((x) => x.kind === kind);
    return p !== undefined && p.hp <= 0;
  }

  /**
   * 部位伤害：扣部件 HP，返回本击打毁的部件列表（含桅杆倒压帆装的连锁毁损）。
   * 部件不存在或已毁 → 返回空数组（调用方应把伤害全额转给船体）。
   */
  damagePart(kind: PartKind, dmg: number): ShipPart[] {
    const destroyed: ShipPart[] = [];
    const part = this.parts.find((x) => x.kind === kind);
    if (!part || part.hp <= 0) return destroyed;
    part.hp = Math.max(0, part.hp - dmg);
    if (part.hp > 0) return destroyed;
    destroyed.push(part);
    if (kind === 'mast') {
      // 桅杆倒下砸毁帆装：等效伤害 = 桅杆自身 maxHp
      const sails = this.parts.find((x) => x.kind === 'sails');
      if (sails && sails.hp > 0) {
        sails.hp = Math.max(0, sails.hp - part.maxHp);
        if (sails.hp === 0) destroyed.push(sails);
      }
      this.breakMastVisual();
    }
    return destroyed;
  }

  /** 修理桶：修复最破损（HP 比例最低）的部件 30% maxHp，返回被修的部件。 */
  repairWorstPart(frac = 0.3): ShipPart | null {
    let worst: ShipPart | null = null;
    for (const p of this.parts) {
      if (p.hp >= p.maxHp) continue;
      if (!worst || p.hp / p.maxHp < worst.hp / worst.maxHp) worst = p;
    }
    if (!worst) return null;
    const wasDead = worst.hp <= 0;
    worst.hp = Math.min(worst.maxHp, worst.hp + worst.maxHp * frac);
    if (wasDead && worst.hp > 0 && worst.kind === 'mast') this.restoreMastVisual();
    return worst;
  }

  /** 桅杆视觉：倾倒（程序化船），精致模型无节点只做数值。 */
  private breakMastVisual(): void {
    if (!this.mastVisual) return;
    this.mastVisual.rotation.z = 0.55;
    this.mastVisual.position.y -= 0.8;
  }

  private restoreMastVisual(): void {
    if (!this.mastVisual) return;
    this.mastVisual.rotation.z = 0;
    this.mastVisual.position.y += 0.8;
  }

  /** 命中后按概率独立判定 debuff，返回本次触发的 key 列表。skipFire：大雨灭火。 */
  rollDebuffs(skipFire = false): DebuffKind[] {
    const applied: DebuffKind[] = [];
    for (const key of Object.keys(DEBUFF_DEFS) as DebuffKind[]) {
      if (key === 'fire' && skipFire) continue;
      if (Math.random() < DEBUFF_DEFS[key].chance) {
        this.debuff[key] = DEBUFF_DEFS[key].duration; // 重复触发刷新时间
        applied.push(key);
      }
    }
    return applied;
  }

  startSinking(): void {
    if (this.sinking) return;
    this.sinking = true;
    this.sinkT = 0;
    this.sinkDir = Math.random() < 0.5 ? 1 : -1;
    this.debuff.fire = this.debuff.leak = this.debuff.sail = 0; // 沉船清除 debuff
  }

  /** 复位到可玩状态（R 重开）。 */
  revive(): void {
    this.hp = this.maxHp;
    this.sinking = false;
    this.sinkT = 0;
    this.dead = false;
    this.speed = 0;
    this.pitch = 0;
    this.roll = 0;
    this.hurtT = 0;
    this.debuff.fire = this.debuff.leak = this.debuff.sail = 0;
    for (const p of this.parts) p.hp = p.maxHp; // 部件一并修复
    this.restoreMastVisual();
    this.position.set(0, 0, 0);
    this.heading = 0;
    this.applyPose();
  }

  /** 返回 true = 这一击把船打沉了。 */
  takeDamage(dmg: number): boolean {
    if (this.sinking) return false;
    if (this.debuff.leak > 0) dmg *= DEBUFF_DEFS.leak.damageTakenMul; // 漏水易伤
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.hp = 0;
      this.startSinking();
      return true;
    }
    return false;
  }

  update(dt: number, heightAt: WaveHeightAt): void {
    const p = this.object.position;

    if (this.sinking) {
      // 沉船动画：倾斜 + 缓慢下沉 + 减速
      this.sinkT += dt;
      this.roll += dt * 0.35 * this.sinkDir;
      this.pitch += dt * 0.12;
      p.y -= dt * (0.5 + this.sinkT * 0.3);
      this.speed = Math.max(0, this.speed - dt * 4);
      this.applyMotion(dt);
      if (this.sinkT > 5) this.dead = true;
      return;
    }

    // ---- debuff 计时（着火持续掉血，可致命） ----
    if (this.debuff.fire > 0) {
      this.debuff.fire -= dt;
      this.hp -= DEBUFF_DEFS.fire.dps * dt;
      if (this.hp <= 0) {
        this.hp = 0;
        this.startSinking();
        return;
      }
    }
    if (this.debuff.leak > 0) this.debuff.leak -= dt;
    if (this.debuff.sail > 0) this.debuff.sail -= dt;

    // ---- 浮力：采样船头/船尾/左舷/右舷四点波高（随船长缩放） ----
    const ls = this.lengthScale;
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const hBow = heightAt(p.x + sinH * 3.5 * ls, p.z + cosH * 3.5 * ls);
    const hStern = heightAt(p.x - sinH * 3.5 * ls, p.z - cosH * 3.5 * ls);
    const hPort = heightAt(p.x - cosH * 2.0 * ls, p.z + sinH * 2.0 * ls);
    const hStar = heightAt(p.x + cosH * 2.0 * ls, p.z - sinH * 2.0 * ls);

    const avgH = (hBow + hStern + hPort + hStar) / 4;
    const peakH = Math.max(hBow, hStern, hPort, hStar);
    // 以波峰为主要参考抬高船体：风浪大时船"骑"在浪上，避免波峰穿模透过甲板
    const targetY = avgH * 0.35 + peakH * 0.65 + this.baseY;
    // 俯仰/横摇限幅，防止船头扎浪、船身侧倾过深导致甲板没水
    const targetPitch = THREE.MathUtils.clamp(Math.atan2(hStern - hBow, 7.0 * ls), -0.15, 0.15);
    const targetRoll = THREE.MathUtils.clamp(Math.atan2(hStar - hPort, 4.0 * ls), -0.18, 0.18);

    // 平滑插值，漂浮感
    const k = 1 - Math.exp(-3 * dt);
    p.y += (targetY - p.y) * k;
    this.pitch += (targetPitch - this.pitch) * k;
    this.roll += (targetRoll - this.roll) * k;

    this.applyMotion(dt);
  }

  /** 位移 + 姿态应用（普通与沉船状态共用）。 */
  private applyMotion(dt: number): void {
    const p = this.object.position;
    p.x += Math.sin(this.heading) * this.speed * dt;
    p.z += Math.cos(this.heading) * this.speed * dt;

    // 限制活动范围
    const rx = p.x - this.limitCX;
    const rz = p.z - this.limitCZ;
    const r = Math.hypot(rx, rz);
    if (r > this.limitR) {
      p.x = this.limitCX + (rx * this.limitR) / r;
      p.z = this.limitCZ + (rz * this.limitR) / r;
    }

    this.applyPose();
  }

  /** 旧版 heading/pitch/roll → 基座 +X 船头模型的欧拉角，换算见文件头注释。 */
  private applyPose(): void {
    this.object.rotation.set(this.roll, this.heading - Math.PI / 2, -this.pitch);
  }

  /** 朝目标角度转向，返回剩余角差。 */
  turnToward(targetHeading: number, dt: number, rateScale = 1): number {
    let diff = targetHeading - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const maxTurn = this.turnRate * rateScale * this.turnMul * dt;
    this.heading += THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);
    return diff;
  }
}
