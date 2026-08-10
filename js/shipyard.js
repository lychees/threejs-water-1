// 参数化程序化船生成器 + 大航海时代2 全 25 船配置表
// 输出接口 { group, setSailAmount } 与 Ship.setVisual 兼容；真实模型的 4 艘走 modelship.js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ================= 共享材质（按颜色缓存，控制 drawcall 状态切换与内存） =================
const matCache = new Map();
function hullMat(color) {
  if (!matCache.has(color)) {
    matCache.set(color, new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9 }));
  }
  return matCache.get(color);
}
const sailMatCache = new Map();
function sailMat(color) {
  if (!sailMatCache.has(color)) {
    sailMatCache.set(color, new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.9 }));
  }
  return sailMatCache.get(color);
}
const DECK_COLOR = 0xc9a86a;
const DARK_COLOR = 0x2b2b2b;

// ================= 帆 =================
// shape: square 横帆 / lateen 大三角帆 / gaff 梯形纵帆 / lug 中式硬帆
function makeSailGeometry(w, h, shape) {
  const geo = new THREE.PlaneGeometry(w, h, 6, 6);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const v = (y + h / 2) / h; // 0 底 ~ 1 顶
    if (shape === 'lateen') pos.setX(i, x * (1 - v));            // 三角：顶部收成尖
    else if (shape === 'gaff') pos.setX(i, x * (0.8 + 0.2 * v)); // 梯形：上宽下窄
  }
  geo.translate(0, -h / 2, 0); // 顶边对齐桁
  return geo;
}

function buildSail(spec) {
  const { type, w, h, color = 0xf3ead5 } = spec;
  const geo = makeSailGeometry(w, h, type);
  const mesh = new THREE.Mesh(geo, sailMat(color));
  const sail = { geo, base: geo.attributes.position.array.slice(), w, h, bulge: w * 0.16, mesh };

  const g = new THREE.Group();
  g.add(mesh);

  if (type === 'lateen') {
    // 斜桁沿帆前缘
    const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, Math.hypot(w, h) * 1.05, 5), hullMat(DARK_COLOR));
    yard.rotation.z = Math.atan2(h, w) - Math.PI / 2 + 0.1;
    yard.position.set(-w / 2 + 0.1, -h / 2, 0);
    g.add(yard);
    g.rotation.z = 0.35; // 整体前倾，形成三角帆的斜势
  } else {
    // 桁（横帆水平、纵帆略斜、硬帆水平）
    const tilt = type === 'gaff' ? 0.28 : 0;
    const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, w * 1.08, 5), hullMat(DARK_COLOR));
    yard.rotation.z = Math.PI / 2 + tilt;
    yard.position.y = type === 'gaff' ? h * 0.06 : 0;
    g.add(yard);
    if (type === 'lug') {
      // 中式硬帆的横向竹篾
      for (let i = 1; i <= 4; i++) {
        const batten = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 0.05, 0.05), hullMat(DARK_COLOR));
        batten.position.set(0, -(h / 5) * i, 0.03);
        g.add(batten);
      }
    }
  }
  g.userData.sail = sail;
  return g;
}

function applySail(sail, amount) {
  const pos = sail.geo.attributes.position;
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
function buildHull(spec) {
  const { length: L, beam: B, depth: D } = spec;
  const group = new THREE.Group();

  if (spec.boxy) {
    // 箱型船体（铁甲船/安宅船/关船/驳船）
    const box = new THREE.Mesh(new THREE.BoxGeometry(B, D * 1.6, L), hullMat(spec.hull));
    box.position.y = -D * 0.1;
    group.add(box);
  } else {
    // 流线船体：侧面轮廓沿宽度挤出（与原版程序化船同法）
    const bowTop = D * (0.85 + (spec.bowUp || 0));
    const shape = new THREE.Shape();
    shape.moveTo(0.5 * L, bowTop);
    shape.lineTo(0.42 * L, -0.35 * D);
    shape.quadraticCurveTo(0, -0.6 * D, -0.42 * L, -0.32 * D);
    shape.lineTo(-0.5 * L, D * (0.85 + (spec.sternLift || 0.15)));
    shape.lineTo(0.5 * L, bowTop);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: B, bevelEnabled: true, bevelThickness: B * 0.08, bevelSize: B * 0.08, bevelSegments: 1,
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
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.05, D * 0.2, L * 0.9), hullMat(spec.stripe));
      s.position.set(side * (B / 2 + 0.02), D * 0.45, 0);
      group.add(s);
    }
  }

  // 艏艉楼
  if (spec.sternCastle) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(B * 0.88, spec.sternCastle, L * 0.22), hullMat(spec.hull));
    c.position.set(0, D * 0.8 + spec.sternCastle / 2, -L * 0.36);
    group.add(c);
  }
  if (spec.bowCastle) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(B * 0.8, spec.bowCastle, L * 0.16), hullMat(spec.hull));
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
/**
 * @param {object} spec 见文件底部 25 船配置
 * @param {object} opts { sailColor, hullColor } 玩家定制染色（null = 用 spec 原色）
 * @returns {{ group: THREE.Group, setSailAmount: Function }}
 */
