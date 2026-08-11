/**
 * 岸防炮：近岸高地的固定炮位，敌对、只打玩家。
 *
 * 选点：陆地高度 3~14m 且 60m 内有水的位置，间距 ≥300m，自定义海域 4 个；
 * 默认迷雾岛可达陆地只有沙嘴尖一小条，通常只能放下 1 个。
 * 模型：Poly Haven cannon_01（CC0，AssetLoader 加载）+ 程序化石台；模型加载
 * 失败退程序化低模炮（圆柱炮管 + 轮子盒），炮位功能不依赖模型。
 *
 * 行为：玩家进 150m → 每 6~10s 一发抛物线炮弹（带 ×0.7 线性提前量、散布大），
 * 弹道/水花/命中都复用 Combat。可被玩家炮弹摧毁（HP 80）：大爆炸 + 掉 1~2 个
 * 漂浮补给箱。R 重开复位。
 */

import * as THREE from 'three/webgpu';
import type { AssetLoader } from '../scene/AssetLoader';
import type { GameShip } from './GameShip';
import type { Combat } from './Combat';
import type { GroundSampler } from './Towns';

const CANNON_URL = '/models/coast/cannon_01/cannon_01_1k.gltf';

const BATTERY_HP = 80;
const FIRE_RANGE = 150;
const RELOAD_MIN = 6;
const RELOAD_SPAN = 4;
const SHOT_SPEED = 26; // 水平初速基准（决定飞行时间）
const LEAD_FACTOR = 0.7; // 提前量折扣（满提前量太准）
const SPREAD = 0.16; // 角散布（弧度，刻意不准）

/** 炮位在 Combat 命中体系里的包装（GameShip 鸭子类型子集）。 */
export class BatteryBody {
  heading = 0;
  speed = 0;
  pitch = 0;
  roll = 0;
  sinking = false; // 摧毁后 = true（Combat 不再命中它）
  dead = false;
  hurtT = 0;
  cid = 0;
  hitRadius = 3.2;
  lengthScale = 1;
  hp: number = BATTERY_HP;
  readonly maxHp = BATTERY_HP;
  readonly debuff = { fire: 0, leak: 0, sail: 0 };
  archetype: 'warship' = 'warship';
  mapColor = '#c03028';

  constructor(readonly object: THREE.Object3D) {}

  get position(): THREE.Vector3 {
    return this.object.position;
  }

  takeDamage(dmg: number): boolean {
    if (this.sinking) return false;
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.hp = 0;
      this.sinking = true;
      return true;
    }
    return false;
  }

  revive(): void {
    this.hp = this.maxHp;
    this.sinking = false;
    this.dead = false;
  }

  /** Game.onHit 对所有目标调 rollDebuffs；固定炮位不吃 debuff。 */
  rollDebuffs(): string[] {
    return [];
  }
}

export interface Battery {
  body: BatteryBody;
  cooldown: number;
  destroyed: boolean;
}

export class ShoreBatteries {
  readonly object = new THREE.Group();
  readonly batteries: Battery[] = [];

  private constructor(private readonly combat: Combat) {
    this.object.name = 'shore-batteries';
  }

