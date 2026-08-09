// 船模注册表（均为 Poly Haven CC0）+ 按需加载 / 校正 / 克隆 / 染色
// 每个模型独立 Promise 缓存，只加载被选中的；失败时 resolve(null)，调用方回退程序化船
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

// stats：玩家船属性（敌船仍用基准值）；bars：选船界面的属性条（0~1 相对值）
export const SHIP_MODELS = {
  dutch_ship_medium: {
    name: '中型帆船',
    desc: '均衡的战船，攻守兼备',
    path: 'models/dutch_ship_medium/dutch_ship_medium_2k.gltf',
    thumb: 'models/dutch_ship_medium/thumb.png',
    targetLength: 9.0,
    stats: { hp: 100, maxSpeed: 15, turnRate: 1.0, cannons: 3 },
    bars: { hp: 0.6, speed: 0.6, cannons: 0.6 },
  },
  dutch_ship_large_01: {
    name: '大型战列舰',
    desc: '血厚炮多，但迟缓笨重',
    path: 'models/dutch_ship_large_01/dutch_ship_large_01_1k.gltf',
    thumb: 'models/dutch_ship_large_01/thumb.png',
    targetLength: 13.0,
    flip: true, // 实测船头反向：反转启发式的判断结果
    stats: { hp: 150, maxSpeed: 12.5, turnRate: 0.8, cannons: 4 },
    bars: { hp: 1.0, speed: 0.45, cannons: 1.0 },
  },
  dutch_ship_large_02: {
    name: '武装商船',
    desc: '装甲厚实的多面手',
    path: 'models/dutch_ship_large_02/dutch_ship_large_02_1k.gltf',
    thumb: 'models/dutch_ship_large_02/thumb.png',
    targetLength: 12.0,
    flip: true, // 实测船头反向
    stats: { hp: 135, maxSpeed: 13.5, turnRate: 0.85, cannons: 4 },
    bars: { hp: 0.85, speed: 0.55, cannons: 0.9 },
  },
  ship_pinnace: {
    name: '轻型快船',
    desc: '快而脆，走位决定生死',
    path: 'models/ship_pinnace/ship_pinnace_1k.gltf',
    thumb: 'models/ship_pinnace/thumb.png',
    targetLength: 7.5,
    flip: true, // 实测船头反向
    stats: { hp: 70, maxSpeed: 19.5, turnRate: 1.3, cannons: 2 },
    bars: { hp: 0.35, speed: 1.0, cannons: 0.35 },
  },
  // Quaternius Pirate Kit（CC0，自嵌入无外部依赖）；stats 仅作回退，实际数值来自 ships.json
  quaternius_ship_large: {
    name: '大型海盗船',
    desc: 'Quaternius Pirate Kit 精致模型',
    path: 'models/quaternius_pirate/Ship_Large.gltf',
    thumb: null, // 无预制缩略图，加载后离屏实拍
    targetLength: 11,
    stats: { hp: 144, maxSpeed: 17, turnRate: 0.86, cannons: 5 },
    bars: { hp: 0.85, speed: 0.8, cannons: 0.8 },
  },
  quaternius_ship_small: {
    name: '小型海盗船',
    desc: 'Quaternius Pirate Kit 精致模型',
    path: 'models/quaternius_pirate/Ship_Small.gltf',
    thumb: null,
    targetLength: 6.5,
    stats: { hp: 90, maxSpeed: 17, turnRate: 1.36, cannons: 3 },
    bars: { hp: 0.5, speed: 0.8, cannons: 0.5 },
  },
};

export const DEFAULT_SHIP_ID = 'dutch_ship_medium';

// 基准船长（中型帆船），其余船按 targetLength / BASE_LENGTH 得到 lengthScale
export const BASE_LENGTH = 9.0;

const cache = new Map(); // id -> Promise<template|null>

// 自顶向下更新矩阵后测量包围盒（旋转/平移在校正层上，必须从顶层刷新）
function measure(container) {
  container.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(container);
}

