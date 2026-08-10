/**
 * 敌方 AI 船队：远处生成、接近、环绕、舷侧齐射；被击沉后延迟补充，难度随波次提升。
 * 移植自旧 js/enemy.js。
 *
 * 阶段 B2：外观从基座 glTF 克隆换成 Shipyard 程序化生成——从中大型船 spec 池
 * 随机取材，深色船体 + 暗红帆区分敌我；同步生成，没有异步加载窗口。
 */

import * as THREE from 'three/webgpu';
import { GameShip, type WaveHeightAt } from './GameShip';
import { buildShip, getShipDef, BASE_LENGTH } from './Shipyard';
import type { Combat } from './Combat';

const ENEMY_HULL = 0x3a3f4a; // 深灰船体
const ENEMY_SAIL = 0x9e3030; // 暗红帆，辨识度

/** 敌船可用的中大型船池（SHIP_DEFS id）。 */
const ENEMY_POOL = [9, 10, 11, 15, 20];

export interface FleetHooks {
  onEnemySunk(ship: GameShip): void;
  onWaveUp(wave: number): void;
}

/** 程序化船是 +Z 船头，转到 GameShip 容器（+X 船头约定）下要 yaw +π/2。 */
function wrapEnemyVisual(spec: (typeof ENEMY_POOL)[number]): THREE.Group {
  const def = getShipDef(spec);
  const visual = buildShip(def.spec, { hullColor: ENEMY_HULL, sailColor: ENEMY_SAIL });
  visual.setSailAmount(0.9); // 敌船恒近满帆
  const container = new THREE.Group();
  visual.group.rotation.y = Math.PI / 2;
  container.add(visual.group);
  return container;
}

export class EnemyFleet {
  readonly enemies: GameShip[] = [];
  wave = 1;
  killsThisWave = 0;

  private readonly scene: THREE.Scene;
  private readonly combat: Combat;
  private readonly respawnTimers: number[] = [];

  constructor(scene: THREE.Scene, combat: Combat) {
    this.scene = scene;
    this.combat = combat;
  }

  get targetCount(): number {
    return Math.min(2 + (this.wave - 1), 6);
  }

  spawnOne(playerPos: THREE.Vector3): void {
    const angle = Math.random() * Math.PI * 2;
    const dist = 150 + Math.random() * 90;
    const defId = ENEMY_POOL[Math.floor(Math.random() * ENEMY_POOL.length)];
    const def = getShipDef(defId);
    const lengthScale = def.spec.length / BASE_LENGTH;

    const ship = new GameShip(wrapEnemyVisual(defId), {
      maxHp: 50 + this.wave * 15,
      maxSpeed: 6.5 + this.wave * 0.4,
      turnRate: 0.55,
      cannons: 3,
      lengthScale,
    });
    // 程序化船体的吃水：比旧版略抬，防大浪穿模透过甲板
    ship.baseY = 0.55 * lengthScale;
    ship.position.set(
      playerPos.x + Math.cos(angle) * dist,
      0,
      playerPos.z + Math.sin(angle) * dist,
    );
    ship.heading = angle + Math.PI; // 大致朝玩家
    ship.orbitDir = Math.random() < 0.5 ? 1 : -1;
    ship.cooldown = 2 + Math.random() * 3;
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
    const aliveCount = this.enemies.filter((e) => !e.sinking).length;
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

      const toP = new THREE.Vector3().subVectors(pp, e.position);
      const dist = toP.length();
      const angleToP = Math.atan2(toP.x, toP.z);

      // 期望航向：远则接近，近则环绕；太近则稍微拉开
      let desired: number;
      if (dist > 55) {
        desired = angleToP;
      } else if (dist < 26) {
        desired = angleToP + e.orbitDir * Math.PI * 0.75;
      } else {
        desired = angleToP + e.orbitDir * Math.PI * 0.5;
      }
      e.turnToward(desired, dt);
      const targetSpeed = (dist > 20 ? e.maxSpeed : e.maxSpeed * 0.55) * e.speedMul;
      e.speed += (targetSpeed - e.speed) * Math.min(1, dt * 1.5);

      // 开火：舷侧大致对准玩家且进入射程
      e.cooldown -= dt;
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
