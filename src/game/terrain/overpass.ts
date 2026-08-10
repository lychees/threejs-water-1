/**
 * Overpass API 抓取 bbox 内的海岸线（natural=coastline）并组装成折线段。
 *
 * 查询 `way["natural"=coastline"](S,W,N,E);(._;>;);out body;`：返回 way 与全部
 * 引用节点（含 bbox 外的节点——跨边界的 way 需要完整几何才能当"墙"用）。
 *
 * 不做多边形组装：海岸线 way 在 bbox 边缘被切断、顺序杂乱、有洞，拼多边形
 * 脆弱；下游用"画布画线 → 边缘洪水填充"把折线当墙，对碎段鲁棒得多。
 */

export interface BBox {
  /** 南/西/北/东，度数。 */
  s: number;
  w: number;
  n: number;
  e: number;
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const TIMEOUT_MS = 30_000;

/** 一条折线：经纬度对序列 [lat, lon, lat, lon, ...]。 */
export type Coastline = Float32Array;

export interface CoastlineData {
  lines: Coastline[];
  nodeCount: number;
}

export async function fetchCoastlines(bbox: BBox): Promise<CoastlineData> {
  const query = `[out:json][timeout:25];way["natural"="coastline"](${bbox.s},${bbox.w},${bbox.n},${bbox.e});(._;>;);out body;`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const json = (await res.json()) as {
    elements: { type: string; id: number; lat?: number; lon?: number; nodes?: number[] }[];
  };

  const nodes = new Map<number, [number, number]>();
  const ways: number[][] = [];
  for (const el of json.elements) {
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      nodes.set(el.id, [el.lat, el.lon]);
    } else if (el.type === 'way' && el.nodes && el.nodes.length >= 2) {
      ways.push(el.nodes);
    }
  }

  const lines: Coastline[] = [];
  for (const way of ways) {
    const line = new Float32Array(way.length * 2);
    let n = 0;
    for (const id of way) {
      const node = nodes.get(id);
      if (!node) continue; // 缺节点就跳（下游把线当墙，断一小段可接受）
      line[n++] = node[0];
      line[n++] = node[1];
    }
    if (n >= 4) lines.push(line.subarray(0, n) as Coastline);
  }
  return { lines, nodeCount: nodes.size };
}
