/**
 * 战斗：炮弹（抛物线弹道）、粒子（水花/硝烟/爆炸/气泡）、环形波纹、命中判定。
 * 移植自旧 js/combat.js，改动只有两处：
 *  - 波高函数换成基座 OceanSampler 的同步采样（不再需要 time 参数）；
 *  - 目标类型换成 GameShip。
 */

import * as THREE from 'three/webgpu';
import type { GameShip, WaveHeightAt } from './GameShip';

const BALL_GRAVITY = 18; // 炮弹重力（比真实大，手感更 arcade）
export { BALL_GRAVITY }; // 弹道预览与命中判定共用
const HIT_RADIUS = 3.4; // 基准船体命中半径（船长 9m 基准，大船按 lengthScale 放大）

export interface HitTarget {
  ship: GameShip;
  isPlayer: boolean;
}

export interface Cannonball {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  fromPlayer: boolean;
  life: number;
  damageMul: number;
}

export type HitHandler = (ball: Cannonball, target: HitTarget) => void;

// ---- 一次性粒子簇 ----
class Burst {
  private readonly points: THREE.Points;
  private readonly velocities: THREE.Vector3[] = [];
  private readonly scene: THREE.Scene;
  private readonly gravity: number;
  private readonly life: number;
  private age = 0;

  constructor(
    scene: THREE.Scene,
    origin: THREE.Vector3,
    opts: {
      count: number;
      color: number;
      speed: number;
      up: number;
      life: number;
      size: number;
      gravity: number;
    },
  ) {
    this.life = opts.life;
    this.gravity = opts.gravity;
    const positions = new Float32Array(opts.count * 3);
    for (let i = 0; i < opts.count; i++) {
      positions[i * 3] = origin.x;
      positions[i * 3 + 1] = origin.y;
      positions[i * 3 + 2] = origin.z;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * opts.speed;
      this.velocities.push(
        new THREE.Vector3(
          Math.cos(a) * r,
          opts.up * (0.4 + Math.random() * 0.9),
          Math.sin(a) * r,
        ),
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: opts.color,
        size: opts.size,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      }),
    );
    scene.add(this.points);
    this.scene = scene;
  }

  update(dt: number): boolean {
    this.age += dt;
    const pos = this.points.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < this.velocities.length; i++) {
      const v = this.velocities[i];
      v.y -= this.gravity * dt;
      pos.setXYZ(i, pos.getX(i) + v.x * dt, pos.getY(i) + v.y * dt, pos.getZ(i) + v.z * dt);
    }
    pos.needsUpdate = true;
    (this.points.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - this.age / this.life);
    if (this.age >= this.life) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      (this.points.material as THREE.Material).dispose();
      return false;
    }
    return true;
  }
}

// ---- 落水环形波纹 ----
class Ring {
  private readonly mesh: THREE.Mesh;
  private readonly scene: THREE.Scene;
  private age = 0;

  constructor(scene: THREE.Scene, pos: THREE.Vector3) {
    this.mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1.0, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.copy(pos);
    scene.add(this.mesh);
    this.scene = scene;
  }

  update(dt: number): boolean {
    this.age += dt;
    const s = 1 + this.age * 7;
    this.mesh.scale.setScalar(s);
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.7 - this.age * 0.9);
    if (((this.mesh.material as THREE.MeshBasicMaterial).opacity ?? 0) <= 0) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      return false;
    }
    return true;
  }
}

export class Combat {
  particleScale = 1; // 画质档位缩放粒子数量
  onSplash: (() => void) | null = null; // 落水音效钩子

  private readonly scene: THREE.Scene;
  private readonly heightAt: WaveHeightAt;
  private readonly balls: Cannonball[] = [];
  private bursts: Burst[] = [];
  private rings: Ring[] = [];
  private readonly ballGeo = new THREE.SphereGeometry(0.24, 6, 5);
  private readonly ballMat = new THREE.MeshBasicMaterial({ color: 0x1c1c1c });

  constructor(scene: THREE.Scene, heightAt: WaveHeightAt) {
    this.scene = scene;
    this.heightAt = heightAt;
  }

  /** 按画质档位缩放粒子数。 */
  private n(count: number): number {
    return Math.max(3, Math.round(count * this.particleScale));
  }

