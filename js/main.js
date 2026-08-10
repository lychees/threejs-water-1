// 入口：场景装配、输入、相机、HUD、游戏状态机、主循环
import * as THREE from 'three';
import { createWater, getWaveHeight } from './water.js';
import { createOcean } from './ocean.js';
import { createSky, SUN_DIR } from './sky.js';
import { Ship, DEBUFF_DEFS } from './ship.js';
import { Combat, BALL_GRAVITY } from './combat.js';
import { EnemyFleet } from './enemy.js';
import { loadShipModel, instantiateShip, SHIP_MODELS, BASE_LENGTH } from './modelship.js';
import { SHIP_DEFS, buildShip, buildFigurehead, FIGUREHEADS, loadFigureheadModel, computeStats, FALLBACK_STATS, renderShipThumbnail, DEFAULT_SHIP_DEF_ID } from './shipyard.js';
import { createWorld, ISLAND_DEFS } from './world.js';
import { WakeManager } from './wake.js';
import { Weather } from './weather.js';
import { DayTime } from './daytime.js';
import { Fn, pass, uv, uniform, vec2, vec3, vec4, sin, abs, exp, smoothstep } from 'three/tsl';
import { GameAudio } from './audio.js';

// ===== 渲染器（WebGPU 优先，WebGL2 回退；用户可在开始界面强制 WebGL2） =====
const backendPref = sessionStorage.getItem('waters-backend') || 'webgpu';
let forceWebGL = backendPref === 'webgl';
if (!forceWebGL) {
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      forceWebGL = !adapter;
    } catch {
      forceWebGL = true;
    }
  } else {
    forceWebGL = true;
  }
}
if (forceWebGL && !document.createElement('canvas').getContext('webgl2')) {
  document.body.innerHTML = '<div style="color:#fff;padding:40px;font-size:18px;">当前浏览器不支持 WebGPU / WebGL2，无法运行游戏。</div>';
  throw new Error('WebGPU/WebGL2 unavailable');
}
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.getElementById('app').appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);

// ===== 后处理（WebGPU PostProcessing）：场景 pass → 水下折射/水线 meniscus（TSL） =====
// PostProcessing 输出端自动做色调映射 + sRGB（outputColorTransform 默认开），与原管线等价
const warpU = {
  uTime: uniform(0),
  uWarp: uniform(0),       // 水下折射扰动强度 = underT × 天气 warp
  uMeniscus: uniform(0),   // 水线亮带强度（相机在波面 ±0.5m 内）
  uWaterlineY: uniform(0.5), // 水线的屏幕 y（0~1，由相机俯仰近似推算）
};
const postProcessing = new THREE.PostProcessing(renderer);
const scenePass = pass(scene, camera);
const sceneColor = scenePass.getTextureNode();
postProcessing.outputNode = Fn(() => {
  const uv0 = uv().toVar();
  // 水下折射扰动：两组正弦扭动（强度随天气分级）
  const dx = sin(uv0.y.mul(30.0).add(warpU.uTime.mul(2.2))).mul(0.006).mul(warpU.uWarp)
    .add(sin(uv0.y.mul(13.0).sub(warpU.uTime.mul(1.3))).mul(0.004).mul(warpU.uWarp));
  const dy = sin(uv0.x.mul(24.0).sub(warpU.uTime.mul(1.8))).mul(0.006).mul(warpU.uWarp);
  const col = sceneColor.sample(uv0.add(vec2(dx, dy))).rgb.toVar();
  // meniscus：水线附近的水平亮带 + 下方轻微压暗模拟透镜拉伸
  const d = abs(uv0.y.sub(warpU.uWaterlineY));
  const band = exp(d.mul(d).mul(900.0).negate());
  col.addAssign(vec3(0.9, 0.97, 1.0).mul(band).mul(warpU.uMeniscus).mul(0.5));
  const below = smoothstep(0.0, 0.06, warpU.uWaterlineY.sub(uv0.y)).mul(warpU.uMeniscus);
  col.mulAssign(below.mul(0.08).oneMinus());
  return vec4(col, 1.0);
})();
let menT = 0; // meniscus 强度（平滑）
const camDirVec = new THREE.Vector3();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ===== 世界 =====
const sky = createSky(scene);
// 岛屿碎浪带 uniform 数据（与 world.js 碰撞半径同源：size × 0.45）
const SURF_ISLANDS = ISLAND_DEFS.map((d) => ({ x: d.pos[0], z: d.pos[1], radius: d.size * 0.45 }));
// 双路径海面：WebGPU 原生 → JONSWAP+FFT（ocean.js）；WebGL2 回退 → Gerstner（water.js）
let water;
if (!forceWebGL) {
  try {
    water = createOcean(renderer, SUN_DIR, SURF_ISLANDS);
    console.info('[ocean] FFT 海面已启用');
  } catch (e) {
    console.warn('[ocean] FFT 海面初始化失败，回退 Gerstner：', e);
    water = null;
  }
}
if (!water) water = createWater(SUN_DIR, SURF_ISLANDS);
// FFT 路径自带 CPU 波高（32 分量正弦叠加），Gerstner 路径用 water.js 的
const waveFn = water.getWaveHeight || getWaveHeight;
scene.add(water.mesh);
const combat = new Combat(scene, waveFn);
const wakes = new WakeManager(scene, waveFn);
const weather = new Weather({
  scene, camera, renderer,
  waterUniforms: water.uniforms,
  skyUniforms: sky.uniforms,
  sun: sky.sun,
  hemi: sky.hemi,
});
const audio = new GameAudio();
combat.onSplash = () => audio.splash();
weather.onLightning = (delay) => audio.thunder(delay); // 闪电 → 延迟雷声
// 昼夜循环：产出光照/颜色基底，天气在其上乘法调光（loop 里先 daytime 后 weather）
const dayTime = new DayTime({
  scene, camera,
  skyUniforms: sky.uniforms,
  waterUniforms: water.uniforms,
  sun: sky.sun,
});

// ===== 画质档位（高/中/低，存 sessionStorage） =====
const QUALITY_KEY = 'waters-quality';
const QUALITY_LEVELS = {
  high: { label: '高', pixelRatio: Math.min(window.devicePixelRatio, 2), detailWaves: 3, particleScale: 1, rainDensity: 1, wakeFoam: true },
  mid:  { label: '中', pixelRatio: 1.25, detailWaves: 2, particleScale: 0.5, rainDensity: 1, wakeFoam: true },
  low:  { label: '低', pixelRatio: 1, detailWaves: 1, particleScale: 0.5, rainDensity: 0.5, wakeFoam: false },
};
let quality = QUALITY_LEVELS[sessionStorage.getItem(QUALITY_KEY)] ? sessionStorage.getItem(QUALITY_KEY) : 'high';

function applyQuality(q) {
  quality = q;
  const def = QUALITY_LEVELS[q];
  sessionStorage.setItem(QUALITY_KEY, q);
  renderer.setPixelRatio(def.pixelRatio);
  water.setDetailWaves(def.detailWaves);
  combat.particleScale = def.particleScale;
  weather.setRainDensity(def.rainDensity);
  wakes.foamEnabled = def.wakeFoam;
  const btn = $('quality-btn');
  if (btn) btn.textContent = `画质：${def.label}`;
}

