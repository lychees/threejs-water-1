// 船迹尾流（Kelvin wake 简化版）：船尾泡沫带（世界锚定 quad 串）+ 船头脉冲推波环
import * as THREE from 'three';

// ---- 参数（集中在此调整） ----
const FOAM_LIFE = 3.2;       // 泡沫存活秒数（2~4 随机）
const FOAM_POOL_MAX = 220;   // 全场泡沫 quad 池上限
const MIN_SPEED = 1.5;       // 低于此速度不产生尾流
const BOW_RINGS = 2;         // 每船船头推波环数

const foamGeo = new THREE.PlaneGeometry(1, 1);
foamGeo.rotateX(-Math.PI / 2);
const ringGeo = new THREE.RingGeometry(0.7, 1.0, 20);
ringGeo.rotateX(-Math.PI / 2);

function makeFoamMesh() {
  return new THREE.Mesh(foamGeo, new THREE.MeshBasicMaterial({
    color: 0xf2fbfc, transparent: true, opacity: 0, depthWrite: false,
  }));
}

export class WakeManager {
  constructor(scene, waveFn) {
    this.scene = scene;
    this.waveFn = waveFn;
    this.foamEnabled = true;  // 低画质档关闭泡沫带（保留推波环）
    this.foams = [];            // { mesh, age, life, size, alive } 共享池
    this.shipState = new Map(); // ship -> { spawnT, rings: [{mesh, phase}] }
  }

  _stateFor(ship) {
    let st = this.shipState.get(ship);
    if (!st) {
      st = { spawnT: 0, rings: [] };
      for (let i = 0; i < BOW_RINGS; i++) {
        const mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
        }));
        mesh.visible = false;
        this.scene.add(mesh);
        st.rings.push({ mesh, phase: i / BOW_RINGS });
      }
      this.shipState.set(ship, st);
    }
    return st;
  }

  _spawnFoam(x, y, z, size) {
    // 池化复用：找死对象，没有则新建；超上限则复用最老的
    let f = this.foams.find((it) => !it.alive);
    if (!f) {
      if (this.foams.length >= FOAM_POOL_MAX) {
        f = this.foams[0];
        this.foams.push(this.foams.shift());
      } else {
        f = { mesh: makeFoamMesh(), age: 0, life: 1, size: 1, alive: false };
        this.scene.add(f.mesh);
        this.foams.push(f);
      }
    }
    f.alive = true;
    f.age = 0;
    f.life = FOAM_LIFE * (0.7 + Math.random() * 0.6);
    f.size = size;
    f.mesh.visible = true;
    f.mesh.position.set(x, y, z);
    f.mesh.rotation.y = Math.random() * Math.PI;
    f.mesh.scale.setScalar(size);
  }

  /**
   * @param {Array} ships 玩家 + 敌船（含正在下沉的）；已移除的船自动清理
   */
  update(dt, time, ships) {
    // 清理已离场船只的推波环
    const seen = new Set(ships);
    for (const [ship, st] of this.shipState) {
      if (!seen.has(ship)) {
        for (const r of st.rings) {
          this.scene.remove(r.mesh);
          r.mesh.material.dispose();
        }
        this.shipState.delete(ship);
      }
    }

    for (const ship of ships) {
      const st = this._stateFor(ship);
      const speed = Math.abs(ship.speed);
      const active = !ship.sinking && !ship.dead && speed > MIN_SPEED;
      const ls = ship.lengthScale || 1;
      const speedRatio = Math.min(1, speed / ship.maxSpeed);
      const fwd = ship.forward;
      const p = ship.position;

      // 船尾泡沫带：按速度间隔在船尾留下泡沫 quad（世界锚定，不随船走）
      if (active && this.foamEnabled) {
        st.spawnT -= dt;
        if (st.spawnT <= 0) {
          st.spawnT = 0.5 - speedRatio * 0.35; // 越快越密
          const x = p.x - fwd.x * 3.2 * ls + (Math.random() - 0.5) * 1.2 * ls;
          const z = p.z - fwd.z * 3.2 * ls + (Math.random() - 0.5) * 1.2 * ls;
          this._spawnFoam(x, this.waveFn(x, z, time) + 0.06, z, (0.8 + speedRatio * 1.2) * ls);
        }
      }

      // 船头 V 形推波：两个错相位的脉冲环随船移动，速度越快越明显
      for (const r of st.rings) {
        r.mesh.visible = active;
        if (!active) continue;
        const bx = p.x + fwd.x * 3.6 * ls;
        const bz = p.z + fwd.z * 3.6 * ls;
        r.mesh.position.set(bx, this.waveFn(bx, bz, time) + 0.08, bz);
        const cycle = (time * (0.5 + speedRatio * 0.7) + r.phase) % 1;
        r.mesh.scale.setScalar((0.6 + cycle * 2.2) * ls);
        r.mesh.material.opacity = (1 - cycle) * 0.45 * speedRatio;
      }
    }

    // 泡沫老化：扩大 + 淡出
    for (const f of this.foams) {
      if (!f.alive) continue;
      f.age += dt;
      const t = f.age / f.life;
      if (t >= 1) {
        f.alive = false;
        f.mesh.visible = false;
        continue;
      }
      f.mesh.scale.setScalar(f.size * (1 + t * 1.8));
      f.mesh.material.opacity = 0.5 * (1 - t);
    }
  }
}
