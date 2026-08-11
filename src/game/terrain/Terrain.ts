/**
 * 自定义海域地形：Overpass 海岸线 → 高度场 → 陆地 mesh + 出生点 + 小地图轮廓。
 *
 * 摆放：区域中心放在 CUSTOM_CENTER（离基座迷雾岛与原点高原都足够远），
 * 不改变基座 Seafloor——并存方案。代价是基座水体的浅滩染色/碎浪只认
 * 原岛屿的高度场（TSL 孪生，运行期换不了），自定义区域的浅水视觉由
 * 地形 mesh 自身的水下部分承担（沙滩色带延伸到水下）。
 */

import * as THREE from 'three/webgpu';
import { fetchCoastlines, type BBox } from './overpass';
import { fetchElevation } from './elevation';
import { buildHeightField, buildFieldFromMask, sampleHeight, GRID, type HeightField } from './heightfield';

// 测试钩子（与 __game/__ocean 同待遇）：分类器可用合成海岸线直接单测。
(window as unknown as { __terrainBuild: typeof buildHeightField }).__terrainBuild = buildHeightField;

/** 区域中心（世界坐标）。迷雾岛在 (-1150,-780)，原点在高原浅水区，这里两边都不沾。 */
export const CUSTOM_CENTER = { x: 6000, z: 6000 };

const MESH_SEGMENTS = 256; // 地形网格密度（真实山脊需要比半价更高）

export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly center = CUSTOM_CENTER;

  private constructor(private readonly field: HeightField) {
    this.mesh = this.buildMesh();
  }

  static async load(bbox: BBox): Promise<Terrain> {
    // v2：海陆分类算法改为陆侧标记（v1 的边界洪水法在大陆海岸选区会把陆判成海），
    // 旧缓存掩码一律作废。
    const cacheKey = maskCacheKey(bbox);

    // 缓存命中：跳过 Overpass，直接从海陆掩码重建高度场（确定性，结果一致）
    let cachedMask: Uint8Array | null = null;
    try {
      const raw = window.localStorage.getItem(cacheKey);
      if (raw) {
        const bin = atob(raw);
        if (bin.length === GRID * GRID) {
          cachedMask = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) cachedMask[i] = bin.charCodeAt(i);
        }
      }
    } catch {
      cachedMask = null;
    }

    // 真实高程与海岸线拉取并行（高程失败 → null → 合成高程回退，不阻塞）
    const elevationPromise = fetchElevation(bbox);

    let field;
    if (cachedMask) {
      console.info('[terrain] 命中本地缓存，跳过 Overpass');
      field = buildFieldFromMask(bbox, cachedMask, await elevationPromise);
    } else {
      const { lines, nodeCount } = await fetchCoastlines(bbox);
      if (lines.length === 0) throw new Error('该区域没有海岸线数据');
      console.info(`[terrain] 海岸线 ${lines.length} 条 / ${nodeCount} 节点，开始光栅化`);
      field = buildHeightField(bbox, lines, await elevationPromise);
      // 写缓存（147KB 掩码 → ~196KB base64，放得下 localStorage；写失败不碍事）
      try {
        let bin = '';
        const CHUNK = 32768;
        for (let i = 0; i < field.landMask.length; i += CHUNK) {
          bin += String.fromCharCode(...field.landMask.subarray(i, i + CHUNK));
        }
        window.localStorage.setItem(cacheKey, btoa(bin));
      } catch {
        // 存储满了就算了，下次再拉
      }
    }

    //  sanity：全陆或全海都不是战场
    let land = 0;
    for (let i = 0; i < field.landMask.length; i++) land += field.landMask[i];
    const ratio = land / field.landMask.length;
    if (ratio < 0.02 || ratio > 0.85) {
      throw new Error(`陆地占比异常（${(ratio * 100).toFixed(0)}%），换一片有岛有海的位置`);
    }
    return new Terrain(field);
  }

  /** 战场局部坐标（区域中心为原点）的高度。 */
  height(x: number, z: number): number {
    return sampleHeight(this.field, x, z);
  }

  /** 世界坐标高度。 */
  heightWorld(x: number, z: number): number {
    return this.height(x - this.center.x, z - this.center.z);
  }

  isLandWorld(x: number, z: number): boolean {
    return this.heightWorld(x, z) > 0;
  }

  /** 出生点：距岸 ~80~150m 的可航浅水外缘（水深 -6 ~ -12m），进门就能看到生成的岛屿。 */
  findSpawn(): THREE.Vector3 {
    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < 600; i++) {
      const x = (Math.random() - 0.5) * this.field.sizeX * 0.9;
      const z = (Math.random() - 0.5) * this.field.sizeZ * 0.9;
      const h = this.height(x, z);
      if (h > -6 || h < -12) continue; // 太浅会搁浅，太深就看不见岸
      const score = Math.abs(h + 8); // 最接近 8m 水深
      if (score < bestScore) {
        bestScore = score;
        best = new THREE.Vector3(x + this.center.x, 0, z + this.center.z);
      }
    }
    // 兜底：全非海岸区域（纯海）退回中心
    return best ?? new THREE.Vector3(this.center.x, 0, this.center.z);
  }

  /** 小地图用：掩码直接画成 ImageData（陆绿海蓝），返回 canvas。 */
  makeMinimapImage(): HTMLCanvasElement {
    const G = GRID;
    const canvas = document.createElement('canvas');
    canvas.width = G;
    canvas.height = G;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(G, G);
    for (let i = 0; i < G * G; i++) {
      const land = this.field.landMask[i];
      img.data[i * 4] = land ? 63 : 6;
      img.data[i * 4 + 1] = land ? 122 : 30;
      img.data[i * 4 + 2] = land ? 79 : 44;
      img.data[i * 4 + 3] = land ? 220 : 110;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** 区域局部坐标 → 掩码图像素。Minimap 画轮廓时换算用。 */
  get grid(): number {
    return GRID;
  }

  get sizeX(): number {
    return this.field.sizeX;
  }

  get sizeZ(): number {
    return this.field.sizeZ;
  }

  private buildMesh(): THREE.Mesh {
    const { sizeX, sizeZ } = this.field;
    const seg = MESH_SEGMENTS;
    const geo = new THREE.PlaneGeometry(sizeX, sizeZ, seg, seg);
    geo.rotateX(-Math.PI / 2); // 平躺，+Z 朝南无所谓——采样用世界坐标
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const sand = new THREE.Color(0xc2b280);
    const grass = new THREE.Color(0x4a7a3f);
    const rock = new THREE.Color(0x6a6a66);
    const snow = new THREE.Color(0xe8ecef);
    const underwater = new THREE.Color(0x9a8f6a);
    const c = new THREE.Color();
    // 真实高程下的色带按自适应峰高分档（与 heightfield 的压缩目标同式）
    const peak = Math.max(30, Math.min(120, sizeX * 0.02));
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const lz = pos.getZ(i);
      const h = this.height(lx, lz);
      pos.setY(i, h);
      // 高程配色：水下沙 → 沙滩 → 植被 → 岩 →（高峰）雪
      if (h < 0) c.copy(underwater);
      else if (h < 2) c.copy(sand);
      else if (h < peak * 0.35) c.copy(sand).lerp(grass, (h - 2) / (peak * 0.35 - 2));
      else if (h < peak * 0.7) c.copy(grass).lerp(rock, (h - peak * 0.35) / (peak * 0.35));
      else c.copy(rock).lerp(snow, Math.min(1, (h - peak * 0.7) / (peak * 0.2)));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: false }),
    );
    mesh.position.set(this.center.x, 0, this.center.z);
    mesh.receiveShadow = true;
    mesh.name = 'custom-terrain';
    return mesh;
  }
}