  /**
   * 选点 + 布台（模型异步换装）。返回 null 表示找不到合适岸位（全图没陆地）。
   */
  static async deploy(
    scene: THREE.Scene,
    assets: AssetLoader,
    combat: Combat,
    ground: GroundSampler,
    center: { x: number; z: number },
    searchRadius: number,
    count: number,
  ): Promise<ShoreBatteries | null> {
    // ---- 选点：近岸高地候选（默认海域可达陆地只是一小条沙嘴尖，多撒些点） ----
    const spots: THREE.Vector3[] = [];
    for (let i = 0; i < 4000 && spots.length < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * searchRadius;
      const x = center.x + Math.cos(a) * r;
      const z = center.z + Math.sin(a) * r;
      const h = ground.height(x, z);
      if (h < 3 || h > 14) continue;
      const nearWater =
        ground.height(x + 60, z) < 0 ||
        ground.height(x - 60, z) < 0 ||
        ground.height(x, z + 60) < 0 ||
        ground.height(x, z - 60) < 0;
      if (!nearWater) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 300)) continue;
      spots.push(new THREE.Vector3(x, h, z));
    }
    if (spots.length === 0) return null;

    const batteries = new ShoreBatteries(combat);

    // 模型一次加载（失败 null → 程序化炮）
    let cannonTemplate: THREE.Object3D | null = null;
    try {
      cannonTemplate = await assets.load(CANNON_URL);
    } catch {
      cannonTemplate = null;
    }

    for (const spot of spots) {
      const group = new THREE.Group();
      group.position.copy(spot);
      // 石台
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(3.4, 4.0, 1.6, 8),
        new THREE.MeshStandardMaterial({ color: 0x7a756c, roughness: 0.95, flatShading: true }),
      );
      base.position.y = 0.4;
      base.castShadow = true;
      group.add(base);

      if (cannonTemplate) {
        const cannon = cannonTemplate.clone(true);
        // 归一化到 ~2.2m 长，立在石台上
        const box = new THREE.Box3().setFromObject(cannon);
        const size = box.getSize(new THREE.Vector3());
        const s = 2.2 / Math.max(size.x, size.y, size.z);
        cannon.scale.setScalar(s);
        const box2 = new THREE.Box3().setFromObject(cannon);
        const ctr = box2.getCenter(new THREE.Vector3());
        cannon.position.sub(ctr).y += 1.2 + (box2.max.y - box2.min.y) / 2 - (box2.max.y - ctr.y);
        group.add(cannon);
      } else {
        // 程序化低模炮：炮管 + 双轮
        const barrel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 0.3, 2.4, 8),
          new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 }),
        );
        barrel.rotation.z = Math.PI / 2 - 0.12;
        barrel.position.y = 1.6;
        group.add(barrel);
        for (const side of [-1, 1]) {
          const wheel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.55, 0.55, 0.18, 10),
            new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9 }),
          );
          wheel.rotation.x = Math.PI / 2;
          wheel.position.set(-0.3, 1.0, side * 0.7);
          group.add(wheel);
        }
      }

      const body = new BatteryBody(group);
      batteries.batteries.push({
        body,
        cooldown: RELOAD_MIN + Math.random() * RELOAD_SPAN,
        destroyed: false,
      });
      batteries.object.add(group);
    }

    scene.add(batteries.object);
    return batteries;
  }

  /**
   * 每帧：冷却 + 射程内开火（带提前量）。返回的是 Combat 的命中目标适配数组。
   */
  update(dt: number, player: GameShip): void {
    if (player.sinking) return;
    for (const b of this.batteries) {
      if (b.destroyed) continue;
      b.cooldown -= dt;
      if (b.cooldown > 0) continue;
      const dist = b.body.position.distanceTo(player.position);
      if (dist > FIRE_RANGE) {
        b.cooldown = 1.5; // 射程外低频重查
        continue;
      }
      b.cooldown = RELOAD_MIN + Math.random() * RELOAD_SPAN;
      // 提前量：玩家速度方向线性预判 ×0.7
      const tof = dist / SHOT_SPEED;
      const fwd = player.forward;
      const aimX = player.position.x + fwd.x * player.speed * tof * LEAD_FACTOR;
      const aimZ = player.position.z + fwd.z * player.speed * tof * LEAD_FACTOR;
      this.combat.fireBatteryShot(b.body.position, aimX, aimZ, tof, SPREAD);
    }
  }

  /** 击毁结算：大爆炸 + 标记，返回 true 表示本次击毁。 */
  destroy(b: Battery): void {
    b.destroyed = true;
    b.body.object.visible = false; // 残骸留石台太细——先整体隐藏
    this.combat.explosion(b.body.position.clone().add(new THREE.Vector3(0, 2, 0)));
    this.combat.explosion(b.body.position.clone().add(new THREE.Vector3(0, 4, 0)));
  }

  /** R 重开复位。 */
  reset(): void {
    for (const b of this.batteries) {
      b.destroyed = false;
      b.body.revive();
      b.body.object.visible = true;
      b.cooldown = RELOAD_MIN + Math.random() * RELOAD_SPAN;
    }
  }
}
