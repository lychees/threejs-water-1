/**
 * 大航海景观层：真实港口建筑群 + 海岸礁石/悬崖 + 水面孤礁 + 沉船残骸。
 *
 * 素材：Quaternius Pirate Kit（CC0，public/models/harbor/，自嵌入 gltf）+
 * Poly Haven（CC0，coast_rocks_05、dressing 的 wooden_lantern_01）。
 *
 * 摆放（全部走 GroundSampler 贴地形）：
 *  - 港口核心：每个城镇点位摆真房子（House1-3/Sawmill 混摆，r 8~45m；程序化
 *    盒子房已退到 38~100m 外环当郊区），第一个点位带码头（伸向水面）与灯笼；
 *  - 海岸：近岸带（h -1.5~1.5）撒礁石、近岸高地（h 8~25 且 60m 内有水）立悬崖、
 *    岸边撒棕榈；
 *  - 水面孤礁：战场水域 3~6 块（水深 2.5~14m、岩顶露出水面 1~2.5m，避让出生点
 *    ≥200m、城镇 ≥150m）——航海的危险感，不另加碰撞（避浅逻辑已覆盖）；
 *  - 沉船残骸：浅水 1~2 艘 Ship_Small 半沉倾斜、帆布压暗。
 *
 * 重复模型全部转 InstancedMesh（子网格 × 放置矩阵），整层 draw call ≈ 子网格
 * 总数（~20）；任一模型加载失败静默跳过（景观不是关键路径）。
 */

import * as THREE from 'three/webgpu';
import type { AssetLoader } from '../scene/AssetLoader';
import type { GroundSampler, TownSite } from './Towns';

const H = '/models/harbor';
const HOUSE_URLS = [`${H}/House1.gltf`, `${H}/House2.gltf`, `${H}/House3.gltf`, `${H}/Sawmill.gltf`];
const DOCK_URLS = [`${H}/Dock.gltf`, `${H}/Dock_Broken.gltf`];
const PALM_URLS = [`${H}/PalmTree_1.gltf`, `${H}/PalmTree_2.gltf`, `${H}/PalmTree_3.gltf`];
const CLIFF_URLS = [`${H}/Cliff1.gltf`, `${H}/Cliff2.gltf`, `${H}/Cliff3.gltf`, `${H}/Cliff4.gltf`];
const ROCK_URLS = [`${H}/Rock_1.gltf`, `${H}/Rock_3.gltf`, `${H}/Rock_5.gltf`];
const BIG_ROCK_URL = '/models/coast/coast_rocks_05/coast_rocks_05_1k.gltf';
const LANTERN_URL = '/models/dressing/wooden_lantern_01.glb';
const WRECK_URL = '/models/game-ships/quaternius_pirate/Ship_Small.gltf';

interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** 横倾/纵倾（弧度，默认 0；沉船残骸用）。 */
  roll?: number;
  pitch?: number;
}

/**
 * 模板 → InstancedMesh 组：归一化（最大边 = targetMax、底部对齐 y=0、中心对齐 xz）
 * 后按放置列表实例化；模板的每个子网格一个 InstancedMesh。
 */
function instancedFromTemplate(
  template: THREE.Object3D,
  placements: Placement[],
  targetMax: number,
  tint: number | null = null,
): THREE.Object3D[] {
  if (placements.length === 0) return [];
  const box = new THREE.Box3().setFromObject(template);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim <= 0) return [];
  const s = targetMax / maxDim;
  // 归一化矩阵：缩放到目标尺寸 + 底部/中心对齐
  const corr = new THREE.Matrix4()
    .makeScale(s, s, s)
    .multiply(
      new THREE.Matrix4().makeTranslation(
        -(box.min.x + box.max.x) / 2,
        -box.min.y,
        -(box.min.z + box.max.z) / 2,
      ),
    );
  template.updateMatrixWorld(true);
  const subs: { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; rel: THREE.Matrix4 }[] = [];
  template.traverse((n) => {
    const mesh = n as THREE.Mesh;
    if (mesh.isMesh) subs.push({ geo: mesh.geometry, mat: mesh.material, rel: mesh.matrixWorld.clone() });
  });
  const out: THREE.Object3D[] = [];
  const pm = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const one = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  for (const { geo, mat, rel } of subs) {
    let useMat = mat;
    if (tint !== null && !Array.isArray(mat)) {
      const c = mat.clone() as THREE.MeshStandardMaterial;
      c.color.multiply(new THREE.Color(tint)); // 压暗（沉船残骸）
      useMat = c;
    }
    const im = new THREE.InstancedMesh(geo, useMat, placements.length);
    placements.forEach((pl, i) => {
      e.set(pl.roll ?? 0, pl.yaw, pl.pitch ?? 0, 'YXZ');
      q.setFromEuler(e);
      pos.set(pl.x, pl.y, pl.z);
      pm.compose(pos, q, one);
      im.setMatrixAt(i, pm.multiply(corr).multiply(rel));
    });
    im.castShadow = true;
    im.receiveShadow = true;
    out.push(im);
  }
  return out;
}

