/**
 * 参数化程序化船生成器 + 大航海时代2 全 25 船配置表 + 数值映射。
 * 移植自旧 js/shipyard.js（船首像与缩略图渲染留到 B3）。
 *
 * 输出 { group, setSailAmount }：group 的前进方向为本地 +Z，挂在 GameShip
 * 容器下时由调用方旋转 π/2 对齐基座的 +X 船头约定（见 GameShip 头注释）。
 */

import * as THREE from 'three/webgpu';
import type { PartKind, PartSpec } from './GameShip';

// ================= 类型 =================

export type SailType = 'square' | 'lateen' | 'gaff' | 'lug' | 'none';

export interface SailSpec {
  type: SailType;
  w: number;
  h: number;
  color?: number;
}

export interface MastSpec {
  /** 船长比例位置：船头 +0.5 ~ 船尾 -0.5。 */
  z: number;
  h: number;
  sail?: SailSpec;
}

export interface ShipSpec {
  length: number;
  beam: number;
  depth: number;
  hull: number;
  boxy?: boolean;
  bowUp?: number;
  sternLift?: number;
  stripe?: number;
  sternCastle?: number;
  bowCastle?: number;
  oars?: number;
  masts?: MastSpec[];
}

export interface ShipDef {
  id: number;
  en: string;
  cn: string;
  /** 有真实模型的船（B3 加载 models/ 下的精致模型；B2 用基座船模缩放代替）。 */
  model?: string;
  spec: ShipSpec;
}

/** ships.json 里的大航海时代2 原始数值（只用得到这四项）。 */
export interface RawShipData {
  durability: number;
  power: number;
  tacking: number;
  maximumGuns: number;
  basePrice?: number;
}

export interface ShipStats {
  hp: number;
  maxSpeed: number;
  turnRate: number;
  cannons: number;
  /** 原作价格（金币），仅用于选船界面排序与展示；ships.json 缺失时为 0 */
  price?: number;
}

export interface ShipVisual {
  group: THREE.Group;
  setSailAmount(amount: number): void;
  /** 桅杆节点（与 spec.masts 同序）：桅杆部件毁损时倾倒第一根做视觉反馈。 */
  masts: THREE.Object3D[];
}

// ================= 数值映射（大航海时代2 原始数值 -> 游戏属性） =================

export function computeStats(raw: RawShipData): ShipStats {
  return {
    hp: Math.round(raw.durability * 1.8), // 36 ~ 162
    maxSpeed: raw.power * 0.2, // 12 ~ 20
    turnRate: raw.tacking / 70, // 0.71 ~ 1.43
    cannons: Math.min(6, Math.max(2, Math.round(raw.maximumGuns / 15))), // 2 ~ 6
    price: raw.basePrice ?? 0,
  };
}
export const FALLBACK_STATS: ShipStats = { hp: 100, maxSpeed: 15, turnRate: 1.0, cannons: 3 };

/** 旧版基准船长（米），lengthScale 都相对它取。 */
export const BASE_LENGTH = 9;

// ================= 共享材质（按颜色缓存，控制 drawcall 状态切换与内存） =================

const matCache = new Map<number, THREE.MeshStandardMaterial>();
function hullMat(color: number): THREE.MeshStandardMaterial {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9 });
    matCache.set(color, m);
  }
  return m;
}
const sailMatCache = new Map<number, THREE.MeshStandardMaterial>();
function sailMat(color: number): THREE.MeshStandardMaterial {
  let m = sailMatCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.9 });
    sailMatCache.set(color, m);
  }
  return m;
}
const DECK_COLOR = 0xc9a86a;
const DARK_COLOR = 0x2b2b2b;

// ================= 帆 =================

interface Sail {
  geo: THREE.PlaneGeometry;
  base: Float32Array;
  w: number;
  h: number;
  bulge: number;
  mesh: THREE.Mesh;
}

// shape: square 横帆 / lateen 大三角帆 / gaff 梯形纵帆 / lug 中式硬帆
function makeSailGeometry(w: number, h: number, shape: SailType): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(w, h, 6, 6);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const v = (y + h / 2) / h; // 0 底 ~ 1 顶
    if (shape === 'lateen') pos.setX(i, x * (1 - v)); // 三角：顶部收成尖
    else if (shape === 'gaff') pos.setX(i, x * (0.8 + 0.2 * v)); // 梯形：上宽下窄
  }
  geo.translate(0, -h / 2, 0); // 顶边对齐桁
  return geo;
}