export function buildShip(spec, opts = {}) {
  const { sailColor = null, hullColor = null } = opts;
  const effSpec = hullColor ? { ...spec, hull: hullColor } : spec;
  const group = new THREE.Group();
  group.add(buildHull(effSpec));

  const sails = [];
  const deckY = spec.boxy ? spec.depth * 0.72 : spec.depth * 0.78;
  for (const m of spec.masts || []) {
    const mastZ = m.z * spec.length;
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.length * 0.008, spec.length * 0.012, m.h, 6),
      hullMat(0x6a4a28)
    );
    mast.position.set(0, deckY + m.h / 2, mastZ);
    group.add(mast);

    if (m.sail && m.sail.type !== 'none') {
      const sailSpec = sailColor ? { ...m.sail, color: sailColor } : m.sail;
      const sailG = buildSail(sailSpec);
      sailG.position.set(0, deckY + m.h * 0.95, mastZ + 0.05);
      group.add(sailG);
      sails.push(sailG.userData.sail);
    }
  }

  function setSailAmount(amount) {
    for (const s of sails) applySail(s, amount);
    // 收帆时帆面轻微缩短
    for (const s of sails) s.mesh.scale.y = 0.75 + 0.25 * amount;
  }
  setSailAmount(1);

  return { group, setSailAmount };
}

// ================= 船首像注册表 =================
// 全部有程序化低模（buildFigurehead）；带 model 字段的可走精致模型（勾选"使用精致模型"后按需加载）
export const FIGUREHEADS = [
  { id: 'none', cn: '无' },
  { id: 'dragon', cn: '海龙' },
  { id: 'skull', cn: '骷髅' },
  { id: 'dolphin', cn: '海豚' },
  { id: 'lion', cn: '狮首', model: 'lion_head' },
  { id: 'horse', cn: '马首', model: 'horse_head' },
  { id: 'shark', cn: '鲨鱼', model: 'bronze_shark_statue' },
  { id: 'whale', cn: '鲸鱼', model: 'bronze_whale_statue' },
  { id: 'ray', cn: '鳐鱼', model: 'bronze_ray_statue' },
  { id: 'goddess', cn: '女神', model: 'gothic_statue' },
];

const FH_TARGET_SIZE = 1.2; // 精致船首像归一化尺寸（挂载时再按船长比例缩放）
const fhCache = new Map();  // model id -> Promise<Group|null>

// 归一化：长轴对齐 +Z（船头方向）、最长边缩到 FH_TARGET_SIZE、底部对齐 y=0
function normalizeFigurehead(root) {
  const g = new THREE.Group();
  g.add(root);
  g.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(g);
  let size = box.getSize(new THREE.Vector3());
  if (size.x > size.z) { // 长轴转到 Z
    root.rotation.y = Math.PI / 2;
    g.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(g);
    size = box.getSize(new THREE.Vector3());
  }
  const s = FH_TARGET_SIZE / Math.max(size.x, size.y, size.z);
  g.scale.setScalar(s);
  root.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  return g;
}

// 按需加载精致船首像（Promise 缓存；失败 resolve(null)，调用方回退低模）
export function loadFigureheadModel(modelId) {
  if (!fhCache.has(modelId)) {
    fhCache.set(modelId, new Promise((resolve) => {
      new GLTFLoader().load(
        `models/${modelId}/${modelId}_1k.gltf`,
        (gltf) => resolve(normalizeFigurehead(gltf.scene)),
        undefined,
        (err) => { console.warn(`[figurehead] ${modelId} 加载失败，回退低模：`, err); resolve(null); }
      );
    }));
  }
  return fhCache.get(modelId);
}

