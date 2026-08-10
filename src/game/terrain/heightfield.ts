/**
 * 海岸线 → 陆地掩码 → 高度场。
 *
 * 管线（全部在一张 GRID² 的网格上）：
 *   1. 把海岸线折线画成"墙"（canvas 1px 白线，全几何含 bbox 外段——跨边界
 *      的 way 必须画出去，墙才闭合）；
 *   2. 从画布四边洪水填充 = 海；够不着的 = 陆。墙有细缺口会漏，所以画两遍
 *      （1px + 2px 偏移）并在填充后做一次"海扩张"收口；
 *   3. 近似距离变换（两遍 chamfer）分别量"距海距离"（陆内）与"距陆距离"（海内）；
 *   4. 高度场：岸线 0，陆内按距海抬升（沙滩→丘陵），海内按距陆下沉（浅滩→深水），
 *      叠加少量确定性噪声。
 *
 * 坐标：网格 (i,j) ↔ 战场局部坐标（米，原点在区域中心）。lat/lon → 米用
 * 等距圆柱近似（区域 ≤20km，误差可忽略）。
 */

import type { BBox, Coastline } from './overpass';

export const GRID = 384;

export interface HeightField {
  /** GRID²，米（负 = 水下）。 */
  data: Float32Array;
  /** 区域边长（米，x/z 各自）。 */
  sizeX: number;
  sizeZ: number;
  /** 掩码：1 陆 0 海（小地图用）。 */
  landMask: Uint8Array;
}

/** bbox 对角线超过这个度数就拒绝（约 20km）。 */
export const MAX_SPAN_DEG = 0.2;

export function bboxSizeMeters(bbox: BBox): { sizeX: number; sizeZ: number } {
  const midLat = ((bbox.s + bbox.n) / 2) * (Math.PI / 180);
  const sizeX = (bbox.e - bbox.w) * 111320 * Math.cos(midLat);
  const sizeZ = (bbox.n - bbox.s) * 110540;
  return { sizeX, sizeZ };
}

/** 确定性 hash 噪声（逐格点，平滑由双线性采样承担）。 */
function noise2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) % 1000) / 1000;
}

