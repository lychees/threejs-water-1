// 战斗：炮弹（抛物线弹道）、粒子（水花/硝烟/爆炸/气泡）、环形波纹、命中判定
import * as THREE from 'three';

const BALL_GRAVITY = 18;   // 炮弹重力（比真实大，手感更 arcade）
const HIT_RADIUS = 3.4;    // 船体命中半径

// ---- 一次性粒子簇 ----
class Burst {
  constructor(scene, origin, { count, color, speed, up, life, size, gravity }) {
    this.life = life;
    this.age = 0;
    this.velocities = [];
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = origin.x;
      positions[i * 3 + 1] = origin.y;
      positions[i * 3 + 2] = origin.z;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * speed;
      this.velocities.push(new THREE.Vector3(
        Math.cos(a) * r,
        up * (0.4 + Math.random() * 0.9),
        Math.sin(a) * r
      ));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color, size, transparent: true, opacity: 1, depthWrite: false })
    );
    scene.add(this.points);
    this.scene = scene;
    this.gravity = gravity;
  }

  update(dt) {
    this.age += dt;
    const pos = this.points.geometry.attributes.position;
    for (let i = 0; i < this.velocities.length; i++) {
      const v = this.velocities[i];
      v.y -= this.gravity * dt;
      pos.setXYZ(i, pos.getX(i) + v.x * dt, pos.getY(i) + v.y * dt, pos.getZ(i) + v.z * dt);
    }
    pos.needsUpdate = true;
    this.points.material.opacity = Math.max(0, 1 - this.age / this.life);
    if (this.age >= this.life) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      this.points.material.dispose();
      return false;
    }
    return true;
  }
}

// ---- 落水环形波纹 ----
class Ring {
  constructor(scene, pos) {
    this.mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1.0, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false })
    );
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.copy(pos);
    scene.add(this.mesh);
    this.scene = scene;
    this.age = 0;
  }

  update(dt) {
    this.age += dt;
    const s = 1 + this.age * 7;
    this.mesh.scale.setScalar(s);
    this.mesh.material.opacity = Math.max(0, 0.7 - this.age * 0.9);
    if (this.mesh.material.opacity <= 0) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      return false;
    }
    return true;
  }
}

export class Combat {
  constructor(scene, waveFn) {
    this.scene = scene;
    this.waveFn = waveFn;
    this.balls = [];
    this.bursts = [];
    this.rings = [];
    this.ballGeo = new THREE.SphereGeometry(0.24, 6, 5);
    this.ballMat = new THREE.MeshBasicMaterial({ color: 0x1c1c1c });
  }

  /**
   * 舷侧齐射
   * @param {Ship} ship  开火的船
   * @param {number} side -1 左舷 / +1 右舷
   */
  fireBroadside(ship, side, opts = {}) {
    const { count = 3, speed = 30, spread = 0.06, fromPlayer = true } = opts;
    // 舷侧方向：右舷 = (cos h, 0, -sin h)
    const dir = new THREE.Vector3(side * Math.cos(ship.heading), 0, -side * Math.sin(ship.heading));
    const fwd = ship.forward;

    for (let i = 0; i < count; i++) {
      const along = (i - (count - 1) / 2) * 2.0; // 沿船身排开
      const start = ship.position.clone()
        .addScaledVector(fwd, along)
        .addScaledVector(dir, 1.5);
      start.y += 1.3;

      const vel = dir.clone().multiplyScalar(speed * (0.95 + Math.random() * 0.1));
      // 少量散布 + 上抛形成抛物线
      vel.x += (Math.random() - 0.5) * speed * spread * 2;
      vel.z += (Math.random() - 0.5) * speed * spread * 2;
      vel.y = 5 + Math.random() * 1.5;

      const mesh = new THREE.Mesh(this.ballGeo, this.ballMat);
      mesh.position.copy(start);
      this.scene.add(mesh);
      this.balls.push({ mesh, vel, fromPlayer, life: 6 });

      // 炮口硝烟
      this.bursts.push(new Burst(this.scene, start, {
        count: 8, color: 0xcccccc, speed: 1.5, up: 1.5, life: 0.9, size: 1.6, gravity: -0.5,
      }));
    }
  }

  splash(pos) {
    this.bursts.push(new Burst(this.scene, pos, {
      count: 22, color: 0xeaf7ff, speed: 2.5, up: 5, life: 0.9, size: 0.9, gravity: 12,
    }));
    this.rings.push(new Ring(this.scene, pos));
  }

  explosion(pos) {
    // 木屑
    this.bursts.push(new Burst(this.scene, pos, {
      count: 26, color: 0x9a6a3a, speed: 5, up: 6, life: 1.1, size: 0.9, gravity: 10,
    }));
    // 硝烟
    this.bursts.push(new Burst(this.scene, pos, {
      count: 16, color: 0x555555, speed: 1.8, up: 3, life: 1.6, size: 2.2, gravity: -0.6,
    }));
    // 火花
    this.bursts.push(new Burst(this.scene, pos, {
      count: 10, color: 0xffc040, speed: 4, up: 5, life: 0.5, size: 1.1, gravity: 6,
    }));
  }

  bubbles(pos) {
    this.bursts.push(new Burst(this.scene, pos, {
      count: 6, color: 0xdff4ff, speed: 1.2, up: 2.5, life: 1.2, size: 0.8, gravity: -2,
    }));
  }

  /**
   * 每帧更新
   * @param {Array} targets [{ ship, isPlayer }] 可被命中的船
   * @param {Function} onHit (ball, target) 命中回调
   */
  update(dt, time, targets, onHit) {
    // ---- 炮弹 ----
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.vel.y -= BALL_GRAVITY * dt;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.life -= dt;

      const pos = b.mesh.position;
      let dead = b.life <= 0;

      // 落水
      if (!dead && pos.y < this.waveFn(pos.x, pos.z, time)) {
        pos.y = this.waveFn(pos.x, pos.z, time) + 0.05;
        this.splash(pos);
        dead = true;
      }

      // 命中船只
      if (!dead) {
        for (const t of targets) {
          if (t.isPlayer === b.fromPlayer) continue; // 不打自己人
          if (t.ship.sinking) continue;
          const sp = t.ship.position;
          const dx = pos.x - sp.x;
          const dz = pos.z - sp.z;
          if (dx * dx + dz * dz < HIT_RADIUS * HIT_RADIUS && pos.y > sp.y - 1.5 && pos.y < sp.y + 6) {
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

    // ---- 粒子 / 波纹 ----
    this.bursts = this.bursts.filter((b) => b.update(dt));
    this.rings = this.rings.filter((r) => r.update(dt));
  }
}