function buildSail(spec: SailSpec & { color?: number }): THREE.Group {
  const { type, w, h, color = 0xf3ead5 } = spec;
  const geo = makeSailGeometry(w, h, type);
  const mesh = new THREE.Mesh(geo, sailMat(color));
  const sail: Sail = {
    geo,
    base: (geo.attributes.position.array as Float32Array).slice(),
    w,
    h,
    bulge: w * 0.16,
    mesh,
  };

  const g = new THREE.Group();
  g.add(mesh);

  if (type === 'lateen') {
    // 斜桁沿帆前缘
    const yard = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, Math.hypot(w, h) * 1.05, 5),
      hullMat(DARK_COLOR),
    );
    yard.rotation.z = Math.atan2(h, w) - Math.PI / 2 + 0.1;
    yard.position.set(-w / 2 + 0.1, -h / 2, 0);
    g.add(yard);
    g.rotation.z = 0.35; // 整体前倾，形成三角帆的斜势
  } else {
    // 桁（横帆水平、纵帆略斜、硬帆水平）
    const tilt = type === 'gaff' ? 0.28 : 0;
    const yard = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, w * 1.08, 5),
      hullMat(DARK_COLOR),
    );
    yard.rotation.z = Math.PI / 2 + tilt;
    yard.position.y = type === 'gaff' ? h * 0.06 : 0;
    g.add(yard);
    if (type === 'lug') {
      // 中式硬帆的横向竹篾
      for (let i = 1; i <= 4; i++) {
        const batten = new THREE.Mesh(
          new THREE.BoxGeometry(w * 0.96, 0.05, 0.05),
          hullMat(DARK_COLOR),
        );
        batten.position.set(0, -(h / 5) * i, 0.03);
        g.add(batten);
      }
    }
  }
  g.userData.sail = sail;
  return g;
}

function applySail(sail: Sail, amount: number): void {
  const pos = sail.geo.attributes.position as THREE.BufferAttribute;
  const base = sail.base;
  const b = amount * sail.bulge;
  for (let i = 0; i < pos.count; i++) {
    const bx = base[i * 3];
    const by = base[i * 3 + 1];
    const u = bx / sail.w + 0.5;
    const v = 1 + by / sail.h; // 顶 1 ~ 底 0
    pos.setZ(i, b * Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.15 + 0.85 * v)));
  }
  pos.needsUpdate = true;
  sail.geo.computeVertexNormals();
}

// ================= 船体 =================

function buildHull(spec: ShipSpec): THREE.Group {
  const { length: L, beam: B, depth: D } = spec;
  const group = new THREE.Group();

  if (spec.boxy) {
    // 箱型船体（铁甲船/安宅船/关船/驳船）
    const box = new THREE.Mesh(new THREE.BoxGeometry(B, D * 1.6, L), hullMat(spec.hull));
    box.position.y = -D * 0.1;
    group.add(box);
  } else {
    // 流线船体：侧面轮廓沿宽度挤出
    const bowTop = D * (0.85 + (spec.bowUp || 0));
    const shape = new THREE.Shape();
    shape.moveTo(0.5 * L, bowTop);
    shape.lineTo(0.42 * L, -0.35 * D);
    shape.quadraticCurveTo(0, -0.6 * D, -0.42 * L, -0.32 * D);
    shape.lineTo(-0.5 * L, D * (0.85 + (spec.sternLift || 0.15)));
    shape.lineTo(0.5 * L, bowTop);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: B,
      bevelEnabled: true,
      bevelThickness: B * 0.08,
      bevelSize: B * 0.08,
      bevelSegments: 1,
    });
    geo.translate(0, 0, -B / 2);
    geo.rotateY(-Math.PI / 2); // 船头朝 +z
    group.add(new THREE.Mesh(geo, hullMat(spec.hull)));
  }

  // 甲板
  const deck = new THREE.Mesh(new THREE.BoxGeometry(B * 0.9, 0.08, L * 0.86), hullMat(DECK_COLOR));
  deck.position.y = spec.boxy ? D * 0.72 : D * 0.78;
  group.add(deck);

  // 舷侧条纹（炮门带等）
  if (spec.stripe) {
    for (const side of [-1, 1]) {
      const s = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, D * 0.2, L * 0.9),
        hullMat(spec.stripe),
      );
      s.position.set(side * (B / 2 + 0.02), D * 0.45, 0);
      group.add(s);
    }
  }

  // 艏艉楼
  if (spec.sternCastle) {
    const c = new THREE.Mesh(
      new THREE.BoxGeometry(B * 0.88, spec.sternCastle, L * 0.22),
      hullMat(spec.hull),
    );
    c.position.set(0, D * 0.8 + spec.sternCastle / 2, -L * 0.36);
    group.add(c);
  }
  if (spec.bowCastle) {
    const c = new THREE.Mesh(
      new THREE.BoxGeometry(B * 0.8, spec.bowCastle, L * 0.16),
      hullMat(spec.hull),
    );
    c.position.set(0, D * 0.8 + spec.bowCastle / 2, L * 0.38);
    group.add(c);
  }

  // 桨（桨帆船：两舷各 N 根）
  if (spec.oars) {
    const oarGeo = new THREE.BoxGeometry(B * 1.6, 0.07, 0.16);
    for (const side of [-1, 1]) {
      for (let i = 0; i < spec.oars; i++) {
        const oar = new THREE.Mesh(oarGeo, hullMat(DECK_COLOR));
        const z = (spec.oars === 1 ? 0 : (i / (spec.oars - 1) - 0.5)) * L * 0.6;
        oar.position.set(side * B * 0.55, D * 0.45, z);
        oar.rotation.z = -side * 0.32;
        group.add(oar);
      }
    }
  }
  return group;
}