export interface SceneryOptions {
  ground: GroundSampler;
  /** 海岸区（悬崖/岸礁/棕榈/沉船）：自定义 = 地形中心+半径；默认 = 迷雾岛。 */
  coast: { x: number; z: number; radius: number };
  /** 战场区（水面孤礁）：默认 = 原点活动圈；自定义 = 同海岸区。 */
  play: { x: number; z: number; radius: number };
  towns: readonly TownSite[];
  spawn: { x: number; z: number };
}

export class Scenery {
  readonly object = new THREE.Group();
  /** 各分类放置数量（验证/调试可读）。 */
  readonly counts = { houses: 0, docks: 0, lanterns: 0, palms: 0, cliffs: 0, shoreRocks: 0, reefs: 0, wrecks: 0 };
  /** 各分类第一个放置点（验证截图取景用）。 */
  readonly samples: Partial<Record<keyof Scenery['counts'], { x: number; y: number; z: number }>> = {};

  private constructor() {
    this.object.name = 'scenery';
  }

  static async deploy(
    scene: THREE.Scene,
    assets: AssetLoader,
    opts: SceneryOptions,
  ): Promise<Scenery> {
    const sc = new Scenery();
    const g = opts.ground;

    // ---- 全部模型并行加载；单个失败 → null → 该分类静默跳过 ----
    const load = async (url: string): Promise<THREE.Object3D | null> => {
      try {
        return await assets.load(url);
      } catch {
        return null;
      }
    };
    const urls = [
      ...HOUSE_URLS, ...DOCK_URLS, ...PALM_URLS, ...CLIFF_URLS, ...ROCK_URLS,
      BIG_ROCK_URL, LANTERN_URL, WRECK_URL,
    ];
    const loaded = await Promise.all(urls.map(load));
    const at = (i: number) => loaded[i];
    const houses = HOUSE_URLS.map((_, i) => at(i));
    const docks = DOCK_URLS.map((_, i) => at(HOUSE_URLS.length + i));
    const palms = PALM_URLS.map((_, i) => at(HOUSE_URLS.length + DOCK_URLS.length + i));
    const cliffs = CLIFF_URLS.map((_, i) => at(HOUSE_URLS.length + DOCK_URLS.length + PALM_URLS.length + i));
    const rocks = ROCK_URLS.map((_, i) => at(HOUSE_URLS.length + DOCK_URLS.length + PALM_URLS.length + CLIFF_URLS.length + i));
    const bigRock = at(HOUSE_URLS.length + DOCK_URLS.length + PALM_URLS.length + CLIFF_URLS.length + ROCK_URLS.length);
    const lantern = at(urls.length - 2);
    const wreck = at(urls.length - 1);

    const nearWater = (x: number, z: number, d = 60): boolean =>
      g.height(x + d, z) < 0 || g.height(x - d, z) < 0 || g.height(x, z + d) < 0 || g.height(x, z - d) < 0;

    /** 在环带内随机采样满足条件的点（pred 收世界坐标与高度）。 */
    const sample = (
      cx: number, cz: number, rMin: number, rMax: number,
      pred: (x: number, z: number, h: number) => boolean,
      tries = 40,
    ): Placement | null => {
      for (let i = 0; i < tries; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = rMin + Math.random() * (rMax - rMin);
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        const h = g.height(x, z);
        if (pred(x, z, h)) return { x, y: h - 0.15, z, yaw: Math.random() * Math.PI * 2 };
      }
      return null;
    };

    const add = (templates: (THREE.Object3D | null)[], placements: Placement[][], targetMax: number, tint: number | null = null): number => {
      let added = 0;
      templates.forEach((tpl, i) => {
        if (!tpl || placements[i].length === 0) return;
        for (const obj of instancedFromTemplate(tpl, placements[i], targetMax, tint)) sc.object.add(obj);
        added += placements[i].length;
      });
      return added;
    };

    // ---- 港口核心：真房子（r 8~45，h>1.5；每点位 4~6 栋，总量 ≤80） ----
    const housePl: Placement[][] = houses.map(() => []);
    for (const site of opts.towns) {
      const n = 4 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const p = sample(site.x, site.z, 8, 45, (_x, _z, h) => h > 1.5);
        if (!p) continue;
        housePl[Math.floor(Math.random() * houses.length)].push(p);
      }
    }
    // 总量封顶：超出随机丢弃
    let totalHouses = housePl.reduce((s, a) => s + a.length, 0);
    while (totalHouses > 80) {
      const i = Math.floor(Math.random() * housePl.length);
      if (housePl[i].length > 0) {
        housePl[i].pop();
        totalHouses--;
      }
    }
    sc.counts.houses = add(houses, housePl, 7);
    sc.samples.houses = housePl.flat()[0];

