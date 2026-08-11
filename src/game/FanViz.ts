/**
 * 蓄力扇形覆盖面预览：内边界 = 0 蓄力射程，外边界 = 当前蓄力射程，
 * 角宽 = 散布角，扇面顶点逐帧贴波面。移植自旧 js/main.js 的 fan viz 段。
 *
 * B 阶段加 3D 弹道弧线（makeArcViz / updateArcViz）：扇面中央叠加一条
 * 从炮口出发的抛物线采样线（金色亮线 + 落水点小圈），滚轮调仰角实时可见
 * 弧线变高变远；初速/上抛/出膛点/重力与 Combat.fireBroadside/fireBowShot
 * 逐字一致（共用 muzzleParams 与 BALL_GRAVITY）。
 */

import * as THREE from 'three/webgpu';
import { BALL_GRAVITY } from './Combat';
import { FEEL } from './PlayerConfig';
import type { GameShip, WaveHeightAt } from './GameShip';

const FAN_SEGMENTS = 24; // 扇面角向采样数
const FAN_HALF_ANGLE = 0.15; // 舷炮散布半角（弧度）
const FAN_HALF_ANGLE_BOW = 0.035; // 艏炮窄扇面半角
const ARC_SEGMENTS = 24; // 弹道弧线采样段数

export function makeFanViz(scene: THREE.Scene): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array((FAN_SEGMENTS + 1) * 2 * 3), 3),
  );
  const idx: number[] = [];
  for (let i = 0; i < FAN_SEGMENTS; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); // 内外弧三角条带
  }
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color: 0xffd76e,
      transparent: true,
      // 比旧版（0.22）高一档：基座的艉随镜头更低更平，扇面在掠射角下会被洗没。
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false, // 始终画在水面之上，防浪高时穿插遮挡
    }),
  );
  mesh.renderOrder = 999;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);
  return mesh;
}

/** 平抛近似射程：从高度 h0、上抛 vy、初速 speed 到落回波面。 */
function ballisticRange(speed: number, vy: number, h0: number): number {
  const t = (vy + Math.sqrt(vy * vy + 2 * BALL_GRAVITY * h0)) / BALL_GRAVITY;
  return speed * t;
}

/** 炮口参数：方向角/出膛点/初速基准/散布半角，舷炮与艏炮两分支与 Combat 一一对应。 */
interface MuzzleParams {
  dirAng: number;
  sx: number;
  sy: number; // 出膛高度（世界 y）
  sz: number;
  baseSpeed: number;
  halfAng: number;
}

function muzzleParams(side: -1 | 0 | 1, player: GameShip, azimuth: number): MuzzleParams {
  const ls = player.lengthScale || 1;
  const pp = player.position;
  if (side === 0) {
    return {
      dirAng: player.heading - azimuth, // 艏炮：正 azimuth 向右舷侧偏转（与 Combat.fireBowShot 一致）
      sx: pp.x + Math.sin(player.heading) * 4.2 * ls,
      sy: pp.y + 1.4,
      sz: pp.z + Math.cos(player.heading) * 4.2 * ls,
      baseSpeed: FEEL.BOW_SPEED,
      halfAng: FAN_HALF_ANGLE_BOW,
    };
  }
  const dx = -side * Math.cos(player.heading); // 舷侧方向与 Combat.fireBroadside 同约定
  const dz = side * Math.sin(player.heading);
  return {
    // 水平射角：正 = 偏船头（左舷减角、右舷加角）
    dirAng: Math.atan2(dx, dz) + side * azimuth,
    sx: pp.x + dx * 1.5,
    sy: pp.y + 1.3,
    sz: pp.z + dz * 1.5,
    baseSpeed: FEEL.BROADSIDE_SPEED,
    halfAng: FAN_HALF_ANGLE,
  };
}

/**
 * side: -1 左舷 / +1 右舷 / 0 艏炮；charge 为 null 时隐藏。
 * 参数与 Combat.fireBroadside / fireBowShot 的初速、上抛、出膛点一一对应。
 * elevVy：当前射角的上抛初速（蓄力期间滚轮调节），射程随它实时变化。
 */