// ================= 生成器入口 =================

/** opts.sailColor / opts.hullColor：定制染色（不传 = 用 spec 原色）。 */
export function buildShip(
  spec: ShipSpec,
  opts: { sailColor?: number | null; hullColor?: number | null } = {},
): ShipVisual {
  const { sailColor = null, hullColor = null } = opts;
  const effSpec = hullColor ? { ...spec, hull: hullColor } : spec;
  const group = new THREE.Group();
  group.add(buildHull(effSpec));

  const sails: Sail[] = [];
  const masts: THREE.Object3D[] = [];
  const deckY = spec.boxy ? spec.depth * 0.72 : spec.depth * 0.78;
  for (const m of spec.masts || []) {
    const mastZ = m.z * spec.length;
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.length * 0.008, spec.length * 0.012, m.h, 6),
      hullMat(0x6a4a28),
    );
    mast.position.set(0, deckY + m.h / 2, mastZ);
    group.add(mast);
    masts.push(mast);

    if (m.sail && m.sail.type !== 'none') {
      const sailSpec = sailColor ? { ...m.sail, color: sailColor } : m.sail;
      const sailG = buildSail(sailSpec);
      sailG.position.set(0, deckY + m.h * 0.95, mastZ + 0.05);
      group.add(sailG);
      sails.push(sailG.userData.sail as Sail);
    }
  }

  // 程序化的船体也投影：海战的剪影是辨识度的另一半
  group.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) node.castShadow = true;
  });

  function setSailAmount(amount: number): void {
    for (const s of sails) applySail(s, amount);
    // 收帆时帆面轻微缩短
    for (const s of sails) s.mesh.scale.y = 0.75 + 0.25 * amount;
  }
  setSailAmount(1);

  return { group, setSailAmount, masts };
}

// ================= 25 船配置表 =================
// 桅杆 z 为船长比例（船头 +0.5 ~ 船尾 -0.5）；帆色默认米白

const SQ = (w: number, h: number, color?: number): SailSpec => ({ type: 'square', w, h, color });
const LAT = (w: number, h: number, color?: number): SailSpec => ({ type: 'lateen', w, h, color });
const GAF = (w: number, h: number, color?: number): SailSpec => ({ type: 'gaff', w, h, color });
const LUG = (w: number, h: number, color: number = 0xb59a6a): SailSpec => ({ type: 'lug', w, h, color }); // 中式硬帆默认棕褐

