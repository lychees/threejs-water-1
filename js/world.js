// 世界场景资产：真实岛屿/要塞/码头/植被/浮标 + 漂浮补给（均为 Poly Haven CC0）
// 加载全部并行异步进行，不阻塞游戏开始；单个资产失败只跳过对应布置，不影响其余
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---- 资产清单（models/<id>/<id>_1k.gltf） ----
const ASSET_IDS = [
  'coastal_cliff_01', 'coast_rocks_01', 'sand_rocks_small_01',
  'modular_fort_01', 'modular_wooden_pier', 'cannon_01',
  'treasure_chest', 'wooden_barrels_01', 'wooden_crate_01', 'wooden_crate_02',
  'ocean_buoy',
  'fern_02', 'grass_bermuda_01', 'shrub_sorrel_01', 'pachira_aquatica_01',
];

const cache = new Map(); // id -> Promise<THREE.Group|null>

export function loadModel(id) {
  if (!cache.has(id)) {
    cache.set(id, new Promise((resolve) => {
      new GLTFLoader().load(
        `models/${id}/${id}_1k.gltf`,
        (gltf) => resolve(gltf.scene),
        undefined,
        (err) => { console.warn(`[world] ${id} 加载失败，跳过：`, err); resolve(null); }
      );
    }));
  }
  return cache.get(id);
}

// 通用归一化包装：水平最大边缩放到 targetSize、水平居中、底部对齐 y=0 后再抬到 bottomY
function wrapProp(root, targetSize, bottomY = 0) {
  const g = new THREE.Group();
  g.add(root);
  g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g);
  const size = box.getSize(new THREE.Vector3());
  const s = targetSize / Math.max(size.x, size.z);
  g.scale.setScalar(s);
  root.position.set(
    -(box.min.x + box.max.x) / 2,
    -box.min.y,
    -(box.min.z + box.max.z) / 2
  );
  g.position.y = bottomY;
  g.userData.height = size.y * s; // 缩放后的总高，摆放附属物时用
  return g;
}

// ---- 岛屿布局（均离出生点 >100m，分布不同方位）；导出供水面碎浪带使用 ----
export const ISLAND_DEFS = [
  { id: 'coastal_cliff_01', size: 85, pos: [-270, -210], bottom: -14, veg: 14, fort: true },
  { id: 'coast_rocks_01',   size: 60, pos: [300, 180],   bottom: -6,  veg: 8 },
  { id: 'coastal_cliff_01', size: 50, pos: [60, 340],    bottom: -10, veg: 8 },
];
const VEG_DEFS = [
  { id: 'fern_02', size: 1.4 },
  { id: 'grass_bermuda_01', size: 1.0 },
  { id: 'shrub_sorrel_01', size: 1.3 },
  { id: 'pachira_aquatica_01', size: 5.0 },
];
const BUOY_COUNT = 5;

// ---- 漂浮补给 ----
const SUPPLY_TYPES = [
  { id: 'wooden_barrels_01', size: 1.7, kind: 'repair', label: '+10 修复', weight: 3 },
  { id: 'wooden_crate_01', size: 1.5, kind: 'repair', label: '+10 修复', weight: 3 },
  { id: 'wooden_crate_02', size: 1.5, kind: 'repair', label: '+10 修复', weight: 2 },
  { id: 'treasure_chest', size: 1.4, kind: 'loot', label: '+1 战利品', weight: 2 },
];
const SUPPLY_COUNT = 10;
const PICKUP_DIST = 4;
const WORLD_RADIUS = 380; // 漂浮物活动半径

function rand(min, max) { return min + Math.random() * (max - min); }

