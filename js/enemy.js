// 敌方 AI 船队：远处生成、接近、环绕、舷侧齐射；被击沉后延迟补充，难度随波次提升
import * as THREE from 'three';
import { Ship } from './ship.js';

const ENEMY_HULL = 0x3a3f4a; // 深灰船体
const ENEMY_SAIL = 0x9e3030; // 暗红帆，辨识度

export class EnemyFleet {
  constructor(scene, combat) {
    this.scene = scene;
    this.combat = combat;
    this.enemies = [];        // 存活或正在下沉的敌船
    this.respawnTimers = [];  // 待补充的倒计时
    this.wave = 1;
    this.killsThisWave = 0;
    this.visualFactory = null; // 真实模型外观工厂（加载完成后由 main 注入）
    this.enemyTint = null;
  }

  get targetCount() {
    return Math.min(2 + (this.wave - 1), 6);
  }

  spawnOne(playerPos) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 150 + Math.random() * 90;
    const ship = new Ship(this.scene, {
      hullColor: ENEMY_HULL,
      sailColor: ENEMY_SAIL,
      hp: 50 + this.wave * 15,
      maxSpeed: 6.5 + this.wave * 0.4,
      turnRate: 0.55,
    });
    ship.position.set(playerPos.x + Math.cos(angle) * dist, 0, playerPos.z + Math.sin(angle) * dist);
    ship.heading = angle + Math.PI; // 大致朝玩家
    ship.orbitDir = Math.random() < 0.5 ? 1 : -1; // 环绕方向
    ship.cooldown = 2 + Math.random() * 3;
    // 真实模型可用则直接换装（染色版）
    if (this.visualFactory) {
      const v = this.visualFactory(this.enemyTint);
      ship.setVisual(v.group, v.setSailAmount);
    }
    this.enemies.push(ship);
  }

  /**
   * @param {Ship} player
   * @param {object} hooks { onEnemySunk(ship), onWaveUp(wave) }
   */
  update(dt, time, player, waveFn, hooks) {
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
      e.update(dt, time, waveFn);

      // 沉船动画播完：移除 + 计数 + 升波
      if (e.dead) {
        this.scene.remove(e.group);
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
      if (player.sinking) { e.speed = Math.max(0, e.speed - dt * 2); continue; }

      const toP = new THREE.Vector3().subVectors(pp, e.position);
      const dist = toP.length();
      const angleToP = Math.atan2(toP.x, toP.z);

      // 期望航向：远则接近，近则环绕；太近则稍微拉开
      let desired;
      if (dist > 55) {
        desired = angleToP;
      } else if (dist < 26) {
        desired = angleToP + e.orbitDir * Math.PI * 0.75;
      } else {
        desired = angleToP + e.orbitDir * Math.PI * 0.5;
      }
      e.turnToward(desired, dt);
      const targetSpeed = dist > 20 ? e.maxSpeed : e.maxSpeed * 0.55;
      e.speed += (targetSpeed - e.speed) * Math.min(1, dt * 1.5);

      // 开火：舷侧大致对准玩家且进入射程
      e.cooldown -= dt;
      if (e.cooldown <= 0 && dist < 52) {
        const starboard = new THREE.Vector3(Math.cos(e.heading), 0, -Math.sin(e.heading));
        const dot = starboard.dot(toP.clone().normalize());
        if (Math.abs(dot) > 0.72) {
          // 精度一般：散布大、无提前量，给玩家躲避空间
          this.combat.fireBroadside(e, dot > 0 ? 1 : -1, {
            count: 3, speed: 26, spread: 0.14, fromPlayer: false,
          });
          e.cooldown = 4.5 + Math.random() * 2.5;
        } else {
          e.cooldown = 0.5; // 没对准就稍后再试
        }
      }
    }
  }

  // 重开一局时清空
  reset() {
    for (const e of this.enemies) this.scene.remove(e.group);
    this.enemies = [];
    this.respawnTimers = [];
    this.wave = 1;
    this.killsThisWave = 0;
  }
}
