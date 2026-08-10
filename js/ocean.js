// FFT 海面（WebGPU 原生后端专用）：JONSWAP 频谱 + TSL compute 逆 FFT
// 参考 Tessendorf "Simulating Ocean Water"；蝶形调度移植自 gasgiant/FFT-Ocean（预计算 twiddle+索引表）
// 与 water.js（Gerstner）接口一致：{ mesh, uniforms, getWaveHeight, setDetailWaves, update }
import * as THREE from 'three';
import {
  Fn, uniform, texture, textureStore, storage, varying, instanceIndex,
  positionLocal, cameraPosition,
  vec2, vec3, vec4, float, int, uint, uvec2,
  dot, normalize, mix, clamp, smoothstep, pow, max, min, abs, length, sin, cos, step, reflect,
} from 'three/tsl';
import { SKY_COLORS, SKY_UNIFORMS, makeSkyColor } from './sky.js';
import { generateWaterNormalMap, registerOceanScaleHook } from './water.js';

// ---- 参数（集中在此） ----
const N = 256;              // FFT 尺寸
const LOG_N = 8;
const L = 250;              // 频谱平铺尺度（米）
const GRAVITY = 9.8;
const WIND_DIR = { x: 0.93, z: 0.36 }; // 主导风向
const CPU_COMPONENTS = 32;  // CPU 浮力用的高能波数分量数
const SPECTRUM_SEED = 1337; // 固定种子：重新生成谱时保持相位不变

// 固定种子的随机数（Box-Muller 高斯用）
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- JONSWAP 谱（CPU 一次性；U = 风速 m/s） ----
// 返回 { h0: Float32Array(N*N*4), waves: Float32Array(N*N*4), components, heightNorm, hs }
function buildSpectrum(U) {
  const dk = (Math.PI * 2) / L;
  const wp = GRAVITY / Math.max(U, 3); // 主峰角频率
  const alpha = 0.0081;
  const gamma = 3.3;
  const rand = mulberry32(SPECTRUM_SEED); // 每次重建从同一种子开始 → 相同随机相位

  // 高斯对（Box-Muller）
  const gauss = () => {
    const r1 = Math.max(rand(), 1e-9);
    const r2 = rand();
    const m = Math.sqrt(-2 * Math.log(r1));
    return [m * Math.cos(2 * Math.PI * r2), m * Math.sin(2 * Math.PI * r2)];
  };

  // 居中布局：index i ↔ k = (i - N/2)·dk
  const raw = new Float32Array(N * N * 2); // 未归一化 h0（每格 2 float）
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const kx = (ix - N / 2) * dk;
      const kz = (iz - N / 2) * dk;
      const k = Math.hypot(kx, kz);
      const i2 = (iz * N + ix) * 2;
      if (k < 1e-4) continue;
      const w = Math.sqrt(GRAVITY * k);
      // JONSWAP S(ω)
      const sigma = w <= wp ? 0.07 : 0.09;
      const r = Math.exp(-((w - wp) * (w - wp)) / (2 * sigma * sigma * wp * wp));
      const s = (alpha * GRAVITY * GRAVITY) / Math.pow(w, 5)
        * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(gamma, r);
      // ω → k 转换雅可比（dω/dk / k）
      const pk = (s * GRAVITY) / (2 * w * k);
      // 方向分布：cos²s（s=2），背风为零
      const dtheta = Math.atan2(kz, kx) - Math.atan2(WIND_DIR.z, WIND_DIR.x);
      const c = Math.cos(dtheta / 2);
      const spread = Math.abs(dtheta) < Math.PI ? (2 / Math.PI) * c * c * (Math.abs(dtheta) <= Math.PI / 2 ? 1 : 0) : 0;
      const [gr, gi] = gauss();
      const amp = Math.sqrt(Math.max(pk * spread, 0) * dk * dk / 2);
      raw[i2] = gr * amp;
      raw[i2 + 1] = gi * amp;
    }
  }

  // 归一化：让有效波高 Hs ≈ min(0.024·U², 5)（IFFT 在合并 pass 里乘 1/N²）
  let sum2 = 0;
  for (let i = 0; i < N * N; i++) sum2 += raw[i * 2] * raw[i * 2] + raw[i * 2 + 1] * raw[i * 2 + 1];
  const sigmaH = Math.sqrt(sum2) / (N * N);
  const hs = Math.min(0.024 * U * U, 5);
  const scale = hs / 4 / Math.max(sigmaH, 1e-9);

  // h0 打包：(h0.re, h0.im, conj(h0(-k)).re, conj(h0(-k)).im)
  const h0 = new Float32Array(N * N * 4);
  const waves = new Float32Array(N * N * 4); // (kx, kz, ω, -)
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const mx = (N - ix) % N;
      const mz = (N - iz) % N;
      const i4 = (iz * N + ix) * 4;
      const i2 = (iz * N + ix) * 2;
      const m2 = (mz * N + mx) * 2;
      h0[i4] = raw[i2] * scale;
      h0[i4 + 1] = raw[i2 + 1] * scale;
      h0[i4 + 2] = raw[m2] * scale;       // conj：实部不变
      h0[i4 + 3] = -raw[m2 + 1] * scale;  // 虚部取负
      const kx = (ix - N / 2) * dk;
      const kz = (iz - N / 2) * dk;
      const k = Math.hypot(kx, kz);
      waves[i4] = kx;
      waves[i4 + 1] = kz;
      waves[i4 + 2] = Math.sqrt(GRAVITY * Math.max(k, 1e-4)); // ω
      waves[i4 + 3] = 0;
    }
  }

  // CPU 浮力：取 |h0| 最高的 32 个（±k 去重）分量
  const cands = [];
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const i = iz * N + ix;
      const mx = (N - ix) % N;
      const mz = (N - iz) % N;
      const mi = mz * N + mx;
      if (mi < i) continue; // ±k 去重
      const mag = Math.hypot(h0[i * 4], h0[i * 4 + 1]);
      if (mag > 1e-7) {
        cands.push({
          kx: waves[i * 4], kz: waves[i * 4 + 1], omega: waves[i * 4 + 2],
          amp: (2 * mag) / (N * N), phase: Math.atan2(h0[i * 4 + 1], h0[i * 4]),
        });
      }
    }
  }
  cands.sort((a, b) => b.amp - a.amp);
  const components = cands.slice(0, CPU_COMPONENTS);

  return { h0, waves, components, heightNorm: 1 / Math.max(hs * 0.6, 0.2), hs };
}

