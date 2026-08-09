// 水面：Gerstner 波叠加（GPU 顶点位移 + CPU 同参数高度采样）
import * as THREE from 'three';

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
export function getWaveHeight(x, z, t) {
  let y = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const w = WAVES[i];
    y += w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.omega * t);
  }
  return y;
}

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform vec4 uWaves[${WAVE_COUNT}];  // dirX, dirZ, amp, k
  uniform vec4 uWave2[${WAVE_COUNT}];  // omega, q, -, -

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;               // 归一化波高 0~1

  #include <fog_pars_vertex>

  void main() {
    vec2 xz = position.xz;             // 以静止位置计算相位（标准 Gerstner 做法）
    vec3 disp = vec3(0.0);
    vec3 n = vec3(0.0, 1.0, 0.0);
    float ampSum = 0.0;

    for (int i = 0; i < ${WAVE_COUNT}; i++) {
      vec2 d = uWaves[i].xy;
      float amp = uWaves[i].z;
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
    }

    vec3 p = position + disp;
    vHeight = disp.y / ampSum * 0.5 + 0.5;
    vNormal = normalize(n);

    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorldPos = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uSkyColor;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;

  #include <fog_pars_fragment>

  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorldPos);

    // 深蓝 -> 青绿：随波高渐变
    vec3 col = mix(uDeepColor, uShallowColor, vHeight);

    // 菲涅尔：掠射角反射天空色
    float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    col = mix(col, uSkyColor, fres * 0.65);

    // 太阳高光（Blinn-Phong 镜面）
    vec3 h = normalize(uSunDir + v);
    float spec = pow(max(dot(n, h), 0.0), 240.0);
    col += uSunColor * spec * 1.6;

    // 波峰白沫：波高高且法线倾斜处起沫
    float foam = smoothstep(0.72, 0.95, vHeight + (1.0 - n.y) * 0.35);
    col = mix(col, vec3(0.93, 0.97, 0.98), foam * 0.85);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createWater(sunDir) {
  const geo = new THREE.PlaneGeometry(1000, 1000, 256, 256);
  geo.rotateX(-Math.PI / 2); // 躺平到 xz 平面，position.y 全为 0

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uDeepColor: { value: new THREE.Color(0x0b3b5e) },
      uShallowColor: { value: new THREE.Color(0x1e9e9a) },
      uSkyColor: { value: new THREE.Color(0x7fc4e8) },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(0xffe6b0) },
    },
  ]);
  // merge 之后再把波形数组填进去（数组不便走 merge）
  uniforms.uWaves = { value: WAVES.map((w) => new THREE.Vector4(w.dx, w.dz, w.amp, w.k)) };
  uniforms.uWave2 = { value: WAVES.map((w) => new THREE.Vector4(w.omega, w.q, 0, 0)) };

  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    fog: true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;

  return {
    mesh,
    update(time) {
      uniforms.uTime.value = time;
    },
  };
}