// ================= 船首像（低模 <200 三角面，共享材质缓存） =================
// kind: 'dragon' 海龙 / 'skull' 骷髅 / 'dolphin' 海豚；朝 +Z（船头方向）
export function buildFigurehead(kind) {
  const g = new THREE.Group();

  if (kind === 'dragon') {
    const body = hullMat(0x2e8f7a);
    const fin = hullMat(0xd4b04a);
    // 三段渐弯的颈（逐节前倾）
    const segs = [
      { y: 0.15, z: 0.00, r: 0.5, len: 0.45, r1: 0.12, r2: 0.10 },
      { y: 0.42, z: 0.18, r: 0.9, len: 0.42, r1: 0.10, r2: 0.08 },
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
  }
  return g;
}

// ================= 缩略图：共享离屏 renderer，渲染一帧转 dataURL =================
// dispose=true 用于程序化船副本（渲染完释放几何体）；
// dispose=false 用于真实模型模板（几何体与游戏内克隆共享，绝不能销毁）
// WebGPU 迁移：用独立的 WebGPURenderer（强制 WebGL2 后端 + preserveDrawingBuffer，
// 保证 toDataURL 能读到帧），异步 init，返回 Promise
let thumbRenderer = null;
let thumbRendererReady = null;
function getThumbRenderer() {
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGPURenderer({ antialias: true, preserveDrawingBuffer: true, forceWebGL: true });
    thumbRenderer.setSize(220, 110);
    thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    thumbRenderer.toneMappingExposure = 1.1;
    thumbRendererReady = thumbRenderer.init();
  }
  return thumbRendererReady;
}

export async function renderShipThumbnail(group, { dispose = true } = {}) {
  try {
    await getThumbRenderer();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d2f45);
    scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x2a4a3a, 1.2));
    const dl = new THREE.DirectionalLight(0xfff0d0, 2.2);
    dl.position.set(3, 5, 4);
    scene.add(dl);
    scene.add(group);

    // 按包围盒取景（固定 3/4 侧视角度）
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z);
    const cam = new THREE.PerspectiveCamera(35, 2, 0.1, 1000);
    cam.position.set(center.x + r * 1.1, center.y + r * 0.5, center.z + r * 1.15);
    cam.lookAt(center);

    thumbRenderer.render(scene, cam);
    const url = thumbRenderer.domElement.toDataURL('image/png');

    scene.remove(group);
    if (dispose) {
      // 缩略图副本用完即弃：只释放几何体（材质是共享缓存的）
      group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    }
    return url;
  } catch (e) {
    console.warn('[shipyard] 缩略图渲染失败：', e);
    return null;
  }
}

// ================= 数值映射（大航海时代2 原始数值 -> 游戏属性） =================
export function computeStats(raw) {
  return {
    hp: Math.round(raw.durability * 1.8),                    // 36 ~ 162
    maxSpeed: raw.power * 0.2,                               // 12 ~ 20
    turnRate: raw.tacking / 70,                              // 0.71 ~ 1.43
    cannons: Math.min(6, Math.max(2, Math.round(raw.maximumGuns / 15))), // 2 ~ 6
  };
}
export const FALLBACK_STATS = { hp: 100, maxSpeed: 15, turnRate: 1.0, cannons: 3 };

// ================= 25 船配置表 =================
// 桅杆 z 为船长比例（船头 +0.5 ~ 船尾 -0.5）；帆色默认米白
const SQ = (w, h, color) => ({ type: 'square', w, h, color });
const LAT = (w, h, color) => ({ type: 'lateen', w, h, color });
const GAF = (w, h, color) => ({ type: 'gaff', w, h, color });
const LUG = (w, h, color = 0xb59a6a) => ({ type: 'lug', w, h, color }); // 中式硬帆默认棕褐

export const SHIP_DEFS = [
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

export const DEFAULT_SHIP_DEF_ID = 10; // 卡拉克帆船（= 原默认 dutch_ship_medium）
