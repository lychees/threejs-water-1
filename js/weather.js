// 天气系统：6 态预设（晴/多云/黄昏/夜晚/大雾/风暴）+ 平滑插值过渡
// 驱动：波幅/白沫/云影/天空/光照/雾距/雨/闪电/星空/全船减速
import * as THREE from 'three';
import { setWaveScale } from './water.js';

// ---- 天气预设表（所有可调参数集中于此） ----
export const PRESETS = {
  clear: {
    name: '晴朗', icon: '☀️',
    waveScale: 1.0, foamBoost: 0.0, cloud: 0.15,
    zenith: 0x2a76c2, horizon: 0xcfe9f3, sunColor: 0xffe6b0,
    sun: 2.4, hemi: 0.9, exposure: 1.1,
    rain: 0, night: 0, fogNear: 90, fogFar: 460, speedMul: 1.0,
  },
  cloudy: {
    name: '多云', icon: '⛅',
    waveScale: 0.85, foamBoost: 0.03, cloud: 0.5,
    zenith: 0x6a8fb5, horizon: 0xc4d4dc, sunColor: 0xf0e2c8,
    sun: 1.6, hemi: 0.85, exposure: 1.05,
    rain: 0, night: 0, fogNear: 80, fogFar: 400, speedMul: 1.0,
  },
  dusk: {
    name: '黄昏', icon: '🌇',
    waveScale: 1.0, foamBoost: 0.0, cloud: 0.3,
    zenith: 0x3a3f6e, horizon: 0xf2a45c, sunColor: 0xff9a4d,
    sun: 1.6, hemi: 0.7, exposure: 1.05,
    rain: 0, night: 0, fogNear: 80, fogFar: 420, speedMul: 1.0,
  },
  night: {
    name: '夜晚', icon: '🌙',
    waveScale: 0.9, foamBoost: 0.0, cloud: 0.1,
    zenith: 0x060d1f, horizon: 0x16283e, sunColor: 0xcfe0ff, // 月光：冷白弱光
    sun: 0.5, hemi: 0.25, exposure: 0.9,
    rain: 0, night: 1, fogNear: 60, fogFar: 260, speedMul: 1.0,
  },
  fog: {
    name: '大雾', icon: '🌫️',
    waveScale: 0.7, foamBoost: 0.0, cloud: 0.6,
    zenith: 0x9aa5ab, horizon: 0xb8c0c4, sunColor: 0xe8e8e2,
    sun: 0.7, hemi: 1.0, exposure: 1.0,
    rain: 0, night: 0, fogNear: 40, fogFar: 160, speedMul: 0.9,
  },
  storm: {
    name: '风暴', icon: '⛈️',
    waveScale: 1.8, foamBoost: 0.22, cloud: 0.75,
    zenith: 0x39485a, horizon: 0x6b7d88, sunColor: 0xd8d8d0,
    sun: 0.9, hemi: 0.5, exposure: 0.95,
    rain: 1, night: 0, fogNear: 70, fogFar: 380, speedMul: 0.75,
  },
};

const PRESET_KEYS = Object.keys(PRESETS);
const MIN_INTERVAL = 120, MAX_INTERVAL = 240; // 自动切换间隔（2~4 分钟）
const RAIN_DROPS = 1200;            // 雨线条数（LineSegments）
const RAIN_AREA = 60;               // 相机周围的降雨范围（米）
const RAIN_TOP = 28;                // 雨滴生成高度
const WIND_X = 6;                   // 风暴横向风速（雨倾斜）
const STAR_COUNT = 700;             // 星空点数

// 数值字段与颜色字段分开插值
const NUM_FIELDS = ['waveScale', 'foamBoost', 'cloud', 'sun', 'hemi', 'exposure', 'rain', 'night', 'fogNear', 'fogFar', 'speedMul'];
const COLOR_FIELDS = ['zenith', 'horizon', 'sunColor'];

function rand(min, max) { return min + Math.random() * (max - min); }
const lerp = (a, b, t) => a + (b - a) * t;

// 预设（hex 数字）或运行中参数（Color 实例）都能快照
function snapshot(src) {
  const out = {};
  for (const f of NUM_FIELDS) out[f] = src[f];
  for (const f of COLOR_FIELDS) out[f] = src[f] instanceof THREE.Color ? src[f].clone() : new THREE.Color(src[f]);
  return out;
}

export class Weather {
  constructor({ scene, camera, renderer, waterUniforms, skyUniforms, sun, hemi }) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.waterUniforms = waterUniforms;
    this.skyUniforms = skyUniforms;
    this.sun = sun;
    this.hemi = hemi;

    this.current = 'clear';
    this.blend = 1;                       // 1 = 已到达 current
    this.transitionTime = 40;             // 过渡秒数（30~45 随机）
    this.from = snapshot(PRESETS.clear);
    this.to = snapshot(PRESETS.clear);
    this.params = snapshot(PRESETS.clear); // 当前显示参数（逐帧 lerp）
    this.timer = rand(MIN_INTERVAL, MAX_INTERVAL);
    this.flash = 0;                       // 闪电余晖
    this.fogColor = new THREE.Color(PRESETS.clear.horizon); // 供水下雾插值做水上面

