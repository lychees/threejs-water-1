/**
 * 海岸线 → 陆地掩码 → 高度场。
 *
 * 管线（全部在一张 GRID² 的网格上）：
 *   1. 海岸线画墙（canvas 粗描边，全几何含 bbox 外段）；
 *   2. 非墙像素 4 连通分区；
 *   3. 对每条岸线段沿途采样，用叉积解析判定左右：左侧区域计"陆票"、
 *      右侧计"海票"（OSM 约定：way 行进方向左侧是陆地），区域按多数票
 *      定陆海。像素偏移画标记的旧法在锯齿海岸会跨墙渗漏，扫描线奇偶
 *      法则扛不住断头岸线段——投票法对两者都鲁棒；
 *   4. 近似距离变换（两遍 chamfer）分别量"距海距离"（陆内）与"距陆距离"（海内）；
 *   5. 高度场：岸线 0，陆内按距海抬升（沙滩→丘陵），海内按距陆下沉（浅滩→深水），
 *      叠加少量确定性噪声。
 *
 * 坐标：网格 (i,j) ↔ 战场局部坐标（米，原点在区域中心）。lat/lon → 米用
 * 等距圆柱近似（区域 ≤20km，误差可忽略）。
 */

import type { BBox, Coastline } from './overpass';
import type { ElevationGrid } from './elevation';

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

export function buildHeightField(
  bbox: BBox,
  lines: Coastline[],
  elev: ElevationGrid | null = null,
): HeightField {
  const G = GRID;

  // 区域分类演进史：边界洪水（大陆岸误判）→ 像素偏移陆标（锯齿海岸跨墙渗漏）
  // → 扫描线奇偶（断头岸线段污染整行）。当前版本：墙 + 连通区域 + 几何投票。
  //
  //   1. 海岸线画墙（粗描边，全几何含 bbox 外段）；
  //   2. 非墙像素 4 连通分区；
  //   3. 对每条岸线段沿途逐像素采样，取左右两侧 ~2px 处的区域 id：
  //      左侧区域得"陆票"、右侧得"海票"（OSM 约定：way 行进方向左侧是陆地）。
  //      用叉积解析判定左右，不画偏移线，锯齿/急弯/断头段都安全；
  //   4. 区域按多数票定陆海；零票区域（理论上不与任何岸线相邻）：贴边=海，
  //      封闭=海（潟湖），岛内部位从岸线段总能拿到陆票。
  const toPx = (lat: number, lon: number): [number, number] => [
    ((lon - bbox.w) / (bbox.e - bbox.w)) * (G - 1),
    (1 - (lat - bbox.s) / (bbox.n - bbox.s)) * (G - 1),
  ];

  // ---- 1. 画墙 ----
  const canvas = document.createElement('canvas');
  canvas.width = G;
  canvas.height = G;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, G, G);
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
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
  const img = ctx.getImageData(0, 0, G, G).data;
  const wall = new Uint8Array(G * G);
  for (let i = 0; i < G * G; i++) wall[i] = img[i * 4] > 100 ? 1 : 0;

  // ---- 2. 连通分区（非墙像素，4 连通） ----
  const comp = new Int32Array(G * G).fill(-1);
  const compTouchEdge: boolean[] = [];
  const stack = new Int32Array(G * G);
  for (let start = 0; start < G * G; start++) {
    if (wall[start] || comp[start] >= 0) continue;
    const id = compTouchEdge.length;
    let touch = false;
    let sp = 0;
    stack[sp++] = start;
    comp[start] = id;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % G;
      const z = (idx / G) | 0;
      if (x === 0 || x === G - 1 || z === 0 || z === G - 1) touch = true;
      if (x > 0 && !wall[idx - 1] && comp[idx - 1] < 0) { comp[idx - 1] = id; stack[sp++] = idx - 1; }
      if (x < G - 1 && !wall[idx + 1] && comp[idx + 1] < 0) { comp[idx + 1] = id; stack[sp++] = idx + 1; }
      if (z > 0 && !wall[idx - G] && comp[idx - G] < 0) { comp[idx - G] = id; stack[sp++] = idx - G; }
      if (z < G - 1 && !wall[idx + G] && comp[idx + G] < 0) { comp[idx + G] = id; stack[sp++] = idx + G; }
    }
    compTouchEdge.push(touch);
  }

  // ---- 3. 左右侧投票 ----
  const landVotes = new Int32Array(compTouchEdge.length);
  const seaVotes = new Int32Array(compTouchEdge.length);
  const compAt = (x: number, y: number): number => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= G || iy >= G) return -1;
    return comp[iy * G + ix];
  };
  for (const line of lines) {
    for (let k = 0; k + 3 < line.length; k += 2) {
      const [x0, y0] = toPx(line[k], line[k + 1]);
      const [x1, y1] = toPx(line[k + 2], line[k + 3]);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      // 画布坐标（x 东 y 南）的左法线：(dy, -dx)
      const nx = (dy / len) * 2.2;
      const ny = (-dx / len) * 2.2;
      const steps = Math.max(1, Math.ceil(len));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = x0 + dx * t;
        const py = y0 + dy * t;
        const left = compAt(px + nx, py + ny);
        const right = compAt(px - nx, py - ny);
        if (left >= 0) landVotes[left]++;
        if (right >= 0) seaVotes[right]++;
      }
    }
  }

  // ---- 4. 多数票定陆海 ----
  console.info(
    `[terrain] 分区 ${compTouchEdge.length}，陆票 ${[...landVotes].reduce((a, b) => a + b, 0)}，` +
      `海票 ${[...seaVotes].reduce((a, b) => a + b, 0)}`,
  );
  const landMask = new Uint8Array(G * G);
  for (let i = 0; i < G * G; i++) {
    if (wall[i]) {
      landMask[i] = 1; // 墙像素归陆（岸线略鼓，视觉无所谓）
      continue;
    }
    const c = comp[i];
    const land = landVotes[c] > 0 || seaVotes[c] > 0
      ? landVotes[c] > seaVotes[c]
      : false; // 零票 = 海（贴边大洋 / 封闭潟湖都不与岸线直接相邻时）
    landMask[i] = land ? 1 : 0;
  }

  return buildFieldFromMask(bbox, landMask, elev);
}