// ===== 操控与氛围参数 =====
const ASTERN_MAX = 0.3;         // 倒车最大帆量幅度（负帆量，即极速的 30%）
const SAIL_RATE = 1 / 2.5;      // 帆量每秒变化（0 → 满帆约 2.5s）
const ASTERN_HOLD = 0.4;        // 帆量降到 0 后 S 继续按住进入倒车的延迟
const CHARGE_TIME = 1.2;        // 火炮蓄力满所需秒数
const BOW_RELOAD = 2.0;         // 艏炮独立冷却
const BOW_SPEED = 45;           // 艏炮初速（比舷炮略高，弹道平直）
const BROADSIDE_SPEED = 40;     // 舷炮初速基准（满蓄力 ×1.5 = 60）
const RUDDER_CURVE = 1.5;       // 舵效 ∝ (航速/极速)^RUDDER_CURVE（舵是翼面）
const RUDDER_MIN_EFF = 0.05;    // 静止时的残存舵效
const CAM_MAX_DIP = 6.0;        // 相机允许没入波面下的最大深度（不穿海底的底线）
const UNDER_FOG = { color: new THREE.Color(0x0a4a4e), near: 2, far: 70 };
let underT = 0;                 // 0 水上 ~ 1 水下（0.3s 插值）

// ===== 玩家 =====
const player = new Ship(scene, {
  hullColor: 0x7a4f2a,
  sailColor: 0xf3ead5,
  hp: 100,
  maxSpeed: 15,
  turnRate: 1.0,
});

// ===== 敌人 =====
const fleet = new EnemyFleet(scene, combat);

// ===== 世界场景资产（岛屿/要塞/浮标/漂浮补给）：并行异步加载，不阻塞游戏开始 =====
let world = null;
createWorld(scene, waveFn).then((w) => { world = w; });

// ===== 玩家选船：大航海时代2 全 25 种，fetch ships.json 数据驱动属性 =====
const STORAGE_KEY = 'waters-ship';
// 旧版存档键值（模型 id）-> 新船 id 的兼容映射
const LEGACY_IDS = { dutch_ship_medium: 10, dutch_ship_large_01: 11, dutch_ship_large_02: 20, ship_pinnace: 13 };
const SHIP_STATS = {}; // id -> { hp, maxSpeed, turnRate, cannons }

const storedShip = sessionStorage.getItem(STORAGE_KEY);
let selectedShipId = LEGACY_IDS[storedShip] ?? parseInt(storedShip, 10);
if (!SHIP_DEFS.some((d) => d.id === selectedShipId)) selectedShipId = DEFAULT_SHIP_DEF_ID;
let choiceToken = 0; // 防止快速切换时旧请求后到账覆盖新选择

async function loadShipStats() {
  let data = null;
  try {
    const res = await fetch('assets/ships.json');
    data = await res.json();
  } catch (e) {
    console.warn('[ships] assets/ships.json 加载失败，全部使用基准属性：', e);
  }
  for (const def of SHIP_DEFS) {
    const raw = data && data[String(def.id)];
    SHIP_STATS[def.id] = raw ? computeStats(raw) : { ...FALLBACK_STATS };
  }
}

// ===== 船只定制状态（sessionStorage 恢复） =====
const KEY_FANCY = 'waters-fancy';               // '1' = 使用精致模型
const KEY_SAIL_COLOR = 'waters-sail-color';     // 船帆染色（null = 原色）
const KEY_HULL_COLOR = 'waters-hull-color';     // 船体染色
const KEY_FIGUREHEAD = 'waters-figurehead';     // none / dragon / skull / dolphin
let fancyModel = sessionStorage.getItem(KEY_FANCY) === '1';
let sailColor = sessionStorage.getItem(KEY_SAIL_COLOR) || null;
let hullColor = sessionStorage.getItem(KEY_HULL_COLOR) || null;
let figurehead = sessionStorage.getItem(KEY_FIGUREHEAD) || 'none';

function applyShipChoice(id) {
  const def = SHIP_DEFS.find((d) => d.id === id);
  if (!def) return;
  const stats = SHIP_STATS[id] || FALLBACK_STATS;
  player.maxHp = stats.hp;
  player.hp = stats.hp;
  player.maxSpeed = stats.maxSpeed;
  player.turnRate = stats.turnRate;
  player.cannons = stats.cannons;
  const tok = ++choiceToken;
  const useModel = fancyModel && def.model; // 默认一律低模，勾选且有精致模型才加载

  // 挂船首像（船头 +Z 端水线上方，按船长比例）并应用外观
  const finish = (group, sailSetter, shipLength) => {
    if (figurehead !== 'none') {
      const def = FIGUREHEADS.find((f) => f.id === figurehead);
      const s = shipLength / BASE_LENGTH;
      const mount = (fh) => {
        fh.scale.multiplyScalar(s);
        fh.position.set(0, 1.05 * s, shipLength * 0.46);
        group.add(fh);
      };
      if (fancyModel && def && def.model) {
        // 精致船首像：与船模同一开关，按需加载，失败回退低模
        loadFigureheadModel(def.model).then((tpl) => {
          mount(tpl ? tpl.clone(true) : buildFigurehead(figurehead));
        });
      } else {
        mount(buildFigurehead(figurehead));
      }
    }
    player.setVisual(group, sailSetter);
    player.setSailAmount(Math.max(0, sailAmount));
  };

  if (useModel) {
    // 精致模型：异步加载；染色走材质 clone 乘色，不污染共享模板
    const mdef = SHIP_MODELS[def.model];
    player.lengthScale = mdef.targetLength / BASE_LENGTH;
    player.hitRadius = 3.4 * player.lengthScale;
    const tint = {};
    if (hullColor) tint.hull = hullColor;
    if (sailColor) tint.sail = sailColor;
    loadShipModel(def.model).then((template) => {
      if (tok !== choiceToken) return;
      if (!template) {
        // 失败回退本船的低模版本
        const v = buildShip(def.spec, { sailColor, hullColor });
        finish(v.group, v.setSailAmount, def.spec.length);
      } else {
        const v = instantiateShip(template, Object.keys(tint).length ? tint : null);
        finish(v.group, v.setSailAmount, mdef.targetLength);
      }
    });
  } else {
    // 参数化程序化船：同步生成（染色直接进材质缓存 key）
    player.lengthScale = def.spec.length / BASE_LENGTH;
    player.hitRadius = 3.4 * player.lengthScale;
    const v = buildShip(def.spec, { sailColor, hullColor });
    finish(v.group, v.setSailAmount, def.spec.length);
  }
}

// ===== 选船卡片 UI（开始遮罩内，可滚动网格） =====
function statBar(label, ratio) {
  return `<div class="stat-row"><span class="lbl">${label}</span>` +
    `<span class="sbar"><div style="width:${Math.round(Math.min(1, ratio) * 100)}%"></div></span></div>`;
}

// 缩略图统一走异步（WebGPURenderer 需 init）：先放占位，渲染完成后替换
function setCardThumb(card, urlPromise, alt) {
  Promise.resolve(urlPromise).then((url) => {
    if (!url) return;
    const ph = card.querySelector('.thumb-fallback');
    if (!ph) return;
    const img = document.createElement('img');
    img.src = url;
    img.alt = alt;
    ph.replaceWith(img);
  });
}