export const SHIP_DEFS: ShipDef[] = [
  { id: 1, en: 'Balsa', cn: '巴尔萨筏船', spec: { length: 6, beam: 1.8, depth: 0.8, hull: 0xa8793f, masts: [{ z: 0.05, h: 5, sail: LAT(2.8, 3.4) }] } },
  { id: 2, en: 'Hansa Cog', cn: '汉萨柯克船', spec: { length: 7, beam: 2.6, depth: 1.5, hull: 0x7a4f2a, sternCastle: 0.8, masts: [{ z: 0, h: 6.5, sail: SQ(4.2, 4.2) }] } },
  { id: 3, en: 'Dhow', cn: '阿拉伯三角帆船', spec: { length: 7, beam: 2.0, depth: 1.0, hull: 0x8a5a30, bowUp: 0.5, masts: [{ z: 0, h: 6.5, sail: LAT(3.6, 5.2) }] } },
  { id: 4, en: 'Buss', cn: '巴斯船', spec: { length: 8, beam: 2.9, depth: 1.5, hull: 0x6f4a2c, masts: [{ z: 0.18, h: 6.5, sail: SQ(4.4, 4.0) }, { z: -0.24, h: 5.5, sail: SQ(3.6, 3.2) }] } },
  { id: 5, en: 'Tallette', cn: '塔莱特船', spec: { length: 6, beam: 1.8, depth: 0.9, hull: 0x9a6a38, masts: [{ z: 0.05, h: 5.5, sail: LAT(3.0, 4.0) }] } },
  { id: 6, en: 'Caravela Latina', cn: '拉丁卡拉维尔', spec: { length: 8, beam: 2.1, depth: 1.1, hull: 0x7a4f2a, masts: [{ z: 0.18, h: 7, sail: LAT(3.4, 4.8) }, { z: -0.24, h: 6, sail: LAT(2.8, 4.0) }] } },
  { id: 7, en: 'Caravela Redonda', cn: '圆帆卡拉维尔', spec: { length: 8, beam: 2.2, depth: 1.1, hull: 0x7a4f2a, masts: [{ z: 0.18, h: 7, sail: SQ(4.0, 4.2) }, { z: -0.24, h: 6, sail: LAT(2.8, 4.0) }] } },
  { id: 8, en: 'Brigantine', cn: '双桅横帆船', spec: { length: 9, beam: 2.3, depth: 1.2, hull: 0x74502e, masts: [{ z: 0.18, h: 7.5, sail: SQ(4.4, 4.6) }, { z: -0.22, h: 6.5, sail: SQ(3.6, 3.8) }] } },
  { id: 9, en: 'Nao', cn: '纳奥船', spec: { length: 10, beam: 3.1, depth: 1.5, hull: 0x7a4f2a, sternCastle: 0.7, masts: [{ z: 0.28, h: 7.5, sail: SQ(4.6, 4.4) }, { z: 0, h: 8.5, sail: SQ(5.0, 5.0) }, { z: -0.28, h: 6, sail: LAT(2.6, 3.6) }] } },
  { id: 10, en: 'Carrack', cn: '卡拉克帆船', model: 'dutch_ship_medium', spec: { length: 11, beam: 3.0, depth: 1.5, hull: 0x7a4f2a, sternCastle: 1.2, bowCastle: 0.9, masts: [{ z: 0.34, h: 7.5, sail: SQ(4.4, 4.2) }, { z: 0.1, h: 9, sail: SQ(5.0, 5.2) }, { z: -0.14, h: 8, sail: SQ(4.4, 4.6) }, { z: -0.36, h: 6, sail: LAT(2.6, 3.6) }] } },
  { id: 11, en: 'Galleon', cn: '盖伦帆船', model: 'dutch_ship_large_01', spec: { length: 12.5, beam: 2.6, depth: 1.4, hull: 0x6a4527, sternCastle: 0.9, stripe: 0x2b2b2b, masts: [{ z: 0.3, h: 8, sail: SQ(4.6, 4.6) }, { z: 0, h: 9.5, sail: SQ(5.2, 5.4) }, { z: -0.3, h: 7, sail: SQ(3.8, 3.8) }] } },
  { id: 12, en: 'Xebec', cn: '谢贝克船', spec: { length: 11, beam: 2.0, depth: 1.1, hull: 0x8a5f36, bowUp: 0.3, masts: [{ z: 0.28, h: 7.5, sail: LAT(3.2, 4.6) }, { z: 0, h: 8, sail: LAT(3.6, 5.2) }, { z: -0.28, h: 6.5, sail: LAT(2.8, 4.0) }] } },
  { id: 13, en: 'Pinnace', cn: '纵帆快船', model: 'ship_pinnace', spec: { length: 7.5, beam: 2.0, depth: 1.0, hull: 0x845632, masts: [{ z: 0.16, h: 6.5, sail: GAF(3.2, 3.8) }, { z: -0.2, h: 5.5, sail: GAF(2.6, 3.0) }] } },
  { id: 14, en: 'Sloop', cn: '单桅帆船', model: 'quaternius_ship_small', spec: { length: 7, beam: 2.0, depth: 1.0, hull: 0x845632, masts: [{ z: 0.1, h: 7, sail: GAF(3.6, 4.4) }] } },
  { id: 15, en: 'Frigate', cn: '巡航护卫舰', model: 'quaternius_ship_large', spec: { length: 12, beam: 2.4, depth: 1.3, hull: 0x5a4632, stripe: 0x22201e, masts: [{ z: 0.3, h: 8, sail: SQ(4.6, 4.6) }, { z: 0.02, h: 9, sail: SQ(5.0, 5.2) }, { z: -0.28, h: 7, sail: SQ(3.6, 3.6) }] } },
  { id: 16, en: 'Barge', cn: '大型驳船', spec: { length: 12, beam: 4.2, depth: 1.1, hull: 0x6a5136, boxy: true, masts: [{ z: 0.28, h: 7, sail: SQ(5.0, 4.0) }, { z: 0, h: 7.5, sail: SQ(5.2, 4.2) }, { z: -0.28, h: 6.5, sail: SQ(4.4, 3.6) }] } },
  { id: 17, en: 'Full-rigged Ship', cn: '全帆装船', spec: { length: 14, beam: 3.0, depth: 1.5, hull: 0x5f4028, sternCastle: 0.8, stripe: 0x2b2b2b, masts: [{ z: 0.36, h: 8, sail: SQ(4.6, 4.4) }, { z: 0.12, h: 9.5, sail: SQ(5.2, 5.4) }, { z: -0.12, h: 9, sail: SQ(4.8, 5.0) }, { z: -0.36, h: 7, sail: SQ(3.6, 3.4) }] } },
  { id: 18, en: 'Junk', cn: '中式戎克船', spec: { length: 10, beam: 3.2, depth: 1.4, hull: 0x7a3f28, sternCastle: 1.0, masts: [{ z: 0.16, h: 8, sail: LUG(4.6, 5.2) }, { z: -0.22, h: 7, sail: LUG(3.8, 4.2) }] } },
  { id: 19, en: 'Light Galley', cn: '轻型桨帆船', spec: { length: 9, beam: 1.8, depth: 1.0, hull: 0x8a5f36, oars: 6, masts: [{ z: 0.05, h: 7, sail: LAT(3.4, 4.8) }] } },
  { id: 20, en: 'Flemish Galleon', cn: '佛兰德盖伦', model: 'dutch_ship_large_02', spec: { length: 12, beam: 3.4, depth: 1.5, hull: 0x74502e, sternCastle: 0.7, masts: [{ z: 0.3, h: 7.5, sail: SQ(5.0, 4.4) }, { z: 0, h: 8.5, sail: SQ(5.4, 5.0) }, { z: -0.3, h: 6.5, sail: SQ(4.2, 3.6) }] } },
  { id: 21, en: 'Venetian Galeass', cn: '威尼斯加莱赛船', spec: { length: 13, beam: 2.8, depth: 1.4, hull: 0x6f4a2c, oars: 8, masts: [{ z: 0.28, h: 8, sail: LAT(3.6, 5.0) }, { z: 0, h: 8.5, sail: LAT(4.0, 5.6) }, { z: -0.28, h: 7, sail: LAT(3.0, 4.2) }] } },
  { id: 22, en: 'La Reale', cn: '皇家桨帆船', spec: { length: 11, beam: 2.2, depth: 1.1, hull: 0x8e2f28, oars: 10, masts: [{ z: 0.18, h: 7.5, sail: LAT(3.4, 4.8) }, { z: -0.2, h: 6.5, sail: LAT(2.8, 4.0) }] } },
  { id: 23, en: 'Tekkousen', cn: '铁甲船', spec: { length: 12, beam: 3.4, depth: 1.5, hull: 0x2e3136, boxy: true, sternCastle: 0.6, masts: [{ z: 0, h: 8, sail: LUG(4.8, 5.0, 0x8a8078) }] } },
  { id: 24, en: 'Atakabune', cn: '安宅船', spec: { length: 9, beam: 2.8, depth: 1.3, hull: 0x6b4a2f, boxy: true, sternCastle: 0.8, masts: [{ z: 0, h: 7, sail: LUG(4.2, 4.6) }] } },
  { id: 25, en: 'Kansen', cn: '关船', spec: { length: 7, beam: 2.0, depth: 1.0, hull: 0x7a5636, boxy: true, oars: 4, masts: [{ z: 0.05, h: 6, sail: LUG(3.4, 3.8) }] } },
];

