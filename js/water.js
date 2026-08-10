// 水面（TSL / WebGPURenderer）：Gerstner 大波位移 + 法线贴图细节 + SSS + Jacobian 白沫 + 天空反射
import * as THREE from 'three';
import {
  Fn, uniform, texture, varying, positionLocal, cameraPosition,
  vec2, vec3, float, dot, normalize, mix, clamp, smoothstep, pow, max, min, abs,
  length, sin, cos, step, reflect,
} from 'three/tsl';
import { SKY_COLORS, SKY_UNIFORMS, makeSkyColor } from './sky.js';
// 波形参数表：CPU（浮力）与 GPU（顶点着色器）共用同一份，保证一致
// dir 会自动归一化；amp 振幅；len 波长；q 波峰尖锐度(0~1)
const RAW_WAVES = [
  // 大洋涌浪：长波长大振幅，撑出海面的大尺度起伏
  { dir: [0.90, -0.35], amp: 0.50, len: 210.0, q: 0.35 },
  { dir: [-0.60, 0.80], amp: 0.40, len: 130.0, q: 0.35 },
  // 主浪
  { dir: [1.00,  0.15], amp: 0.55, len: 60.0, q: 0.55 },
  { dir: [0.80,  0.60], amp: 0.38, len: 31.0, q: 0.55 },
  { dir: [-0.50, 0.90], amp: 0.28, len: 18.0, q: 0.50 },
  { dir: [0.30, -1.00], amp: 0.17, len: 9.0,  q: 0.40 },
  { dir: [-0.90, -0.40], amp: 0.11, len: 5.5, q: 0.35 },
  { dir: [0.20,  0.98], amp: 0.07, len: 3.2,  q: 0.25 },
];

const WAVE_COUNT = RAW_WAVES.length;