export function updateFanViz(
  mesh: THREE.Mesh,
  charge: number | null,
  side: -1 | 0 | 1,
  player: GameShip,
  heightAt: WaveHeightAt,
  elevVy: number,
  azimuth = 0,
): void {
  if (charge === null) {
    mesh.visible = false;
    return;
  }
  const p = Math.min(1, charge / FEEL.CHARGE_TIME);
  const mp = muzzleParams(side, player, azimuth);
  const { dirAng, sx, sz, baseSpeed, halfAng } = mp;
  const h0 = mp.sy - player.position.y; // 出膛点高出船体水线（常量 1.3/1.4）
  // 内边界 = 0 蓄力射程，外边界 = 当前蓄力射程
  const rIn = Math.max(4, ballisticRange(baseSpeed * 0.6, elevVy, h0));
  const rOut = ballisticRange(baseSpeed * (0.6 + 0.9 * p), elevVy, h0);

  // 扇面顶点贴波面（每帧采样波高）
  const attr = mesh.geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i <= FAN_SEGMENTS; i++) {
    const ang = dirAng - halfAng + (2 * halfAng * i) / FAN_SEGMENTS;
    const sinA = Math.sin(ang);
    const cosA = Math.cos(ang);
    const xi = sx + sinA * rIn;
    const zi = sz + cosA * rIn;
    const xo = sx + sinA * rOut;
    const zo = sz + cosA * rOut;
    attr.setXYZ(i * 2, xi, heightAt(xi, zi) + 0.6, zi);
    attr.setXYZ(i * 2 + 1, xo, heightAt(xo, zo) + 0.6, zo);
  }
  attr.needsUpdate = true;
  mesh.visible = true;
}

// ---------------------------------------------------------------- 3D 弹道弧线

export interface ArcViz {
  readonly root: THREE.Group;
  readonly line: THREE.Line;
  readonly ring: THREE.Mesh;
}

/** 弹道弧线：24 段金色亮线 + 落水点小圈（初始隐藏，蓄力时由 updateArcViz 驱动）。 */
export function makeArcViz(scene: THREE.Scene): ArcViz {
  const root = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ARC_SEGMENTS + 1) * 3), 3));
  const line = new THREE.Line(
    geo,
    new THREE.LineBasicMaterial({
      color: 0xffd76e,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false, // 与扇面同：始终可见，防浪高遮挡
    }),
  );
  line.frustumCulled = false;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1.1, 20),
    new THREE.MeshBasicMaterial({
      color: 0xffd76e,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  root.add(line, ring);
  root.renderOrder = 999;
  root.visible = false;
  scene.add(root);
  return { root, line, ring };
}

/**
 * 蓄力弹道弧线：从炮口出发按当前蓄力初速/仰角 vy/方位角采样抛物线，
 * 逐字对应 Combat.fireBroadside/fireBowShot 的均值弹道（不含逐发随机散布）。
 * charge 为 null 时隐藏。
 */
export function updateArcViz(
  viz: ArcViz,
  charge: number | null,
  side: -1 | 0 | 1,
  player: GameShip,
  heightAt: WaveHeightAt,
  elevVy: number,
  azimuth = 0,
): void {
  if (charge === null) {
    viz.root.visible = false;
    return;
  }
  const p = Math.min(1, charge / FEEL.CHARGE_TIME);
  const mp = muzzleParams(side, player, azimuth);
  const speed = mp.baseSpeed * (0.6 + 0.9 * p); // 水平初速（与扇面外边界同式）
  const h0w = mp.sy - heightAt(mp.sx, mp.sz); // 出膛点高出当地波面
  // 飞行时间：解 y(t) = 波面（与 ballisticRange 同式）
  const tF = (elevVy + Math.sqrt(elevVy * elevVy + 2 * BALL_GRAVITY * h0w)) / BALL_GRAVITY;
  const dx = Math.sin(mp.dirAng) * speed;
  const dz = Math.cos(mp.dirAng) * speed;
  const attr = viz.line.geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const t = (tF * i) / ARC_SEGMENTS;
    attr.setXYZ(i, mp.sx + dx * t, mp.sy + elevVy * t - 0.5 * BALL_GRAVITY * t * t, mp.sz + dz * t);
  }
  attr.needsUpdate = true;
  // 落水点小圈（末点贴波面）
  const lx = mp.sx + dx * tF;
  const lz = mp.sz + dz * tF;
  viz.ring.position.set(lx, heightAt(lx, lz) + 0.5, lz);
  viz.root.visible = true;
}
