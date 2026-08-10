/**
 * 选船卡片网格：大航海时代2 全 25 船，中文名 + 英文名 + 血/速/舵/炮属性条。
 * 挂载在开始门（StartGate）里；选择即时写 localStorage（SHIP_STORAGE_KEY），
 * Game 启动时经 resolveShipId() 读回。
 *
 * 缩略图按 B2 约定从简：纯文字卡 + 属性条，不做模型实拍。
 * 属性条先按基准属性渲染，ships.json 到达后刷新为真实比例。
 */

import { assetUrl } from '../core/paths';
import {
  SHIP_DEFS,
  FALLBACK_STATS,
  loadShipStats,
  resolveShipId,
  storeShipId,
  type ShipStats,
} from './Shipyard';

/** 属性条归一化分母（旧 js/main.js 选船卡片同源）。 */
const STAT_MAX = { hp: 170, maxSpeed: 21, turnRate: 1.5, cannons: 6 } as const;
const STAT_LABELS: readonly [keyof ShipStats, string][] = [
  ['hp', '血'],
  ['maxSpeed', '速'],
  ['turnRate', '舵'],
  ['cannons', '炮'],
];

export function buildShipSelect(): HTMLElement {
  const section = document.createElement('div');
  section.className = 'shipselect';

  const label = document.createElement('div');
  label.className = 'boot__gate-label';
  label.textContent = 'Ship · 选择座舰';
  section.append(label);

  const grid = document.createElement('div');
  grid.className = 'shipselect__grid';
  grid.setAttribute('role', 'listbox');
  grid.setAttribute('aria-label', 'Ship selection');
  section.append(grid);

  let selected = resolveShipId();
  const barsByDef = new Map<number, Map<keyof ShipStats, HTMLElement>>();
  const cards: HTMLElement[] = [];

  for (const def of SHIP_DEFS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'shipselect__card';
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', String(def.id === selected));
    card.classList.toggle('is-selected', def.id === selected);
    card.dataset.ship = String(def.id);

    const name = document.createElement('span');
    name.className = 'shipselect__name';
    name.textContent = def.cn;
    const en = document.createElement('span');
    en.className = 'shipselect__en';
    en.textContent = def.en;
    card.append(name, en);

    const bars = new Map<keyof ShipStats, HTMLElement>();
    for (const [key, labelText] of STAT_LABELS) {
      const row = document.createElement('span');
      row.className = 'shipselect__stat';
      const lbl = document.createElement('span');
      lbl.className = 'shipselect__stat-label';
      lbl.textContent = labelText;
      const track = document.createElement('span');
      track.className = 'shipselect__stat-track';
      const fill = document.createElement('span');
      fill.className = 'shipselect__stat-fill';
      track.append(fill);
      row.append(lbl, track);
      card.append(row);
      bars.set(key, fill);
    }
    barsByDef.set(def.id, bars);

    card.addEventListener('click', () => {
      selected = def.id;
      storeShipId(def.id);
      for (const c of cards) {
        const active = c === card;
        c.classList.toggle('is-selected', active);
        c.setAttribute('aria-selected', String(active));
      }
    });
    cards.push(card);
    grid.append(card);
  }

  // 先用基准属性铺底，ships.json 到了再刷成真实比例
  const paint = (stats: Record<number, ShipStats>): void => {
    for (const def of SHIP_DEFS) {
      const s = stats[def.id] ?? FALLBACK_STATS;
      const bars = barsByDef.get(def.id);
      if (!bars) continue;
      for (const [key] of STAT_LABELS) {
        const ratio = Math.min(1, s[key] / STAT_MAX[key]);
        bars.get(key)!.style.width = `${Math.round(ratio * 100)}%`;
      }
    }
  };
  paint(Object.fromEntries(SHIP_DEFS.map((d) => [d.id, FALLBACK_STATS])));
  void loadShipStats(assetUrl('/data/ships.json')).then(paint);

  return section;
}