export const DEFAULT_SHIP_DEF_ID = 10; // 卡拉克帆船（= 基座自带的 dutch_ship_medium）

// ================= 部件血量配置 =================
// 数值为船体 HP 的比例；hullMul 是船体 HP 倍率（乘在 ships.json 映射的 hp 上）。
// sails 与 oars 互斥：日式/桨帆船型用 oars（毁损极速 ×0.5），其余用 sails
// （毁损帆量上限压 40%）；rudder 毁损舵效 ×0.35；mast 给大中型多桅船
// （毁损时等效伤害连锁到帆装 + 程序化船视觉倾倒一根桅杆）。

export interface PartsRatio {
  hullMul?: number;
  sails?: number;
  oars?: number;
  rudder?: number;
  mast?: number;
}

export const SHIP_PARTS: Record<number, PartsRatio> = {
  1: { sails: 0.35, rudder: 0.2 }, // 巴尔萨筏船：小快脆
  2: { sails: 0.5, rudder: 0.3 }, // 汉萨柯克船
  3: { sails: 0.4, rudder: 0.22 }, // 阿拉伯三角帆船：轻快
  4: { sails: 0.5, rudder: 0.3 }, // 巴斯船
  5: { sails: 0.35, rudder: 0.2 }, // 塔莱特船：小快脆
  6: { sails: 0.45, rudder: 0.25 }, // 拉丁卡拉维尔
  7: { sails: 0.45, rudder: 0.25 }, // 圆帆卡拉维尔
  8: { sails: 0.5, rudder: 0.28 }, // 双桅横帆船
  9: { sails: 0.55, rudder: 0.3, mast: 0.45 }, // 纳奥船
  10: { sails: 0.55, rudder: 0.28, mast: 0.5 }, // 卡拉克帆船
  11: { sails: 0.6, rudder: 0.22, mast: 0.5 }, // 盖伦帆船：大型战舰部件厚、舵脆
  12: { sails: 0.45, rudder: 0.25 }, // 谢贝克船
  13: { sails: 0.38, rudder: 0.2 }, // 纵帆快船：小快脆
  14: { sails: 0.35, rudder: 0.2 }, // 单桅帆船：小快脆
  15: { sails: 0.6, rudder: 0.22, mast: 0.5 }, // 巡航护卫舰：同盖伦思路
  16: { sails: 0.55, rudder: 0.32, mast: 0.45 }, // 大型驳船：笨重但舵厚实
  17: { sails: 0.65, rudder: 0.22, mast: 0.55 }, // 全帆装船：帆装最重
  18: { sails: 0.7, rudder: 0.3 }, // 中式戎克：硬帆耐打 ×1.4
  19: { oars: 0.55, rudder: 0.25 }, // 轻型桨帆船
  20: { sails: 0.6, rudder: 0.24, mast: 0.5 }, // 佛兰德盖伦
  21: { oars: 0.65, rudder: 0.28, mast: 0.45 }, // 威尼斯加莱赛：桨厚
  22: { oars: 0.7, rudder: 0.26 }, // 皇家桨帆船：桨最厚
  23: { hullMul: 1.6, oars: 0.65, rudder: 0.3 }, // 铁甲船：船体 ×1.6、强桨
  24: { hullMul: 1.25, oars: 0.6, rudder: 0.3 }, // 安宅船：日式楼船，船体略厚
  25: { oars: 0.55, rudder: 0.25 }, // 关船：小桨船
};