function buildShipCards() {
  const wrap = $('ship-select');
  wrap.innerHTML = ''; // 支持重建（切换精致模型勾选时）
  for (const def of SHIP_DEFS) {
    const stats = SHIP_STATS[def.id] || FALLBACK_STATS;
    const useModel = fancyModel && def.model;
    // 缩略图：勾选精致模型才用真实模型（预制 thumb 或加载后实拍）；否则程序化低模实拍
    const presetThumb = useModel ? SHIP_MODELS[def.model].thumb : null;

    const card = document.createElement('div');
    card.className = 'ship-card' + (def.id === selectedShipId ? ' selected' : '');
    card.dataset.ship = def.id;
    card.innerHTML =
      (presetThumb ? `<img src="${presetThumb}" alt="${def.cn}">` : `<div class="thumb-fallback">${def.cn}</div>`) +
      (useModel ? '<span class="badge">★精致模型</span>' : '') +
      `<h3>${def.cn}</h3>` +
      `<div class="en-name">${def.en}</div>` +
      statBar('血', stats.hp / 170) +
      statBar('速', stats.maxSpeed / 21) +
      statBar('舵', stats.turnRate / 1.5) +
      statBar('炮', stats.cannons / 6);
    card.addEventListener('click', () => {
      selectedShipId = def.id;
      sessionStorage.setItem(STORAGE_KEY, String(def.id));
      wrap.querySelectorAll('.ship-card').forEach((c) =>
        c.classList.toggle('selected', Number(c.dataset.ship) === def.id));
      applyShipChoice(def.id);
    });
    wrap.appendChild(card);

    if (!presetThumb) {
      if (useModel) {
        // 无预制缩略图的精致模型：勾选状态下按需加载，完成后实拍一张补上
        setCardThumb(card, loadShipModel(def.model).then((template) =>
          template ? renderShipThumbnail(template, { dispose: false }) : null), def.cn);
      } else {
        // 程序化低模：生成副本离屏实拍
        const t = buildShip(def.spec);
        setCardThumb(card, renderShipThumbnail(t.group), def.cn);
      }
    }
  }
}

// ===== 定制 UI（精致模型勾选 / 染色 / 船首像） =====
function initCustomizeUI() {
  const fancyChk = $('fancy-model');
  fancyChk.checked = fancyModel;
  fancyChk.addEventListener('change', () => {
    fancyModel = fancyChk.checked;
    sessionStorage.setItem(KEY_FANCY, fancyModel ? '1' : '0');
    buildShipCards(); // 缩略图随低模/精致切换重渲染
    applyShipChoice(selectedShipId);
  });

  const sailInput = $('sail-color');
  sailInput.value = sailColor || '#f3ead5';
  sailInput.addEventListener('input', () => {
    sailColor = sailInput.value;
    sessionStorage.setItem(KEY_SAIL_COLOR, sailColor);
    applyShipChoice(selectedShipId);
  });

  const hullInput = $('hull-color');
  hullInput.value = hullColor || '#7a4f2a';
  hullInput.addEventListener('input', () => {
    hullColor = hullInput.value;
    sessionStorage.setItem(KEY_HULL_COLOR, hullColor);
    applyShipChoice(selectedShipId);
  });

  // 渲染后端开关（更改后刷新生效；FFT 海面只在 WebGPU 原生后端启用）
  const beChk = $('backend-webgpu');
  beChk.checked = (sessionStorage.getItem('waters-backend') || 'webgpu') === 'webgpu';
  beChk.addEventListener('change', () => {
    sessionStorage.setItem('waters-backend', beChk.checked ? 'webgpu' : 'webgl');
    location.reload();
  });

  // 船首像按钮组：按注册表动态生成（含新增精致模型项）
  const fhGroup = $('fh-group');
  if (!FIGUREHEADS.some((f) => f.id === figurehead)) figurehead = 'none'; // 键值校验
  fhGroup.innerHTML = '';
  for (const f of FIGUREHEADS) {
    const b = document.createElement('button');
    b.className = 'fh-btn' + (f.id === figurehead ? ' selected' : '');
    b.dataset.fh = f.id;
    b.textContent = f.cn;
    b.addEventListener('click', () => {
      figurehead = f.id;
      sessionStorage.setItem(KEY_FIGUREHEAD, figurehead);
      fhGroup.querySelectorAll('.fh-btn').forEach((x) => x.classList.toggle('selected', x === b));
      applyShipChoice(selectedShipId);
    });
    fhGroup.appendChild(b);
  }
}

// ===== 游戏状态 =====
let state = 'menu'; // menu | playing | over
let kills = 0;
let loot = 0;               // 战利品（宝箱）计数
let sailAmount = 0;             // 帆量连续值：-ASTERN_MAX(倒车) ~ 1(满帆)
let asternHoldT = 0;            // S 按住且帆量为 0 的持续时间（超 ASTERN_HOLD 进入倒车）
const RELOAD_TIME = 3.2;
let cooldownL = 0;
let cooldownR = 0;
let cooldownBow = 0;            // 艏炮独立冷却
let chargeL = null;             // 蓄力进度秒数（null = 未按住），左/右/艏各一
let chargeR = null;
let chargeBow = null;
let gameOverT = 0;

// ===== HUD =====
const $ = (id) => document.getElementById(id);
const hud = $('hud');

// 装填条只表示冷却进度（蓄力进度由画面里的弹道预览线表达）
function setReloadBar(el, cooldown, cooldownMax) {
  el.style.width = `${(1 - cooldown / cooldownMax) * 100}%`;
}

function updateHUD() {
  $('hp-fill').style.width = `${(player.hp / player.maxHp) * 100}%`;
  $('kills').textContent = kills;
  $('loot').textContent = loot;
  $('wave').textContent = fleet.wave;
  $('weather-icon').textContent = weather.icon;
  $('weather-stat').title = `天气：${weather.name}（点击切换）`;
  // 昼夜时钟
  const hh = Math.floor(dayTime.hour);
  const mm = Math.floor((dayTime.hour - hh) * 60);
  $('clock-icon').textContent = dayTime.isNight ? '🌙' : '🌞';
  $('clock').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  $('sail-state').textContent = sailAmount < 0
    ? `帆位：倒车 ${Math.round(-sailAmount * 100)}%（W 复位）`
    : `帆位：${Math.round(sailAmount * 100)}%（按住 W/S 调整）`;
  setReloadBar($('reload-l'), cooldownL, RELOAD_TIME);
  setReloadBar($('reload-r'), cooldownR, RELOAD_TIME);
  setReloadBar($('reload-b'), cooldownBow, BOW_RELOAD);
  // 玩家 debuff 图标（带剩余秒数）
  $('debuff-fire').textContent = player.debuff.fire > 0 ? `🔥 ${Math.ceil(player.debuff.fire)}s` : '';
  $('debuff-leak').textContent = player.debuff.leak > 0 ? `💧 ${Math.ceil(player.debuff.leak)}s` : '';
  $('debuff-sail').textContent = player.debuff.sail > 0 ? `⛵ ${Math.ceil(player.debuff.sail)}s` : '';
}

// 初始化选船界面并应用上次选择（需在 $ / sailAmount 声明之后调用）
loadShipStats().then(() => {
  buildShipCards();
  initCustomizeUI();
  applyShipChoice(selectedShipId);
});

// ===== HUD 小按钮（画质 / 静音）与天气图标 =====
function syncMuteBtn(muted) {
  const btn = $('mute-btn');
  if (btn) btn.textContent = muted ? '🔇' : '🔊';
}

$('quality-btn').addEventListener('click', () => {
  const order = ['high', 'mid', 'low'];
  applyQuality(order[(order.indexOf(quality) + 1) % order.length]);
});
$('mute-btn').addEventListener('click', () => {
  audio.init(); // 按钮本身也是用户交互，可直接初始化
  syncMuteBtn(audio.toggleMute());
});
applyQuality(quality);
syncMuteBtn(audio.muted);