    // ---- 雨：相机跟随的斜落线条 ----
    const positions = new Float32Array(RAIN_DROPS * 2 * 3);
    this.drops = [];
    for (let i = 0; i < RAIN_DROPS; i++) {
      this.drops.push({
        x: rand(-RAIN_AREA / 2, RAIN_AREA / 2),
        y: rand(0, RAIN_TOP),
        z: rand(-RAIN_AREA / 2, RAIN_AREA / 2),
        speed: rand(18, 26),
      });
    }
    this.rainGeo = new THREE.BufferGeometry();
    this.rainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.rainMat = new THREE.LineBasicMaterial({ color: 0xafc8d8, transparent: true, opacity: 0 });
    this.rain = new THREE.LineSegments(this.rainGeo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);

    // ---- 星空：上半球随机点，只在夜晚淡入 ----
    const starPos = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      // 上半球均匀采样
      const u = Math.random();
      const v = Math.random();
      const theta = Math.PI * 2 * u;
      const phi = Math.acos(1 - v * 0.95); // 靠近天顶多一些
      const r = 820;
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.cos(phi);
      starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.8, sizeAttenuation: false,
      transparent: true, opacity: 0, fog: false, depthWrite: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.visible = false;
    scene.add(this.stars);
  }

  // ---- 对外接口（兼容既有调用） ----
  get strength() { return this.params.rain; } // 雨天强度（灭火/减速/音频沿用）
  get speedMul() { return this.params.speedMul; }
  get fogNear() { return this.params.fogNear; }
  get fogFar() { return this.params.fogFar; }
  get icon() { return PRESETS[this.current].icon; }
  get name() { return PRESETS[this.current].name; }

  // 手动循环切换：晴→多云→黄昏→夜→雾→风暴（重置自动计时器）
  toggle() {
    const next = PRESET_KEYS[(PRESET_KEYS.indexOf(this.current) + 1) % PRESET_KEYS.length];
    this.switchTo(next);
  }

  switchTo(key) {
    if (key === this.current) return;
    this.from = snapshot(this.params); // 从当前插值状态平滑接续
    this.to = snapshot(PRESETS[key]);
    this.current = key;
    this.blend = 0;
    this.transitionTime = rand(30, 45);
    this.timer = rand(MIN_INTERVAL, MAX_INTERVAL);
  }

  update(dt) {
    // 自动切换：随机跳到另一种天气
    this.timer -= dt;
    if (this.timer <= 0) {
      let next = this.current;
      while (next === this.current) next = PRESET_KEYS[Math.floor(Math.random() * PRESET_KEYS.length)];
      this.switchTo(next);
    }
    if (this.blend < 1) this.blend = Math.min(1, this.blend + dt / this.transitionTime);

    const p = this.params;
    for (const f of NUM_FIELDS) p[f] = lerp(this.from[f], this.to[f], this.blend);
    for (const f of COLOR_FIELDS) p[f].lerpColors(this.from[f], this.to[f], this.blend);

    // ---- 应用 ----
    setWaveScale(p.waveScale);
    this.waterUniforms.uFoamBoost.value = p.foamBoost;
    this.waterUniforms.uCloudAmount.value = p.cloud;
    this.waterUniforms.uSunColor.value.copy(p.sunColor); // 水面高光/反射联动变色
    this.skyUniforms.uZenith.value.copy(p.zenith);
    this.skyUniforms.uHorizon.value.copy(p.horizon);
    this.skyUniforms.uSunColor.value.copy(p.sunColor);
    this.fogColor.copy(p.horizon);
    this.sun.intensity = p.sun;
    this.sun.color.copy(p.sunColor);
    this.renderer.toneMappingExposure = p.exposure;

    // 闪电：仅雨强高（风暴）时随机闪烁
    if (p.rain > 0.7 && Math.random() < dt * 0.12) this.flash = 1;
    this.flash *= Math.exp(-dt * 5);
    this.hemi.intensity = p.hemi + this.flash * 2.5;

    // 星空
    this.stars.visible = p.night > 0.02;
    this.starMat.opacity = p.night * 0.9;

    // 雨
    this.rain.visible = p.rain > 0.03;
    this.rainMat.opacity = p.rain * 0.55;
    if (this.rain.visible) {
      this.rain.position.copy(this.camera.position);
      const pos = this.rainGeo.attributes.position;
      const wx = WIND_X * p.rain;
      for (let i = 0; i < this.drops.length; i++) {
        const d = this.drops[i];
        d.y -= d.speed * dt;
        d.x += wx * dt;
        if (d.y < 0) {
          d.y = RAIN_TOP;
          d.x = rand(-RAIN_AREA / 2, RAIN_AREA / 2);
          d.z = rand(-RAIN_AREA / 2, RAIN_AREA / 2);
        }
        if (d.x > RAIN_AREA / 2) d.x -= RAIN_AREA;
        pos.setXYZ(i * 2, d.x, d.y, d.z);
        pos.setXYZ(i * 2 + 1, d.x - wx * 0.04, d.y + 0.7, d.z);
      }
      pos.needsUpdate = true;
    }
  }

  // 画质档位：低密度时裁剪一半雨滴
  setRainDensity(mul) {
    this.rainDensity = mul;
    this.rainGeo.setDrawRange(0, Math.floor(RAIN_DROPS * mul) * 2);
  }
}
