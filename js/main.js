// 入口：场景装配、输入、相机、HUD、游戏状态机、主循环
import * as THREE from 'three';
import { createWater, getWaveHeight } from './water.js';
import { createSky, SUN_DIR } from './sky.js';
import { Ship } from './ship.js';
import { Combat } from './combat.js';
import { EnemyFleet } from './enemy.js';
import { loadShipModel, instantiateShip, SHIP_MODELS, BASE_LENGTH } from './modelship.js';
import { SHIP_DEFS, buildShip, buildFigurehead, computeStats, FALLBACK_STATS, renderShipThumbnail, DEFAULT_SHIP_DEF_ID } from './shipyard.js';
import { createWorld } from './world.js';

// ===== 渲染器 / 场景 / 相机 =====
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ===== 世界 =====
const sky = createSky(scene);
const water = createWater(SUN_DIR);
scene.add(water.mesh);
const combat = new Combat(scene, getWaveHeight);

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
createWorld(scene, getWaveHeight).then((w) => { world = w; });

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
      const fh = buildFigurehead(figurehead);
      const s = shipLength / BASE_LENGTH;
      fh.scale.setScalar(s);
      fh.position.set(0, 1.05 * s, shipLength * 0.46);
      group.add(fh);
    }
    player.setVisual(group, sailSetter);
    player.setSailAmount(sailLevel / 3);
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