    // ---- 码头：前 6 个点位各 1 座。真实高程下 place 节点可能在内陆数百米，
    // 先螺旋扫到最近岸线（h -1~2 且 50m 内有水），再朝水面摆 ----
    const dockPl: Placement[][] = docks.map(() => []);
    for (const site of opts.towns.slice(0, 6)) {
      let found: Placement | null = null;
      outer: for (let r = 0; r <= 400 && !found; r += 30) {
        const steps = Math.max(8, Math.round(r / 15));
        for (let i = 0; i < steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          const x = site.x + Math.cos(a) * r;
          const z = site.z + Math.sin(a) * r;
          const h = g.height(x, z);
          if (h > -1 && h < 2 && nearWater(x, z, 50)) {
            // 桩腿下沉 1m 扎进坡地（底对齐放在单点采样高度，坡面另一侧会悬空）
            found = { x, y: h - 1.0, z, yaw: 0 };
            break outer;
          }
        }
      }
      if (!found) continue;
      // 朝向：朝最近水方向（八向粗测）
      let bestA = 0;
      let bestH = Infinity;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const hh = g.height(found.x + Math.cos(a) * 25, found.z + Math.sin(a) * 25);
        if (hh < bestH) {
          bestH = hh;
          bestA = a;
        }
      }
      found.yaw = bestA;
      // 往水侧走到真正水线（h<-1.5），桩腿埋进水底：码头从岸坡跨进水面，
      // 而不是底对齐悬在岸坡上
      for (let i = 0; i < 14; i++) {
        const nx = found.x + Math.cos(bestA) * 5;
        const nz = found.z + Math.sin(bestA) * 5;
        found.x = nx;
        found.z = nz;
        if (g.height(nx, nz) < -1.5) break;
      }
      found.y = -2.3; // 桩腿长 ~3.5m（10m 模型），板面 ≈ 水线 +1.2m
      dockPl[Math.floor(Math.random() * docks.length)].push(found);
    }
    sc.counts.docks = add(docks, dockPl, 10);
    sc.samples.docks = dockPl.flat()[0];

    // ---- 灯笼：每个点位 1~2 盏（h>1） ----
    if (lantern) {
      const pl: Placement[] = [];
      for (const site of opts.towns) {
        const n = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < n; i++) {
          const p = sample(site.x, site.z, 6, 40, ( _x, _z, h) => h > 1);
          if (p) pl.push(p);
        }
      }
      sc.counts.lanterns = add([lantern], [pl], 1.4);
    sc.samples.lanterns = pl[0];
    }

    // ---- 棕榈：城镇周边近岸（h 1~6，r<160），总量 ≤40 ----
    {
      const pl: Placement[][] = palms.map(() => []);
      let total = 0;
      for (const site of opts.towns) {
        const n = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n && total < 40; i++) {
          const p = sample(site.x, site.z, 20, 160, (_x, _z, h) => h > 1 && h < 6);
          if (!p) continue;
          pl[Math.floor(Math.random() * palms.length)].push(p);
          total++;
        }
      }
      sc.counts.palms = add(palms, pl, 8);
    sc.samples.palms = pl.flat()[0];
    }

    // ---- 海岸悬崖：近岸高地（h 6~30 且 80m 内有水），4~8 处；真实高程的
    // 合适坡地稀疏，采样量给足 ----
    {
      const pl: Placement[][] = cliffs.map(() => []);
      let n = 0;
      const target = 4 + Math.floor(Math.random() * 5);
      for (let i = 0; i < 800 && n < target; i++) {
        const p = sample(opts.coast.x, opts.coast.z, 0, opts.coast.radius, (x, z, h) => h > 6 && h < 30 && nearWater(x, z, 80), 1);
        if (!p) continue;
        pl[Math.floor(Math.random() * cliffs.length)].push(p);
        n++;
      }
      sc.counts.cliffs = add(cliffs, pl, 20);
    sc.samples.cliffs = pl.flat()[0];
    }

    // ---- 近岸礁石：h -1.5~1.5 岸线带，10~16 块（小礁石 + 大岩礁混合） ----
    {
      const plR: Placement[][] = rocks.map(() => []);
      const plBig: Placement[] = [];
      let n = 0;
      const target = 10 + Math.floor(Math.random() * 7);
      for (let i = 0; i < 500 && n < target; i++) {
        const p = sample(opts.coast.x, opts.coast.z, 0, opts.coast.radius, (_x, _z, h) => h > -1.5 && h < 1.5, 1);
        if (!p) continue;
        if (bigRock && Math.random() < 0.3) plBig.push(p);
        else plR[Math.floor(Math.random() * rocks.length)].push(p);
        n++;
      }
      sc.counts.shoreRocks = add(rocks, plR, 3.5) + add([bigRock], [plBig], 9);
    sc.samples.shoreRocks = plR.flat()[0] ?? plBig[0];
    }

    // ---- 水面孤礁：战场水域 3~6 块，水深 2.5~14m，顶露出水面 1~2.5m ----
    if (bigRock) {
      const pl: Placement[] = [];
      const target = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < 400 && pl.length < target; i++) {
        const p = sample(
          opts.play.x, opts.play.z, 0, opts.play.radius,
          (x, z, h) =>
            h < -2.5 && h > -14 &&
            Math.hypot(x - opts.spawn.x, z - opts.spawn.z) > 200 &&
            !opts.towns.some((t) => Math.hypot(t.x - x, t.z - z) < 150),
          1,
        );
        if (!p) continue;
        pl.push(p);
      }
      // 顶出水 1.2~2.2m：按模型缩放后的真实高度反推基座 y
      const rb = new THREE.Box3().setFromObject(bigRock);
      const rSize = rb.getSize(new THREE.Vector3());
      const topH = rSize.y * (9 / Math.max(rSize.x, rSize.y, rSize.z));
      sc.counts.reefs = add(
        [bigRock],
        [pl.map((p) => ({ ...p, y: 1.2 + Math.random() - topH }))],
        9,
      );
      sc.samples.reefs = pl[0] ? { ...pl[0], y: 1.6 - topH } : undefined;
    }

    // ---- 沉船残骸：浅水 1~2 艘半沉倾斜 Ship_Small（帆布压暗） ----
    if (wreck) {
      const pl: Placement[] = [];
      const target = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < 300 && pl.length < target; i++) {
        const p = sample(
          opts.coast.x, opts.coast.z, 0, opts.coast.radius,
          (x, z, h) => h < -2 && h > -6 && Math.hypot(x - opts.spawn.x, z - opts.spawn.z) > 150,
          1,
        );
        if (!p) continue;
        pl.push({ ...p, y: -1.2 - Math.random() * 0.8 }); // 半沉：水线没过甲板
      }
      // 半沉 + 横倾写进放置矩阵（InstancedMesh 的对象级旋转会绕世界原点，不能用）
      let added = 0;
      for (const p of pl) {
        const tilted: Placement = {
          ...p,
          roll: 0.28 + Math.random() * 0.2,
          pitch: (Math.random() - 0.5) * 0.15,
        };
        for (const obj of instancedFromTemplate(wreck, [tilted], 12, 0x9a8f80)) sc.object.add(obj);
        added++;
      }
      sc.counts.wrecks = added;
    sc.samples.wrecks = pl[0];
    }

    scene.add(sc.object);
    return sc;
  }
}
