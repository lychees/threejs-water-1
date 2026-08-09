// 入口：场景装配、输入、相机、HUD、游戏状态机、主循环
import * as THREE from 'three';
import { createWater, getWaveHeight } from './water.js';
import { createSky, SUN_DIR } from './sky.js';
import { Ship, buildShipModel } from './ship.js';
import { Combat } from './combat.js';
import { EnemyFleet } from './enemy.js';
import { loadShipModel, instantiateShip, SHIP_MODELS, BASE_LENGTH } from './modelship.js';
import { SHIP_DEFS, buildShip, computeStats, FALLBACK_STATS, renderShipThumbnail, DEFAULT_SHIP_DEF_ID } from './shipyard.js';
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

  if (def.model) {
    // 真实模型：异步加载，失败回退程序化船
    const mdef = SHIP_MODELS[def.model];
    player.lengthScale = mdef.targetLength / BASE_LENGTH;
    player.hitRadius = 3.4 * player.lengthScale;
    loadShipModel(def.model).then((template) => {
      if (tok !== choiceToken) return;
      if (!template) {
        const m = buildShipModel({ hullColor: 0x7a4f2a, sailColor: 0xf3ead5 });
        player.setVisual(m.group, m.setSailAmount);
      } else {
        const v = instantiateShip(template, null);
        player.setVisual(v.group, v.setSailAmount);
      }
      player.setSailAmount(sailLevel / 3);
    });
  } else {
    // 参数化程序化船：同步生成
    player.lengthScale = def.spec.length / BASE_LENGTH;
    player.hitRadius = 3.4 * player.lengthScale;
    const v = buildShip(def.spec);
    player.setVisual(v.group, v.setSailAmount);
    player.setSailAmount(sailLevel / 3);
  }
}

// ===== 选船卡片 UI（开始遮罩内，可滚动网格） =====
function statBar(label, ratio) {
  return `<div class="stat-row"><span class="lbl">${label}</span>` +
    `<span class="sbar"><div style="width:${Math.round(Math.min(1, ratio) * 100)}%"></div></span></div>`;
}

function buildShipCards() {
  const wrap = $('ship-select');
  for (const def of SHIP_DEFS) {
    const stats = SHIP_STATS[def.id] || FALLBACK_STATS;
    // 缩略图：真实模型用预制 thumb.png；程序化船离屏渲染一帧
    let thumb;
    if (def.model) {
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
      (def.model ? '<span class="badge">★精致模型</span>' : '') +
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
  }
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