// 天气图标点击循环切换（晴→多云→黄昏→夜→雾→风暴，重置自动计时器）
$('weather-stat').addEventListener('click', () => {
  weather.toggle();
  floatText(`${weather.icon} ${weather.name}…`);
});
// 相机模式点击循环切换（快捷键 1/2/3 保留）
$('cam-stat').addEventListener('click', () => setCamMode((camMode % 3) + 1));
// 时钟点击快进 1 小时
$('clock-stat').addEventListener('click', () => dayTime.advance());

// ===== 小地图（2D canvas 海图，隔帧绘制 ~15fps） =====
const minimap = $('minimap');
const mmCtx = minimap.getContext('2d');
let mmLarge = false;
let mmFrame = 0;
minimap.addEventListener('click', () => {
  mmLarge = !mmLarge;
  minimap.classList.toggle('large', mmLarge);
});

function drawMinimap() {
  const W = minimap.width;          // 340 后备分辨率，CSS 缩放显示
  const cx = W / 2;
  const range = mmLarge ? 600 : 400; // 海图半径（米）
  const s = (cx - 8) / range;
  const px = player.position.x;
  const pz = player.position.z;
  const rim = cx - 10;

  mmCtx.clearRect(0, 0, W, W);
  mmCtx.save();
  mmCtx.beginPath();
  mmCtx.arc(cx, cx, cx - 2, 0, Math.PI * 2);
  mmCtx.clip();
  mmCtx.fillStyle = 'rgba(6, 30, 44, 0.72)';
  mmCtx.fillRect(0, 0, W, W);

  // 世界 -Z 为北（屏幕上）：世界位移 → 屏幕位移直接映射
  const toMapX = (wx) => cx + (wx - px) * s;
  const toMapY = (wz) => cx + (wz - pz) * s;
  const dot = (x, y, r, color) => {
    mmCtx.fillStyle = color;
    mmCtx.beginPath();
    mmCtx.arc(x, y, r, 0, Math.PI * 2);
    mmCtx.fill();
  };

  if (world) {
    // 岛屿：绿色块（按碰撞半径画圆）
    for (const isl of world.islands) {
      dot(toMapX(isl.x), toMapY(isl.z), Math.max(3, isl.radius * s), '#3f7a4f');
    }
    // 浮标：橙色小点
    for (const b of world.buoys) {
      dot(toMapX(b.mesh.position.x), toMapY(b.mesh.position.z), 3, '#e8862e');
    }
    // 漂浮补给：修复=木色，宝箱=金色
    for (const sp of world.supplies) {
      if (!sp.active) continue;
      dot(toMapX(sp.mesh.position.x), toMapY(sp.mesh.position.z), 3.5,
        sp.kind === 'loot' ? '#ffd76e' : '#b5854a');
    }
  }

  // 敌船：红点；超出范围的钳到边缘指示方向
  for (const e of fleet.enemies) {
    if (e.sinking) continue;
    let dx = (e.position.x - px) * s;
    let dy = (e.position.z - pz) * s;
    const d = Math.hypot(dx, dy);
    if (d > rim) { dx *= rim / d; dy *= rim / d; }
    dot(cx + dx, cx + dy, 4.5, '#e0483e');
  }

  // 玩家：中心白色三角，指示船头朝向
  mmCtx.save();
  mmCtx.translate(cx, cx);
  mmCtx.rotate(Math.PI - player.heading); // 船头 forward=(sinθ,cosθ) → 屏幕 (sinθ,cosθ)
  mmCtx.fillStyle = '#ffffff';
  mmCtx.beginPath();
  mmCtx.moveTo(0, -8);
  mmCtx.lineTo(5.5, 6);
  mmCtx.lineTo(-5.5, 6);
  mmCtx.closePath();
  mmCtx.fill();
  mmCtx.restore();

  // 指北针（固定世界北 = -Z = 屏幕上方，与相机无关）
  mmCtx.fillStyle = '#e8a33d';
  mmCtx.font = 'bold 15px sans-serif';
  mmCtx.textAlign = 'center';
  mmCtx.fillText('N', cx, 20);
  mmCtx.restore();
}

// ===== 触屏摇杆（仅触屏设备显示） =====
let touchTurn = 0; // 摇杆横轴转向输入（-1 ~ 1）
(function initTouchUI() {
  const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  if (!isTouch) return;
  document.body.classList.add('touch');

  const joy = $('joystick');
  const knob = $('joy-knob');
  let joyId = null;

  function updateKnob(t) {
    const rect = joy.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = t.clientX - cx;
    let dy = t.clientY - cy;
    const r = rect.width / 2;
    const len = Math.hypot(dx, dy);
    if (len > r) { dx = (dx / len) * r; dy = (dy / len) * r; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    touchTurn = -dx / r; // 摇杆右推 = 右转（turn 为正即左转）
    // 纵轴直接映射连续帆量：上推幅度 = 帆量，下推到底进入倒车，回中保持当前值
    const fy = dy / r;
    if (state === 'playing' && camMode !== 3) {
      if (fy < -0.15) setSail(Math.min(1, -fy * 1.1));
      else if (fy > 0.55) setSail(-((fy - 0.55) / 0.45) * ASTERN_MAX);
    }
  }

  joy.addEventListener('touchstart', (e) => {
    e.preventDefault();
    joyId = e.changedTouches[0].identifier;
    updateKnob(e.changedTouches[0]);
  }, { passive: false });
  joy.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === joyId) updateKnob(t);
  }, { passive: false });
  const joyEnd = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) {
        joyId = null;
        touchTurn = 0;
        knob.style.transform = 'translate(0, 0)';
      }
    }
  };
  joy.addEventListener('touchend', joyEnd);
  joy.addEventListener('touchcancel', joyEnd);

  // 触屏舷炮按钮：同样按住蓄力、松开发射
  $('fire-l').addEventListener('touchstart', (e) => { e.preventDefault(); startCharge('L'); }, { passive: false });
  $('fire-l').addEventListener('touchend', (e) => { e.preventDefault(); releaseCharge('L'); }, { passive: false });
  $('fire-r').addEventListener('touchstart', (e) => { e.preventDefault(); startCharge('R'); }, { passive: false });
  $('fire-r').addEventListener('touchend', (e) => { e.preventDefault(); releaseCharge('R'); }, { passive: false });
})();

// ===== 拾取飘字 =====
function floatText(msg) {
  const el = document.createElement('div');
  el.className = 'float-text';
  el.textContent = msg;
  el.style.marginLeft = `${Math.round((Math.random() - 0.5) * 120)}px`; // 避免连续拾取时叠在一起
  hud.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

// 漂浮补给拾取：木桶/木箱修船，宝箱记战利品
function onPickup(item) {
  combat.splash(item.mesh.position.clone());
  audio.pickup();
  if (item.kind === 'repair') {
    player.hp = Math.min(player.maxHp, player.hp + 10);
    floatText('+10 修复');
  } else {
    loot += 1;
    floatText('+1 战利品');
  }
}

// ===== 输入 =====
const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyM') { syncMuteBtn(audio.toggleMute()); return; }
  if (e.code === 'Digit1') { setCamMode(1); return; }
  if (e.code === 'Digit2') { setCamMode(2); return; }
  if (e.code === 'Digit3') { setCamMode(3); return; }
  if (state !== 'playing') return;
  // 帆位连续化：W/S 在主循环里按按住时长处理，此处不响应离散按键
  if (!e.repeat) {
    if (e.code === 'KeyQ') startCharge('L');
    if (e.code === 'KeyE') startCharge('R');
    if (e.code === 'Space') { e.preventDefault(); startCharge('bow'); }
  }
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'KeyQ') releaseCharge('L');
  if (e.code === 'KeyE') releaseCharge('R');
  if (e.code === 'Space') releaseCharge('bow');
});

