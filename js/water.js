// 水面：Gerstner 大波位移 + 细节法线 + 次表面散射 + Jacobian 白沫 + 天空反射
import * as THREE from 'three';
import { SKY_GLSL, SKY_COLORS } from './sky.js';

// 波形参数表：CPU（浮力）与 GPU（顶点着色器）共用同一份，保证一致
// dir 会自动归一化；amp 振幅；len 波长；q 波峰尖锐度(0~1)
const RAW_WAVES = [
  { dir: [1.00,  0.15], amp: 0.55, len: 60.0, q: 0.45 },
  { dir: [0.80,  0.60], amp: 0.38, len: 31.0, q: 0.45 },
  { dir: [-0.50, 0.90], amp: 0.28, len: 18.0, q: 0.40 },
  { dir: [0.30, -1.00], amp: 0.17, len: 9.0,  q: 0.30 },
  { dir: [-0.90, -0.40], amp: 0.11, len: 5.5, q: 0.30 },
  { dir: [0.20,  0.98], amp: 0.07, len: 3.2,  q: 0.20 },
];

const WAVE_COUNT = RAW_WAVES.length;

// 预处理：归一化方向，预计算波数 k 与角频率 omega（深水色散关系 ω=√(g·k)）
const WAVES = RAW_WAVES.map((w) => {
  const l = Math.hypot(w.dir[0], w.dir[1]);
  const dx = w.dir[0] / l;
  const dz = w.dir[1] / l;
  const k = (Math.PI * 2) / w.len;
  const omega = Math.sqrt(9.8 * k);
  return { dx, dz, amp: w.amp, k, omega, q: w.q };
});

// CPU 端波高采样（供浮力 / 落水判定使用；忽略水平位移，q 较小误差可接受）
// 天气系统通过 setWaveScale 全局缩放振幅，CPU 与 GPU 保持一致
let cpuWaveScale = 1;
let waterUniforms = null; // createWater 后指向其 uniforms
export function setWaveScale(s) {
  cpuWaveScale = s;
  if (waterUniforms) waterUniforms.uWaveScale.value = s;
}