  /** 舷侧齐射。side: -1 左舷 / +1 右舷。vy 为上抛初速（射角，默认 5.5 旧手感）。
   *  azimuth 水平射角（弧度，正 = 偏向船头扫射）。 */
  fireBroadside(
    ship: GameShip,
    side: -1 | 1,
    opts: {
      count?: number;
      speed?: number;
      spread?: number;
      fromPlayer?: boolean;
      damageMul?: number;
      vy?: number;
      azimuth?: number;
    } = {},
  ): void {
    const {
      count = ship.cannons ?? 3,
      speed = 30,
      spread = 0.06,
      fromPlayer = true,
      damageMul = 1,
      vy = 5.5,
      azimuth = 0,
    } = opts;
    // 舷侧方向：右舷 = (-cos h, 0, sin h)（旧版约定，与 GameShip.heading 同源）；
    // 水平射角：dirAng 空间里 side×azimuth 即"朝船头偏转"（左舷基角 π/2、右舷 -π/2）
    const baseAng = Math.atan2(-side * Math.cos(ship.heading), side * Math.sin(ship.heading));
    const ang = baseAng + side * azimuth;
    const dir = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang));
    const fwd = ship.forward;

    for (let i = 0; i < count; i++) {
      const along = (i - (count - 1) / 2) * 2.0; // 沿船身排开
      const start = ship.position.clone().addScaledVector(fwd, along).addScaledVector(dir, 1.5);
      start.y += 1.3;

      const vel = dir.clone().multiplyScalar(speed * (0.95 + Math.random() * 0.1));
      // 少量散布 + 上抛形成抛物线
      vel.x += (Math.random() - 0.5) * speed * spread * 2;
      vel.z += (Math.random() - 0.5) * speed * spread * 2;
      vel.y = vy * (0.9 + Math.random() * 0.27); // 上抛（射角）带少量散布

      const mesh = new THREE.Mesh(this.ballGeo, this.ballMat);
      mesh.position.copy(start);
      this.scene.add(mesh);
      this.balls.push({ mesh, vel, fromPlayer, life: 6, damageMul });

      // 炮口硝烟
      this.bursts.push(
        new Burst(this.scene, start, {
          count: this.n(8),
          color: 0xcccccc,
          speed: 1.5,
          up: 1.5,
          life: 0.9,
          size: 1.6,
          gravity: -0.5,
        }),
      );
    }
  }

  /** 艏炮：朝船头单发，弹道平直、初速略高（玩家专用）。vy 默认 2.5 低平弹道；azimuth 水平射角（弧度，正=偏右舷侧）。 */
  fireBowShot(ship: GameShip, opts: { speed?: number; damageMul?: number; vy?: number; azimuth?: number } = {}): void {
    const { speed = 36, damageMul = 1, vy = 2.5, azimuth = 0 } = opts;
    const ang = ship.heading - azimuth; // 正 azimuth（鼠标右移）= 向右舷侧偏转
    const fwd = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang));
    const start = ship.position.clone().addScaledVector(fwd, 4.2 * (ship.lengthScale || 1));
    start.y += 1.4;
    const vel = fwd.multiplyScalar(speed);
    vel.y = vy;
    const mesh = new THREE.Mesh(this.ballGeo, this.ballMat);
    mesh.position.copy(start);
    this.scene.add(mesh);
    this.balls.push({ mesh, vel, fromPlayer: true, life: 6, damageMul });
    this.bursts.push(
      new Burst(this.scene, start, {
        count: this.n(8),
        color: 0xcccccc,
        speed: 1.5,
        up: 1.5,
        life: 0.9,
        size: 1.6,
        gravity: -0.5,
      }),
    );
  }

  /** 着火持续火焰（debuff 视觉）：火舌 + 黑烟。 */
  firePuff(pos: THREE.Vector3): void {
    this.bursts.push(
      new Burst(this.scene, pos, {
        count: this.n(6),
        color: 0xff7a20,
        speed: 1.0,
        up: 3,
        life: 0.7,
        size: 1.5,
        gravity: -3,
      }),
    );
    this.bursts.push(
      new Burst(this.scene, pos, {
        count: this.n(4),
        color: 0x444444,
        speed: 0.8,
        up: 2,
        life: 1.2,
        size: 2.0,
        gravity: -1,
      }),
    );
  }

  /**
   * 岸防炮弹：从炮位向目标点打抛物线（水平初速由飞行时间反推，vy = ½g·tof）。
   * spread 为角散布（弧度），岸防炮刻意不准。
   */
  fireBatteryShot(from: THREE.Vector3, aimX: number, aimZ: number, tof: number, spread: number): void {
    const dx = aimX - from.x;
    const dz = aimZ - from.z;
    const start = from.clone();
    start.y += 2;
    const vel = new THREE.Vector3(dx / tof, 0.5 * BALL_GRAVITY * tof, dz / tof);
    // 角散布：水平面内偏转
    const hs = Math.hypot(vel.x, vel.z);
    const ang = Math.atan2(vel.x, vel.z) + (Math.random() - 0.5) * spread * 2;
    vel.x = Math.sin(ang) * hs;
    vel.z = Math.cos(ang) * hs;
    const mesh = new THREE.Mesh(this.ballGeo, this.ballMat);
    mesh.position.copy(start);
    this.scene.add(mesh);
    this.balls.push({ mesh, vel, fromPlayer: false, life: tof + 2, damageMul: 1 });
    // 炮口硝烟
    this.bursts.push(
      new Burst(this.scene, start, {
        count: this.n(8),
        color: 0xcccccc,
        speed: 1.5,
        up: 1.5,
        life: 0.9,
        size: 1.6,
        gravity: -0.5,
      }),
    );
  }

  splash(pos: THREE.Vector3): void {    this.bursts.push(
      new Burst(this.scene, pos, {
        count: this.n(22),
        color: 0xeaf7ff,
        speed: 2.5,
        up: 5,
        life: 0.9,
        size: 0.9,
        gravity: 12,
      }),
    );
    this.rings.push(new Ring(this.scene, pos));
  }

  explosion(pos: THREE.Vector3): void {
    // 木屑
    this.bursts.push(
      new Burst(this.scene, pos, {
        count: this.n(26),
        color: 0x9a6a3a,
        speed: 5,
        up: 6,
        life: 1.1,
        size: 0.9,
        gravity: 10,
      }),
    );
    // 硝烟
    this.bursts.push(
      new Burst(this.scene, pos, {
        count: this.n(16),
        color: 0x555555,
        speed: 1.8,
        up: 3,
        life: 1.6,
        size: 2.2,
        gravity: -0.6,
      }),
    );
    // 火花
    this.bursts.push(
      new Burst(this.scene, pos, {
        count: this.n(10),
        color: 0xffc040,
        speed: 4,
        up: 5,
        life: 0.5,
        size: 1.1,
        gravity: 6,
      }),
    );
  }

  bubbles(pos: THREE.Vector3): void {
    this.bursts.push(
      new Burst(this.scene, pos, {
        count: this.n(6),
        color: 0xdff4ff,
        speed: 1.2,
        up: 2.5,
        life: 1.2,
        size: 0.8,
        gravity: -2,
      }),
    );
  }

  /** 每帧更新。targets 为可被命中的船，onHit 命中回调。 */
  update(dt: number, targets: HitTarget[], onHit: HitHandler): void {
    // ---- 炮弹 ----
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.vel.y -= BALL_GRAVITY * dt;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.life -= dt;

      const pos = b.mesh.position;
      let dead = b.life <= 0;

      // 落水
      if (!dead && pos.y < this.heightAt(pos.x, pos.z)) {
        pos.y = this.heightAt(pos.x, pos.z) + 0.05;
        this.splash(pos);
        if (this.onSplash) this.onSplash();
        dead = true;
      }

      // 命中船只
      if (!dead) {
        for (const t of targets) {
          if (t.isPlayer === b.fromPlayer) continue; // 不打自己人
          if (t.ship.sinking) continue;
          const sp = t.ship.position;
          const hr = t.ship.hitRadius || HIT_RADIUS;
          const dx = pos.x - sp.x;
          const dz = pos.z - sp.z;
          if (dx * dx + dz * dz < hr * hr && pos.y > sp.y - 1.5 && pos.y < sp.y + 6) {
            this.explosion(pos.clone());
            onHit(b, t);
            dead = true;
            break;
          }
        }
      }

      if (dead) {
        this.scene.remove(b.mesh);
        this.balls.splice(i, 1);
      }
    }

    // ---- 粒子 / 波纹（原地压缩，不每帧 filter 出新数组） ----
    let w = 0;
    for (let i = 0; i < this.bursts.length; i++) {
      if (this.bursts[i].update(dt)) this.bursts[w++] = this.bursts[i];
    }
    this.bursts.length = w;
    let wr = 0;
    for (let i = 0; i < this.rings.length; i++) {
      if (this.rings[i].update(dt)) this.rings[wr++] = this.rings[i];
    }
    this.rings.length = wr;
  }
}
