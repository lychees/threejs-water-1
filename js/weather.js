// 天气系统：4 态预设（晴/多云/大雾/风暴）+ 平滑插值过渡
// 与昼夜（daytime.js）解耦：时间给出光照/颜色基底，天气在此之上做乘法调光
import * as THREE from 'three';
import { setWaveScale } from './water.js';

// ---- 天气预设表（所有可调参数集中于此；光照/雾距为相对时间基底的乘区） ----
// rain = 雨强（可见度/灭火阈值/音频联动）；rainDensity = 雨线密度；speedMul = 全船减速
export const PRESETS = {
  clear: {
    name: '晴朗', icon: '☀️',
    waveScale: 1.0, foamBoost: 0.0, cloud: 0.15, rain: 0, rainDensity: 0,
    speedMul: 1.0, lightMul: 1.0, fogMul: 1.0, grayT: 0.0,
  },
  cloudy: {
    name: '多云', icon: '⛅',
    waveScale: 0.85, foamBoost: 0.03, cloud: 0.55, rain: 0, rainDensity: 0,
    speedMul: 1.0, lightMul: 0.75, fogMul: 0.9, grayT: 0.35,
  },
  drizzle: {
    name: '小雨', icon: '🌦️',
    waveScale: 1.15, foamBoost: 0.06, cloud: 0.5, rain: 0.2, rainDensity: 0.2,
    speedMul: 1.0, lightMul: 0.85, fogMul: 0.95, grayT: 0.25,
  },
  rain: {
    name: '中雨', icon: '🌧️',
    waveScale: 1.3, foamBoost: 0.1, cloud: 0.6, rain: 0.45, rainDensity: 0.45,
    speedMul: 0.95, lightMul: 0.75, fogMul: 0.9, grayT: 0.35,
  },
  heavy: {
    name: '大雨', icon: '🌧️',
    waveScale: 1.5, foamBoost: 0.15, cloud: 0.68, rain: 0.7, rainDensity: 0.7,
    speedMul: 0.85, lightMul: 0.65, fogMul: 0.88, grayT: 0.42,
  },
  storm: {
    name: '暴风雨', icon: '⛈️',
    waveScale: 1.8, foamBoost: 0.22, cloud: 0.75, rain: 1.0, rainDensity: 1.0,
    speedMul: 0.75, lightMul: 0.55, fogMul: 0.85, grayT: 0.5,
  },
  fog: {
    name: '大雾', icon: '🌫️',
    waveScale: 0.7, foamBoost: 0.0, cloud: 0.6, rain: 0, rainDensity: 0,
    speedMul: 0.9, lightMul: 0.85, fogMul: 0.38, grayT: 0.7,
  },
};

const PRESET_KEYS = Object.keys(PRESETS);
const MIN_INTERVAL = 120, MAX_INTERVAL = 240; // 自动切换间隔（2~4 分钟）
const RAIN_DROPS = 1200;            // 雨线条数（LineSegments）
const RAIN_AREA = 60;               // 相机周围的降雨范围（米）
const RAIN_TOP = 28;                // 雨滴生成高度
const WIND_X = 6;                   // 风暴横向风速（雨倾斜）
const MIN_BRIGHTNESS = 0.35;        // 主光+半球光强度下限（防夜晚+风暴黑到看不见）
const GRAY = new THREE.Color(0x6a7a85); // 阴雨灰化目标色

const NUM_FIELDS = ['waveScale', 'foamBoost', 'cloud', 'rain', 'rainDensity', 'speedMul', 'lightMul', 'fogMul', 'grayT'];

function rand(min, max) { return min + Math.random() * (max - min); }
const lerp = (a, b, t) => a + (b - a) * t;

function snapshot(src) {
  const out = {};
  for (const f of NUM_FIELDS) out[f] = src[f];
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
    this.params = snapshot(PRESETS.clear);
    this.timer = rand(MIN_INTERVAL, MAX_INTERVAL);
    this.flash = 0;                       // 闪电余晖
    this.qualityMul = 1;                  // 画质档位的雨密度系数
    this.fogColor = new THREE.Color(0xcfe9f3); // 供水下雾插值做水上面
    this.fogNearV = 90;
    this.fogFarV = 460;

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
  }

  // ---- 对外接口 ----
  get strength() { return this.params.rain; } // 雨强（音频联动沿用）
  get fireOut() { return this.params.rain >= 0.15; } // 小雨及以上：灭火 & 不新附着火
  get speedMul() { return this.params.speedMul; }
  get fogNear() { return this.fogNearV; }
  get fogFar() { return this.fogFarV; }
  get icon() { return PRESETS[this.current].icon; }
  get name() { return PRESETS[this.current].name; }

  // 手动循环切换：晴→多云→雾→风暴（重置自动计时器）
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

  /**
   * @param {DayTime} day 昼夜基底（daytime.js 本帧输出）
   */
  update(dt, day) {
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

    // ---- 天气独有通道 ----
    setWaveScale(p.waveScale);
    this.waterUniforms.uFoamBoost.value = p.foamBoost;
    this.waterUniforms.uCloudAmount.value = p.cloud;

    // ---- 时间基底 × 天气调光 ----
    // 天空/水面高光色：随时间基底，阴雨按 grayT 灰化
    this.skyUniforms.uZenith.value.lerpColors(day.zenith, GRAY, p.grayT * 0.7);
    this.skyUniforms.uHorizon.value.lerpColors(day.horizon, GRAY, p.grayT * 0.7);
    this.skyUniforms.uSunColor.value.copy(day.sunColor);
    this.waterUniforms.uSunColor.value.copy(day.sunColor);
    // 雾：颜色灰化 + 距离乘区
    this.fogColor.lerpColors(day.horizon, GRAY, p.grayT * 0.8);
    this.fogNearV = day.fogNear * p.fogMul;
    this.fogFarV = day.fogFar * p.fogMul;
    // 曝光随时间基底微调（阴雨略压）
    this.renderer.toneMappingExposure = day.exposure * (1 - p.grayT * 0.08);

    // 光照：乘法叠加，主光+半球光不低于下限；闪电只加在半球光上
    this.sun.intensity = day.light * p.lightMul;
    if (p.rain > 0.7 && Math.random() < dt * 0.12) this.flash = 1;
    this.flash *= Math.exp(-dt * 5);
    let hemiI = day.hemi * p.lightMul;
    if (this.sun.intensity + hemiI < MIN_BRIGHTNESS) hemiI = MIN_BRIGHTNESS - this.sun.intensity;
    this.hemi.intensity = hemiI + this.flash * 2.5;

    // ---- 雨（密度 = 预设密度 × 画质密度） ----
    this.rain.visible = p.rain > 0.03;
    this.rainMat.opacity = p.rain * 0.55;
    this.rainGeo.setDrawRange(0, Math.floor(RAIN_DROPS * p.rainDensity * this.qualityMul) * 2);
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

  // 画质档位：低密度时裁剪雨滴（与预设密度相乘）
  setRainDensity(mul) {
    this.qualityMul = mul;
    this.rainGeo.setDrawRange(0, Math.floor(RAIN_DROPS * this.params.rainDensity * mul) * 2);
  }
}