/** 由陆地掩码重建高度场（距离变换 + 高程 + 噪声），缓存命中时免拉 Overpass。 */
export function buildFieldFromMask(
  bbox: BBox,
  landMask: Uint8Array,
  elev: ElevationGrid | null = null,
): HeightField {
  const { sizeX, sizeZ } = bboxSizeMeters(bbox);
  const G = GRID;

  // ---- 3. chamfer 距离变换（陆：距海；海：距陆） ----
  const distToSea = chamfer(landMask, 1, G); // 陆格 → 距最近海格
  const distToLand = chamfer(landMask, 0, G); // 海格 → 距最近陆格

  // 真实高程的渐近软压缩目标峰高：按选区尺寸自适应（宽约 2%），任何选区
  // 都有起伏但不过高。h' = H·h/(h + 0.6H)：小 h 近似线性，大 h 渐近 H/1.6 倍以上。
  const peakTarget = Math.max(30, Math.min(120, sizeX * 0.02));

  // ---- 4. 高度场 ----
  const cellX = sizeX / G;
  const cellZ = sizeZ / G;
  const cell = (cellX + cellZ) / 2;
  const data = new Float32Array(G * G);
  for (let z = 0; z < G; z++) {
    // 格点经纬度（toPx 的逆运算：行 0 = 北）
    const lat = bbox.n - (z / (G - 1)) * (bbox.n - bbox.s);
    for (let x = 0; x < G; x++) {
      const i = z * G + x;
      const n = noise2(x >> 2, z >> 2) - 0.5;
      let y: number;
      if (landMask[i]) {
        const d = distToSea[i] * cell;
        if (elev) {
          // 真实高程（软压缩），近岸 2 格内向沙滩带平滑 blend 防岸线跳变
          const lon = bbox.w + (x / (G - 1)) * (bbox.e - bbox.w);
          const hReal = Math.max(0, elev.sample(lat, lon));
          const hComp = (peakTarget * hReal) / (hReal + peakTarget * 0.6) + n * 2;
          const beach = Math.min(hComp, 0.8);
          const blend = Math.min(1, d / (cell * 2));
          y = beach * (1 - blend) + hComp * blend;
          // 噪声在近岸零高程处会抖出小坑：陆格最浅只到 -0.4m（潮池级别，不成洼地）
          if (y < -0.4) y = -0.4;
        } else {
          // 合成：0 ~ 200m 距海抬到 +28m，近岸 1 格内压到沙滩高度
          y = 28 * Math.min(1, d / 200) + n * 3 * Math.min(1, d / 60);
          if (d < cell * 1.5) y = Math.min(y, 0.8);
        }
      } else {
        // 海：0 ~ 260m 距陆沉到 -24m（水下地形平缓过渡，近岸浅滩；Terrarium 海洋无数据，保持合成）
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
