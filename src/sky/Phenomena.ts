/**
 * 天空现象层：雾团 / 彩虹 / 极光 / 流星。
 *
 * 全部挂在同一个跟随相机的容器上，由 App 每帧喂环境状态（太阳方向、天气
 * kind/强度、预设雾量、风向风速、画质缩放），各自平滑淡入淡出——切换预设
 * 或昼夜时没有任何硬切换。TSL 只用在极光（顶点波动必须在着色器里），其余
 * 是普通几何体 + CPU 驱动，两个后端行为一致。
 *
 * 触发条件一览：
 *   雾团  —— 预设体积雾量超过阈值（foggy；storm 边缘也沾一点）
 *   彩虹  —— 雨停之后几分钟内，太阳对面天空，缓慢淡出
 *   极光  —— 夜里（太阳沉到地平线以下）的 moonlit / arctic
 *   流星  —— 晴朗夜空，随机 20~60s 一颗（开场 4~8s 先来一颗）
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  mix,
  positionLocal,
  sin,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import type { WeatherKind } from './Weather';

// ---------------------------------------------------------------- 共享参数

/** 雾团：体积雾量达到 FOG_BANK_FULL 时满强度。 */
const FOG_BANK_ONSET = 0.0012;
const FOG_BANK_FULL = 0.0028;
const FOG_BANK_COUNT = 6; // 低档减半
const FOG_BANK_SIZE_MIN = 130;
const FOG_BANK_SIZE_SPAN = 110;
const FOG_BANK_WRAP = 620; // 离相机超过这个距离就绕到另一侧

/** 彩虹：雨停后 Rainbow 满强度，RAINBOW_DECAY 秒内线性淡出。 */
const RAINBOW_DECAY = 150;
const RAINBOW_OPACITY = 0.55;
const RAINBOW_DISTANCE = 700;

/** 极光：两条光带，顶点附近。 */
const AURORA_BANDS = 3;
const AURORA_HEIGHT = 300;
const AURORA_OPACITY = 0.55;

/** 流星。 */
const METEOR_FIRST_MIN = 4;
const METEOR_FIRST_SPAN = 4;
const METEOR_INTERVAL_MIN = 20;
const METEOR_INTERVAL_SPAN = 40;
const METEOR_LIFE = 1.0;
const METEOR_POOL = 3;

/** 入夜判定：太阳高度角低于此值视为夜（与 Atmosphere 的昼夜混合同量级）。 */
const NIGHT_ELEVATION = -0.04;

export interface PhenomenaEnv {
  cameraPosition: THREE.Vector3;
  /** 归一化太阳方向（y>0 为白天）。 */
  sunDirection: THREE.Vector3;
  weatherKind: WeatherKind;
  weatherIntensity: number;
  /** 当前预设的体积雾量（fog.volumetric）。 */
  fogVolumetric: number;
  presetId: string;
  windDirection: number;
  windSpeed: number;
  /** 画质粒子缩放（低档 0.5）。 */
  particleScale: number;
}

// ---------------------------------------------------------------- 雾团

function makeFogTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.38)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class FogBanks {
  readonly object = new THREE.Group();
  private readonly banks: { mesh: THREE.Mesh; opacity: number; drift: number }[] = [];
  private strength = 0;

  constructor() {
    this.object.name = 'fog-banks';
    const tex = makeFogTexture();
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      fog: false,
      color: 0xd3dde2,
    });
    for (let i = 0; i < FOG_BANK_COUNT; i++) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat.clone());
      mesh.renderOrder = 90;
      const size = FOG_BANK_SIZE_MIN + Math.random() * FOG_BANK_SIZE_SPAN;
      mesh.scale.set(size, size * 0.32, 1);
      mesh.position.set(0, -9999, 0); // 首次 update 时归位
      this.object.add(mesh);
      this.banks.push({
        mesh,
        opacity: 0.14 + Math.random() * 0.14,
        drift: 0.6 + Math.random() * 0.8,
      });
    }
  }

  update(dt: number, env: PhenomenaEnv): void {
    // 目标强度：预设雾量映射，平滑过渡
    const target = THREE.MathUtils.smoothstep(env.fogVolumetric, FOG_BANK_ONSET, FOG_BANK_FULL);
    this.strength += (target - this.strength) * Math.min(1, dt * 0.5);
    this.object.visible = this.strength > 0.01;
    if (!this.object.visible) return;

    const cam = env.cameraPosition;
    const windX = Math.sin(env.windDirection);
    const windZ = Math.cos(env.windDirection);
    const count = Math.max(2, Math.round(this.banks.length * env.particleScale));

    for (let i = 0; i < this.banks.length; i++) {
      const bank = this.banks[i];
      const mesh = bank.mesh;
      mesh.visible = i < count;
      if (!mesh.visible) continue;

      if (mesh.position.y < -1000) {
        // 初次：相机周围 150~500m 环带
        const a = Math.random() * Math.PI * 2;
        const d = 150 + Math.random() * 350;
        mesh.position.set(cam.x + Math.cos(a) * d, 6 + Math.random() * 16, cam.z + Math.sin(a) * d);
      }

      // 随风漂移，离相机太远就绕到上风侧
      mesh.position.x += windX * env.windSpeed * 0.35 * bank.drift * dt;
      mesh.position.z += windZ * env.windSpeed * 0.35 * bank.drift * dt;
      const dx = mesh.position.x - cam.x;
      const dz = mesh.position.z - cam.z;
      if (Math.hypot(dx, dz) > FOG_BANK_WRAP) {
        mesh.position.x = cam.x - dx * 0.9;
        mesh.position.z = cam.z - dz * 0.9;
      }

      // 始终面向相机（billboard）
      mesh.quaternion.copy(_camQuat);
      (mesh.material as THREE.MeshBasicMaterial).opacity = bank.opacity * this.strength;
    }
  }
}

const _camQuat = new THREE.Quaternion();

// ---------------------------------------------------------------- 彩虹

/** 彩虹色带（从外弧到内弧：红→紫）。 */
const RAINBOW_STOPS: readonly [number, number][] = [
  [0.0, 0xff3b30],
  [0.2, 0xff9500],
  [0.38, 0xffd60a],
  [0.55, 0x34c759],
  [0.72, 0x32ade6],
  [0.88, 0x5856d6],
  [1.0, 0xaf52de],
];

class Rainbow {
  readonly mesh: THREE.Mesh;
  private strength = 0;
  private wasRaining = false;

  constructor() {
    // 竖直圆弧：内半径/外半径的环段，顶点色沿径向铺彩虹
    const inner = 380;
    const outer = 520;
    const geo = new THREE.RingGeometry(inner, outer, 72, 1, Math.PI * 0.08, Math.PI * 0.84);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const thetaVerts = 72 + 1; // RingGeometry 顶点按 theta 分行
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      const t = 1 - (r - inner) / (outer - inner); // 外弧 t=0 红，内弧 t=1 紫
      c.set(RAINBOW_STOPS[RAINBOW_STOPS.length - 1][1]);
      for (let k = 0; k < RAINBOW_STOPS.length - 1; k++) {
        const [t0, c0] = RAINBOW_STOPS[k];
        const [t1, c1] = RAINBOW_STOPS[k + 1];
        if (t >= t0 && t <= t1) {
          c.set(c0).lerp(new THREE.Color(c1), (t - t0) / (t1 - t0));
          break;
        }
      }
      // additive 混合下黑色即透明：弧的两端淡出，消掉 RingGeometry 的硬切边
      const thetaT = (i % thetaVerts) / (thetaVerts - 1);
      const endFade = Math.min(1, Math.min(thetaT, 1 - thetaT) / 0.1);
      colors[i * 3] = c.r * endFade;
      colors[i * 3 + 1] = c.g * endFade;
      colors[i * 3 + 2] = c.b * endFade;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
    this.mesh.renderOrder = 80;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  update(dt: number, env: PhenomenaEnv): void {
    const raining = env.weatherKind === 'rain' && env.weatherIntensity > 0.05;
    // 雨停的一刻起弧；白天才读得到（夜里没有彩虹）
    if (this.wasRaining && !raining) this.strength = 1;
    this.wasRaining = raining;
    const day = THREE.MathUtils.smoothstep(env.sunDirection.y, 0.02, 0.2);
    const target = Math.min(this.strength, 1) * day;
    this.strength = Math.max(0, this.strength - dt / RAINBOW_DECAY);

    const opacity = target * RAINBOW_OPACITY;
    this.mesh.visible = opacity > 0.004;
    if (!this.mesh.visible) return;

    // 太阳对面：彩虹弧心在与太阳方位角相反的方向上
    const sunAz = Math.atan2(env.sunDirection.x, env.sunDirection.z);
    const awayAz = sunAz + Math.PI;
    const cam = env.cameraPosition;
    this.mesh.position.set(
      cam.x + Math.sin(awayAz) * RAINBOW_DISTANCE,
      0,
      cam.z + Math.cos(awayAz) * RAINBOW_DISTANCE,
    );
    this.mesh.lookAt(cam.x, this.mesh.position.y, cam.z);
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = opacity;
  }
}

// ---------------------------------------------------------------- 极光

class Aurora {
  readonly object = new THREE.Group();
  private readonly opacity = uniform(0);
  private readonly time = uniform(0);
  private strength = 0;