// 鼠标：模式1 移动环视 + 按住蓄力齐射；模式2/3 拖拽转视角（齐射用 Q/E）
let mouseNX = 0; // -0.5 ~ 0.5
let mouseNY = 0;
let dragging = false;
let lastMouseX = 0;
let lastMouseY = 0;
window.addEventListener('mousemove', (e) => {
  mouseNX = e.clientX / window.innerWidth - 0.5;
  mouseNY = e.clientY / window.innerHeight - 0.5;
  if (dragging) {
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    if (camMode === 2) {
      orbitYaw -= dx * 0.005;
      orbitPitch = THREE.MathUtils.clamp(orbitPitch + dy * 0.005, 0.05, 1.4);
    } else if (camMode === 3) {
      fly.yaw -= dx * 0.004;
      fly.pitch = THREE.MathUtils.clamp(fly.pitch - dy * 0.004, -1.3, 1.3);
    }
  }
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
});
window.addEventListener('mousedown', (e) => {
  if (state !== 'playing') return;
  if (camMode === 1) {
    if (e.button === 0) startCharge('L');
    if (e.button === 2) startCharge('R');
  } else if (e.button === 0) {
    dragging = true;
  }
});
window.addEventListener('mouseup', (e) => {
  dragging = false;
  if (e.button === 0) releaseCharge('L');
  if (e.button === 2) releaseCharge('R');
});
window.addEventListener('wheel', (e) => {
  if (camMode === 2) orbitDist = THREE.MathUtils.clamp(orbitDist + e.deltaY * 0.02, 6, 40);
}, { passive: true });
window.addEventListener('contextmenu', (e) => e.preventDefault());

// 帆位连续设置（倒车为负值；破帆时上限被压低）
function setSail(v) {
  sailAmount = THREE.MathUtils.clamp(v, -ASTERN_MAX, player.sailCap);
  player.setSailAmount(Math.max(0, sailAmount)); // 倒车时帆面按收帆显示
}

// ===== 火炮蓄力：按住蓄力、松开发射；冷却未结束时按住不开始蓄力 =====
function startCharge(which) {
  if (state !== 'playing' || player.sinking) return;
  if (which === 'L' && cooldownL <= 0 && chargeL === null) chargeL = 0;
  if (which === 'R' && cooldownR <= 0 && chargeR === null) chargeR = 0;
  if (which === 'bow' && cooldownBow <= 0 && chargeBow === null) chargeBow = 0;
}

function releaseCharge(which) {
  if (which === 'L' && chargeL !== null) { fireCharged(-1, chargeL / CHARGE_TIME); chargeL = null; }
  if (which === 'R' && chargeR !== null) { fireCharged(1, chargeR / CHARGE_TIME); chargeR = null; }
  if (which === 'bow' && chargeBow !== null) { fireBow(chargeBow / CHARGE_TIME); chargeBow = null; }
}

function fireCharged(side, power) {
  if (player.sinking) return;
  const p = Math.min(1, power);
  combat.fireBroadside(player, side, {
    speed: BROADSIDE_SPEED * (0.6 + 0.9 * p), // 初速/射程随蓄力
    spread: 0.05,
    fromPlayer: true,                    // 炮数取 ship.cannons
    damageMul: 0.7 + 0.8 * p,            // 伤害随蓄力
  });
  audio.cannon();
  if (side < 0) cooldownL = RELOAD_TIME;
  else cooldownR = RELOAD_TIME;
}

// 艏炮：单发、弹道平直；小船（炮数 ≤2）伤害 ×1.5 补偿
function fireBow(power) {
  if (player.sinking) return;
  const p = Math.min(1, power);
  combat.fireBowShot(player, {
    speed: BOW_SPEED * (0.6 + 0.9 * p),
    damageMul: (0.7 + 0.8 * p) * (player.cannons <= 2 ? 1.5 : 1),
  });
  audio.cannon();
  cooldownBow = BOW_RELOAD;
}

// ===== 蓄力扇形覆盖面：内边界=0 蓄力射程，外边界=当前蓄力射程，角宽=散布角 =====
const FAN_SEGMENTS = 24;            // 扇面角向采样数
const FAN_HALF_ANGLE = 0.15;        // 舷炮散布半角（弧度）
const FAN_HALF_ANGLE_BOW = 0.035;   // 艏炮窄扇面半角

function makeFanViz() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((FAN_SEGMENTS + 1) * 2 * 3), 3));
  const idx = [];
  for (let i = 0; i < FAN_SEGMENTS; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); // 内外弧三角条带
  }
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0xffd76e, transparent: true, opacity: 0.22,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    depthWrite: false, depthTest: false, // 始终画在水面之上，防浪高时穿插遮挡
  }));
  mesh.renderOrder = 999;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);
  return mesh;
}
const fanL = makeFanViz();
const fanR = makeFanViz();
const fanBow = makeFanViz();

// 平抛近似射程：从高度 h0、上抛 vy、初速 speed 到落回波面
function ballisticRange(speed, vy, h0) {
  const t = (vy + Math.sqrt(vy * vy + 2 * BALL_GRAVITY * h0)) / BALL_GRAVITY;
  return speed * t;
}

// side: -1 左舷 / +1 右舷 / 0 艏炮；charge 为 null 时隐藏
function updateFanViz(mesh, charge, side, time) {
  if (charge === null) {
    mesh.visible = false;
    return;
  }
  const p = Math.min(1, charge / CHARGE_TIME);
  const ls = player.lengthScale || 1;
  const pp = player.position;
  let dirAng;
  let sx;
  let sz;
  let vy;
  let h0;
  let baseSpeed;
  let halfAng;
  if (side === 0) {
    dirAng = player.heading;
    sx = pp.x + Math.sin(player.heading) * 4.2 * ls;
    sz = pp.z + Math.cos(player.heading) * 4.2 * ls;
    vy = 2.5; h0 = 1.4; baseSpeed = BOW_SPEED; halfAng = FAN_HALF_ANGLE_BOW;
  } else {
    const dx = -side * Math.cos(player.heading); // 舷侧方向与 combat.fireBroadside 同约定
    const dz = side * Math.sin(player.heading);
    dirAng = Math.atan2(dx, dz);
    sx = pp.x + dx * 1.5;
    sz = pp.z + dz * 1.5;
    vy = 5.5; h0 = 1.3; baseSpeed = BROADSIDE_SPEED; halfAng = FAN_HALF_ANGLE;
  }
  // 内边界 = 0 蓄力射程，外边界 = 当前蓄力射程
  const rIn = Math.max(4, ballisticRange(baseSpeed * 0.6, vy, h0));
  const rOut = ballisticRange(baseSpeed * (0.6 + 0.9 * p), vy, h0);

  // 扇面顶点贴波面（每帧采样 getWaveHeight）
  const attr = mesh.geometry.attributes.position;
  for (let i = 0; i <= FAN_SEGMENTS; i++) {
    const ang = dirAng - halfAng + (2 * halfAng * i) / FAN_SEGMENTS;
    const sinA = Math.sin(ang);
    const cosA = Math.cos(ang);
    const xi = sx + sinA * rIn;
    const zi = sz + cosA * rIn;
    const xo = sx + sinA * rOut;
    const zo = sz + cosA * rOut;
    attr.setXYZ(i * 2, xi, waveFn(xi, zi, time) + 0.6, zi);
    attr.setXYZ(i * 2 + 1, xo, waveFn(xo, zo, time) + 0.6, zo);
  }
  attr.needsUpdate = true;
  mesh.visible = true;
}