export function getWaveHeight(x, z, t) {
  let y = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const w = WAVES[i];
    y += w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.omega * t);
  }
  return y * cpuWaveScale;
}

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uWaveScale;            // 天气驱动的振幅全局缩放（与 CPU 浮力一致）
  uniform vec4 uWaves[${WAVE_COUNT}];  // dirX, dirZ, amp, k
  uniform vec4 uWave2[${WAVE_COUNT}];  // omega, q, -, -

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;               // 归一化波高 0~1
  varying float vFoam;                 // 由雅可比行列式推得的破浪强度

  #include <fog_pars_vertex>

  void main() {
    vec2 xz = position.xz;             // 以静止位置计算相位（标准 Gerstner 做法）
    vec3 disp = vec3(0.0);
    vec3 n = vec3(0.0, 1.0, 0.0);
    float ampSum = 0.0;
    // 水平位移梯度（雅可比矩阵元），用于检测波峰卷破
    float dxx = 0.0;
    float dzz = 0.0;
    float dxz = 0.0;

    for (int i = 0; i < ${WAVE_COUNT}; i++) {
      vec2 d = uWaves[i].xy;
      float amp = uWaves[i].z * uWaveScale;
      float k = uWaves[i].w;
      float omega = uWave2[i].x;
      float q = uWave2[i].y;

      float f = k * dot(d, xz) - omega * uTime;
      float s = sin(f);
      float c = cos(f);

      disp.x += q * amp * d.x * c;     // 水平位移让波峰变尖
      disp.z += q * amp * d.y * c;
      disp.y += amp * s;

      // 法线用 y 对 x/z 的偏导近似（与 CPU 采样一致）
      n.x -= d.x * k * amp * c;
      n.z -= d.y * k * amp * c;
      ampSum += amp;

      // 水平位移对静止坐标的偏导
      float qs = q * amp * k * s;
      dxx -= d.x * d.x * qs;
      dzz -= d.y * d.y * qs;
      dxz -= d.x * d.y * qs;
    }

    vec3 p = position + disp;
    vHeight = disp.y / ampSum * 0.5 + 0.5;
    vNormal = normalize(n);

    // 雅可比行列式：J 越小说明水面折叠越厉害（波峰卷破），波幅温和故放大系数
    float J = (1.0 + dxx) * (1.0 + dzz) - dxz * dxz;
    vFoam = clamp((1.0 - J) * 5.0, 0.0, 1.0);

    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorldPos = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uSSSColor;
  uniform vec3 uFoamColor;
  uniform vec4 uIslands[4]; // x, z, 碎浪带半径, 呼吸相位（半径为 0 表示空槽位）
  uniform float uFoamBoost;    // 天气驱动：风暴时白沫阈值降低
  uniform float uCloudAmount;  // 云影强度（晴天淡、风暴浓）
  uniform float uDetailWaves;  // 细节小波数量上限（画质档位）

  ${SKY_GLSL}

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;
  varying float vFoam;

  #include <fog_pars_fragment>

  // 廉价二维值噪声（泡沫打散、太阳闪点）
  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main() {
    vec3 toCam = cameraPosition - vWorldPos;
    float camDist = length(toCam);
    vec3 v = toCam / camDist;

    // ---- 细节法线：10 个高频小波（只扰动法线不做位移，随距离衰减防远处闪烁） ----
    vec3 n = normalize(vNormal);
    float detailFade = 1.0 - smoothstep(40.0, 170.0, camDist);
    if (detailFade > 0.001 && uDetailWaves > 0.5) {
      vec2 dn = vec2(0.0);
      for (int i = 0; i < 10; i++) {
        if (float(i) >= uDetailWaves) break; // 画质档位控制
        float fi = float(i);
        float ang = fi * 2.39996 + 0.7;        // 黄金角让方向均匀分散
        vec2 d = vec2(cos(ang), sin(ang));
        float len = 0.5 + fi * 0.6;            // 波长 0.5 ~ 5.9 m
        float k = 6.28318 / len;
        float amp = 0.010 + fi * 0.004;
        float omega = sqrt(9.8 * k) * 1.4;     // 涟漪跑得比深水色散快一点，更活泼
        float f = k * dot(d, vWorldPos.xz) - omega * uTime;
        dn -= d * (k * amp * cos(f));
      }
      n = normalize(n + vec3(dn.x, 0.0, dn.y) * detailFade);
    }

    // ---- 基础色：深蓝 -> 青绿随波高渐变 ----
    vec3 col = mix(uDeepColor, uShallowColor, vHeight);

    // ---- 天空反射：反射向量查与天空穹顶同一个 skyColor()，水天无缝 ----
    vec3 r = reflect(-v, n);
    r.y = abs(r.y);                            // 不允许反射到海平面以下
    vec3 refl = skyColor(r);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0); // Schlick
    col = mix(col, refl, clamp(fres * 1.1, 0.0, 1.0));

    // ---- 云影：大尺度慢速漂移噪声暗化（与天气联动） ----
    float cloudN = vnoise(vWorldPos.xz * 0.006 + vec2(uTime * 0.008, uTime * 0.005));
    col *= mix(1.0, 0.8 + 0.2 * cloudN, uCloudAmount);

    // ---- 次表面散射：视线朝向太阳时，浪峰透出青绿辉光 ----
    float crest = smoothstep(0.45, 0.95, vHeight);
    float sss = pow(max(dot(v, uSunDir), 0.0), 3.0) * crest;
    col += uSSSColor * sss * 0.55;

    // ---- 太阳高光：宽高光 + 噪声调制的窄闪点（glitter） ----
    vec3 h = normalize(uSunDir + v);
    float ndh = max(dot(n, h), 0.0);
    col += uSunColor * pow(ndh, 260.0) * 1.2;
    float g = vnoise(vWorldPos.xz * 22.0 + vec2(uTime * 1.8, -uTime * 1.3));
    float glitter = pow(ndh, 520.0) * smoothstep(0.55, 0.95, g);
    col += uSunColor * glitter * 3.0 * (0.3 + 0.7 * detailFade);

    // ---- 破浪白沫：雅可比 + 波高阈值，噪声打散边缘，波谷渐隐 ----
    float foamN = vnoise(vWorldPos.xz * 2.3 + vec2(uTime * 0.12, -uTime * 0.09));
    float foamBase = clamp(vFoam * 1.1 + smoothstep(0.6, 0.92, vHeight) * 0.55 + uFoamBoost, 0.0, 1.0);
    float foam = smoothstep(0.42, 0.72, foamBase + (foamN - 0.5) * 0.45);
    foam *= smoothstep(0.28, 0.5, vHeight);            // 波谷处泡沫渐隐

    // ---- 岛屿浅水碎浪带：碰撞半径附近一圈泡沫，噪声打散 + 随时间呼吸 ----
    float surf = 0.0;
    for (int i = 0; i < 4; i++) {
      float ir = uIslands[i].z;
      if (ir < 0.1) continue;
      float rr = ir + sin(uTime * 0.7 + uIslands[i].w) * 1.5; // 呼吸
      float d = distance(vWorldPos.xz, uIslands[i].xy);
      surf = max(surf, 1.0 - smoothstep(0.0, 7.0, abs(d - rr)));
    }
    float surfN = vnoise(vWorldPos.xz * 1.6 + vec2(uTime * 0.25, -uTime * 0.18));
    surf *= 0.55 + 0.45 * surfN;
    foam = max(foam, surf);

    foam *= 1.0 - smoothstep(150.0, 320.0, camDist);   // 远处淡出防摩尔纹
    col = mix(col, uFoamColor, clamp(foam, 0.0, 1.0) * 0.9);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createWater(sunDir, islands = []) {
  const geo = new THREE.PlaneGeometry(1000, 1000, 256, 256);
  geo.rotateX(-Math.PI / 2); // 躺平到 xz 平面，position.y 全为 0

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uWaveScale: { value: 1 },
      uFoamBoost: { value: 0 },
      uCloudAmount: { value: 0.15 },
      uDetailWaves: { value: 10 },
      uDeepColor: { value: new THREE.Color(0x0b3b5e) },
      uShallowColor: { value: new THREE.Color(0x1e9e9a) },
      uSSSColor: { value: new THREE.Color(0x35d0b0) },
      uFoamColor: { value: new THREE.Color(0xf2fbfc) },
      // 与天空穹顶共用同一组参数（SKY_GLSL 里声明的 uniform）
      uZenith: { value: SKY_COLORS.zenith.clone() },
      uHorizon: { value: SKY_COLORS.horizon.clone() },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: SKY_COLORS.sun.clone() },
    },
  ]);
  // merge 之后再把波形数组填进去（数组不便走 merge）
  uniforms.uWaves = { value: WAVES.map((w) => new THREE.Vector4(w.dx, w.dz, w.amp, w.k)) };
  uniforms.uWave2 = { value: WAVES.map((w) => new THREE.Vector4(w.omega, w.q, 0, 0)) };
  // 岛屿碎浪带：x, z, 半径, 呼吸相位；空槽位半径为 0
  uniforms.uIslands = {
    value: [0, 1, 2, 3].map((i) => islands[i]
      ? new THREE.Vector4(islands[i].x, islands[i].z, islands[i].radius, i * 1.7)
      : new THREE.Vector4(0, 0, 0, 0)),
  };

  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    fog: true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;

  waterUniforms = uniforms; // 供 setWaveScale 使用

  return {
    mesh,
    uniforms,
    setDetailWaves(n) { uniforms.uDetailWaves.value = n; },
    update(time) {
      uniforms.uTime.value = time;
    },
  };
}