// 猜测船头方向：统计长度方向两端 12% 区域内顶点的平均高度，
// 船头一侧有上翘的艏斜桅/艏楼，平均高度通常高于船尾
function guessBowAtPositiveZ(root, box) {
  const len = box.max.z - box.min.z;
  const slab = len * 0.12;
  const v = new THREE.Vector3();
  let frontSum = 0, frontN = 0, backSum = 0, backN = 0;

  root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    if (!pos) return;
    const step = Math.max(1, Math.floor(pos.count / 4000)); // 采样即可，不必全量
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.z > box.max.z - slab) { frontSum += v.y; frontN++; }
      else if (v.z < box.min.z + slab) { backSum += v.y; backN++; }
    }
  });
  if (frontN === 0 || backN === 0) return true;
  return frontSum / frontN >= backSum / backN;
}

// 把原始模型包进校正容器：长轴对齐 Z、船头朝 +Z、缩放到目标船长、龙骨对齐吃水
function normalizeModel(gltfScene, targetLength, flip = null) {
  const container = new THREE.Group(); // 对外：原点即水线中心，船头 +Z
  const inner = new THREE.Group();     // 校正层：旋转 + 缩放
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

  // 2. 船头方向校正：flip=true 表示启发式判断错了，取其反（需要时绕 Y 转 180°）
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
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (/sail/i.test(m.name) || /sail/i.test(o.name)) {
        m.transparent = false;
        m.alphaTest = 0.5;
        m.side = THREE.DoubleSide;
      } else if (m.transparent) {
        m.transparent = false;
        m.alphaTest = 0.5;
      }
    }
  });

  container.userData.rawLength = len;
  container.userData.scale = s;
  container.userData.flipped = needFlip;
  return container;
}

/**
 * 按需加载指定船模（每个 id 只加载一次）
 * @returns {Promise<THREE.Group|null>} 校正后的模板容器；失败为 null
 */
export function loadShipModel(id) {
  const def = SHIP_MODELS[id];
  if (!def) return Promise.resolve(null);
  if (!cache.has(id)) {
    cache.set(id, new Promise((resolve) => {
      new GLTFLoader().load(
        def.path,
        (gltf) => {
          const template = normalizeModel(gltf.scene, def.targetLength, def.flip ?? null);
          console.info(
            `[ship-model] ${id} 原始船长 ${template.userData.rawLength.toFixed(2)}，` +
            `缩放系数 ${template.userData.scale.toFixed(4)}，` +
            `船头判定 ${template.userData.flipped ? '-Z（已翻转 180°）' : '+Z（未翻转）'}`
          );
          resolve(template);
        },
        undefined,
        (err) => {
          console.warn(`[ship-model] ${id} 加载失败，回退程序化船：`, err);
          resolve(null);
        }
      );
    }));
  }
  return cache.get(id);
}

/**
 * 从模板克隆一艘船（统一走 SkeletonUtils.clone，兼容带骨骼的 pinnace）
 * @param {THREE.Group} template loadShipModel 得到的模板
 * @param {object|null} tint 染色 { hull, sail }（十六进制），null 保持原色
 * @returns {{ group: THREE.Group, setSailAmount: Function|null }}
 */
export function instantiateShip(template, tint) {
  const inst = skeletonClone(template); // 共享 geometry / texture，省显存

  // 染色需要独立材质（clone 出来的材质仍共享贴图）
  if (tint) {
    inst.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const cloned = mats.map((m) => {
        const c = m.clone();
        if (/sail/i.test(c.name) || /sail/i.test(o.name)) {
          if (tint.sail !== undefined) c.color.set(tint.sail);
        } else if (tint.hull !== undefined) {
          c.color.set(tint.hull);
        }
        return c;
      });
      o.material = Array.isArray(o.material) ? cloned : cloned[0];
    });
  }

  // 帆节点可分离就支持鼓/收帆（轻微纵向缩放），分不开则 no-op
  const sails = [];
  inst.traverse((o) => {
    if (o.isMesh && /sail/i.test(o.name)) sails.push(o);
  });
  const setSailAmount = sails.length
    ? (a) => { for (const s of sails) s.scale.y = 0.85 + 0.15 * a; }
    : null;

  return { group: inst, setSailAmount };
}