// ===== 开始 / 结束 / 重开 =====
function begin() {
  $('start-overlay').classList.add('hidden');
  hud.classList.remove('hidden');
  state = 'playing';
  audio.init(); // AudioContext 需在用户交互后创建
  syncMuteBtn(audio.muted);
  setSail(0.6); // 出航初始 60% 帆
  fleet.spawnOne(player.position);
  fleet.spawnOne(player.position);
}

$('start-btn').addEventListener('click', begin);

// 重开后直接进游戏（跳过开始界面）
if (sessionStorage.getItem('waters-autostart') === '1') {
  sessionStorage.removeItem('waters-autostart');
  begin();
}

function gameOver() {
  state = 'over';
  gameOverT = 0;
}

window.addEventListener('keydown', (e) => {
  if (state === 'over' && e.code === 'KeyR' && !$('gameover-overlay').classList.contains('hidden')) {
    sessionStorage.setItem('waters-autostart', '1');
    location.reload();
  }
});

// ===== 命中回调：伤害 ×蓄力系数，并按概率给目标挂 debuff =====
// 伤害数字字号：10~60 伤害映射 16~24px
const dmgFontSize = (d) => 16 + Math.min(1, Math.max(0, (d - 10) / 50)) * 8;
const ENEMY_HP_BAR_TIME = 5; // 敌船受击后血条显示秒数

function onHit(ball, target) {
  const base = target.isPlayer ? 12 : 20;
  const dmg = base * (ball.damageMul ?? 1);
  audio.hit();
  const sunk = target.ship.takeDamage(dmg);
  if (!target.isPlayer && ball.fromPlayer) {
    // 玩家造成的伤害：白字漂浮 + 敌船血条
    target.ship.hurtT = ENEMY_HP_BAR_TIME;
    floatTextAt(`-${Math.round(dmg)}`, target.ship.position, { color: '#ffffff', size: dmgFontSize(dmg) });
  }
  if (!sunk) {
    // 雨天（风暴中）不附加着火
    for (const key of target.ship.rollDebuffs(!weather.fireOut)) {
      // 敌船中 debuff：头上飘字；玩家中 debuff：HUD 图标表达（updateHUD）
      if (!target.isPlayer) floatTextAt(`敌船${DEBUFF_DEFS[key].label}！`, target.ship.position);
    }
  }
  if (sunk && target.isPlayer) gameOver();
}

// 世界坐标 → 屏幕位置飘字（敌船头顶）；opts: { color, size }
function floatTextAt(msg, worldPos, opts = {}) {
  const v = worldPos.clone();
  v.y += 4;
  v.project(camera);
  if (v.z > 1) { floatText(msg); return; } // 在镜头后方则退回中央飘字
  const el = document.createElement('div');
  el.className = 'float-text';
  el.textContent = msg;
  el.style.left = `${(v.x * 0.5 + 0.5) * 100}%`;
  el.style.top = `${(-v.y * 0.5 + 0.5) * 100}%`;
  el.style.bottom = 'auto';
  if (opts.color) el.style.color = opts.color;
  if (opts.size) el.style.fontSize = `${opts.size}px`;
  hud.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

// ===== 敌船血条：受玩家攻击后头顶显示 5s（池化 div，每帧投影更新） =====
const EHP_POOL_SIZE = 8;
const ehpPool = [];
for (let i = 0; i < EHP_POOL_SIZE; i++) {
  const el = document.createElement('div');
  el.className = 'enemy-hp';
  el.innerHTML = '<div class="ehp-name">敌船</div><div class="ehp-bar"><div class="ehp-fill"></div></div>';
  hud.appendChild(el);
  ehpPool.push({ el, fill: el.querySelector('.ehp-fill') });
}
const ehpVec = new THREE.Vector3();

function updateEnemyHpBars(dt) {
  let slot = 0;
  for (const e of fleet.enemies) {
    if (e.hurtT > 0) {
      e.hurtT -= dt;
      if (e.sinking) e.hurtT = 0;
    }
    if (e.hurtT <= 0 || slot >= EHP_POOL_SIZE) continue;
    ehpVec.copy(e.position);
    ehpVec.y += 5 * (e.lengthScale || 1);
    ehpVec.project(camera);
    if (ehpVec.z > 1) continue; // 在镜头后方
    const s = ehpPool[slot++];
    s.el.style.display = 'block';
    s.el.style.left = `${(ehpVec.x * 0.5 + 0.5) * 100}%`;
    s.el.style.top = `${(-ehpVec.y * 0.5 + 0.5) * 100}%`;
    s.fill.style.width = `${(e.hp / e.maxHp) * 100}%`;
  }
  for (; slot < EHP_POOL_SIZE; slot++) ehpPool[slot].el.style.display = 'none';
}

const fleetHooks = {
  onEnemySunk() {
    kills += 1;
  },
  onWaveUp() {
    // 波次提升，HUD 每帧自动刷新
  },
};

// ===== 相机（1 跟随 / 2 自由环绕 / 3 自由飞行，数字键切换，0.5s 平滑过渡） =====
let camYaw = 0;
let camPitch = 0.32;
const camTarget = new THREE.Vector3();
let camMode = 1;
let camBlend = 1;                       // 切换过渡 0→1
const CAM_BLEND_TIME = 0.5;
const prevCamPos = new THREE.Vector3();
const prevCamQuat = new THREE.Quaternion();
// 模式 2：自由环绕
let orbitYaw = Math.PI;
let orbitPitch = 0.35;
let orbitDist = 15;
// 模式 3：自由飞行
const fly = { yaw: 0, pitch: 0, speed: 30 };
const CAM_MODE_NAMES = { 1: '跟随', 2: '环绕', 3: '飞行' };

function setCamMode(m) {
  if (m === camMode) return;
  prevCamPos.copy(camera.position);
  prevCamQuat.copy(camera.quaternion);
  camBlend = 0;
  camMode = m;
  if (m === 2) orbitYaw = player.heading + Math.PI + camYaw; // 从当前视角接续
  if (m === 3) {
    fly.yaw = player.heading + Math.PI;
    fly.pitch = 0.15;
  }
  const el = $('cam-mode');
  if (el) el.textContent = CAM_MODE_NAMES[m];
  updateHelp();
}

function updateHelp() {
  const tips = {
    1: '按住 W/S 调帆 · A/D 转向 · 按住 左键/Q 右键/E 蓄力齐射 · 空格艏炮 · 1/2/3 相机',
    2: '拖拽旋转 · 滚轮缩放 · Q/E 齐射 · 按 1 返回跟随',
    3: '拖拽转向 · WASD 平移 · Q/E 升降 · 船保持帆位直行 · 按 1 返回跟随',
  };
  const el = $('help');
  if (el) el.textContent = tips[camMode];
}

function updateCamera(dt, time) {
  const p = player.position;
  const pos = new THREE.Vector3();
  const look = new THREE.Vector3(p.x, p.y + 3, p.z);

  if (camMode === 1) {
    // 跟随：平滑逼近鼠标目标角度
    const k = 1 - Math.exp(-6 * dt);
    camYaw += (-mouseNX * Math.PI * 1.4 - camYaw) * k;
    camPitch += (THREE.MathUtils.clamp(0.3 + mouseNY * 0.9, 0.06, 1.1) - camPitch) * k;
    const dist = 15;
    const angle = player.heading + Math.PI + camYaw; // 默认在船尾后方
    const horiz = Math.cos(camPitch) * dist;
    pos.set(p.x + Math.sin(angle) * horiz, 0, p.z + Math.cos(angle) * horiz);
    pos.y = p.y + 2.5 + Math.sin(camPitch) * dist;
  } else if (camMode === 2) {
    // 自由环绕：角度不回弹，滚轮缩放
    const horiz = Math.cos(orbitPitch) * orbitDist;
    pos.set(p.x + Math.sin(orbitYaw) * horiz, 0, p.z + Math.cos(orbitYaw) * horiz);
    pos.y = p.y + 2.0 + Math.sin(orbitPitch) * orbitDist;
  } else {
    // 自由飞行：WASD 平移 + Q/E 升降，拖拽转向；船保持帆位直行
    const dir = new THREE.Vector3(
      Math.sin(fly.yaw) * Math.cos(fly.pitch),
      Math.sin(fly.pitch),
      Math.cos(fly.yaw) * Math.cos(fly.pitch)
    );
    const right = new THREE.Vector3(-Math.cos(fly.yaw), 0, Math.sin(fly.yaw)); // 屏幕右 = (-cos, 0, sin)
    const move = new THREE.Vector3();
    if (keys['KeyW']) move.add(dir);
    if (keys['KeyS']) move.sub(dir);
    if (keys['KeyA']) move.sub(right);
    if (keys['KeyD']) move.add(right);
    if (keys['KeyE']) move.y += 1;
    if (keys['KeyQ']) move.y -= 1;
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(fly.speed * dt);
      camera.position.add(move);
    }
    pos.copy(camera.position); // 飞行模式位置即状态
    look.copy(pos).add(dir);
  }

  // 跟随/环绕：镜头受波浪轻微影响；允许入水（水下过渡），保底不坠向海底
  if (camMode !== 3) {
    const waveAtCam = waveFn(pos.x, pos.z, time);
    pos.y += waveAtCam * 0.25;
    pos.y = Math.max(pos.y, waveAtCam - CAM_MAX_DIP);
  } else {
    pos.y = Math.max(pos.y, waveFn(pos.x, pos.z, time) - CAM_MAX_DIP);
  }

  // 模式切换 0.5s 平滑过渡
  if (camBlend < 1) {
    camBlend = Math.min(1, camBlend + dt / CAM_BLEND_TIME);
    pos.lerpVectors(prevCamPos, pos, camBlend);
    camera.position.copy(pos);
    camera.lookAt(look);
    const newQuat = camera.quaternion.clone();
    camera.quaternion.slerpQuaternions(prevCamQuat, newQuat, camBlend);
  } else {
    camera.position.copy(pos);
    camera.lookAt(look);
  }
}

