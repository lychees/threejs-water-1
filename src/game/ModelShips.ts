/**
 * 精致船模注册表 + 按需加载 / 校正 / 克隆 / 染色。
 * 移植自旧 js/modelship.js，加载走基座 AssetLoader（assetUrl 子路径安全、
 * 独立克隆、失败可独立缺席）。
 *
 * 模型：Poly Haven（dutch 三艘 + pinnace）与 Quaternius Pirate Kit，均 CC0。
 * dutch_ship_medium 与基座 public/models/ 下的逐字节相同，直接复用不重复拷贝。
 *
 * 校正：长轴对齐 Z、船头朝 +Z（顶点高度启发式 + flip 标记表）、缩放到目标
 * 船长、龙骨对齐吃水——输出容器原点即水线中心、船头 +Z，与 Shipyard 的
 * 程序化船同一约定，挂 GameShip 容器时同样 yaw +π/2。
 */

import * as THREE from 'three/webgpu';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl } from '../core/paths';
import type { AssetLoader } from '../scene/AssetLoader';

export interface ShipModelDef {
  /** AssetLoader 可解析的 public 内路径。 */
  path: string;
  /** 归一化目标船长（米）。 */
  targetLength: number;
  /** 实测船头反向：反转启发式的判断结果。 */
  flip?: boolean;
}

export const SHIP_MODELS: Record<string, ShipModelDef> = {
  dutch_ship_medium: {
    path: '/models/dutch_ship_medium/dutch_ship_medium_2k.gltf',
    targetLength: 9.0,
  },
  dutch_ship_large_01: {
    path: '/models/game-ships/dutch_ship_large_01/dutch_ship_large_01_1k.gltf',
    targetLength: 13.0,
    flip: true,
  },
  dutch_ship_large_02: {
    path: '/models/game-ships/dutch_ship_large_02/dutch_ship_large_02_1k.gltf',
    targetLength: 12.0,
    flip: true,
  },
  ship_pinnace: {
    path: '/models/game-ships/ship_pinnace/ship_pinnace_1k.gltf',
    targetLength: 7.5,
    flip: true,
  },
  quaternius_ship_large: {
    path: '/models/game-ships/quaternius_pirate/Ship_Large.gltf',
    targetLength: 11,
  },
  quaternius_ship_small: {
    path: '/models/game-ships/quaternius_pirate/Ship_Small.gltf',
    targetLength: 6.5,
  },
};

/** 模板缓存：model id -> Promise<校正模板|null>。 */
const cache = new Map<string, Promise<THREE.Group | null>>();

/** 自顶向下更新矩阵后测量包围盒（旋转/平移在校正层上，必须从顶层刷新）。 */
function measure(container: THREE.Object3D): THREE.Box3 {
  container.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(container);
}

/**
 * 猜测船头方向：统计长度方向两端 12% 区域内顶点的平均高度，
 * 船头一侧有上翘的艏斜桅/艏楼，平均高度通常高于船尾。
 */
function guessBowAtPositiveZ(root: THREE.Object3D, box: THREE.Box3): boolean {
  const len = box.max.z - box.min.z;
  const slab = len * 0.12;
  const v = new THREE.Vector3();
  let frontSum = 0,
    frontN = 0,
    backSum = 0,
    backN = 0;

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.attributes.position;
    if (!pos) return;
    const step = Math.max(1, Math.floor(pos.count / 4000)); // 采样即可，不必全量
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (v.z > box.max.z - slab) {
        frontSum += v.y;
        frontN++;
      } else if (v.z < box.min.z + slab) {
        backSum += v.y;
        backN++;
      }
    }
  });
  if (frontN === 0 || backN === 0) return true;
  return frontSum / frontN >= backSum / backN;
}

/** 把原始模型包进校正容器：长轴对齐 Z、船头朝 +Z、缩放到目标船长、龙骨对齐吃水。 */
function normalizeModel(
  gltfScene: THREE.Group,
  targetLength: number,
  flip: boolean | null = null,
): THREE.Group {
  const container = new THREE.Group(); // 对外：原点即水线中心，船头 +Z
  const inner = new THREE.Group(); // 校正层：旋转 + 缩放
  const root = gltfScene;
  inner.add(root);
  container.add(inner);

  // 1. 长轴对齐 Z 轴
  let box = measure(container);
  let size = box.getSize(new THREE.Vector3());
  if (size.x > size.z) {
    inner.rotation.y = Math.PI / 2;
    box = measure(container);
    size = box.getSize(new THREE.Vector3());
  }

  // 2. 船头方向校正：flip=true 表示启发式判断错了，取其反
  const heuristicFlip = !guessBowAtPositiveZ(root, box);
  const needFlip = flip ? !heuristicFlip : heuristicFlip;
  if (needFlip) {
    inner.rotation.y += Math.PI;
    box = measure(container);
  }

  // 3. 缩放到目标船长
  const len = box.max.z - box.min.z;
  const s = targetLength / len;
  inner.scale.setScalar(s);

  // 4. 平移：水平居中、龙骨贴到吃水深度（随船长比例加深）
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  root.position.set(-cx, -box.min.y, -cz);
  inner.position.y = -0.145 * targetLength;

  // 5. 帆材质修复：alpha 贴图改 alphaTest 裁剪，避免透明排序异常
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const mat = m as THREE.MeshStandardMaterial;
      if (/sail/i.test(mat.name) || /sail/i.test(mesh.name)) {
        mat.transparent = false;
        mat.alphaTest = 0.5;
        mat.side = THREE.DoubleSide;
      } else if (mat.transparent) {
        mat.transparent = false;
        mat.alphaTest = 0.5;
      }
    }
  });

  container.userData.rawLength = len;
  container.userData.scale = s;
  container.userData.flipped = needFlip;
  return container;
}

