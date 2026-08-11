/**
 * 火焰特效：持续燃烧（着火 debuff）+ 爆炸火球 + 炮口闪光。
 *
 * 渲染：全部效果走两个共享 InstancedMesh 广告牌池——火舌池（canvas 程序化
 * 泪滴形橙黄→暗红渐变纹理，底锚定）与光斑池（径向渐变软圆纹理，中心锚定），
 * additive 混合下 instanceColor 的亮度即不透明度（渐黑 = 渐隐），
 * 两种纹理各一次 draw call。柱状广告牌（只绕世界 Y 轴朝相机），火苗带闪烁、
 * 烟带自旋。无 PointLight/实时阴影：夜间光晕是大半径低亮度 additive 光斑。
 *
 * 性能：粒子结构体对象池 + 网格下标环形分配（满了覆盖最旧的，自然降级），
 * 主循环零分配；燃烧船超过 MAX_FULL_FIRES 艘时按比降发射率；particleScale
 * 随画质档位减半（App 每帧同步，与 Phenomena 同一惯例）。
 */

import * as THREE from 'three/webgpu';
import type { GameShip } from './GameShip';

/** 火舌池容量（火苗 + 爆炸火球）。 */
const FLAME_CAP = 160;
/** 光斑池容量（烟/火星/闪光/光晕）。 */
const SOFT_CAP = 224;
/** 结构体池上限（超出直接不生成）。 */
const PART_CAP = 512;
/** 全速率燃烧的船数上限，超出按比降。 */
const MAX_FULL_FIRES = 3;

// ---------------------------------------------------------------- 纹理

/** 泪滴形火舌：底橙黄白芯 → 橙 → 顶暗红透明（纵向椭圆渐变）。 */
function makeFlameTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  // 纵向压扁坐标系里画径向渐变，得到泪滴轮廓
  ctx.save();
  ctx.scale(0.5, 1); // 64x128 → 视觉 32 宽
  const g = ctx.createRadialGradient(64, 92, 4, 64, 92, 86);
  g.addColorStop(0, 'rgba(255, 240, 190, 1)');
  g.addColorStop(0.25, 'rgba(255, 170, 60, 0.95)');
  g.addColorStop(0.55, 'rgba(230, 80, 15, 0.6)');
  g.addColorStop(0.85, 'rgba(120, 20, 0, 0.18)');
  g.addColorStop(1, 'rgba(60, 5, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  ctx.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 柔和径向光斑：白芯 → 透明（烟/闪光/光晕/火星通用，颜色靠 instanceColor）。 */
function makeSoftTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- 粒子

interface Particle {
  on: boolean;
  pool: number; // 0 = 火舌池，1 = 光斑池
  idx: number; // 池内下标
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  grav: number;
  age: number; life: number;
  s0: number; s1: number; // 尺寸起止（世界单位）
  stretch: number; // 纵向拉伸（火舌）
  r0: number; g0: number; b0: number; // 颜色起止（亮度含淡出）
  r1: number; g1: number; b1: number;
  spin: number; // 视轴自旋速度
  flicker: number; // 闪烁频率（0 = 不闪）
  phase: number;
}

/** 广告牌池：InstancedMesh + 环形下标分配（写满覆盖最旧，免空闲表）。 */
class BillboardPool {
  readonly mesh: THREE.InstancedMesh;
  private cursor = 0;

  constructor(scene: THREE.Scene, texture: THREE.Texture, capacity: number, bottomAnchor: boolean) {
    const geo = new THREE.PlaneGeometry(1, 1);
    if (bottomAnchor) geo.translate(0, 0.5, 0); // 火苗位置即根部
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false; // 粒子满场跑，包围盒算不准
    this.mesh.renderOrder = 10;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // 初始化：全部零缩放（不可见）+ 白色
    const m = new THREE.Matrix4().makeScale(0, 0, 0);
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, m);
      this.mesh.setColorAt(i, white);
    }
    scene.add(this.mesh);
  }

  alloc(): number {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.mesh.count;
    return i;
  }
}

/** 一艘燃烧船的发射点布局（甲板局部坐标，随船运动）。 */
interface ShipFire {
  points: { across: number; y: number; along: number }[];
  glowAcc: number;
  emitAcc: number;
}

export class Fire {
  particleScale = 1; // 画质档位缩放（App 每帧同步）

  private readonly flamePool: BillboardPool;
  private readonly softPool: BillboardPool;
  private readonly particles: Particle[] = []; // 活跃粒子（交换删除）
  private readonly freelist: Particle[] = [];
  private readonly burning = new Map<GameShip, ShipFire>();
  private camera: THREE.Camera | null = null;