// ---- 程序化法线贴图：可平铺分形值噪声 → 高度场 → 中心差分转法线（一次性 CPU 生成） ----
function generateWaterNormalMap(size = 512) {
  // 分形八度：格子数 ×2 递增，每层独立打乱表；格点按周期环绕 → 贴图可平铺
  const octaves = [6, 12, 24, 48].map((cells) => {
    const perm = new Uint8Array(cells);
    for (let i = 0; i < cells; i++) perm[i] = i;
    for (let i = cells - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    return { cells, perm };
  });

  function vnoise(x, y, oct) {
    const { cells, perm } = oct;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf);
    const sy = yf * yf * (3 - 2 * yf);
    const wrap = (v) => ((v % cells) + cells) % cells;
    const lat = (ix, iy) => perm[(wrap(ix) + perm[wrap(iy)]) % cells] / (cells - 1);
    const a = lat(xi, yi);
    const b = lat(xi + 1, yi);
    const c = lat(xi, yi + 1);
    const d = lat(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }

  // 高度场（fbm 叠加）
  const height = new Float32Array(size * size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let h = 0;
      let amp = 1;
      let norm = 0;
      for (const oct of octaves) {
        h += vnoise((px / size) * oct.cells, (py / size) * oct.cells, oct) * amp;
        norm += amp;
        amp *= 0.5;
      }
      height[py * size + px] = h / norm;
    }
  }

  // 中心差分 → 法线（边缘环绕取样）
  const STRENGTH = 2.4;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = (at(px + 1, py) - at(px - 1, py)) * STRENGTH;
      const dy = (at(px, py + 1) - at(px, py - 1)) * STRENGTH;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (py * size + px) * 4;
      img.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      img.data[i + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      img.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace; // 法线数据，不做 sRGB 转换
  return tex;
}

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


// ================= TSL 材质部分 =================
// 波参数/岛屿全部烘焙为常量（运行期不变），动态 uniform 只剩天气/昼夜接口

export function createWater(sunDir, islands = []) {
  const geo = new THREE.PlaneGeometry(1000, 1000, 256, 256);
  geo.rotateX(-Math.PI / 2); // 躺平到 xz 平面，position.y 全为 0

  // 动态 uniform（weather.js / daytime.js 通过 .value 写入，接口与 GLSL 时代一致）
  const uniforms = {
    uTime: uniform(0),
    uWaveScale: uniform(1),
    uFoamBoost: uniform(0),
    uCloudAmount: uniform(0.15),
    uDetailWaves: uniform(3),          // 法线贴图层数（画质档位 1~3）
    uDaylight: uniform(1),
    uLightElev: uniform(0.5),
    uDeepColor: uniform(new THREE.Color(0x0b3b5e)),
    uShallowColor: uniform(new THREE.Color(0x1e9e9a)),
    uSSSColor: uniform(new THREE.Color(0x35d0b0)),
    uFoamColor: uniform(new THREE.Color(0xf2fbfc)),
    uSunDir: uniform(sunDir.clone()),          // 日月混合光源方向（daytime 写入）
    uSunColor: uniform(SKY_COLORS.sun.clone()), // 日月混合光源颜色（daytime 写入）
    uZenith: SKY_UNIFORMS.uZenith,             // 与天空穹顶共享
    uHorizon: SKY_UNIFORMS.uHorizon,
  };
  waterUniforms = uniforms; // 供 setWaveScale 使用

  const normalMap = generateWaterNormalMap(512);
  const skyColor = makeSkyColor(uniforms); // 用水的光源 uniform，反射与高光同源

  // 顶点 -> 片元插值
  const vWorldPos = varying(vec3(0));
  const vNormal = varying(vec3(0, 1, 0));
  const vHeight = varying(float(0));
  const vFoam = varying(float(0));

  // ---- 顶点：8 个 Gerstner 波叠加（JS 展开为常量表达式） ----
  const positionNode = Fn(() => {
    const xz = positionLocal.xz.toVar(); // 以静止位置计算相位（标准 Gerstner 做法）
    const disp = vec3(0).toVar();
    const nrm = vec3(0, 1, 0).toVar();
    const ampSum = float(0).toVar();
    const dxx = float(0).toVar(); // 水平位移梯度（雅可比矩阵元）
    const dzz = float(0).toVar();
    const dxz = float(0).toVar();

    for (const w of WAVES) {
      const f = float(w.k).mul(dot(vec2(w.dx, w.dz), xz)).sub(uniforms.uTime.mul(w.omega));
      const s = sin(f);
      const c = cos(f);
      const amp = float(w.amp).mul(uniforms.uWaveScale); // 天气缩放
      disp.x.addAssign(amp.mul(w.q * w.dx).mul(c));      // 水平位移让波峰变尖
      disp.z.addAssign(amp.mul(w.q * w.dz).mul(c));
      disp.y.addAssign(amp.mul(s));
      nrm.x.subAssign(amp.mul(w.k * w.dx).mul(c));       // 法线用 y 对 x/z 偏导（与 CPU 一致）
      nrm.z.subAssign(amp.mul(w.k * w.dz).mul(c));
      ampSum.addAssign(amp);
      const qs = amp.mul(w.k * w.q).mul(s);
      dxx.subAssign(qs.mul(w.dx * w.dx));
      dzz.subAssign(qs.mul(w.dz * w.dz));
      dxz.subAssign(qs.mul(w.dx * w.dz));
    }

    const p = positionLocal.add(disp);
    vWorldPos.assign(p); // mesh 在原点，局部坐标即世界坐标
    vNormal.assign(normalize(nrm));
    vHeight.assign(disp.y.div(ampSum).mul(0.5).add(0.5));
    const J = dxx.add(1).mul(dzz.add(1)).sub(dxz.mul(dxz)); // 雅可比行列式
    vFoam.assign(clamp(J.oneMinus().mul(5), 0, 1));
    return p;
  })();

  // ---- 片元 ----
  const colorNode = Fn(() => {
    const toCam = cameraPosition.sub(vWorldPos);
    const camDist = length(toCam).toVar();
    const v = toCam.div(camDist).toVar();

    // 细节法线：法线贴图三层滚动采样（4m/13m/47m），随距离衰减防摩尔纹
    const n = normalize(vNormal).toVar();
    const detailFade = float(1).sub(smoothstep(40.0, 170.0, camDist)).toVar();
    const nm1 = texture(normalMap, vWorldPos.xz.add(vec2(uniforms.uTime.mul(0.55), uniforms.uTime.mul(0.22))).div(4.0)).rgb.mul(2).sub(1);
    const nm2 = texture(normalMap, vWorldPos.xz.mul(vec2(1.0, 0.92)).add(vec2(uniforms.uTime.mul(-0.30), uniforms.uTime.mul(0.26))).div(13.0)).rgb.mul(2).sub(1);
    const nm3 = texture(normalMap, vWorldPos.xz.add(vec2(uniforms.uTime.mul(0.16), uniforms.uTime.mul(-0.12))).div(47.0)).rgb.mul(2).sub(1);
    const nm = nm1
      .add(nm2.mul(step(1.5, uniforms.uDetailWaves)))
      .add(nm3.mul(step(2.5, uniforms.uDetailWaves)));
    n.assign(normalize(n.add(vec3(nm.x, 0.0, nm.y).mul(detailFade.mul(0.22)))));

    // 基础色：深蓝 -> 青绿随波高渐变（夜晚随 uDaylight 压暗）
    const col = mix(uniforms.uDeepColor, uniforms.uShallowColor, vHeight)
      .mul(float(0.25).add(uniforms.uDaylight.mul(0.75))).toVar();

    // 天空反射：反射向量查与天空穹顶同一个 skyColor，水天无缝
    const r = reflect(v.negate(), n).toVar();
    r.y.assign(abs(r.y)); // 不允许反射到海平面以下
    const refl = skyColor(r).toVar();
    // 向阳侧混入地平线暖色：黄昏时"金色海面"更明显
    const sunSide = pow(max(dot(normalize(r.xz.add(1e-4)), normalize(uniforms.uSunDir.xz.add(1e-4))), 0.0), 3.0);
    refl.assign(mix(refl, uniforms.uHorizon.mul(1.1), sunSide.mul(0.25)));
    const fres = float(0.04).add(float(0.96).mul(pow(float(1).sub(max(dot(n, v), 0.0)), 5.0))); // Schlick
    col.assign(mix(col, refl, clamp(fres.mul(1.1), 0.0, 1.0)));

    // 云影：法线贴图绿色通道做大尺度慢漂移暗化（与天气联动）
    const cloudN = texture(normalMap, vWorldPos.xz.mul(0.006).add(vec2(uniforms.uTime.mul(0.008), uniforms.uTime.mul(0.005)))).g;
    col.mulAssign(mix(1.0, cloudN.mul(0.2).add(0.8), uniforms.uCloudAmount));

    // 次表面散射：视线朝向光源时，浪峰透出青绿辉光
    const crest = smoothstep(0.45, 0.95, vHeight);
    const sss = pow(max(dot(v, uniforms.uSunDir), 0.0), 3.0).mul(crest);
    col.addAssign(uniforms.uSSSColor.mul(sss.mul(0.55).mul(uniforms.uDaylight)));

    // 日月光路：各向异性高光（光源方位保持、垂直方向放大粗糙度，Cox-Munk 近似）
    // 低仰角时拉伸比 3→6、颜色更深更暖
    const h = normalize(uniforms.uSunDir.add(v));
    const sunAz = normalize(uniforms.uSunDir.xz.add(vec2(1e-4, 0.0)));
    const perpAz = vec2(sunAz.y.negate(), sunAz.x);
    const lowElev = float(1).sub(smoothstep(0.05, 0.4, uniforms.uLightElev));
    const nAlong = dot(n.xz, sunAz);
    const nAcross = dot(n.xz, perpAz).mul(float(3.0).add(lowElev.mul(3.0)));
    const na = normalize(vec3(
      sunAz.x.mul(nAlong).add(perpAz.x.mul(nAcross)),
      n.y,
      sunAz.y.mul(nAlong).add(perpAz.y.mul(nAcross))
    ));
    const ndh = max(dot(na, h), 0.0);
    const lightLv = float(0.35).add(uniforms.uDaylight.mul(0.65));
    const specCol = uniforms.uSunColor.mul(mix(vec3(1, 1, 1), vec3(1.25, 0.95, 0.7), lowElev));
    col.addAssign(specCol.mul(min(pow(ndh, 260.0).mul(1.2), 1.4)).mul(lightLv));
    const g = texture(normalMap, vWorldPos.xz.mul(0.35).add(vec2(uniforms.uTime.mul(0.3), uniforms.uTime.mul(-0.22)))).g;
    const glitter = pow(ndh, 520.0).mul(smoothstep(0.55, 0.95, g)).mul(float(1).add(lowElev.mul(0.5)));
    col.addAssign(specCol.mul(min(glitter.mul(3.0), 2.0))
      .mul(float(0.3).add(detailFade.mul(0.7)))
      .mul(float(0.15).add(uniforms.uDaylight.mul(0.85))));

    // 破浪白沫：雅可比 + 波高阈值，法线贴图绿通道纹理化打散，波谷渐隐
    const foamN = texture(normalMap, vWorldPos.xz.mul(0.09).add(vec2(uniforms.uTime.mul(0.02), uniforms.uTime.mul(-0.014)))).g;
    const foamBase = clamp(
      vFoam.mul(0.9).add(smoothstep(0.62, 0.95, vHeight).mul(0.5)).add(uniforms.uFoamBoost), 0, 1
    );
    const foam = smoothstep(0.48, 0.78, foamBase.add(foamN.sub(0.5).mul(0.45))).toVar();
    foam.mulAssign(smoothstep(0.28, 0.5, vHeight)); // 波谷处泡沫渐隐

    // 岛屿浅水碎浪带：碰撞半径附近一圈泡沫（烘焙常量），贴图打散 + 随时间呼吸
    const surf = float(0).toVar();
    let phase = 0;
    for (const isl of islands) {
      if (!isl || isl.radius < 0.1) continue;
      const rr = float(isl.radius).add(sin(uniforms.uTime.mul(0.7).add(phase)).mul(1.5));
      const d = length(vWorldPos.xz.sub(vec2(isl.x, isl.z)));
      surf.assign(max(surf, float(1).sub(smoothstep(0.0, 7.0, abs(d.sub(rr))))));
      phase += 1.7;
    }
    const surfN = texture(normalMap, vWorldPos.xz.mul(0.05).add(vec2(uniforms.uTime.mul(0.012), uniforms.uTime.mul(-0.008)))).g;
    surf.mulAssign(float(0.55).add(surfN.mul(0.45)));
    foam.assign(max(foam, surf));

    foam.mulAssign(float(1).sub(smoothstep(150.0, 320.0, camDist))); // 远处淡出
    col.assign(mix(col, uniforms.uFoamColor.mul(float(0.3).add(uniforms.uDaylight.mul(0.7))), clamp(foam, 0, 1).mul(0.9)));

    return col;
  })();

  const material = new THREE.NodeMaterial();
  material.positionNode = positionNode;
  material.colorNode = colorNode;
  material.fog = true; // NodeMaterial 自动接入场景雾

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;

  return {
    mesh,
    uniforms,
    setDetailWaves(n) { uniforms.uDetailWaves.value = n; },
    update(time) {
      uniforms.uTime.value = time;
    },
  };
}
