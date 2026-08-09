// 天气系统：晴天 ⇄ 风暴，平滑过渡；驱动波幅/白沫/云影/天空/光照/雨/闪电
import * as THREE from 'three';
import { setWaveScale } from './water.js';

// ---- 两套天气参数（过渡期间逐项 lerp） ----
const CLEAR = {
  waveScale: 1.0, foamBoost: 0.0, cloud: 0.15,
  zenith: new THREE.Color(0x2a76c2), horizon: new THREE.Color(0xcfe9f3),
  sun: 2.4, hemi: 0.9, exposure: 1.1,
};
const STORM = {
  waveScale: 1.8, foamBoost: 0.22, cloud: 0.75,
  zenith: new THREE.Color(0x39485a), horizon: new THREE.Color(0x6b7d88),
  sun: 0.9, hemi: 0.5, exposure: 0.95,
};
const TRANSITION_TIME = 45;         // 过渡秒数（30~60 区间中值）
const MIN_INTERVAL = 120, MAX_INTERVAL = 240; // 随机切换间隔（2~4 分钟）
const RAIN_DROPS = 1200;            // 雨线条数（LineSegments）
const RAIN_AREA = 60;               // 相机周围的降雨范围（米）
const RAIN_TOP = 28;                // 雨滴生成高度
const WIND_X = 6;                   // 风暴横向风速（雨倾斜）

function rand(min, max) { return min + Math.random() * (max - min); }
const lerp = (a, b, t) => a + (b - a) * t;

export class Weather {
  constructor({ scene, camera, renderer, waterUniforms, skyUniforms, sun, hemi }) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.waterUniforms = waterUniforms;
    this.skyUniforms = skyUniforms;
    this.sun = sun;
    this.hemi = hemi;

    this.strength = 0;              // 0 晴天 ~ 1 风暴
    this.target = 0;
    this.timer = rand(MIN_INTERVAL, MAX_INTERVAL);
    this.fogColor = CLEAR.horizon.clone(); // 供 main 的水下雾插值做水上面
    this.flash = 0;                 // 闪电余晖
    this.rainDensity = 1;           // 画质档位缩放

    // 雨：相机跟随的斜落线条（线段对，局部坐标围绕原点，mesh 跟随相机）
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

  get isStorm() { return this.strength > 0.5; }

  update(dt) {
    // 随机切换
    this.timer -= dt;
    if (this.timer <= 0) {
      this.target = this.target > 0.5 ? 0 : 1;
      this.timer = rand(MIN_INTERVAL, MAX_INTERVAL);
    }
    const step = dt / TRANSITION_TIME;
    this.strength += THREE.MathUtils.clamp(this.target - this.strength, -step, step);
    const t = this.strength;

    // ---- 各参数 lerp 应用 ----
    setWaveScale(lerp(CLEAR.waveScale, STORM.waveScale, t));
    this.waterUniforms.uFoamBoost.value = lerp(CLEAR.foamBoost, STORM.foamBoost, t);
    this.waterUniforms.uCloudAmount.value = lerp(CLEAR.cloud, STORM.cloud, t);
    this.skyUniforms.uZenith.value.lerpColors(CLEAR.zenith, STORM.zenith, t);
    this.skyUniforms.uHorizon.value.lerpColors(CLEAR.horizon, STORM.horizon, t);
    this.fogColor.copy(this.skyUniforms.uHorizon.value);
    this.sun.intensity = lerp(CLEAR.sun, STORM.sun, t);
    this.renderer.toneMappingExposure = lerp(CLEAR.exposure, STORM.exposure, t);

    // 闪电：风暴成熟期随机闪烁（半球光瞬时增强）
    if (t > 0.7 && Math.random() < dt * 0.12) this.flash = 1;
    this.flash *= Math.exp(-dt * 5);
    this.hemi.intensity = lerp(CLEAR.hemi, STORM.hemi, t) + this.flash * 2.5;

    // ---- 雨 ----
    this.rain.visible = t > 0.03;
    this.rainMat.opacity = t * 0.55;
    if (this.rain.visible) {
      this.rain.position.copy(this.camera.position);
      const pos = this.rainGeo.attributes.position;
      const wx = WIND_X * t;
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
        // 线段：沿落向倾斜
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
