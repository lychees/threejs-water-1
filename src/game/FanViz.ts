/**
 * 蓄力扇形覆盖面预览：内边界 = 0 蓄力射程，外边界 = 当前蓄力射程，
 * 角宽 = 散布角，扇面顶点逐帧贴波面。移植自旧 js/main.js 的 fan viz 段。
 */

import * as THREE from 'three/webgpu';
import { BALL_GRAVITY } from './Combat';
import { FEEL } from './PlayerConfig';
import type { GameShip, WaveHeightAt } from './GameShip';

const FAN_SEGMENTS = 24; // 扇面角向采样数
const FAN_HALF_ANGLE = 0.15; // 舷炮散布半角（弧度）
const FAN_HALF_ANGLE_BOW = 0.035; // 艏炮窄扇面半角

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
): void {
  if (charge === null) {
    mesh.visible = false;
    return;
  }
  const p = Math.min(1, charge / FEEL.CHARGE_TIME);
  const ls = player.lengthScale || 1;
  const pp = player.position;
  let dirAng: number;
  let sx: number;
  let sz: number;
  let vy: number;
  let h0: number;
  let baseSpeed: number;
  let halfAng: number;
  if (side === 0) {
    dirAng = player.heading;
    sx = pp.x + Math.sin(player.heading) * 4.2 * ls;
    sz = pp.z + Math.cos(player.heading) * 4.2 * ls;
    vy = elevVy;
    h0 = 1.4;
    baseSpeed = FEEL.BOW_SPEED;
    halfAng = FAN_HALF_ANGLE_BOW;
  } else {
    const dx = -side * Math.cos(player.heading); // 舷侧方向与 Combat.fireBroadside 同约定
    const dz = side * Math.sin(player.heading);
    dirAng = Math.atan2(dx, dz);
    sx = pp.x + dx * 1.5;
    sz = pp.z + dz * 1.5;
    vy = elevVy;
    h0 = 1.3;
    baseSpeed = FEEL.BROADSIDE_SPEED;
    halfAng = FAN_HALF_ANGLE;
  }
  // 内边界 = 0 蓄力射程，外边界 = 当前蓄力射程
  const rIn = Math.max(4, ballisticRange(baseSpeed * 0.6, vy, h0));
  const rOut = ballisticRange(baseSpeed * (0.6 + 0.9 * p), vy, h0);

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