// 水下过渡：镜头低于当地波面 → 浓雾 + 蓝绿遮罩，0.3s 插值
function updateUnderwater(dt, time) {
  const cam = camera.position;
  const target = cam.y < waveFn(cam.x, cam.z, time) ? 1 : 0;
  underT += (target - underT) * Math.min(1, dt / 0.3);
  if (scene.fog) {
    scene.fog.color.lerpColors(weather.fogColor, UNDER_FOG.color, underT); // 水上面跟随天气
    scene.fog.near = THREE.MathUtils.lerp(weather.fogNear, UNDER_FOG.near, underT);
    scene.fog.far = THREE.MathUtils.lerp(weather.fogFar, UNDER_FOG.far, underT);
  }
  $('uw-overlay').style.opacity = (underT * 0.85).toFixed(3);
  // TODO(音频): 此处可用 underT 驱动环境音低通滤波实现闷化（已通过 setEnvironment 接入）

  // ---- 后处理 uniform：水下折射扰动 + 水线 meniscus ----
  warpU.uTime.value = time;
  warpU.uWarp.value = underT * weather.warp; // 扰动强度按天气分级
  const camWaveDist = Math.abs(cam.y - waveFn(cam.x, cam.z, time));
  const menTarget = THREE.MathUtils.clamp(1 - camWaveDist / 0.5, 0, 1);
  menT += (menTarget - menT) * Math.min(1, dt * 8);
  warpU.uMeniscus.value = menT;
  // 水线屏幕 y 近似：由相机俯仰推算水平视线的落点
  camera.getWorldDirection(camDirVec);
  const pitch = Math.asin(THREE.MathUtils.clamp(camDirVec.y, -1, 1));
  const ndcY = -Math.tan(pitch) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  warpU.uWaterlineY.value = THREE.MathUtils.clamp(0.5 + 0.5 * ndcY, -0.5, 1.5);
}

// ===== 船只碰撞（椭圆碰撞体 + 撞击伤害） =====
const COLLISION_MIN_SPEED = 3;    // 相对速度低于此值不计伤害
const COLLISION_DAMAGE_MUL = 4;   // 伤害 = (相对速度 - 阈值) × 系数
const COLLISION_COOLDOWN = 1.0;   // 同一对船的伤害结算冷却
const COLLISION_GRIDS = 12;       // 粗筛距离（大于此直接跳过）
const collisionCooldowns = new Map(); // "cidA:cidB" -> 上次结算时间
let shipCidCounter = 0;

function resolveShipCollisions() {
  const ships = [player, ...fleet.enemies].filter((s) => !s.sinking && !s.dead);
  for (let i = 0; i < ships.length; i++) {
    for (let j = i + 1; j < ships.length; j++) {
      const a = ships[i];
      const b = ships[j];
      let dx = b.position.x - a.position.x;
      let dz = b.position.z - a.position.z;
      let dist = Math.hypot(dx, dz);
      if (dist > COLLISION_GRIDS) continue; // 粗筛

      // 椭圆有效半径：沿连线方向取极径（长半轴≈船长×0.9/2，短半轴≈船宽/2，均由 lengthScale 派生）
      const effR = (s) => {
        const la = 4.0 * (s.lengthScale || 1);
        const lb = 1.35 * (s.lengthScale || 1);
        const fx = Math.sin(s.heading);
        const fz = Math.cos(s.heading);
        const cosT = dist > 0.001 ? (dx * fx + dz * fz) / dist : 1;
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        return (la * lb) / Math.sqrt(lb * lb * cosT * cosT + la * la * sinT * sinT);
      };
      const pen = effR(a) + effR(b) - dist;
      if (pen <= 0) continue;

      if (dist < 0.001) { dx = 1; dz = 0; dist = 1; } // 完全重叠的退化情况
      const nx = dx / dist;
      const nz = dz / dist;

      // 撞击前的相对速度（用于伤害结算）
      const vax = Math.sin(a.heading) * a.speed;
      const vaz = Math.cos(a.heading) * a.speed;
      const vbx = Math.sin(b.heading) * b.speed;
      const vbz = Math.cos(b.heading) * b.speed;
      const relSpeed = Math.hypot(vbx - vax, vbz - vaz);

      // 位置分离（各推一半）
      a.position.x -= (nx * pen) / 2;
      a.position.z -= (nz * pen) / 2;
      b.position.x += (nx * pen) / 2;
      b.position.z += (nz * pen) / 2;

      // 消掉沿法向的速度分量，切向保留（船速只能沿船头方向，等效按比例衰减）
      for (const s of [a, b]) {
        const fDotN = Math.sin(s.heading) * nx + Math.cos(s.heading) * nz;
        s.speed *= Math.max(0.2, 1 - fDotN * fDotN);
      }

      // 撞击伤害（同对 1s 冷却）；速度快的一方（撞击方）承伤 ×0.5，慢方（被撞方）×1.5，同速各 ×1.0
      if (relSpeed > COLLISION_MIN_SPEED) {
        a._cid ??= ++shipCidCounter;
        b._cid ??= ++shipCidCounter;
        const key = a._cid < b._cid ? `${a._cid}:${b._cid}` : `${b._cid}:${a._cid}`;
        if (time - (collisionCooldowns.get(key) ?? -9) > COLLISION_COOLDOWN) {
          collisionCooldowns.set(key, time);
          const dmg = (relSpeed - COLLISION_MIN_SPEED) * COLLISION_DAMAGE_MUL;
          const speedA = Math.abs(a.speed);
          const speedB = Math.abs(b.speed);
          let dmgA = dmg;
          let dmgB = dmg;
          if (Math.abs(speedA - speedB) >= 0.5) {
            if (speedA > speedB) { dmgA = dmg * 0.5; dmgB = dmg * 1.5; }
            else { dmgA = dmg * 1.5; dmgB = dmg * 0.5; }
          }
          const mid = new THREE.Vector3(
            (a.position.x + b.position.x) / 2,
            a.position.y + 1,
            (a.position.z + b.position.z) / 2
          );
          combat.explosion(mid); // 木屑+硝烟
          audio.hit();
          const sunkA = a.takeDamage(dmgA);
          const sunkB = b.takeDamage(dmgB);
          // 玩家造成的撞击伤害：敌船飘白字 + 亮血条
          for (const [s, d] of [[a, dmgA], [b, dmgB]]) {
            if (s !== player) {
              s.hurtT = ENEMY_HP_BAR_TIME;
              floatTextAt(`-${Math.round(d)}`, s.position, { color: '#ffffff', size: dmgFontSize(d) });
            }
          }
          if ((sunkA && a === player) || (sunkB && b === player)) gameOver();
        }
      }
    }
  }
}