// 蝶形 twiddle + 索引表（移植自 gasgiant/FFT-Ocean PrecomputeTwiddleFactorsAndInputIndices）
function buildTwiddle() {
  const data = new Float32Array(LOG_N * N * 4);
  for (let s = 0; s < LOG_N; s++) {
    const b = N >> (s + 1);
    for (let y = 0; y < N / 2; y++) {
      const i = (2 * b * Math.floor(y / b) + (y % b)) % N;
      const ang = (-2 * Math.PI * (Math.floor(y / b) * b)) / N;
      const twr = Math.cos(ang);
      const twi = Math.sin(ang);
      data.set([twr, twi, i, i + b], (s * N + y) * 4);
      data.set([-twr, -twi, i, i + b], (s * N + N / 2 + y) * 4); // 下半区负 twiddle
    }
  }
  return data;
}

/**
 * 创建 FFT 海面
 * @param {THREE.WebGPURenderer} renderer
 * @param {THREE.Vector3} sunDir 初始光源方向
 * @param {Array} islands [{x, z, radius}] 碎浪带
 */
export function createOcean(renderer, sunDir, islands = []) {
  // ---- 状态 ----
  let windSpeed = 6;          // 当前风速
  let regenWind = 6;          // 上次重建谱时的风速
  let spectrum = buildSpectrum(windSpeed);
  let ampScale = 1;           // (U/Uregen)² 连续微调，重建之间保持平滑

  // ---- GPU 资源 ----
  const h0Attr = new THREE.StorageInstancedBufferAttribute(spectrum.h0, 4);
  const wavesAttr = new THREE.StorageInstancedBufferAttribute(spectrum.waves, 4);
  const twiddleAttr = new THREE.StorageInstancedBufferAttribute(buildTwiddle(), 4);
  const bufHA = new THREE.StorageInstancedBufferAttribute(new Float32Array(N * N * 4), 4); // 高度链 ping
  const bufHB = new THREE.StorageInstancedBufferAttribute(new Float32Array(N * N * 4), 4); // 高度链 pong
  const bufSA = new THREE.StorageInstancedBufferAttribute(new Float32Array(N * N * 4), 4); // 坡度链 ping
  const bufSB = new THREE.StorageInstancedBufferAttribute(new Float32Array(N * N * 4), 4); // 坡度链 pong
  const outTex = new THREE.StorageTexture(N, N);
  outTex.type = THREE.HalfFloatType;
  outTex.magFilter = THREE.LinearFilter;
  outTex.minFilter = THREE.LinearFilter;
  outTex.wrapS = outTex.wrapT = THREE.RepeatWrapping;

  const COUNT = N * N;
  const h0Read = storage(h0Attr, 'vec4', COUNT).toReadOnly();
  const wavesRead = storage(wavesAttr, 'vec4', COUNT).toReadOnly();
  const twRead = storage(twiddleAttr, 'vec4', LOG_N * N).toReadOnly();
  const bufRead = (attr) => storage(attr, 'vec4', COUNT).toReadOnly();
  const bufWrite = (attr) => storage(attr, 'vec4', COUNT);

  // ---- 动态 uniform（与 Gerstner 水面同接口） ----
  const uniforms = {
    uTime: uniform(0),
    uAmpScale: uniform(1),
    uHeightNorm: uniform(spectrum.heightNorm),
    uFoamBoost: uniform(0),
    uCloudAmount: uniform(0.15),
    uDetailWaves: uniform(3),
    uDaylight: uniform(1),
    uLightElev: uniform(0.5),
    uDeepColor: uniform(new THREE.Color(0x0b3b5e)),
    uShallowColor: uniform(new THREE.Color(0x1e9e9a)),
    uSSSColor: uniform(new THREE.Color(0x35d0b0)),
    uFoamColor: uniform(new THREE.Color(0xf2fbfc)),
    uSunDir: uniform(sunDir.clone()),
    uSunColor: uniform(SKY_COLORS.sun.clone()),
    uZenith: SKY_UNIFORMS.uZenith,
    uHorizon: SKY_UNIFORMS.uHorizon,
  };
  const normalMap = generateWaterNormalMap(512);
  const skyColor = makeSkyColor(uniforms);

  // ---- pass 1：时变谱 h(k,t) + 坡度谱 ----
  const spectrumPass = Fn(() => {
    const idx = instanceIndex;
    const h0 = h0Read.element(idx);
    const wd = wavesRead.element(idx); // (kx, kz, ω, -)
    const ph = wd.z.mul(uniforms.uTime).mod(Math.PI * 2); // 取模防长时间浮点漂移
    const er = cos(ph);
    const ei = sin(ph);
    // h = h0·e^{iωt} + conj(h0(-k))·e^{-iωt}
    const hr = h0.x.mul(er).sub(h0.y.mul(ei)).add(h0.z.mul(er).add(h0.w.mul(ei)));
    const hi = h0.x.mul(ei).add(h0.y.mul(er)).add(h0.w.mul(er).sub(h0.z.mul(ei)));
    // 坡度谱：i·k·h = (-hi·k, hr·k)
    bufWrite(bufHA).element(idx).assign(vec4(hr, hi, 0, 0));
    bufWrite(bufSA).element(idx).assign(vec4(hi.negate().mul(wd.x), hr.mul(wd.x), hi.negate().mul(wd.z), hr.mul(wd.z)));
  })().compute(COUNT);

  // ---- pass 2：蝶形（逆 FFT = 共轭 twiddle；vec4 双通道复数并行） ----
  function butterflyPass(readAttr, writeAttr, stepIdx, vertical) {
    return Fn(() => {
      const idx = instanceIndex;
      const x = int(idx.mod(N));
      const y = int(idx.div(N));
      const row = vertical ? y : x;
      const data = twRead.element(stepIdx * N + row); // (tw.re, tw.im, i, i+b)
      const i0 = int(data.z);
      const i1 = int(data.w);
      const aIdx = vertical ? i0.mul(N).add(x) : y.mul(N).add(i0);
      const bIdx = vertical ? i1.mul(N).add(x) : y.mul(N).add(i1);
      const A = bufRead(readAttr).element(aIdx);
      const B = bufRead(readAttr).element(bIdx);
      const twr = data.x;
      const twi = data.y.negate(); // 逆变换共轭
      // A + tw·B（rg 与 ba 两路复数）
      const out = vec4(
        A.x.add(twr.mul(B.x).sub(twi.mul(B.y))),
        A.y.add(twr.mul(B.y).add(twi.mul(B.x))),
        A.z.add(twr.mul(B.z).sub(twi.mul(B.w))),
        A.w.add(twr.mul(B.w).add(twi.mul(B.z)))
      );
      bufWrite(writeAttr).element(idx).assign(out);
    })().compute(COUNT);
  }

  // ---- pass 3：合并（1/N² 缩放 + 棋盘 permute + 写入渲染纹理） ----
  const mergePass = Fn(() => {
    const idx = instanceIndex;
    const x = int(idx.mod(N));
    const y = int(idx.div(N));
    const H = bufRead(bufHA).element(idx);
    const S = bufRead(bufSA).element(idx);
    const sign = float(1).sub(float(x.add(y).mod(2)).mul(2)); // (-1)^(x+y)
    const sc = sign.div(COUNT);
    textureStore(outTex, uvec2(uint(x), uint(y)), vec4(H.x.mul(sc), S.x.mul(sc), S.z.mul(sc), 0)).toWriteOnly();
  })().compute(COUNT);

  // 调度表：高度链 16 步 + 坡度链 16 步（每步 A→B→A 交替，8 步后结果回到 A 缓冲）
  const schedule = [];
  for (let s = 0; s < LOG_N; s++) schedule.push(butterflyPass(s % 2 === 0 ? bufHA : bufHB, s % 2 === 0 ? bufHB : bufHA, s, false));
  for (let s = 0; s < LOG_N; s++) schedule.push(butterflyPass(s % 2 === 0 ? bufHA : bufHB, s % 2 === 0 ? bufHB : bufHA, s, true));
  for (let s = 0; s < LOG_N; s++) schedule.push(butterflyPass(s % 2 === 0 ? bufSA : bufSB, s % 2 === 0 ? bufSB : bufSA, s, false));
  for (let s = 0; s < LOG_N; s++) schedule.push(butterflyPass(s % 2 === 0 ? bufSA : bufSB, s % 2 === 0 ? bufSB : bufSA, s, true));

  // ---- 海面网格与材质 ----
  const geo = new THREE.PlaneGeometry(1000, 1000, 256, 256);
  geo.rotateX(-Math.PI / 2);

  const vWorldPos = varying(vec3(0));
  const vSlope = varying(vec2(0));
  const vHeight01 = varying(float(0));

  const positionNode = Fn(() => {
    const xz = positionLocal.xz.toVar();
    const tex = texture(outTex, xz.div(L)); // RepeatWrapping 平铺
    const h = tex.r.mul(uniforms.uAmpScale);
    vWorldPos.assign(vec3(xz.x, h, xz.y));
    vSlope.assign(tex.gb.mul(uniforms.uAmpScale));
    vHeight01.assign(h.mul(uniforms.uHeightNorm).mul(0.5).add(0.5));
    return positionLocal.add(vec3(0, h, 0));
  })();

  const colorNode = Fn(() => {
    const toCam = cameraPosition.sub(vWorldPos);
    const camDist = length(toCam).toVar();
    const v = toCam.div(camDist).toVar();

    // 法线：FFT 坡度 + 法线贴图两层微细节（随距离衰减）
    const n = normalize(vec3(vSlope.x.negate(), 1, vSlope.y.negate())).toVar();
    const detailFade = float(1).sub(smoothstep(40.0, 170.0, camDist)).toVar();
    const nm1 = texture(normalMap, vWorldPos.xz.add(vec2(uniforms.uTime.mul(0.55), uniforms.uTime.mul(0.22))).div(4.0)).rgb.mul(2).sub(1);
    const nm2 = texture(normalMap, vWorldPos.xz.mul(vec2(1.0, 0.92)).add(vec2(uniforms.uTime.mul(-0.30), uniforms.uTime.mul(0.26))).div(13.0)).rgb.mul(2).sub(1);
    const nm = nm1.add(nm2.mul(step(1.5, uniforms.uDetailWaves)));
    n.assign(normalize(n.add(vec3(nm.x, 0.0, nm.y).mul(detailFade.mul(0.2)))));

    // 基础色（夜晚压暗）
    const col = mix(uniforms.uDeepColor, uniforms.uShallowColor, vHeight01)
      .mul(float(0.25).add(uniforms.uDaylight.mul(0.75))).toVar();

    // 天空反射（与天空穹顶共享 skyColor）+ 向阳暖调
    const r = reflect(v.negate(), n).toVar();
    r.y.assign(abs(r.y));
    const refl = skyColor(r).toVar();
    const sunSide = pow(max(dot(normalize(r.xz.add(1e-4)), normalize(uniforms.uSunDir.xz.add(1e-4))), 0.0), 3.0);
    refl.assign(mix(refl, uniforms.uHorizon.mul(1.1), sunSide.mul(0.25)));
    const fres = float(0.04).add(float(0.96).mul(pow(float(1).sub(max(dot(n, v), 0.0)), 5.0)));
    col.assign(mix(col, refl, clamp(fres.mul(1.1), 0.0, 1.0)));

    // 云影
    const cloudN = texture(normalMap, vWorldPos.xz.mul(0.006).add(vec2(uniforms.uTime.mul(0.008), uniforms.uTime.mul(0.005)))).g;
    col.mulAssign(mix(1.0, cloudN.mul(0.2).add(0.8), uniforms.uCloudAmount));

    // 次表面散射
    const crest = smoothstep(0.45, 0.95, vHeight01);
    const sss = pow(max(dot(v, uniforms.uSunDir), 0.0), 3.0).mul(crest);
    col.addAssign(uniforms.uSSSColor.mul(sss.mul(0.55).mul(uniforms.uDaylight)));

    // 日月光路（各向异性，低仰角拉伸比 3→6）
    const hh = normalize(uniforms.uSunDir.add(v));
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
    const ndh = max(dot(na, hh), 0.0);
    const lightLv = float(0.35).add(uniforms.uDaylight.mul(0.65));
    const specCol = uniforms.uSunColor.mul(mix(vec3(1, 1, 1), vec3(1.25, 0.95, 0.7), lowElev));
    col.addAssign(specCol.mul(min(pow(ndh, 260.0).mul(1.2), 1.4)).mul(lightLv));
    const g = texture(normalMap, vWorldPos.xz.mul(0.35).add(vec2(uniforms.uTime.mul(0.3), uniforms.uTime.mul(-0.22)))).g;
    const glitter = pow(ndh, 520.0).mul(smoothstep(0.55, 0.95, g)).mul(float(1).add(lowElev.mul(0.5)));
    col.addAssign(specCol.mul(min(glitter.mul(3.0), 2.0))
      .mul(float(0.3).add(detailFade.mul(0.7)))
      .mul(float(0.15).add(uniforms.uDaylight.mul(0.85))));

    // 白沫：坡度幅值 + 波峰（FFT 路径无水平位移，用坡度近似雅可比卷破），贴图打散
    const slopeMag = length(vSlope);
    const foamN = texture(normalMap, vWorldPos.xz.mul(0.09).add(vec2(uniforms.uTime.mul(0.02), uniforms.uTime.mul(-0.014)))).g;
    const foamBase = clamp(
      smoothstep(0.5, 1.1, slopeMag).mul(0.8)
        .add(smoothstep(0.55, 0.9, vHeight01).mul(0.5))
        .add(uniforms.uFoamBoost), 0, 1
    );
    const foam = smoothstep(0.48, 0.78, foamBase.add(foamN.sub(0.5).mul(0.45))).toVar();
    foam.mulAssign(smoothstep(0.35, 0.55, vHeight01)); // 波谷渐隐

    // 岛屿碎浪带（烘焙常量，与 Gerstner 版同逻辑）
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

    foam.mulAssign(float(1).sub(smoothstep(150.0, 320.0, camDist)));
    col.assign(mix(col, uniforms.uFoamColor.mul(float(0.3).add(uniforms.uDaylight.mul(0.7))), clamp(foam, 0, 1).mul(0.9)));

    return col;
  })();

  const material = new THREE.NodeMaterial();
  material.positionNode = positionNode;
  material.colorNode = colorNode;
  material.fog = true;

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;

  // ---- CPU 浮力（32 个高能分量正弦叠加，与 GPU 场近似一致） ----
  function getWaveHeight(x, z, t) {
    let y = 0;
    const comps = spectrum.components;
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      y += c.amp * Math.cos(c.kx * x + c.kz * z - c.omega * t + c.phase);
    }
    return y * ampScale;
  }

  // ---- 天气接口：浪幅缩放 → 风速；相位保持（固定种子重建） ----
  function setWind(U) {
    windSpeed = U;
    if (Math.abs(U - regenWind) > 0.3) {
      regenWind = U;
      spectrum = buildSpectrum(U); // 同一种子 → 相同随机相位
      h0Attr.array.set(spectrum.h0);
      h0Attr.needsUpdate = true;
      wavesAttr.array.set(spectrum.waves);
      wavesAttr.needsUpdate = true;
      uniforms.uHeightNorm.value = spectrum.heightNorm;
    }
    ampScale = (U / regenWind) * (U / regenWind);
    uniforms.uAmpScale.value = ampScale;
  }
  registerOceanScaleHook((s) => setWind(6 + (s - 1) * 10)); // waveScale 1.0→1.8 映射 6~14 m/s

  return {
    mesh,
    uniforms,
    getWaveHeight,
    setDetailWaves(n) { uniforms.uDetailWaves.value = n; },
    // 每帧：更新相位时间 + 跑 compute 管线（1 谱 + 32 蝶形 + 1 合并 = 34 次 dispatch）
    update(time) {
      uniforms.uTime.value = time;
      renderer.compute(spectrumPass);
      for (const p of schedule) renderer.compute(p);
      renderer.compute(mergePass);
    },
  };
}