  constructor() {
    this.object.name = 'aurora';
    for (let i = 0; i < AURORA_BANDS; i++) {
      const phase = i * 2.1;
      const mat = new THREE.MeshBasicNodeMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const t = this.time;
      // 顶点波：两列异相正弦沿带长方向推，光带缓慢流动
      mat.positionNode = Fn(() => {
        const p = positionLocal;
        const wave = sin(p.x.mul(0.011).add(t.mul(0.31)).add(phase))
          .mul(26)
          .add(sin(p.x.mul(0.023).sub(t.mul(0.17)).add(phase * 1.7)).mul(13));
        return vec3(p.x, p.y.add(wave), p.z.add(sin(p.x.mul(0.007).add(t.mul(0.11))).mul(18)));
      })();
      // 竖向渐变：下绿上紫，两端与带底渐隐
      mat.colorNode = Fn(() => {
        const v = uv().y;
        const edge = uv().x.mul(uv().x.oneMinus()).mul(4).min(1);
        const vertical = v.mul(v.oneMinus()).mul(4).min(1);
        const green = vec3(0.15, 0.95, 0.45);
        const purple = vec3(0.5, 0.25, 0.9);
        const col = mix(green, purple, v);
        return vec4(col, edge.mul(vertical).mul(this.opacity));
      })();

      const geo = new THREE.PlaneGeometry(1500, 130, 48, 6);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 85;
      // 各带占一个方位角——光带只铺在一个方向上时，追船相机多半背对它们
      const az = (i / AURORA_BANDS) * Math.PI * 2 + 0.6;
      mesh.position.set(
        Math.cos(az) * 300,
        AURORA_HEIGHT + i * 60,
        Math.sin(az) * 300,
      );
      mesh.rotation.x = -0.35 - i * 0.08;
      mesh.rotation.y = -az + Math.PI / 2; // 带长方向沿该方位角的切线铺开
      this.object.add(mesh);
    }
  }

  update(dt: number, env: PhenomenaEnv): void {
    this.time.value = (this.time.value + dt) % 3600;
    const night = THREE.MathUtils.smoothstep(-env.sunDirection.y, -NIGHT_ELEVATION, 0.15);
    const presetOn = env.presetId === 'moonlit' || env.presetId === 'arctic' ? 1 : 0;
    const target = night * presetOn;
    this.strength += (target - this.strength) * Math.min(1, dt * 0.4);
    this.opacity.value = this.strength * AURORA_OPACITY;
    this.object.visible = this.strength > 0.01;
    if (this.object.visible) {
      this.object.position.set(env.cameraPosition.x, 0, env.cameraPosition.z);
    }
  }
}

// ---------------------------------------------------------------- 流星

interface Meteor {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  age: number;
  active: boolean;
}

function makeMeteorTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 8;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.75, 'rgba(190,215,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 8);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class Meteors {
  private readonly pool: Meteor[] = [];
  private timer = METEOR_FIRST_MIN + Math.random() * METEOR_FIRST_SPAN;