// ---------------------------------------------------------------- bbox 存取

export const BBOX_STORAGE_KEY = 'web-ocean:bbox:v1';

/** 当前选区：URL 参数 ?bbox=S,W,N,E 优先，其次 localStorage，null = 默认迷雾岛。 */
export function resolveBBox(): BBox | null {
  const parse = (raw: string | null): BBox | null => {
    if (!raw) return null;
    const parts = raw.split(',').map(Number);
    if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
    const [s, w, n, e] = parts;
    if (s >= n || w >= e) return null;
    if (n - s > 0.2 || e - w > 0.2) return null; // ~20km 上限
    return { s, w, n, e };
  };
  const fromUrl = parse(new URL(window.location.href).searchParams.get('bbox'));
  if (fromUrl) return fromUrl;
  try {
    return parse(window.localStorage.getItem(BBOX_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeBBox(bbox: BBox | null): void {
  try {
    if (bbox) {
      window.localStorage.setItem(BBOX_STORAGE_KEY, [bbox.s, bbox.w, bbox.n, bbox.e].join(','));
      pushArea(bbox);
    } else {
      window.localStorage.removeItem(BBOX_STORAGE_KEY);
    }
  } catch {
    // 隐私模式：当次会话有效
  }
}

// ---------------------------------------------------------------- 选区历史与缓存管理

const AREAS_KEY = 'web-ocean:areas:v1';
const MAX_AREAS = 8;

export interface AreaEntry extends BBox {
  savedAt: number;
}

const bboxEq = (a: BBox, b: BBox): boolean =>
  a.s === b.s && a.w === b.w && a.n === b.n && a.e === b.e;

/** 掩码缓存键（v2 = 左陆右海分类法产物；删历史时连同删除）。 */
export function maskCacheKey(bbox: BBox): string {
  return `web-ocean:terrain-mask:v2:${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
}

/** 历史选区列表（新的在前）。 */
export function listAreas(): AreaEntry[] {
  try {
    const raw = window.localStorage.getItem(AREAS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as AreaEntry[];
    return Array.isArray(arr) ? arr.filter((a) => a && Number.isFinite(a.s)) : [];
  } catch {
    return [];
  }
}

function pushArea(bbox: BBox): void {
  try {
    const list = listAreas().filter((a) => !bboxEq(a, bbox));
    list.unshift({ ...bbox, savedAt: Date.now() });
    window.localStorage.setItem(AREAS_KEY, JSON.stringify(list.slice(0, MAX_AREAS)));
  } catch {
    // 存储满/隐私模式：历史不可用不碍事
  }
}

/** 该选区是否已有本地掩码缓存（命中则免拉 Overpass 秒开）。 */
export function hasMaskCache(bbox: BBox): boolean {
  try {
    return window.localStorage.getItem(maskCacheKey(bbox)) !== null;
  } catch {
    return false;
  }
}

/** 删除历史选区及其掩码缓存。 */
export function removeArea(bbox: BBox): void {
  try {
    window.localStorage.setItem(AREAS_KEY, JSON.stringify(listAreas().filter((a) => !bboxEq(a, bbox))));
    window.localStorage.removeItem(maskCacheKey(bbox));
  } catch {
    // 同上
  }
}