/** 生成一艘船的部件表（HP 绝对值）。无配置的船型回落到通用帆船三部件。 */
export function buildPartsFor(defId: number, hullHp: number): PartSpec[] {
  const r = SHIP_PARTS[defId] ?? { sails: 0.5, rudder: 0.3 };
  const parts: PartSpec[] = [];
  const push = (kind: PartKind, ratio: number | undefined): void => {
    if (ratio !== undefined) parts.push({ kind, maxHp: Math.max(5, Math.round(hullHp * ratio)) });
  };
  push('sails', r.sails);
  push('oars', r.oars);
  push('rudder', r.rudder);
  push('mast', r.mast);
  return parts;
}

/** 船体 HP 倍率（铁甲船 1.6 等）；无配置 = 1。 */
export function hullMulFor(defId: number): number {
  return SHIP_PARTS[defId]?.hullMul ?? 1;
}

export function getShipDef(id: number): ShipDef {
  return SHIP_DEFS.find((d) => d.id === id) ?? SHIP_DEFS.find((d) => d.id === DEFAULT_SHIP_DEF_ID)!;
}

// ================= 选船持久化与数值加载 =================

export const SHIP_STORAGE_KEY = 'web-ocean:ship-id:v1';

/** 当前所选船 id：URL 参数 ?ship=N 优先，其次 localStorage，最后默认。 */
export function resolveShipId(): number {
  const param = new URL(window.location.href).searchParams.get('ship');
  if (param !== null && SHIP_DEFS.some((d) => d.id === Number(param))) return Number(param);
  try {
    const stored = Number(window.localStorage.getItem(SHIP_STORAGE_KEY));
    if (SHIP_DEFS.some((d) => d.id === stored)) return stored;
  } catch {
    // localStorage 不可用就当每次新选
  }
  return DEFAULT_SHIP_DEF_ID;
}

export function storeShipId(id: number): void {
  try {
    window.localStorage.setItem(SHIP_STORAGE_KEY, String(id));
  } catch {
    // 同上
  }
}

/**
 * 加载 ships.json 并映射成全 25 船的游戏属性；失败时全部用基准属性。
 * url 走 AssetLoader 同款 assetUrl 包装（Pages 子路径），由调用方给。
 */
export async function loadShipStats(url: string): Promise<Record<number, ShipStats>> {
  const out: Record<number, ShipStats> = {};
  let data: Record<string, RawShipData> | null = null;
  try {
    const res = await fetch(url);
    if (res.ok) data = (await res.json()) as Record<string, RawShipData>;
  } catch {
    data = null;
  }
  for (const def of SHIP_DEFS) {
    const raw = data?.[String(def.id)];
    out[def.id] = raw ? computeStats(raw) : { ...FALLBACK_STATS };
  }
  return out;
}

// ================= 船首像（低模 <200 三角面，共享材质缓存；朝 +Z 船头方向） =================
// 移植自旧 js/shipyard.js；精致雕像模型（狮首/马首/青铜系）不在本阶段范围。

export const FIGUREHEADS = [
  { id: 'none', cn: '无' },
  { id: 'dragon', cn: '海龙' },
  { id: 'skull', cn: '骷髅' },
  { id: 'dolphin', cn: '海豚' },
  { id: 'goddess', cn: '女神' },
  { id: 'mermaid', cn: '美人鱼' },
  { id: 'lion', cn: '狮首' },
  { id: 'horse', cn: '马首' },
  { id: 'shark', cn: '鲨鱼' },
  { id: 'whale', cn: '鲸鱼' },
  { id: 'ray', cn: '鳐鱼' },
  { id: 'eagle', cn: '雄鹰' },
  { id: 'octopus', cn: '章鱼' },
] as const;

export type FigureheadId = (typeof FIGUREHEADS)[number]['id'];