  constructor(parent: THREE.Object3D) {
    const tex = makeMeteorTexture();
    for (let i = 0; i < METEOR_POOL; i++) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
        }),
      );
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 86;
      parent.add(mesh);
      this.pool.push({ mesh, vel: new THREE.Vector3(), age: 0, active: false });
    }
  }

  update(dt: number, env: PhenomenaEnv): void {
    const night = env.sunDirection.y < NIGHT_ELEVATION;
    const clearSky = env.weatherKind === 'clear' && env.fogVolumetric < FOG_BANK_ONSET;

    this.timer -= dt * (night && clearSky ? 1 : 0);
    if (this.timer <= 0) {
      this.timer =
        (METEOR_INTERVAL_MIN + Math.random() * METEOR_INTERVAL_SPAN) /
        Math.max(0.5, env.particleScale + 0.5);
      this.spawn(env.cameraPosition);
    }

    for (const m of this.pool) {
      if (!m.active) continue;
      m.age += dt;
      if (m.age >= METEOR_LIFE) {
        m.active = false;
        m.mesh.visible = false;
        continue;
      }
      m.mesh.position.addScaledVector(m.vel, dt);
      const t = m.age / METEOR_LIFE;
      (m.mesh.material as THREE.MeshBasicMaterial).opacity = Math.sin(Math.PI * Math.min(1, t)) * 0.9;
    }
  }

  private spawn(cam: THREE.Vector3, azOverride?: number): void {
    const m = this.pool.find((x) => !x.active);
    if (!m) return;
    // 天顶附近随机一点，斜向划落（测试可指定方位角）。
    // 方位角用全局统一的 atan2(x, z) 约定，与 GameShip.heading 一致。
    const az = azOverride ?? Math.random() * Math.PI * 2;
    const el = 0.5 + Math.random() * 0.55;
    const r = 800;
    const x = cam.x + Math.sin(az) * Math.cos(el) * r;
    const y = Math.sin(el) * r;
    const z = cam.z + Math.cos(az) * Math.cos(el) * r;
    m.mesh.position.set(x, y, z);
    // 速度：沿方位角切向 + 下坠分量（同一 atan2(x,z) 约定）
    const tangent = az + Math.PI / 2;
    m.vel
      .set(Math.sin(tangent), 0, Math.cos(tangent))
      .multiplyScalar(420 + Math.random() * 160)
      .add(_down.set(0, -180 - Math.random() * 120, 0));
    const speed = m.vel.length();
    // 拉伸成亮痕：长轴对齐速度方向
    m.mesh.scale.set(speed * 0.32, 2.2, 1);
    m.mesh.lookAt(cam.x, y * 0.8, cam.z); // 大致面向相机
    m.mesh.rotateZ(Math.atan2(m.vel.y, Math.hypot(m.vel.x, m.vel.z)) * 0.6);
    m.age = 0;
    m.active = true;
    m.mesh.visible = true;
    (m.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
  }
}

const _down = new THREE.Vector3();

// ---------------------------------------------------------------- 总装

export class Phenomena {
  readonly object = new THREE.Group();
  private readonly fogBanks = new FogBanks();
  private readonly rainbow = new Rainbow();
  private readonly aurora = new Aurora();
  private readonly meteors: Meteors;

  constructor() {
    this.object.name = 'phenomena';
    this.object.add(this.fogBanks.object, this.rainbow.mesh, this.aurora.object);
    this.meteors = new Meteors(this.object);
  }

  update(dt: number, env: PhenomenaEnv): void {
    if (this.cameraQuaternion) _camQuat.copy(this.cameraQuaternion);
    this.fogBanks.update(dt, env);
    this.rainbow.update(dt, env);
    this.aurora.update(dt, env);
    this.meteors.update(dt, env);
  }

  /** 雾团 billboard 需要的相机姿态，由 App 每帧写入。 */
  cameraQuaternion: THREE.Quaternion | null = null;
}