function buildShipCards() {
  const wrap = $('ship-select');
  wrap.innerHTML = ''; // 支持重建（切换精致模型勾选时）
  for (const def of SHIP_DEFS) {
    const stats = SHIP_STATS[def.id] || FALLBACK_STATS;
    const useModel = fancyModel && def.model;
    // 缩略图：勾选精致模型才用真实模型（预制 thumb 或加载后实拍）；否则程序化低模实拍
    let thumb;
    if (useModel) {
      thumb = SHIP_MODELS[def.model].thumb;
    } else {
      const t = buildShip(def.spec);
      thumb = renderShipThumbnail(t.group);
    }

    const card = document.createElement('div');
    card.className = 'ship-card' + (def.id === selectedShipId ? ' selected' : '');
    card.dataset.ship = def.id;
    card.innerHTML =
      (thumb ? `<img src="${thumb}" alt="${def.cn}">` : `<div class="thumb-fallback">${def.cn}</div>`) +
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

    // 无预制缩略图的精致模型：勾选状态下按需加载，完成后用同一离屏管线实拍一张补上
    if (useModel && !thumb) {
      loadShipModel(def.model).then((template) => {
        if (!template) return;
        const url = renderShipThumbnail(template, { dispose: false }); // 模板几何体共享，不可销毁
        if (!url) return;
        const ph = card.querySelector('.thumb-fallback');
        if (ph) {
          const img = document.createElement('img');
          img.src = url;
          img.alt = def.cn;
          ph.replaceWith(img);
        }
      });
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

  document.querySelectorAll('.fh-btn').forEach((b) => {
    b.classList.toggle('selected', b.dataset.fh === figurehead);
    b.addEventListener('click', () => {
      figurehead = b.dataset.fh;
      sessionStorage.setItem(KEY_FIGUREHEAD, figurehead);
      document.querySelectorAll('.fh-btn').forEach((x) => x.classList.toggle('selected', x === b));
      applyShipChoice(selectedShipId);
    });
  });
}

// ===== 游戏状态 =====
let state = 'menu'; // menu | playing | over
let kills = 0;
let loot = 0;               // 战利品（宝箱）计数
let sailLevel = 0;              // 0 降帆 ~ 3 满帆
const RELOAD_TIME = 3.2;
let cooldownL = 0;
let cooldownR = 0;
let gameOverT = 0;

// ===== HUD =====
const $ = (id) => document.getElementById(id);
const hud = $('hud');
const SAIL_NAMES = ['降帆', '半帆', '大半帆', '满帆'];

function updateHUD() {
  $('hp-fill').style.width = `${(player.hp / player.maxHp) * 100}%`;
  $('kills').textContent = kills;
  $('loot').textContent = loot;
  $('wave').textContent = fleet.wave;
  $('sail-state').textContent = `帆位：${SAIL_NAMES[sailLevel]}（W 升帆 / S 降帆）`;
  $('reload-l').style.width = `${(1 - cooldownL / RELOAD_TIME) * 100}%`;
  $('reload-r').style.width = `${(1 - cooldownR / RELOAD_TIME) * 100}%`;
}

// 初始化选船界面并应用上次选择（需在 $ / sailLevel 声明之后调用）
loadShipStats().then(() => {
  buildShipCards();
  initCustomizeUI();
  applyShipChoice(selectedShipId);
});

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
  if (state !== 'playing') return;
  if (e.code === 'KeyW') setSail(Math.min(3, sailLevel + 1));
  if (e.code === 'KeyS') setSail(Math.max(0, sailLevel - 1));
  if (e.code === 'KeyQ') fire(-1);
  if (e.code === 'KeyE') fire(1);
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

// 鼠标：移动环视；左键左舷齐射，右键右舷齐射
let mouseNX = 0; // -0.5 ~ 0.5
let mouseNY = 0;
window.addEventListener('mousemove', (e) => {
  mouseNX = e.clientX / window.innerWidth - 0.5;
  mouseNY = e.clientY / window.innerHeight - 0.5;
});
window.addEventListener('mousedown', (e) => {
  if (state !== 'playing') return;
  if (e.button === 0) fire(-1);
  if (e.button === 2) fire(1);
});
window.addEventListener('contextmenu', (e) => e.preventDefault());

function setSail(level) {
  sailLevel = level;
  player.setSailAmount(level / 3);
}

function fire(side) {
  if (player.sinking) return;
  if (side < 0 && cooldownL > 0) return;
  if (side > 0 && cooldownR > 0) return;
  combat.fireBroadside(player, side, { count: 3, speed: 30, spread: 0.05, fromPlayer: true });
  if (side < 0) cooldownL = RELOAD_TIME;
  else cooldownR = RELOAD_TIME;
}

// ===== 开始 / 结束 / 重开 =====
function begin() {
  $('start-overlay').classList.add('hidden');
  hud.classList.remove('hidden');
  state = 'playing';
  setSail(2);
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

// ===== 命中回调 =====
function onHit(ball, target) {
  const dmg = target.isPlayer ? 12 : 20;
  const sunk = target.ship.takeDamage(dmg);
  if (sunk && target.isPlayer) gameOver();
}

const fleetHooks = {
  onEnemySunk() {
    kills += 1;
  },
  onWaveUp() {
    // 波次提升，HUD 每帧自动刷新
  },
};

// ===== 相机 =====
let camYaw = 0;
let camPitch = 0.32;
const camTarget = new THREE.Vector3();

function updateCamera(dt, time) {
  const p = player.position;
  // 平滑逼近鼠标目标角度
  const k = 1 - Math.exp(-6 * dt);
  camYaw += (-mouseNX * Math.PI * 1.4 - camYaw) * k;
  camPitch += (THREE.MathUtils.clamp(0.3 + mouseNY * 0.9, 0.06, 1.1) - camPitch) * k;

  const dist = 15;
  const angle = player.heading + Math.PI + camYaw; // 默认在船尾后方
  const horiz = Math.cos(camPitch) * dist;
  const cx = p.x + Math.sin(angle) * horiz;
  const cz = p.z + Math.cos(angle) * horiz;
  let cy = p.y + 2.5 + Math.sin(camPitch) * dist;
  // 镜头受波浪轻微影响，且不入水
  cy += getWaveHeight(cx, cz, time) * 0.25;
  cy = Math.max(cy, getWaveHeight(cx, cz, time) + 2.0);

  camera.position.set(cx, cy, cz);
  camTarget.set(p.x, p.y + 3, p.z);
  camera.lookAt(camTarget);
}

// ===== 主循环 =====
const clock = new THREE.Clock();
let time = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  time += dt;

  // 玩家操控
  if (state === 'playing' && !player.sinking) {
    const targetSpeed = (sailLevel / 3) * player.maxSpeed;
    player.speed += (targetSpeed - player.speed) * Math.min(1, dt * 1.2);
    let turn = 0;
    if (keys['KeyA']) turn -= 1;
    if (keys['KeyD']) turn += 1;
    // 速度越快舵效越好，但停船也能缓慢转向
    const steer = player.turnRate * (0.35 + 0.65 * (player.speed / player.maxSpeed));
    player.heading += turn * steer * dt;
  }

  // 冷却
  cooldownL = Math.max(0, cooldownL - dt);
  cooldownR = Math.max(0, cooldownR - dt);

  // 实体更新
  player.update(dt, time, getWaveHeight);
  fleet.update(dt, time, player, getWaveHeight, fleetHooks);

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
      pos.y = getWaveHeight(pos.x, pos.z, time);
      combat.bubbles(pos);
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
  updateCamera(dt, time);
  updateHUD();

  renderer.render(scene, camera);
});