export function buildFigurehead(kind: FigureheadId): THREE.Group {
  const g = new THREE.Group();

  if (kind === 'dragon') {
    const body = hullMat(0x2e8f7a);
    const fin = hullMat(0xd4b04a);
    // 三段渐弯的颈（逐节前倾）
    const segs = [
      { y: 0.15, z: 0.0, r: 0.5, len: 0.45, r1: 0.12, r2: 0.1 },
      { y: 0.42, z: 0.18, r: 0.9, len: 0.42, r1: 0.1, r2: 0.08 },
      { y: 0.62, z: 0.42, r: 1.2, len: 0.38, r1: 0.08, r2: 0.06 },
    ];
    for (const s of segs) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(s.r2, s.r1, s.len, 6), body);
      seg.position.set(0, s.y, s.z);
      seg.rotation.x = s.r;
      g.add(seg);
    }
    // 头锥 + 两侧鳍
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.42, 6), body);
    head.rotation.x = Math.PI / 2;
    head.position.set(0, 0.68, 0.66);
    g.add(head);
    for (const side of [-1, 1]) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.3, 4), fin);
      f.position.set(side * 0.14, 0.55, 0.35);
      f.rotation.z = -side * 1.2;
      g.add(f);
    }
  } else if (kind === 'skull') {
    const bone = hullMat(0xe8e2d4);
    const dark = hullMat(0x1a1a1a);
    const cranium = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), bone);
    cranium.position.y = 0.35;
    g.add(cranium);
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.22), bone);
    jaw.position.set(0, 0.14, 0.06);
    g.add(jaw);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), dark);
      eye.position.set(side * 0.09, 0.38, 0.17);
      g.add(eye);
    }
  } else if (kind === 'dolphin') {
    const skin = hullMat(0x5a8fb5);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), skin);
    body.scale.set(0.55, 0.5, 1.6); // 纺锤体
    body.position.y = 0.25;
    g.add(body);
    const rostrum = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.06, 0.35, 6), skin);
    rostrum.rotation.x = Math.PI / 2;
    rostrum.position.set(0, 0.22, 0.58);
    g.add(rostrum);
    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.25, 4), skin);
    dorsal.position.set(0, 0.52, -0.05);
    dorsal.rotation.x = -0.3;
    g.add(dorsal);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 4), skin);
    tail.rotation.x = -Math.PI / 2;
    tail.position.set(0, 0.28, -0.55);
    g.add(tail);
  } else if (kind === 'goddess') {
    // 女神：圆锥裙 + 球头 + 双臂
    const marble = hullMat(0xd8d4cc);
    const dress = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.7, 7), marble);
    dress.position.y = 0.35;
    g.add(dress);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 7, 6), marble);
    head.position.y = 0.82;
    g.add(head);
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.4, 5), marble);
      arm.position.set(side * 0.2, 0.62, 0.05);
      arm.rotation.z = -side * 1.1; // 双臂上举
      g.add(arm);
    }
  } else if (kind === 'mermaid') {
    // 美人鱼：鱼尾 + 上身 + 扬臂（与女神同为航神信仰，身形更俯冲）
    const skin = hullMat(0xd8b8a0);
    const tailMat = hullMat(0x3a7f8a);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.34, 6), skin);
    body.position.set(0, 0.52, 0.05);
    body.rotation.x = 0.35; // 前倾
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 7, 6), skin);
    head.position.set(0, 0.74, 0.16);
    g.add(head);
    // 尾鳍向后下方拖出
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.03, 0.5, 6), tailMat);
    tail.position.set(0, 0.22, -0.12);
    tail.rotation.x = -0.55;
    g.add(tail);
    for (const side of [-1, 1]) {
      const fluke = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 4), tailMat);
      fluke.position.set(side * 0.09, 0.06, -0.34);
      fluke.rotation.x = -Math.PI / 2 - 0.4;
      fluke.rotation.z = -side * 0.7;
      g.add(fluke);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 5), skin);
      arm.position.set(side * 0.15, 0.6, 0.14);
      arm.rotation.z = -side * 1.0;
      g.add(arm);
    }
  } else if (kind === 'lion') {
    // 狮首：头球 + 鬃毛锥圈 + 吻部
    const tawny = hullMat(0xb5854a);
    const maneMat = hullMat(0x7a4f22);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), tawny);
    head.position.set(0, 0.35, 0.05);
    g.add(head);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 4), maneMat);
      cone.position.set(Math.cos(a) * 0.22, 0.35 + Math.sin(a) * 0.22, 0.0);
      cone.rotation.z = -a - Math.PI / 2; // 朝外
      g.add(cone);
    }
    const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.14), tawny);
    muzzle.position.set(0, 0.28, 0.24);
    g.add(muzzle);
  } else if (kind === 'horse') {
    // 马首：斜颈 + 长头 + 双耳
    const coat = hullMat(0x7a5a38);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.55, 6), coat);
    neck.position.set(0, 0.22, 0);
    neck.rotation.x = 0.5;
    g.add(neck);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.17, 0.45), coat);
    head.position.set(0, 0.52, 0.28);
    head.rotation.x = 0.25;
    g.add(head);
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.14, 4), coat);
      ear.position.set(side * 0.06, 0.66, 0.12);
      g.add(ear);
    }
    const mane = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.12), hullMat(0x3a2a18));
    mane.position.set(0, 0.35, -0.13);
    mane.rotation.x = 0.5;
    g.add(mane);
  } else if (kind === 'shark') {
    // 鲨鱼：锥身 + 三角背鳍 + 尾鳍 + 张口
    const bronze = hullMat(0x6f7a6a);
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.75, 7), bronze);
    body.rotation.x = Math.PI / 2;
    body.position.set(0, 0.3, 0.05);
    g.add(body);
    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.25, 4), bronze);
    dorsal.position.set(0, 0.5, -0.05);
    g.add(dorsal);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 4), bronze);
    tail.rotation.x = -Math.PI / 2;
    tail.position.set(0, 0.32, -0.42);
    g.add(tail);
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.18), hullMat(0x2a2020));
    jaw.position.set(0, 0.2, 0.38);
    jaw.rotation.x = 0.4; // 张口
    g.add(jaw);
  } else if (kind === 'whale') {
    // 鲸鱼：纺锤身 + 双尾鳍 + 小背鳍
    const bronze = hullMat(0x5f6f72);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), bronze);
    body.scale.set(0.5, 0.42, 1.4);
    body.position.y = 0.3;
    g.add(body);
    for (const side of [-1, 1]) {
      const fluke = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 4), bronze);
      fluke.position.set(side * 0.14, 0.32, -0.5);
      fluke.rotation.z = -side * 1.4;
      fluke.rotation.x = -0.6;
      g.add(fluke);
    }
    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 4), bronze);
    dorsal.position.set(0, 0.5, -0.1);
    g.add(dorsal);
  } else if (kind === 'ray') {
    // 鳐鱼：扁菱形盘 + 细长尾
    const bronze = hullMat(0x66707a);
    const disc = new THREE.Mesh(new THREE.SphereGeometry(0.34, 6, 4), bronze);
    disc.scale.set(1.35, 0.15, 1.0);
    disc.position.y = 0.25;
    g.add(disc);
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.04, 0.55, 4), bronze);
    tail.rotation.x = Math.PI / 2 + 0.15;
    tail.position.set(0, 0.24, -0.55);
    g.add(tail);
  } else if (kind === 'eagle') {
    // 雄鹰：展翅双翼 + 钩喙（船首像里少见的横向展开，轮廓靠翼展读）
    const feather = hullMat(0x4a3826);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 7, 6), feather);
    body.scale.set(0.8, 1, 1.3);
    body.position.y = 0.3;
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 7, 6), hullMat(0xe8e2d4));
    head.position.set(0, 0.48, 0.16);
    g.add(head);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.14, 4), hullMat(0xd4b04a));
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 0.47, 0.28);
    g.add(beak);
    for (const side of [-1, 1]) {
      // 每侧两片翼面，略上掠
      const inner = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 0.2), feather);
      inner.position.set(side * 0.24, 0.42, 0);
      inner.rotation.z = side * 0.35;
      g.add(inner);
      const outer = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.16), feather);
      outer.position.set(side * 0.5, 0.52, -0.02);
      outer.rotation.z = side * 0.55;
      g.add(outer);
    }
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.22), feather);
    tail.position.set(0, 0.26, -0.28);
    tail.rotation.x = 0.25;
    g.add(tail);
  } else if (kind === 'octopus') {
    // 章鱼：球头 + 八条放射触手（锥段前卷）
    const skin = hullMat(0x8a4a5a);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), skin);
    head.position.y = 0.5;
    head.scale.y = 1.25;
    g.add(head);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), hullMat(0xe8e2d4));
      eye.position.set(side * 0.12, 0.52, 0.17);
      g.add(eye);
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.05, 0.5, 5), skin);
      arm.position.set(Math.cos(a) * 0.16, 0.2, Math.sin(a) * 0.16);
      arm.rotation.z = Math.cos(a) * 0.9;
      arm.rotation.x = -Math.sin(a) * 0.9;
      g.add(arm);
    }
  }
  return g;
}