/**
 * 按需加载指定船模（每个 id 只加载一次；失败 resolve(null)，调用方回退程序化船）。
 */
export function loadShipModel(assets: AssetLoader, id: string): Promise<THREE.Group | null> {
  const def = SHIP_MODELS[id];
  if (!def) return Promise.resolve(null);
  let pending = cache.get(id);
  if (!pending) {
    pending = loadRaw(assets, def.path)
      .then((scene) => (scene ? normalizeModel(scene, def.targetLength, def.flip ?? null) : null))
      .then((template) => {
        if (template) logTemplate(id, template);
        return template;
      });
    cache.set(id, pending);
  }
  return pending;
}

/** 选船门（App/AssetLoader 还不存在）用的直连加载：独立 GLTFLoader + 独立缓存。 */
export function loadShipModelDirect(id: string): Promise<THREE.Group | null> {
  const def = SHIP_MODELS[id];
  if (!def) return Promise.resolve(null);
  let pending = directCache.get(id);
  if (!pending) {
    pending = new GLTFLoader()
      .loadAsync(assetUrl(def.path))
      .then((gltf) => {
        const template = normalizeModel(gltf.scene, def.targetLength, def.flip ?? null);
        logTemplate(id, template);
        return template;
      })
      .catch((error: unknown) => {
        console.warn(`[ship-model] ${id} 加载失败：`, error);
        return null;
      });
    directCache.set(id, pending);
  }
  return pending;
}

const directCache = new Map<string, Promise<THREE.Group | null>>();

function loadRaw(assets: AssetLoader, path: string): Promise<THREE.Group | null> {
  return assets.load(path).catch((error: unknown) => {
    console.warn(`[ship-model] ${path} 加载失败：`, error);
    return null;
  });
}

function logTemplate(id: string, template: THREE.Group): void {
  console.info(
    `[ship-model] ${id} 原始船长 ${(template.userData.rawLength as number).toFixed(2)}，` +
      `缩放系数 ${(template.userData.scale as number).toFixed(4)}，` +
      `船头判定 ${template.userData.flipped ? '-Z（已翻转 180°）' : '+Z（未翻转）'}`,
  );
}

export interface ShipModelInstance {
  group: THREE.Group;
  setSailAmount: ((amount: number) => void) | null;
}

/**
 * 从模板克隆一艘船（SkeletonUtils.clone，兼容带骨骼的 pinnace）。
 * tint { hull, sail }（十六进制）：染色需要独立材质（clone 出来的材质仍共享贴图）。
 */
export function instantiateShip(
  template: THREE.Group,
  tint: { hull?: number; sail?: number } | null,
): ShipModelInstance {
  const inst = skeletonClone(template) as THREE.Group; // 共享 geometry / texture，省显存

  if (tint) {
    inst.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = mats.map((m) => {
        const c = m.clone() as THREE.MeshStandardMaterial;
        if (/sail/i.test(c.name) || /sail/i.test(mesh.name)) {
          if (tint.sail !== undefined) c.color.set(tint.sail);
        } else if (tint.hull !== undefined) {
          c.color.set(tint.hull);
        }
        return c;
      });
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
    });
  }

  // 帆节点可分离就支持鼓/收帆（轻微纵向缩放），分不开则 no-op
  const sails: THREE.Mesh[] = [];
  inst.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && /sail/i.test(mesh.name)) sails.push(mesh);
  });
  const setSailAmount = sails.length
    ? (a: number) => {
        const v = Math.max(0, a); // 倒车按收帆
        // 与程序化船同一规则：大幅纵向收放，0% 完全隐藏
        for (const s of sails) {
          s.scale.y = 0.05 + 0.95 * v;
          s.visible = v > 0.02;
        }
      }
    : null;

  inst.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });

  return { group: inst, setSailAmount };
}