  // 复用对象（主循环零分配）
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _qz = new THREE.Quaternion();
  private readonly _pos = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _c = new THREE.Color();
  private static readonly Z_AXIS = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Scene) {
    this.flamePool = new BillboardPool(scene, makeFlameTexture(), FLAME_CAP, true);
    this.softPool = new BillboardPool(scene, makeSoftTexture(), SOFT_CAP, false);
    for (let i = 0; i < PART_CAP; i++) {
      this.freelist.push({
        on: false, pool: 0, idx: 0,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grav: 0,
        age: 0, life: 1, s0: 1, s1: 1, stretch: 1,
        r0: 1, g0: 1, b0: 1, r1: 0, g1: 0, b1: 0,
        spin: 0, flicker: 0, phase: 0,
      });
    }
  }

  /** 柱状广告牌需要相机位置（不是朝向四元数），Game 构造时挂一次。 */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  private n(count: number): number {
    return count * this.particleScale;
  }

  private spawn(pool: number, init: (p: Particle) => void): void {
    const p = this.freelist.pop();
    if (!p) return; // 预算耗尽，静默丢弃
    p.on = true;
    p.pool = pool;
    p.age = 0;
    p.idx = pool === 0 ? this.flamePool.alloc() : this.softPool.alloc();
    init(p);
    this.particles.push(p);
  }

  // ---------------------------------------------------------------- 持续燃烧

  /**
   * 每帧驱动着火船的持续燃烧：火舌 + 火星 + 烟柱 + 光晕。
   * ships 为玩家 + 敌船列表（复用数组，不得留存）。
   */
  updateFires(dt: number, ships: readonly GameShip[]): void {
    // 统计燃烧中的船，超编按比降发射率
    let burningCount = 0;
    for (const s of ships) {
      if (s.debuff.fire > 0 && !s.sinking && !s.dead) burningCount++;
    }
    const rateScale = burningCount <= MAX_FULL_FIRES ? 1 : MAX_FULL_FIRES / burningCount;

    for (const s of ships) {
      const on = s.debuff.fire > 0 && !s.sinking && !s.dead;
      let fire = this.burning.get(s);
      if (!on) {
        if (fire) this.burning.delete(s); // 粒子寿终自然清理，发射点即弃
        continue;
      }
      if (!fire) {
        // 2~4 个发射点：甲板局部坐标（across/along 随船长缩放，一个点偏高模拟桅杆着火）
        const ls = s.lengthScale || 1;
        const count = 2 + Math.floor(Math.random() * 3);
        const points: ShipFire['points'] = [];
        for (let i = 0; i < count; i++) {
          points.push({
            across: (Math.random() - 0.5) * 1.6 * ls,
            y: (1.0 + Math.random() * 0.8) * ls + (i === 0 ? 1.6 * ls : 0),
            along: (Math.random() - 0.5) * 4.5 * ls,
          });
        }
        fire = { points, glowAcc: 0, emitAcc: 0 };
        this.burning.set(s, fire);
      }

      const ls = s.lengthScale || 1;
      const sinH = Math.sin(s.heading);
      const cosH = Math.cos(s.heading);

      // 发射率（每秒每点）：火苗 12 / 烟 4.5 / 火星 6，按预算与画质缩放
      fire.emitAcc += dt * rateScale;
      const step = 1 / (12 * this.n(1) || 1); // 以火苗率为基准节拍
      while (fire.emitAcc >= step) {
        fire.emitAcc -= step;
        for (const pt of fire.points) {
          // 局部 → 世界（船体 yaw）
          const wx = s.position.x + sinH * pt.along - cosH * pt.across;
          const wz = s.position.z + cosH * pt.along + sinH * pt.across;
          const wy = s.position.y + pt.y;
          // 火舌
          this.spawn(0, (p) => {
            p.x = wx; p.y = wy; p.z = wz;
            p.vx = (Math.random() - 0.5) * 0.6;
            p.vy = 2.2 + Math.random() * 1.8;
            p.vz = (Math.random() - 0.5) * 0.6;
            p.grav = -1.5; // 向上加速飘
            p.life = 0.5 + Math.random() * 0.3;
            p.s0 = (0.8 + Math.random() * 0.7) * ls;
            p.s1 = p.s0 * 0.35;
            p.stretch = 1.6 + Math.random() * 0.6;
            p.r0 = 1; p.g0 = 0.95; p.b0 = 0.8;
            p.r1 = 0.4; p.g1 = 0.08; p.b1 = 0.01;
            p.flicker = 22 + Math.random() * 14;
            p.phase = Math.random() * Math.PI * 2;
          });
          // 烟（概率抽稀，按 4.5/12）
          if (Math.random() < 0.38 * this.particleScale) {
            this.spawn(1, (p) => {
              p.x = wx; p.y = wy + 0.8 * ls; p.z = wz;
              p.vx = (Math.random() - 0.5) * 0.5;
              p.vy = 1.8 + Math.random() * 1.2;
              p.vz = (Math.random() - 0.5) * 0.5;
              p.grav = -0.8;
              p.life = 1.4 + Math.random() * 0.8;
              p.s0 = 1.2 * ls;
              p.s1 = 3.4 * ls;
              p.stretch = 1;
              const g = 0.16 + Math.random() * 0.05;
              p.r0 = g; p.g0 = g; p.b0 = g;
              p.r1 = 0; p.g1 = 0; p.b1 = 0;
              p.spin = (Math.random() - 0.5) * 3;
            });
          }
          // 火星（概率抽稀，按 6/12）
          if (Math.random() < 0.5 * this.particleScale) {
            this.spawn(1, (p) => {
              p.x = wx; p.y = wy; p.z = wz;
              p.vx = (Math.random() - 0.5) * 3;
              p.vy = 3 + Math.random() * 2.5;
              p.vz = (Math.random() - 0.5) * 3;
              p.grav = 4; // 抛物线上飘后坠灭
              p.life = 0.7 + Math.random() * 0.6;
              p.s0 = 0.14 + Math.random() * 0.08;
              p.s1 = p.s0 * 0.6;
              p.stretch = 1;
              p.r0 = 1; p.g0 = 0.75; p.b0 = 0.3;
              p.r1 = 0.35; p.g1 = 0.04; p.b1 = 0;
              p.flicker = 30 + Math.random() * 20;
              p.phase = Math.random() * Math.PI * 2;
            });
          }
        }
      }

      // 光晕：大半径低亮度光斑，缓慢脉动（夜里尤其明显；不加 PointLight）
      fire.glowAcc += dt;
      if (fire.glowAcc >= 0.12) {
        fire.glowAcc = 0;
        const pulse = 0.09 + 0.035 * Math.sin(performance.now() * 0.006 + s.position.x);
        this.spawn(1, (p) => {
          p.x = s.position.x; p.y = s.position.y + 2 * ls; p.z = s.position.z;
          p.vx = 0; p.vy = 0.4; p.vz = 0;
          p.grav = 0;
          p.life = 0.16;
          p.s0 = 8 * ls;
          p.s1 = 8.6 * ls;
          p.stretch = 1;
          p.r0 = pulse; p.g0 = pulse * 0.45; p.b0 = pulse * 0.1;
          p.r1 = p.r0 * 0.7; p.g1 = p.g0 * 0.7; p.b1 = p.b0 * 0.7;
        });
      }
    }
  }

  // ---------------------------------------------------------------- 一次性效果

  /** 爆炸升级：白黄闪光（0.12s 爆亮）+ 橙红火球膨胀 + 火星四溅 + 大烟。scale=2 为击毁/沉船级。 */
  blast(pos: THREE.Vector3, scale = 1): void {
    // 闪光
    this.spawn(1, (p) => {
      p.x = pos.x; p.y = pos.y; p.z = pos.z;
      p.vx = 0; p.vy = 0; p.vz = 0;
      p.life = 0.12;
      p.s0 = 5 * scale;
      p.s1 = 9 * scale;
      p.stretch = 1;
      p.r0 = 1; p.g0 = 0.95; p.b0 = 0.75;
      p.r1 = 0.3; p.g1 = 0.12; p.b1 = 0.02;
    });
    // 火球（三团错开）
    for (let i = 0; i < 3; i++) {
      this.spawn(0, (p) => {
        p.x = pos.x + (Math.random() - 0.5) * scale;
        p.y = pos.y + (Math.random() - 0.5) * 0.5 * scale;
        p.z = pos.z + (Math.random() - 0.5) * scale;
        p.vx = (Math.random() - 0.5) * 1.5;
        p.vy = 1.5 + Math.random() * 1.5;
        p.vz = (Math.random() - 0.5) * 1.5;
        p.grav = -1;
        p.life = 0.4 + Math.random() * 0.12;
        p.s0 = 2.2 * scale;
        p.s1 = 6.5 * scale;
        p.stretch = 1.1;
        p.r0 = 1; p.g0 = 0.6; p.b0 = 0.15;
        p.r1 = 0.3; p.g1 = 0.04; p.b1 = 0.01;
        p.flicker = 16;
        p.phase = Math.random() * Math.PI * 2;
      });
    }
    // 火星四溅
    const embers = Math.round(this.n(8 * scale));
    for (let i = 0; i < embers; i++) {
      this.spawn(1, (p) => {
        p.x = pos.x; p.y = pos.y; p.z = pos.z;
        const a = Math.random() * Math.PI * 2;
        const r = 2 + Math.random() * 4 * scale;
        p.vx = Math.cos(a) * r;
        p.vy = 3.5 + Math.random() * 4.5;
        p.vz = Math.sin(a) * r;
        p.grav = 10;
        p.life = 0.5 + Math.random() * 0.5;
        p.s0 = 0.16 + Math.random() * 0.1;
        p.s1 = p.s0 * 0.5;
        p.stretch = 1;
        p.r0 = 1; p.g0 = 0.8; p.b0 = 0.35;
        p.r1 = 0.4; p.g1 = 0.05; p.b1 = 0;
        p.flicker = 26;
        p.phase = Math.random() * Math.PI * 2;
      });
    }
    // 大烟两团
    for (let i = 0; i < 2; i++) {
      this.spawn(1, (p) => {
        p.x = pos.x; p.y = pos.y + 0.5 * scale; p.z = pos.z;
        p.vx = (Math.random() - 0.5) * 0.8;
        p.vy = 1.6 + Math.random();
        p.vz = (Math.random() - 0.5) * 0.8;
        p.grav = -0.6;
        p.life = 1.2 + Math.random() * 0.5;
        p.s0 = 2.4 * scale;
        p.s1 = 5.5 * scale;
        p.stretch = 1;
        p.r0 = 0.14; p.g0 = 0.13; p.b0 = 0.12;
        p.r1 = 0; p.g1 = 0; p.b1 = 0;
        p.spin = (Math.random() - 0.5) * 2;
      });
    }
  }

  /** 炮口火光：一帧级小亮斑（多门齐射时每门一个，由调用方逐门调用）。 */
  muzzleFlash(pos: THREE.Vector3): void {
    this.spawn(1, (p) => {
      p.x = pos.x; p.y = pos.y; p.z = pos.z;
      p.vx = 0; p.vy = 0.3; p.vz = 0;
      p.life = 0.08;
      p.s0 = 1.5;
      p.s1 = 2.6;
      p.stretch = 1;
      p.r0 = 1; p.g0 = 0.88; p.b0 = 0.55;
      p.r1 = 0.5; p.g1 = 0.2; p.b1 = 0.05;
    });
  }

  // ---------------------------------------------------------------- 帧更新

  update(dt: number): void {
    const cam = this.camera;
    const camX = cam ? cam.position.x : 0;
    const camZ = cam ? cam.position.z : 1;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      const mesh = p.pool === 0 ? this.flamePool.mesh : this.softPool.mesh;
      if (p.age >= p.life) {
        // 归零隐藏 + 结构体回收（交换删除）
        this._m.makeScale(0, 0, 0);
        mesh.setMatrixAt(p.idx, this._m);
        this.particles[i] = this.particles[this.particles.length - 1];
        this.particles.pop();
        p.on = false;
        this.freelist.push(p);
        continue;
      }
      const t = p.age / p.life;
      p.vy -= p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // 柱状广告牌：只绕世界 Y 朝相机 + 视轴自旋
      const yaw = Math.atan2(camX - p.x, camZ - p.z);
      this._q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      if (p.spin !== 0) {
        this._qz.setFromAxisAngle(Fire.Z_AXIS, p.spin * p.age);
        this._q.multiply(this._qz);
      }
      let s = p.s0 + (p.s1 - p.s0) * t;
      let bright = 1;
      if (p.flicker > 0) {
        const f = Math.sin(p.age * p.flicker + p.phase);
        s *= 1 + 0.18 * f;
        bright = 0.82 + 0.3 * f;
      }
      this._pos.set(p.x, p.y, p.z);
      this._s.set(s, s * p.stretch, s);
      this._m.compose(this._pos, this._q, this._s);
      mesh.setMatrixAt(p.idx, this._m);
      this._c.setRGB(
        (p.r0 + (p.r1 - p.r0) * t) * bright,
        (p.g0 + (p.g1 - p.g0) * t) * bright,
        (p.b0 + (p.b1 - p.b0) * t) * bright,
      );
      mesh.setColorAt(p.idx, this._c);
    }
    this.flamePool.mesh.instanceMatrix.needsUpdate = true;
    this.softPool.mesh.instanceMatrix.needsUpdate = true;
    if (this.flamePool.mesh.instanceColor) this.flamePool.mesh.instanceColor.needsUpdate = true;
    if (this.softPool.mesh.instanceColor) this.softPool.mesh.instanceColor.needsUpdate = true;
  }
}
