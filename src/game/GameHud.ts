/**
 * 战斗 HUD：玩家血条、双舷 + 艏炮装填条、帆位、击沉数/波次、
 * 伤害白字与敌船头顶血条、Game Over 遮罩。
 * 逻辑移植自旧 js/main.js 的 HUD 段；DOM 结构新写，样式走 styles.css 的 game 区。
 * 纯 DOM，相机只用于世界坐标投影（敌船血条/伤害飘字）。
 */

import * as THREE from 'three/webgpu';
import type { GameShip } from './GameShip';

const EHP_POOL_SIZE = 8;
const ENEMY_HP_BAR_TIME = 5; // 敌船受击后血条显示秒数
export { ENEMY_HP_BAR_TIME };

/** 伤害数字字号：10~60 伤害映射 16~24px。 */
export const dmgFontSize = (d: number): number =>
  16 + Math.min(1, Math.max(0, (d - 10) / 50)) * 8;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class GameHud {
  private readonly rootEl: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly sailState: HTMLElement;
  private readonly reloadL: HTMLElement;
  private readonly reloadR: HTMLElement;
  private readonly reloadB: HTMLElement;
  private readonly killsEl: HTMLElement;
  private readonly waveEl: HTMLElement;
  private readonly lootEl: HTMLElement;
  private readonly debuffFire: HTMLElement;
  private readonly debuffLeak: HTMLElement;
  private readonly debuffSail: HTMLElement;
  private readonly overEl: HTMLElement;
  private readonly overKills: HTMLElement;
  private readonly ehpPool: { el: HTMLElement; fill: HTMLElement }[] = [];
  private readonly ehpVec = new THREE.Vector3();

  constructor(root: HTMLElement) {
    // ---- 左下：玩家状态 ----
    const status = el('section', 'ghud ghud--status');
    status.setAttribute('aria-label', 'Ship status');
    const hpBar = el('div', 'ghud__bar ghud__bar--hp');
    this.hpFill = el('div', 'ghud__fill ghud__fill--hp');
    hpBar.append(this.hpFill);
    this.sailState = el('div', 'ghud__sail', '帆位：0%');
    const mkReload = (label: string): HTMLElement => {
      const row = el('div', 'ghud__reload');
      const bar = el('div', 'ghud__bar ghud__bar--reload');
      const fill = el('div', 'ghud__fill ghud__fill--reload');
      bar.append(fill);
      row.append(el('span', 'ghud__reload-label', label), bar);
      status.append(row);
      return fill;
    };
    status.append(hpBar, this.sailState);
    this.reloadL = mkReload('左舷 Q');
    this.reloadR = mkReload('右舷 E');
    this.reloadB = mkReload('艏炮 ␣');

    // ---- 玩家 debuff 图标（带剩余秒数；无 debuff 时占位空串） ----
    const debuffs = el('div', 'ghud__debuffs');
    this.debuffFire = el('span', 'ghud__debuff', '');
    this.debuffLeak = el('span', 'ghud__debuff', '');
    this.debuffSail = el('span', 'ghud__debuff', '');
    debuffs.append(this.debuffFire, this.debuffLeak, this.debuffSail);
    status.append(debuffs);

    // ---- 右上：战绩 ----
    const score = el('section', 'ghud ghud--score');
    score.setAttribute('aria-label', 'Score');
    this.killsEl = el('span', 'ghud__num', '0');
    this.waveEl = el('span', 'ghud__num', '1');
    this.lootEl = el('span', 'ghud__num', '0');
    score.append(
      el('span', 'ghud__label', '击沉 '),
      this.killsEl,
      el('span', 'ghud__sep', ' · '),
      el('span', 'ghud__label', '波次 '),
      this.waveEl,
      el('span', 'ghud__sep', ' · '),
      el('span', 'ghud__label', '战利品 '),
      this.lootEl,
    );

    // ---- Game Over 遮罩 ----
    this.overEl = el('div', 'ghud__over is-hidden');
    const overBox = el('div', 'ghud__over-box');
    this.overKills = el('div', 'ghud__over-line', '');
    overBox.append(el('div', 'ghud__over-title', '船 沉 了'), this.overKills, el('div', 'ghud__over-hint', '按 R 重开'));
    this.overEl.append(overBox);

    this.rootEl = el('div', 'ghud-root');
    this.rootEl.append(status, score, this.overEl);
    root.append(this.rootEl);

    // ---- 敌船血条池（受玩家攻击后头顶显示 5s，每帧投影更新） ----
    for (let i = 0; i < EHP_POOL_SIZE; i++) {
      const wrap = el('div', 'ghud__ehp');
      const bar = el('div', 'ghud__ehp-bar');
      const fill = el('div', 'ghud__ehp-fill');
      bar.append(fill);
      wrap.append(el('div', 'ghud__ehp-name', '敌船'), bar);
      wrap.style.display = 'none';
      this.rootEl.append(wrap);
      this.ehpPool.push({ el: wrap, fill });
    }
  }

  /** 上次写入的展示值缓存：没变就不碰 DOM（每帧 style/textContent 写入会强制重排）。 */
  private readonly shown = {
    hp: -1,
    sail: '',
    reloadL: -1,
    reloadR: -1,
    reloadB: -1,
    kills: -1,
    wave: -1,
    loot: -1,
    fire: '',
    leak: '',
    sailDebuff: '',
  };

  update(
    player: GameShip,
    sailAmount: number,
    cooldowns: { l: number; r: number; bow: number },
    reloadMax: { broadside: number; bow: number },
    primed: { l: boolean; r: boolean; bow: boolean },
    kills: number,
    wave: number,
    loot = 0,
  ): void {
    const c = this.shown;
    const hp = Math.round((player.hp / player.maxHp) * 1000) / 10;
    if (hp !== c.hp) {
      c.hp = hp;
      this.hpFill.style.width = `${hp}%`;
    }
    if (kills !== c.kills) {
      c.kills = kills;
      this.killsEl.textContent = String(kills);
    }
    if (wave !== c.wave) {
      c.wave = wave;
      this.waveEl.textContent = String(wave);
    }
    if (loot !== c.loot) {
      c.loot = loot;
      this.lootEl.textContent = String(loot);
    }
    const sailText =
      sailAmount < 0
        ? `帆位：倒车 ${Math.round(-sailAmount * 100)}%（W 复位）`
        : `帆位：${Math.round(sailAmount * 100)}%（按住 W/S 调整）`;
    if (sailText !== c.sail) {
      c.sail = sailText;
      this.sailState.textContent = sailText;
    }
    // 装填条只表示冷却进度（蓄力进度由画面里的弹道预览扇面表达）
    const rl = Math.round((1 - cooldowns.l / reloadMax.broadside) * 100);
    const rr = Math.round((1 - cooldowns.r / reloadMax.broadside) * 100);
    const rb = Math.round((1 - cooldowns.bow / reloadMax.bow) * 100);
    if (rl !== c.reloadL) {
      c.reloadL = rl;
      this.reloadL.style.width = `${rl}%`;
    }
    if (rr !== c.reloadR) {
      c.reloadR = rr;
      this.reloadR.style.width = `${rr}%`;
    }
    if (rb !== c.reloadB) {
      c.reloadB = rb;
      this.reloadB.style.width = `${rb}%`;
    }
    // 满装填：装填满后再等半格进入，条变亮白发光提示（开火后消失）
    this.reloadL.classList.toggle('ghud__fill--primed', primed.l);
    this.reloadR.classList.toggle('ghud__fill--primed', primed.r);
    this.reloadB.classList.toggle('ghud__fill--primed', primed.bow);
    // 玩家 debuff 图标（带剩余秒数）
    const fire = player.debuff.fire > 0 ? `🔥 ${Math.ceil(player.debuff.fire)}s` : '';
    const leak = player.debuff.leak > 0 ? `💧 ${Math.ceil(player.debuff.leak)}s` : '';
    const sailD = player.debuff.sail > 0 ? `⛵ ${Math.ceil(player.debuff.sail)}s` : '';
    if (fire !== c.fire) {
      c.fire = fire;
      this.debuffFire.textContent = fire;
    }
    if (leak !== c.leak) {
      c.leak = leak;
      this.debuffLeak.textContent = leak;
    }
    if (sailD !== c.sailDebuff) {
      c.sailDebuff = sailD;
      this.debuffSail.textContent = sailD;
    }
  }

  /** 屏幕下方中央的提示飘字（天气切换、拾取等）。 */
  floatText(msg: string): void {
    const node = el('div', 'ghud__float', msg);
    node.style.marginLeft = `${Math.round((Math.random() - 0.5) * 120)}px`; // 避免连续飘字叠在一起
    this.rootEl.append(node);
    setTimeout(() => node.remove(), 1500);
  }

  /** 世界坐标 → 屏幕位置飘字（敌船头顶伤害白字）；在镜头后方则退回中央飘字。 */
  floatTextAt(
    msg: string,
    worldPos: THREE.Vector3,
    camera: THREE.Camera,
    opts: { color?: string; size?: number } = {},
  ): void {
    const v = worldPos.clone();
    v.y += 4;
    v.project(camera);
    if (v.z > 1) {
      this.floatText(msg);
      return;
    }
    const node = el('div', 'ghud__float ghud__float--at', msg);
    node.style.left = `${(v.x * 0.5 + 0.5) * 100}%`;
    node.style.top = `${(-v.y * 0.5 + 0.5) * 100}%`;
    if (opts.color) node.style.color = opts.color;
    if (opts.size) node.style.fontSize = `${opts.size}px`;
    this.rootEl.append(node);
    setTimeout(() => node.remove(), 1500);
  }

  /** 敌船头顶血条：受击后 5s，池化 div 每帧投影。 */
  updateEnemyHpBars(dt: number, enemies: readonly GameShip[], camera: THREE.Camera): void {
    let slot = 0;
    for (const e of enemies) {
      if (e.hurtT > 0) {
        e.hurtT -= dt;
        if (e.sinking) e.hurtT = 0;
      }
      if (e.hurtT <= 0 || slot >= EHP_POOL_SIZE) continue;
      this.ehpVec.copy(e.position);
      this.ehpVec.y += 5 * (e.lengthScale || 1);
      this.ehpVec.project(camera);
      if (this.ehpVec.z > 1) continue; // 在镜头后方
      const s = this.ehpPool[slot++];
      s.el.style.display = 'block';
      s.el.style.left = `${(this.ehpVec.x * 0.5 + 0.5) * 100}%`;
      s.el.style.top = `${(-this.ehpVec.y * 0.5 + 0.5) * 100}%`;
      s.fill.style.width = `${(e.hp / e.maxHp) * 100}%`;
    }
    for (; slot < EHP_POOL_SIZE; slot++) this.ehpPool[slot].el.style.display = 'none';
  }

  showGameOver(kills: number, wave: number): void {
    this.overKills.textContent = `击沉 ${kills} 艘 · 撑到第 ${wave} 波`;
    this.overEl.classList.remove('is-hidden');
  }

  hideGameOver(): void {
    this.overEl.classList.add('is-hidden');
  }

  dispose(): void {
    this.rootEl.remove();
  }
}