// ================= 外观定制状态（localStorage） =================

export interface ShipCustomization {
  /** 使用精致模型（有真实模型的 6 艘生效）。 */
  fancy: boolean;
  /** 帆色/船体色（'#rrggbb'；null = 原色）。 */
  sailColor: string | null;
  hullColor: string | null;
  figurehead: FigureheadId;
}

const KEY_FANCY = 'web-ocean:fancy-model:v1';
const KEY_SAIL_COLOR = 'web-ocean:sail-color:v1';
const KEY_HULL_COLOR = 'web-ocean:hull-color:v1';
const KEY_FIGUREHEAD = 'web-ocean:figurehead:v1';

export const DEFAULT_CUSTOMIZATION: ShipCustomization = {
  fancy: false,
  sailColor: null,
  hullColor: null,
  figurehead: 'none',
};

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storeCustomizationKey(key: 'fancy' | 'sailColor' | 'hullColor' | 'figurehead', value: string): void {
  const storageKey = { fancy: KEY_FANCY, sailColor: KEY_SAIL_COLOR, hullColor: KEY_HULL_COLOR, figurehead: KEY_FIGUREHEAD }[key];
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    // localStorage 不可用时定制只剩当次会话
  }
}

export function resolveCustomization(): ShipCustomization {
  const figurehead = readStorage(KEY_FIGUREHEAD);
  return {
    fancy: readStorage(KEY_FANCY) === '1',
    sailColor: readStorage(KEY_SAIL_COLOR),
    hullColor: readStorage(KEY_HULL_COLOR),
    figurehead: FIGUREHEADS.some((f) => f.id === figurehead)
      ? (figurehead as FigureheadId)
      : 'none',
  };
}
