// 昼夜循环：太阳与月亮各自的独立轨道、天空与光照基底、星空与月盘
// 与天气系统解耦——本模块产出"时间基底"，天气（weather.js）在基底上做乘法调光
import * as THREE from 'three';

// ---- 参数 ----
const CYCLE_SECONDS = 360;              // 太阳日：一昼夜 6 分钟
const LUNAR_DAY = CYCLE_SECONDS * 24 / 23; // 太阴日略长：每天月升推迟 ~1/24 周期，多日可见相位漂移
const SUN_TILT = -0.35;                 // 太阳轨道平面 z 偏移
const MOON_TILT = 0.25;                 // 月亮轨道平面与太阳有夹角
const MOON_STRENGTH = 0.4;              // 月亮作为光源的强度系数（相对太阳）
const NIGHT_FLOOR = 0.12;               // 无月深夜的主光下限（天气系统还有总亮度下限兜底）
const MOON_WARM = new THREE.Color(0xffb070);  // 月出橙
const MOON_COLD = new THREE.Color(0xd8e4f8);  // 高悬冷白
const STAR_COUNT = 700;
const MOON_DIST = 830; // 天空穹顶（880）内侧

// 三时段基底（白天/黄昏/夜晚），按太阳仰角加权混合
const DAY = {
  zenith: new THREE.Color(0x2a76c2), horizon: new THREE.Color(0xcfe9f3), sunColor: new THREE.Color(0xffe6b0),
  light: 2.4, hemi: 0.9, exposure: 1.1, fogNear: 90, fogFar: 460,
};
const DUSK = {
  zenith: new THREE.Color(0x3a3f6e), horizon: new THREE.Color(0xf2a45c), sunColor: new THREE.Color(0xff9a4d),
  light: 1.6, hemi: 0.65, exposure: 1.05, fogNear: 80, fogFar: 420,
};
const NIGHT = {
  zenith: new THREE.Color(0x060d1f), horizon: new THREE.Color(0x16283e), sunColor: new THREE.Color(0xcfe0ff),
  light: 0.4, hemi: 0.25, exposure: 0.9, fogNear: 55, fogFar: 240,
};

export class DayTime {
  constructor({ scene, camera, skyUniforms, waterUniforms, sun }) {
    this.camera = camera;
    this.skyUniforms = skyUniforms;
    this.waterUniforms = waterUniforms;
    this.sun = sun; // 平行光（跟随混合后的主导光源）

    this.hour = 10;        // 太阳时，开局上午
    this.moonAge = 2.0;    // 月亮相位角（独立累积，开局已近上中天）
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.lightDir = new THREE.Vector3();   // 混合后的主导光源方向
    this.lightColor = new THREE.Color();   // 混合后的主导光源颜色
    this.zenith = DAY.zenith.clone();
    this.horizon = DAY.horizon.clone();
    this.sunColor = DAY.sunColor.clone();  // 天空太阳盘颜色（仅太阳）
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

    // 月亮：发光圆盘，跟随月亮自己的轨道
    this.moon = new THREE.Mesh(
      new THREE.CircleGeometry(26, 24),
      new THREE.MeshBasicMaterial({ color: 0xd8e4f8, transparent: true, opacity: 0, fog: false, depthWrite: false })
    );
    this.moon.visible = false;
    scene.add(this.moon);
  }

  get isNight() { return this.nightT > 0.5; }

  // HUD 点击：快进 1 小时（月亮相位按自身周期同步推进，保持两轨道一致演化）
  advance() {
    this.hour = (this.hour + 1) % 24;
    this.moonAge += ((CYCLE_SECONDS / 24) / LUNAR_DAY) * Math.PI * 2;
  }

