// 昼夜循环：太阳/月亮方位、天空与光照基底、星空与月盘
// 与天气系统解耦——本模块产出"时间基底"，天气（weather.js）在基底上做乘法调光
import * as THREE from 'three';

// ---- 参数（一昼夜 6 分钟；三时段基底按太阳仰角加权混合） ----
const CYCLE_SECONDS = 360;
const DAY = {
  zenith: new THREE.Color(0x2a76c2), horizon: new THREE.Color(0xcfe9f3), sunColor: new THREE.Color(0xffe6b0),
  light: 2.4, hemi: 0.9, exposure: 1.1, fogNear: 90, fogFar: 460,
};
const DUSK = { // 日出日落过渡带（权重 = 1 - 白天 - 夜晚）
  zenith: new THREE.Color(0x3a3f6e), horizon: new THREE.Color(0xf2a45c), sunColor: new THREE.Color(0xff9a4d),
  light: 1.6, hemi: 0.65, exposure: 1.05, fogNear: 80, fogFar: 420,
};
const NIGHT = {
  zenith: new THREE.Color(0x060d1f), horizon: new THREE.Color(0x16283e), sunColor: new THREE.Color(0xcfe0ff), // 月光冷白
  light: 0.4, hemi: 0.25, exposure: 0.9, fogNear: 55, fogFar: 240,
};
const STAR_COUNT = 700;
const MOON_DIST = 830; // 天空穹顶（880）内侧

export class DayTime {
  constructor({ scene, camera, skyUniforms, waterUniforms, sun }) {
    this.camera = camera;
    this.skyUniforms = skyUniforms;
    this.waterUniforms = waterUniforms;
    this.sun = sun; // 平行光（白天=阳光，夜晚=月光）

    this.hour = 10; // 开局上午
    this.sunDir = new THREE.Vector3();
    this.lightDir = new THREE.Vector3();   // 实际光源方向（夜晚切换到月亮）
    this._moonDir = new THREE.Vector3();
    this.zenith = DAY.zenith.clone();
    this.horizon = DAY.horizon.clone();
    this.sunColor = DAY.sunColor.clone();
    this.light = DAY.light;
    this.hemi = DAY.hemi;
    this.exposure = DAY.exposure;
    this.fogNear = DAY.fogNear;
    this.fogFar = DAY.fogFar;
    this.nightT = 0;
    this.daylight = 1; // 0 夜 ~ 1 昼（写入水面 uDaylight，夜晚压暗海面）

    // 星空：上半球随机点，夜晚淡入
    const starPos = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(1 - Math.random() * 0.95);
      starPos[i * 3] = MOON_DIST * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = MOON_DIST * Math.cos(phi);
      starPos[i * 3 + 2] = MOON_DIST * Math.sin(phi) * Math.sin(theta);
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

    // 月亮：发光圆盘，与太阳反向运行
    this.moon = new THREE.Mesh(
      new THREE.CircleGeometry(26, 24),
      new THREE.MeshBasicMaterial({ color: 0xe8f0ff, transparent: true, opacity: 0, fog: false, depthWrite: false })
    );
    this.moon.visible = false;
    scene.add(this.moon);
  }

  get isNight() { return this.nightT > 0.5; }

  // HUD 点击：快进 1 小时
  advance() {
    this.hour = (this.hour + 1) % 24;
  }

  update(dt) {
    this.hour = (this.hour + (dt / CYCLE_SECONDS) * 24) % 24;

    // 太阳方位：6:00 东方日出，18:00 西方日落，夜晚落到地平线下
    const dayAngle = ((this.hour - 6) / 24) * Math.PI * 2;
    const elev = Math.sin(dayAngle);
    this.sunDir.set(Math.cos(dayAngle), elev, -0.35).normalize();

    // 时段权重：白天 / 黄昏（过渡带）/ 夜晚
    const dayT = THREE.MathUtils.smoothstep(elev, 0.08, 0.3);
    const nightT = THREE.MathUtils.smoothstep(-elev, 0.06, 0.22);
    const duskT = Math.max(0, 1 - dayT - nightT);
    this.nightT = nightT;
    this.daylight = dayT + duskT * 0.55; // 黄昏半暗，夜晚为 0

    // 基底混合
    const mixColor = (out, a, b, c) => out.setRGB(
      a.r * dayT + b.r * duskT + c.r * nightT,
      a.g * dayT + b.g * duskT + c.g * nightT,
      a.b * dayT + b.b * duskT + c.b * nightT
    );
    mixColor(this.zenith, DAY.zenith, DUSK.zenith, NIGHT.zenith);
    mixColor(this.horizon, DAY.horizon, DUSK.horizon, NIGHT.horizon);
    mixColor(this.sunColor, DAY.sunColor, DUSK.sunColor, NIGHT.sunColor);
    this.light = DAY.light * dayT + DUSK.light * duskT + NIGHT.light * nightT;
    this.hemi = DAY.hemi * dayT + DUSK.hemi * duskT + NIGHT.hemi * nightT;
    this.exposure = DAY.exposure * dayT + DUSK.exposure * duskT + NIGHT.exposure * nightT;
    this.fogNear = DAY.fogNear * dayT + DUSK.fogNear * duskT + NIGHT.fogNear * nightT;
    this.fogFar = DAY.fogFar * dayT + DUSK.fogFar * duskT + NIGHT.fogFar * nightT;

    // 实际光源方向：夜晚太阳落到地平线下后切换为月亮（反向），避免光从水下打上来
    this._moonDir.copy(this.sunDir).negate();
    if (elev > -0.05) this.lightDir.copy(this.sunDir);
    else this.lightDir.copy(this._moonDir);

    // 写入共享 uniform：天空穹顶的太阳盘跟真实太阳，水面高光/反射跟实际光源（夜晚=月亮）
    this.skyUniforms.uSunDir.value.copy(this.sunDir);
    this.waterUniforms.uSunDir.value.copy(this.lightDir);
    this.waterUniforms.uDaylight.value = this.daylight;
    this.sun.position.copy(this.lightDir).multiplyScalar(200);

    // 月亮与星星
    this.moon.visible = nightT > 0.02;
    this.moon.material.opacity = nightT;
    if (this.moon.visible) {
      this.moon.position.copy(this._moonDir).multiplyScalar(MOON_DIST);
      this.moon.lookAt(this.camera.position);
    }
    this.stars.visible = nightT > 0.02;
    this.starMat.opacity = nightT * 0.9;
  }
}
