/**
 * AWS Terrain Tiles（Terrarium）真实高程。
 *
 * - 瓦片：`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`，
 *   免 key、`Access-Control-Allow-Origin: *`（已实测）。
 * - 解码：`elevation = R×256 + G + B/256 − 32768`（米）。海洋/无数据区返回 0。
 * - zoom=12：单瓦片 ~0.088° 见方，一个 ≤0.2° 的选区覆盖 3×3~4×4 ≈ 9~16 张，
 *   每张 ~60KB、总量 <1MB；z13 瓦片数 ×4 而选区尺度上山脊细节已超出
 *   384² 高度场能表达的密度，不值。
 *
 * 任何一张瓦片失败/超时（15s）→ 整体 resolve(null)，调用方回退合成高程，
 * 不阻塞进场。
 */

import type { BBox } from './overpass';

const ZOOM = 12;
const TILE_SIZE = 256;
const FETCH_TIMEOUT_MS = 15_000;
const TILE_URL = (z: number, x: number, y: number): string =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export interface ElevationGrid {
  /** lat/lon（度）→ 高程（米）；无数据返回 0。 */
  sample(lat: number, lon: number): number;
  /** 选区内实测最大高程（米）。 */
  maxElev: number;
}

function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

function fetchTile(z: number, x: number, y: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tile ${z}/${x}/${y} timeout`)), FETCH_TIMEOUT_MS);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = TILE_SIZE;
        canvas.height = TILE_SIZE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
        const out = new Float32Array(TILE_SIZE * TILE_SIZE);
        for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
          out[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
        }
        resolve(out);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`tile ${z}/${x}/${y} load failed`));
    };
    img.src = TILE_URL(z, x, y);
  });
}

/** bbox → 区域高程采样器；任何失败返回 null（整体回退合成高程）。 */
export async function fetchElevation(bbox: BBox): Promise<ElevationGrid | null> {
  try {
    const x0 = Math.floor(lonToTileX(bbox.w, ZOOM));
    const x1 = Math.floor(lonToTileX(bbox.e, ZOOM));
    const y0 = Math.floor(latToTileY(bbox.n, ZOOM)); // 北 = 较小 y
    const y1 = Math.floor(latToTileY(bbox.s, ZOOM));

    const coords: [number, number][] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) coords.push([x, y]);
    console.info(`[elevation] Terrarium z${ZOOM} 瓦片 ${coords.length} 张`);

    const results = await Promise.all(coords.map(([x, y]) => fetchTile(ZOOM, x, y)));
    const tiles = new Map<string, Float32Array>();
    let maxElev = 0;
    for (let i = 0; i < coords.length; i++) {
      const tile = results[i];
      tiles.set(`${coords[i][0]},${coords[i][1]}`, tile);
      for (let j = 0; j < tile.length; j += 7) if (tile[j] > maxElev) maxElev = tile[j];
    }

    const sample = (lat: number, lon: number): number => {
      const gx = lonToTileX(lon, ZOOM);
      const gy = latToTileY(lat, ZOOM);
      const tx = Math.floor(gx);
      const ty = Math.floor(gy);
      const tile = tiles.get(`${tx},${ty}`);
      if (!tile) return 0;
      // 瓦片内局部坐标（小数像素）
      const fx = (gx - tx) * TILE_SIZE - 0.5;
      const fy = (gy - ty) * TILE_SIZE - 0.5;
      const x0p = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(fx)));
      const y0p = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(fy)));
      const x1p = Math.min(TILE_SIZE - 1, x0p + 1);
      const y1p = Math.min(TILE_SIZE - 1, y0p + 1);
      const ax = Math.max(0, Math.min(1, fx - x0p));
      const ay = Math.max(0, Math.min(1, fy - y0p));
      const a = tile[y0p * TILE_SIZE + x0p];
      const b = tile[y0p * TILE_SIZE + x1p];
      const c = tile[y1p * TILE_SIZE + x0p];
      const d = tile[y1p * TILE_SIZE + x1p];
      return (a + (b - a) * ax) * (1 - ay) + (c + (d - c) * ax) * ay;
    };
    return { sample, maxElev };
  } catch (error) {
    console.warn('[elevation] 高程瓦片获取失败，回退合成高程：', error);
    return null;
  }
}
