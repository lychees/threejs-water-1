/**
 * 漂浮补给：木桶修船（+10 HP）、宝箱记战利品。移植自旧 js/world.js 的补给段，
 * 模型用基座 public/models/dressing/ 下的木桶与宝箱，波面起伏走 OceanSampler。
 *
 * 设计：固定数量在玩家周围巡航半径内随机撒布，拾取后延迟在别处重刷，
 * 保证海上始终有点可追。不看岛屿碰撞（B3 接 Props 的海岸线再避让它）。
 */

import * as THREE from 'three/webgpu';
import type { AssetLoader } from '../scene/AssetLoader';
import type { GameShip, WaveHeightAt } from './GameShip';

const BARREL_URL = '/models/dressing/wooden_barrels_01.glb';
const CHEST_URL = '/models/dressing/treasure_chest.glb';

const SUPPLY_COUNT = 8; // 同时在场的补给数
const SPAWN_MIN = 80; // 距玩家最近/最远撒布半径
const SPAWN_MAX = 350;
const PICKUP_RADIUS = 8; // 拾取半径（27m 船体）
const RESPAWN_SECONDS = 25; // 被拾取后重刷延迟
const REPAIR_AMOUNT = 10;

export type SupplyKind = 'repair' | 'loot';

export interface Supply {
  kind: SupplyKind;
  object: THREE.Object3D;
  active: boolean;
  respawnIn: number; // 剩余重刷秒数（active 时无意义）
  phase: number; // 起伏相位
}

export interface PickupEvent {
  kind: SupplyKind;
  position: THREE.Vector3;
}

export class Supplies {
  readonly items: Supply[] = [];

  private constructor(
    scene: THREE.Scene,
    private readonly heightAt: WaveHeightAt,
    private readonly player: GameShip,
    barrelTemplate: THREE.Object3D,
    chestTemplate: THREE.Object3D,
    private readonly isWater: ((x: number, z: number) => boolean) | null,
  ) {
    for (let i = 0; i < SUPPLY_COUNT; i++) {
      const kind: SupplyKind = i % 3 === 2 ? 'loot' : 'repair'; // 约 1/3 宝箱
      const template = kind === 'loot' ? chestTemplate : barrelTemplate;
      const object = template.clone(true);
      object.scale.setScalar(kind === 'loot' ? 1.6 : 1.4); // 模型 ~1m，放大到海面上可读
      const item: Supply = {
        kind,
        object,
        active: true,
        respawnIn: 0,
        phase: Math.random() * Math.PI * 2,
      };
      this.place(item, this.player.position, true);
      scene.add(object);
      this.items.push(item);
    }
  }

  /** 模型加载失败（任一）则补给系统整体缺席，与基座"特性独立失败"的约定一致。 */
  static async load(
    scene: THREE.Scene,
    assets: AssetLoader,
    heightAt: WaveHeightAt,
    player: GameShip,
    /** 可选：自定义海域的水域判定（落点必须在水里）。 */
    isWater: ((x: number, z: number) => boolean) | null = null,
  ): Promise<Supplies | null> {
    try {
      const [barrel, chest] = await Promise.all([
        assets.load(BARREL_URL),
        assets.load(CHEST_URL),
      ]);
      return new Supplies(scene, heightAt, player, barrel, chest, isWater);
    } catch (error) {
      console.error('[game] supplies failed to load', error);
      return null;
    }
  }

  private place(item: Supply, around: THREE.Vector3, initial = false): void {
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
      const x = around.x + Math.cos(angle) * dist;
      const z = around.z + Math.sin(angle) * dist;
      if (this.isWater && !this.isWater(x, z)) continue; // 自定义海域：只撒在水里
      item.object.position.set(x, 0, z);
      item.object.rotation.y = Math.random() * Math.PI * 2;
      item.active = true;
      item.respawnIn = 0;
      item.object.visible = true;
      if (!initial) item.phase = Math.random() * Math.PI * 2;
      return;
    }
    // 8 次都落在岸上：贴着玩家附近总能找到水——放远点就行，下次重刷再随机
    item.object.position.set(around.x + SPAWN_MIN, 0, around.z);
    item.active = true;
    item.respawnIn = 0;
    item.object.visible = true;
  }

  /** 每帧：起伏 + 拾取判定 + 重刷。onPickup 只在真正拾取时触发。 */
  update(dt: number, time: number, onPickup: (event: PickupEvent) => void): void {
    const pp = this.player.position;
    for (const item of this.items) {
      if (!item.active) {
        item.respawnIn -= dt;
        if (item.respawnIn <= 0) this.place(item, pp);
        continue;
      }
      const p = item.object.position;
      p.y = this.heightAt(p.x, p.z) + 0.15 + Math.sin(time * 1.3 + item.phase) * 0.12;
      item.object.rotation.y += dt * 0.25;

      if (this.player.sinking) continue;
      const dx = p.x - pp.x;
      const dz = p.z - pp.z;
      if (dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS) {
        item.active = false;
        item.object.visible = false;
        item.respawnIn = RESPAWN_SECONDS;
        onPickup({ kind: item.kind, position: p.clone() });
      }
    }
  }

  get repairAmount(): number {
    return REPAIR_AMOUNT;
  }
}