  update(dt) {
    this.hour = (this.hour + (dt / CYCLE_SECONDS) * 24) % 24;
    this.moonAge += (dt / LUNAR_DAY) * Math.PI * 2;

    // 太阳方位：6:00 东方日出，18:00 西方日落
    const dayAngle = ((this.hour - 6) / 24) * Math.PI * 2;
    const sunElev = Math.sin(dayAngle);
    this.sunDir.set(Math.cos(dayAngle), sunElev, SUN_TILT).normalize();
    // 月亮方位：独立周期、独立轨道倾角
    const moonElev = Math.sin(this.moonAge);
    this.moonDir.set(Math.cos(this.moonAge), moonElev, MOON_TILT).normalize();

    // ---- 主导光源混合：权重按各自仰角 ----
    const sunW = THREE.MathUtils.smoothstep(sunElev, -0.04, 0.08);
    const moonW = THREE.MathUtils.smoothstep(moonElev, -0.04, 0.08) * MOON_STRENGTH;
    const domW = Math.min(1, sunW + moonW);

    // 时段权重（天空颜色仍由太阳驱动：白天/黄昏/夜晚）
    const dayT = THREE.MathUtils.smoothstep(sunElev, 0.08, 0.3);
    const nightT = THREE.MathUtils.smoothstep(-sunElev, 0.06, 0.22);
    const duskT = Math.max(0, 1 - dayT - nightT);
    this.nightT = nightT;
    this.daylight = dayT + duskT * 0.55; // 黄昏半暗，夜晚为 0

    // 太阳本体颜色（天空日盘/暖调用）
    const mixColor = (out, a, b, c) => out.setRGB(
      a.r * dayT + b.r * duskT + c.r * nightT,
      a.g * dayT + b.g * duskT + c.g * nightT,
      a.b * dayT + b.b * duskT + c.b * nightT
    );
    mixColor(this.zenith, DAY.zenith, DUSK.zenith, NIGHT.zenith);
    mixColor(this.horizon, DAY.horizon, DUSK.horizon, NIGHT.horizon);
    mixColor(this.sunColor, DAY.sunColor, DUSK.sunColor, NIGHT.sunColor);
    const baseLight = DAY.light * dayT + DUSK.light * duskT + NIGHT.light * nightT;
    this.hemi = DAY.hemi * dayT + DUSK.hemi * duskT + NIGHT.hemi * nightT;
    this.exposure = DAY.exposure * dayT + DUSK.exposure * duskT + NIGHT.exposure * nightT;
    this.fogNear = DAY.fogNear * dayT + DUSK.fogNear * duskT + NIGHT.fogNear * nightT;
    this.fogFar = DAY.fogFar * dayT + DUSK.fogFar * duskT + NIGHT.fogFar * nightT;

    // 月亮颜色随仰角：月出橙 → 高悬冷白
    const moonColdT = THREE.MathUtils.smoothstep(moonElev, 0.02, 0.35);
    const moonColor = new THREE.Color().lerpColors(MOON_WARM, MOON_COLD, moonColdT);

    // 光源方向/颜色 = 日月按权重混合；都无（深夜无月）退化为微弱天顶方向
    this.lightDir.set(0, 0.05, 0)
      .addScaledVector(this.sunDir, sunW)
      .addScaledVector(this.moonDir, moonW)
      .normalize();
    this.lightColor.setRGB(0, 0, 0)
      .addScaledVector(this.sunColor, sunW)
      .addScaledVector(moonColor, moonW);
    const wSum = Math.max(sunW + moonW, 1e-3);
    this.lightColor.multiplyScalar((0.15 + 0.85 * domW) / wSum); // 无月深夜几乎无高光，只剩暗反射

    // 平行光强度 = lerp(夜晚下限, 基底, 主导权重)
    this.light = THREE.MathUtils.lerp(NIGHT_FLOOR, baseLight, domW);

    // ---- 写入共享 uniform ----
    this.skyUniforms.uSunDir.value.copy(this.sunDir);      // 天空日盘跟真实太阳
    this.skyUniforms.uSunColor.value.copy(this.sunColor);
    this.waterUniforms.uSunDir.value.copy(this.lightDir);  // 水面高光/SSS/反射跟混合光源
    this.waterUniforms.uSunColor.value.copy(this.lightColor);
    this.waterUniforms.uLightElev.value = Math.max(0, this.lightDir.y); // 仰角驱动光路形态
    this.waterUniforms.uDaylight.value = this.daylight;
    this.sun.position.copy(this.lightDir).multiplyScalar(200);
    this.sun.color.copy(this.lightColor);

    // ---- 月亮盘：跟月亮轨道；贴地平线略放大偏暖 ----
    const moonVis = THREE.MathUtils.smoothstep(moonElev, -0.02, 0.12);
    this.moon.visible = moonVis > 0.01;
    if (this.moon.visible) {
      this.moon.material.opacity = moonVis * Math.max(nightT, 0.15); // 白天升起也淡淡可见
      this.moon.material.color.copy(moonColor);
      this.moon.position.copy(this.moonDir).multiplyScalar(MOON_DIST);
      this.moon.lookAt(this.camera.position);
      this.moon.scale.setScalar(1 + (1 - moonColdT) * 0.35); // 月出月落略放大
    }
    // 星星仍随夜色
    this.stars.visible = nightT > 0.02;
    this.starMat.opacity = nightT * 0.9;
  }
}