// ===== 主循环 =====
const clock = new THREE.Clock();
let time = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  time += dt;

  // 玩家操控（风暴时极速 ×0.9、操控略钝；飞行模式下船的操控失效保持直行）
  if (state === 'playing' && !player.sinking && camMode !== 3) {
    // 帆位连续化：按住 W 匀速升帆 / S 匀速降帆；降到 0 后 S 再按 ASTERN_HOLD 秒进入倒车
    if (keys['KeyW']) {
      asternHoldT = 0;
      setSail(sailAmount + dt * SAIL_RATE);
    } else if (keys['KeyS']) {
      if (sailAmount > 0) {
        setSail(sailAmount - dt * SAIL_RATE);
      } else {
        asternHoldT += dt;
        if (asternHoldT > ASTERN_HOLD) setSail(sailAmount - dt * SAIL_RATE);
      }
    } else {
      asternHoldT = 0;
    }

    const targetSpeed = sailAmount * player.maxSpeed * weather.speedMul * player.speedMul; // 天气+debuff 双乘区
    player.speed += (targetSpeed - player.speed) * Math.min(1, dt * 1.2);
    let turn = 0;
    if (keys['KeyA']) turn += 1; // A = 左转（heading 增大即向屏幕左）
    if (keys['KeyD']) turn -= 1;
    turn += touchTurn; // 触屏摇杆转向
    // 舵是翼面：舵效 ∝ 航速（低速几乎转不动），倒车时舵效反向
    const speedRatio = Math.min(1, Math.abs(player.speed) / player.maxSpeed);
    const rudderEff = RUDDER_MIN_EFF + (1 - RUDDER_MIN_EFF) * Math.pow(speedRatio, RUDDER_CURVE);
    const rudderDir = player.speed < -0.3 ? -1 : 1;
    const weatherTurnMul = 1 - weather.strength * 0.15;
    player.heading += turn * player.turnRate * rudderEff * rudderDir * weatherTurnMul * dt;
  }

  // 蓄力进度推进
  if (chargeL !== null) chargeL += dt;
  if (chargeR !== null) chargeR += dt;
  if (chargeBow !== null) chargeBow += dt;
  updateFanViz(fanL, chargeL, -1, time);
  updateFanViz(fanR, chargeR, 1, time);
  updateFanViz(fanBow, chargeBow, 0, time);

  // 冷却
  cooldownL = Math.max(0, cooldownL - dt);
  cooldownR = Math.max(0, cooldownR - dt);
  cooldownBow = Math.max(0, cooldownBow - dt);

  // 实体更新
  player.update(dt, time, waveFn);
  fleet.weatherSpeedMul = weather.speedMul; // 天气全船减速（敌船）
  fleet.update(dt, time, player, waveFn, fleetHooks);
  wakes.update(dt, time, [player, ...fleet.enemies]);
  resolveShipCollisions();

  // 大雨灭火：小雨及以上（fireOut）所有船的着火立即清除
  if (weather.fireOut) {
    for (const s of [player, ...fleet.enemies]) {
      if (s.debuff.fire > 0) {
        s.debuff.fire = 0;
        if (s === player) floatText('大雨浇灭了火焰');
      }
    }
  }

  // 世界：岛屿碰撞 + 浮标/补给动画与拾取
  if (world) {
    world.resolveCollisions(player);
    for (const e of fleet.enemies) world.resolveCollisions(e);
    world.update(dt, time, state === 'playing' && !player.sinking ? player.position : null, onPickup);
  }

  // 命中判定目标列表
  const targets = [{ ship: player, isPlayer: true }];
  for (const e of fleet.enemies) targets.push({ ship: e, isPlayer: false });
  combat.update(dt, time, targets, onHit);

  // 沉船冒泡
  const sinkingShips = [player, ...fleet.enemies].filter((s) => s.sinking && !s.dead);
  for (const s of sinkingShips) {
    if (Math.random() < dt * 8) {
      const pos = s.position.clone();
      pos.x += (Math.random() - 0.5) * 4;
      pos.z += (Math.random() - 0.5) * 4;
      pos.y = waveFn(pos.x, pos.z, time);
      combat.bubbles(pos);
    }
  }

  // debuff 粒子：着火冒火焰、漏水舷侧冒水花
  for (const s of [player, ...fleet.enemies]) {
    if (s.sinking || s.dead) continue;
    if (s.debuff.fire > 0 && Math.random() < dt * 10) {
      const pos = s.position.clone();
      pos.x += (Math.random() - 0.5) * 2;
      pos.z += (Math.random() - 0.5) * 2;
      pos.y += 1.5;
      combat.firePuff(pos);
    }
    if (s.debuff.leak > 0 && Math.random() < dt * 1.5) {
      const pos = s.position.clone();
      pos.x += (Math.random() - 0.5) * 3;
      pos.z += (Math.random() - 0.5) * 3;
      pos.y = waveFn(pos.x, pos.z, time) + 0.1;
      combat.splash(pos);
    }
  }

  // 游戏结束：沉船动画播一会儿再弹遮罩
  if (state === 'over') {
    gameOverT += dt;
    if (gameOverT > 3.2 && $('gameover-overlay').classList.contains('hidden')) {
      $('final-kills').textContent = kills;
      $('final-loot').textContent = loot;
      $('gameover-overlay').classList.remove('hidden');
    }
  }

  water.update(time);
  sky.update(dt);
  dayTime.update(dt); // 先算昼夜基底
  weather.update(dt, dayTime); // 天气在基底上乘法调光
  updateCamera(dt, time);
  updateUnderwater(dt, time);
  updateEnemyHpBars(dt);
  audio.setEnvironment(weather.strength, camera.position.y, underT);
  if ((mmFrame++ & 3) === 0) drawMinimap(); // 小地图 ~15fps 节流
  updateHUD();

  postProcessing.render();
});