export async function createWorld(scene, waveFn) {
  // 并行加载全部资产
  const templates = {};
  await Promise.all(ASSET_IDS.map(async (id) => { templates[id] = await loadModel(id); }));

  const islands = []; // { x, z, radius }
  const buoys = [];
  const supplies = [];

  // 随机取一个远离岛屿与出生点的位置
  function randomOpenPos(minR, maxR, clearance) {
    for (let tries = 0; tries < 30; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(minR, maxR);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      let ok = true;
      for (const isl of islands) {
        if (Math.hypot(x - isl.x, z - isl.z) < isl.radius + clearance) { ok = false; break; }
      }
      if (ok) return { x, z };
    }
    return null;
  }

  // ---- 岛屿 + 要塞 + 码头 + 火炮 + 浅滩礁石 + 植被 ----
  for (const def of ISLAND_DEFS) {
    const tpl = templates[def.id];
    if (!tpl) continue;
    const isl = wrapProp(tpl.clone(true), def.size, def.bottom);
    isl.position.x = def.pos[0];
    isl.position.z = def.pos[1];
    isl.rotation.y = Math.random() * Math.PI * 2;
    scene.add(isl);

    const radius = def.size * 0.45;
    const topY = def.bottom + isl.userData.height;
    islands.push({ x: def.pos[0], z: def.pos[1], radius });

    // 浅滩过渡礁石（岛缘没入水中）
    if (templates.sand_rocks_small_01) {
      for (let i = 0; i < 2; i++) {
        const a = Math.random() * Math.PI * 2;
        const rock = wrapProp(templates.sand_rocks_small_01.clone(true), rand(10, 16), -2);
        rock.position.x = def.pos[0] + Math.cos(a) * radius * 1.15;
        rock.position.z = def.pos[1] + Math.sin(a) * radius * 1.15;
        rock.rotation.y = Math.random() * Math.PI * 2;
        scene.add(rock);
      }
    }

    // 植被散布在岛顶附近（允许轻微悬空）
    for (let i = 0; i < def.veg; i++) {
      const veg = VEG_DEFS[Math.floor(Math.random() * VEG_DEFS.length)];
      const vtpl = templates[veg.id];
      if (!vtpl) continue;
      const v = wrapProp(vtpl.clone(true), veg.size * rand(0.8, 1.4));
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * radius * 0.55;
      v.position.set(
        def.pos[0] + Math.cos(a) * r,
        topY * rand(0.75, 0.9),
        def.pos[1] + Math.sin(a) * r
      );
      v.rotation.y = Math.random() * Math.PI * 2;
      scene.add(v);
    }

    // 主岛：要塞 + 码头 + 两门火炮
    if (def.fort) {
      if (templates.modular_fort_01) {
        const fort = wrapProp(templates.modular_fort_01.clone(true), 26);
        fort.position.x = def.pos[0];
        fort.position.z = def.pos[1];
        fort.position.y = topY * 0.82;
        fort.rotation.y = Math.PI / 5;
        scene.add(fort);

        if (templates.cannon_01) {
          for (const off of [[7, 4], [-6, 6]]) {
            const c = wrapProp(templates.cannon_01.clone(true), 2.2);
            c.position.set(def.pos[0] + off[0], topY * 0.82, def.pos[1] + off[1]);
            c.rotation.y = Math.atan2(off[0], off[1]); // 朝岛外
            scene.add(c);
          }
        }
      }
      if (templates.modular_wooden_pier) {
        // 码头从岛缘伸向开阔海面（朝出生点方向）
        const dirA = Math.atan2(-def.pos[0], -def.pos[1]);
        const pier = wrapProp(templates.modular_wooden_pier.clone(true), 22, 0.2);
        pier.position.x = def.pos[0] + Math.sin(dirA) * radius * 0.95;
        pier.position.z = def.pos[1] + Math.cos(dirA) * radius * 0.95;
        pier.rotation.y = dirA;
        scene.add(pier);
      }
    }
  }

  // ---- 浮标：随波浪浮沉摇摆 ----
  if (templates.ocean_buoy) {
    for (let i = 0; i < BUOY_COUNT; i++) {
      const pos = randomOpenPos(90, 320, 20);
      if (!pos) continue;
      const b = wrapProp(templates.ocean_buoy.clone(true), 2.5);
      b.position.set(pos.x, 0, pos.z);
      scene.add(b);
      buoys.push({ mesh: b, phase: Math.random() * Math.PI * 2 });
    }
  }

  // ---- 漂浮补给 ----
  function spawnSupply(existing) {
    // 按权重随机选类型（重生时保持原类型，避免外观与效果不符）
    let type = existing && existing.type;
    if (!type) {
      const totalW = SUPPLY_TYPES.reduce((s, t) => s + t.weight, 0);
      let roll = Math.random() * totalW;
      type = SUPPLY_TYPES[0];
      for (const t of SUPPLY_TYPES) { roll -= t.weight; if (roll <= 0) { type = t; break; } }
    }
    const tpl = templates[type.id];
    if (!tpl) return null;

    const pos = randomOpenPos(60, WORLD_RADIUS, 15);
    if (!pos) return null;
    const item = existing || {};
    if (!item.mesh) {
      item.mesh = wrapProp(tpl.clone(true), type.size);
      scene.add(item.mesh);
    }
    item.type = type;
    item.kind = type.kind;
    item.label = type.label;
    item.mesh.position.set(pos.x, 0, pos.z);
    item.mesh.visible = true;
    item.driftA = Math.random() * Math.PI * 2; // 漂移方向
    item.driftSpeed = rand(0.2, 0.5);
    item.rotSpeed = rand(-0.3, 0.3);
    item.phase = Math.random() * Math.PI * 2;
    item.active = true;
    item.respawnT = 0;
    return item;
  }

  for (let i = 0; i < SUPPLY_COUNT; i++) {
    const s = spawnSupply();
    if (s) supplies.push(s);
  }

  // ---- 对外接口 ----
  return {
    islands,
    buoys,      // 小地图用：{ mesh } 列表
    supplies,   // 小地图用：{ mesh, kind, active } 列表

    // 圆柱碰撞：进入半径的船被沿径向推开并减速
    resolveCollisions(ship) {
      const p = ship.position;
      for (const isl of islands) {
        const dx = p.x - isl.x;
        const dz = p.z - isl.z;
        const d = Math.hypot(dx, dz);
        if (d < isl.radius && d > 0.001) {
          const push = isl.radius / d;
          p.x = isl.x + dx * push;
          p.z = isl.z + dz * push;
          ship.speed *= 0.5;
        }
      }
    },

    /**
     * @param {THREE.Vector3|null} playerPos 为 null 时不做拾取判定（菜单/结束状态）
     * @param {Function} onPickup (item) 拾取回调：item.kind = repair | loot
     */
    update(dt, time, playerPos, onPickup) {
      // 浮标：跟随波高 + 轻微摇摆
      for (const b of buoys) {
        const p = b.mesh.position;
        p.y = waveFn(p.x, p.z, time) + 0.1;
        b.mesh.rotation.x = Math.sin(time * 0.8 + b.phase) * 0.12;
        b.mesh.rotation.z = Math.cos(time * 0.6 + b.phase) * 0.12;
      }

      // 漂浮补给：漂移 + 浮沉 + 自转 + 拾取/重生
      for (const s of supplies) {
        if (!s.active) {
          s.respawnT -= dt;
          if (s.respawnT <= 0) spawnSupply(s); // 20~40 秒后在远处重生
          continue;
        }
        const p = s.mesh.position;
        p.x += Math.sin(s.driftA) * s.driftSpeed * dt;
        p.z += Math.cos(s.driftA) * s.driftSpeed * dt;
        if (Math.hypot(p.x, p.z) > WORLD_RADIUS + 30) s.driftA += Math.PI; // 漂太远掉头
        p.y = waveFn(p.x, p.z, time) + 0.05;
        s.mesh.rotation.y += s.rotSpeed * dt;
        s.mesh.rotation.x = Math.sin(time * 0.7 + s.phase) * 0.08;

        if (playerPos && p.distanceTo(playerPos) < PICKUP_DIST) {
          s.active = false;
          s.mesh.visible = false;
          s.respawnT = rand(20, 40);
          onPickup(s);
        }
      }
    },
  };
}