export function buildHeightField(bbox: BBox, lines: Coastline[]): HeightField {
  const G = GRID;

  // ---- 1. 画墙 ----
  const canvas = document.createElement('canvas');
  canvas.width = G;
  canvas.height = G;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, G, G);
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  // lon → i（西→东 = 左→右），lat → j（南→北 = 下→上，画布 y 翻转）
  const toPx = (lat: number, lon: number): [number, number] => [
    ((lon - bbox.w) / (bbox.e - bbox.w)) * (G - 1),
    (1 - (lat - bbox.s) / (bbox.n - bbox.s)) * (G - 1),
  ];
  for (const pass of [1.6, 2.6]) {
    ctx.lineWidth = pass;
    ctx.beginPath();
    for (const line of lines) {
      for (let k = 0; k < line.length; k += 2) {
        const [px, py] = toPx(line[k], line[k + 1]);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  // ---- 2. 四边洪水填充 = 海 ----
  const img = ctx.getImageData(0, 0, G, G).data;
  const wall = new Uint8Array(G * G);
  for (let i = 0; i < G * G; i++) wall[i] = img[i * 4] > 100 ? 1 : 0;

  const sea = new Uint8Array(G * G);
  const queue = new Int32Array(G * G);
  let head = 0;
  let tail = 0;
  const push = (idx: number): void => {
    if (sea[idx] || wall[idx]) return;
    sea[idx] = 1;
    queue[tail++] = idx;
  };
  for (let i = 0; i < G; i++) {
    push(i);
    push((G - 1) * G + i);
    push(i * G);
    push(i * G + G - 1);
  }
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % G;
    const z = (idx / G) | 0;
    if (x > 0) push(idx - 1);
    if (x < G - 1) push(idx + 1);
    if (z > 0) push(idx - G);
    if (z < G - 1) push(idx + G);
  }

  // 陆地掩码 = 不是海（墙像素归陆，视觉上岸线略鼓，无所谓）
  const landMask = new Uint8Array(G * G);
  for (let i = 0; i < G * G; i++) landMask[i] = sea[i] ? 0 : 1;

  return buildFieldFromMask(bbox, landMask);
}

/** 由陆地掩码重建高度场（距离变换 + 高程 + 噪声），缓存命中时免拉 Overpass。 */
export function buildFieldFromMask(bbox: BBox, landMask: Uint8Array): HeightField {
  const { sizeX, sizeZ } = bboxSizeMeters(bbox);
  const G = GRID;

  // ---- 3. chamfer 距离变换（陆：距海；海：距陆） ----
  const distToSea = chamfer(landMask, 1, G); // 陆格 → 距最近海格
  const distToLand = chamfer(landMask, 0, G); // 海格 → 距最近陆格

  // ---- 4. 高度场 ----
  const cellX = sizeX / G;
  const cellZ = sizeZ / G;
  const cell = (cellX + cellZ) / 2;
  const data = new Float32Array(G * G);
  for (let z = 0; z < G; z++) {
    for (let x = 0; x < G; x++) {
      const i = z * G + x;
      const n = noise2(x >> 2, z >> 2) - 0.5;
      let y: number;
      if (landMask[i]) {
        // 陆：0 ~ 200m 距海抬到 +28m，近岸 1 格内压到沙滩高度
        const d = distToSea[i] * cell;
        y = 28 * Math.min(1, d / 200) + n * 3 * Math.min(1, d / 60);
        if (d < cell * 1.5) y = Math.min(y, 0.8);
      } else {
        // 海：0 ~ 260m 距陆沉到 -24m（水下地形平缓过渡，近岸浅滩）
        const d = distToLand[i] * cell;
        y = -24 * Math.min(1, d / 260) + n * 1.2 * Math.min(1, d / 80);
        if (d < cell * 1.5) y = Math.max(y, -1.2);
      }
      data[i] = y;
    }
  }

  return { data, sizeX, sizeZ, landMask };
}

/** 两遍 chamfer 距离（单位：格）。target = 要测距的掩码值（陆=1 或海=0）。 */
function chamfer(mask: Uint8Array, from: number, G: number): Float32Array {
  const INF = 1e9;
  const dist = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) dist[i] = mask[i] === from ? INF : 0;
  // 前向
  for (let z = 0; z < G; z++) {
    for (let x = 0; x < G; x++) {
      const i = z * G + x;
      if (dist[i] === 0) continue;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (z > 0) {
        d = Math.min(d, dist[i - G] + 1);
        if (x > 0) d = Math.min(d, dist[i - G - 1] + 1.414);
        if (x < G - 1) d = Math.min(d, dist[i - G + 1] + 1.414);
      }
      dist[i] = d;
    }
  }
  // 后向
  for (let z = G - 1; z >= 0; z--) {
    for (let x = G - 1; x >= 0; x--) {
      const i = z * G + x;
      if (dist[i] === 0) continue;
      let d = dist[i];
      if (x < G - 1) d = Math.min(d, dist[i + 1] + 1);
      if (z < G - 1) {
        d = Math.min(d, dist[i + G] + 1);
        if (x < G - 1) d = Math.min(d, dist[i + G + 1] + 1.414);
        if (x > 0) d = Math.min(d, dist[i + G - 1] + 1.414);
      }
      dist[i] = d;
    }
  }
  return dist;
}

/** 双线性采样（x, z 为区域局部坐标，原点在区域中心，米）。 */
export function sampleHeight(field: HeightField, x: number, z: number): number {
  const G = GRID;
  const fx = ((x + field.sizeX / 2) / field.sizeX) * (G - 1);
  const fz = ((z + field.sizeZ / 2) / field.sizeZ) * (G - 1);
  if (fx < 0 || fz < 0 || fx > G - 1 || fz > G - 1) return -24; // 区域外深水
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, G - 1);
  const z1 = Math.min(z0 + 1, G - 1);
  const tx = fx - x0;
  const tz = fz - z0;
  const d = field.data;
  const a = d[z0 * G + x0];
  const b = d[z0 * G + x1];
  const c = d[z1 * G + x0];
  const e = d[z1 * G + x1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (e - c) * tx) * tz;
}
