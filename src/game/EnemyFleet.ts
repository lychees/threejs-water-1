/**
 * 敌方 AI 船队：远处生成、接近、环绕、舷侧齐射；被击沉后延迟补充，难度随波次提升。
 * 移植自旧 js/enemy.js。外观用基座的船模（scene/Ship.load 的独立克隆），
 * 材质克隆后乘暗红色区分敌我——loader 的材质是共享缓存，直接改会连玩家船一起染色。
 */

import * as THREE from 'three/webgpu';
import { Ship } from '../scene/Ship';
import type { AssetLoader } from '../scene/AssetLoader';
import type { GameShip as GameShipType, WaveHeightAt } from './GameShip';
import { GameShip } from './GameShip';
import type { Combat } from './Combat';

/** 基座船模归一化到 27m，旧版基准船长 9m。 */
const LENGTH_SCALE = 27 / 9;

/** 敌船染色：帆乘暗红（辨识度），其余略微压暗。 */
const SAIL_TINT = new THREE.Color(1.0, 0.42, 0.42);
const HULL_TINT = new THREE.Color(0.72, 0.68, 0.72);

export interface FleetHooks {
  onEnemySunk(ship: GameShipType): void;
  onWaveUp(wave: number): void;
}

function tintEnemy(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const name = `${mesh.name} ${mesh.parent?.name ?? ''}`.toLowerCase();
    const tint = name.includes('sail') ? SAIL_TINT : HULL_TINT;
    const tintOne = (m: THREE.Material): THREE.Material => {
      const cloned = m.clone();
      const colored = cloned as THREE.Material & { color?: THREE.Color };
      if (colored.color) colored.color.multiply(tint);
      return cloned;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tintOne) : tintOne(mesh.material);
  });
}

export class EnemyFleet {
  readonly enemies: GameShip[] = [];
  wave = 1;
  killsThisWave = 0;

  private readonly scene: THREE.Scene;
  private readonly assets: AssetLoader;
  private readonly combat: Combat;
  private readonly respawnTimers: number[] = [];

  constructor(scene: THREE.Scene, assets: AssetLoader, combat: Combat) {
    this.scene = scene;
    this.assets = assets;
    this.combat = combat;
  }

  get targetCount(): number {
    return Math.min(2 + (this.wave - 1), 6);
  }

  /** 异步生成：模型经 loader 缓存，首次之后基本即时。 */
  spawnOne(playerPos: THREE.Vector3): void {
    const angle = Math.random() * Math.PI * 2;
    const dist = 150 + Math.random() * 90;
    const wave = this.wave;
    void Ship.load(this.assets)
      .then((visual) => {
        tintEnemy(visual.object);
        const ship = new GameShip(visual.object, {
          maxHp: 50 + wave * 15,
          maxSpeed: 6.5 + wave * 0.4,
          turnRate: 0.55,
          cannons: 3,
          lengthScale: LENGTH_SCALE,
        });
        ship.position.set(
          playerPos.x + Math.cos(angle) * dist,
          0,
          playerPos.z + Math.sin(angle) * dist,
        );
        ship.heading = angle + Math.PI; // 大致朝玩家
        this.scene.add(visual.object);
        // AI 附加状态挂在实体上
        ship.orbitDir = Math.random() < 0.5 ? 1 : -1;
        ship.cooldown = 2 + Math.random() * 3;
        ship.visual = visual;
        this.enemies.push(ship);
      })
      .catch((error: unknown) => {
        console.error('[game] enemy ship failed to load', error);
      });
  }

  update(
    dt: number,
    player: GameShip,
    heightAt: WaveHeightAt,
    hooks: FleetHooks,
  ): void {
    // ---- 补充新船 ----
    for (let i = this.respawnTimers.length - 1; i >= 0; i--) {
      this.respawnTimers[i] -= dt;
      if (this.respawnTimers[i] <= 0) {
        this.respawnTimers.splice(i, 1);
        this.spawnOne(player.position);
      }
    }
    const aliveCount = this.enemies.filter((e) => !e.sinking).length;
    if (aliveCount + this.respawnTimers.length < this.targetCount) {
      this.respawnTimers.push(5 + Math.random() * 4);
    }

    // ---- 每艘船的 AI ----
    const pp = player.position;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.update(dt, heightAt);
      e.visual?.update(dt); // 帆面鼓动

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

      const toP = new THREE.Vector3().subVectors(pp, e.position);
      const dist = toP.length();
      const angleToP = Math.atan2(toP.x, toP.z);

      // 期望航向：远则接近，近则环绕；太近则稍微拉开
      let desired: number;
      if (dist > 55) {
        desired = angleToP;
      } else if (dist < 26) {
        desired = angleToP + (e.orbitDir ?? 1) * Math.PI * 0.75;
      } else {
        desired = angleToP + (e.orbitDir ?? 1) * Math.PI * 0.5;
      }
      e.turnToward(desired, dt);
      const targetSpeed = dist > 20 ? e.maxSpeed : e.maxSpeed * 0.55;
      e.speed += (targetSpeed - e.speed) * Math.min(1, dt * 1.5);

      // 开火：舷侧大致对准玩家且进入射程
      e.cooldown = (e.cooldown ?? 0) - dt;
      if (e.cooldown <= 0 && dist < 52) {
        const starboard = new THREE.Vector3(-Math.cos(e.heading), 0, Math.sin(e.heading)); // 与 Combat 舷侧约定一致
        const dot = starboard.dot(toP.clone().normalize());
        if (Math.abs(dot) > 0.72) {
          // 精度一般：散布大、无提前量，给玩家躲避空间
          this.combat.fireBroadside(e, dot > 0 ? 1 : -1, {
            count: 3,
            speed: 26,
            spread: 0.14,
            fromPlayer: false,
          });
          e.cooldown = 4.5 + Math.random() * 2.5;
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
