// 真实帆船模型（Poly Haven CC0 dutch_ship_medium）的加载、校正、克隆与染色
// 加载全局只发生一次（Promise 缓存）；失败时 resolve(null)，调用方回退程序化船
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL_URL = 'models/dutch_ship_medium/dutch_ship_medium_2k.gltf';

// 校正目标：与程序化船保持一致的水线尺度（船长 ~9、龙骨吃水 ~-1.3、船头朝 +Z）
const TARGET_LENGTH = 9.0;
const HULL_BOTTOM = -1.3;

let modelPromise = null;

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

// 把原始模型包进校正容器：长轴对齐 Z、船头朝 +Z、缩放、吃水线对齐
function normalizeModel(gltfScene) {
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

  // 2. 船头方向校正（需要时绕 Y 转 180°）
  if (!guessBowAtPositiveZ(root, box)) {
    inner.rotation.y += Math.PI;
    box = measure(container);
  }

  // 3. 缩放到目标船长
  const len = box.max.z - box.min.z;
  const s = TARGET_LENGTH / len;
  inner.scale.setScalar(s);

  // 4. 平移：水平居中、龙骨贴到 HULL_BOTTOM
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  root.position.set(-cx, -box.min.y, -cz);
  inner.position.y = HULL_BOTTOM;

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
  return container;
}

/**
 * 加载模型（只加载一次）
 * @returns {Promise<THREE.Group|null>} 校正后的模板容器；失败为 null
 */
export function loadShipModel() {
  if (!modelPromise) {
    modelPromise = new Promise((resolve) => {
      new GLTFLoader().load(
        MODEL_URL,
        (gltf) => {
          const template = normalizeModel(gltf.scene);
          console.info(
            `[ship-model] 原始船长 ${template.userData.rawLength.toFixed(2)}，缩放系数 ${template.userData.scale.toFixed(4)}`
          );
          resolve(template);
        },
        undefined,
        (err) => {
          console.warn('[ship-model] 模型加载失败，回退程序化船：', err);
          resolve(null);
        }
      );
    });
  }
  return modelPromise;
}

/**
 * 从模板克隆一艘船
 * @param {THREE.Group} template loadShipModel 得到的模板
 * @param {object|null} tint 染色 { hull, sail }（十六进制），null 保持原色
 * @returns {{ group: THREE.Group, setSailAmount: Function|null }}
 */
export function instantiateShip(template, tint) {
  const inst = template.clone(true); // 默认共享 geometry / texture，省显存

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
