/**
 * 选船卡片网格：大航海时代2 全 25 船，3D 缩略图 + 中文名 + 英文名 + 属性条。
 * 挂载在开始门（StartGate）里；选择即时写 localStorage（SHIP_STORAGE_KEY），
 * Game 启动时经 resolveShipId() 读回。
 *
 * 缩略图（ShipThumbs.ts，共享离屏渲染器）：逐艘排队渲染，每帧一艘，卡片先
 * 占位后填图，不卡开始门；勾选「精致模型」后重渲有真实模型的 6 张，改染色
 * 重渲当前选中那张；任何一张渲染失败就留着文字占位，不影响开门。
 */

import { assetUrl } from '../core/paths';
import type * as THREE from 'three/webgpu';
import {
  SHIP_DEFS,
  FALLBACK_STATS,
  FIGUREHEADS,
  buildShip,
  loadShipStats,
  resolveShipId,
  storeShipId,
  resolveCustomization,
  storeCustomizationKey,
  type ShipDef,
  type ShipCustomization,
  type ShipStats,
} from './Shipyard';
import { loadShipModelDirect, instantiateShip } from './ModelShips';
import { renderShipThumbnail } from './ShipThumbs';

/** 属性条归一化分母（旧 js/main.js 选船卡片同源）。 */
const STAT_MAX = { hp: 170, maxSpeed: 21, turnRate: 1.5, cannons: 6 } as const;
const STAT_LABELS: readonly [keyof ShipStats, string][] = [
  ['hp', '血'],
  ['maxSpeed', '速'],
  ['turnRate', '舵'],
  ['cannons', '炮'],
];

/** 缩略图用的定制状态快照（模块级，随输入事件更新）。 */
let thumbCustom: ShipCustomization = { fancy: false, sailColor: null, hullColor: null, figurehead: 'none' };

/** 生成一艘船的缩略图模型（一次性副本，渲染完由 renderShipThumbnail 释放几何体）。 */
async function buildThumbModel(def: ShipDef): Promise<THREE.Group | null> {
  const sailColor = thumbCustom.sailColor ? Number.parseInt(thumbCustom.sailColor.slice(1), 16) : null;
  const hullColor = thumbCustom.hullColor ? Number.parseInt(thumbCustom.hullColor.slice(1), 16) : null;
  if (thumbCustom.fancy && def.model) {
    const template = await loadShipModelDirect(def.model);
    if (template) {
      const tint = sailColor !== null || hullColor !== null ? { sail: sailColor ?? undefined, hull: hullColor ?? undefined } : null;
      const inst = instantiateShip(template, tint);
      inst.setSailAmount?.(1);
      return inst.group;
    }
    // 模型加载失败落回程序化预览
  }
  const visual = buildShip(def.spec, { sailColor, hullColor });
  visual.setSailAmount(1);
  return visual.group;
}

export function buildShipSelect(): HTMLElement {
  thumbCustom = resolveCustomization();

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
  const thumbByDef = new Map<number, HTMLElement>();
  const cardByDef = new Map<number, HTMLElement>();
  const priceByDef = new Map<number, HTMLElement>();
  const cards: HTMLElement[] = [];

  for (const def of SHIP_DEFS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'shipselect__card';
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', String(def.id === selected));
    card.classList.toggle('is-selected', def.id === selected);
    card.dataset.ship = String(def.id);

    // 缩略图占位（渲染完成后替换成 img；失败则留文字）
    const thumb = document.createElement('span');
    thumb.className = 'shipselect__thumb';
    thumb.textContent = def.cn;
    thumbByDef.set(def.id, thumb);
    card.append(thumb);

    const name = document.createElement('span');
    name.className = 'shipselect__name';
    name.textContent = def.cn;
    const en = document.createElement('span');
    en.className = 'shipselect__en';
    en.textContent = def.en;
    const price = document.createElement('span');
    price.className = 'shipselect__price';
    priceByDef.set(def.id, price);
    card.append(name, en, price);
    cardByDef.set(def.id, card);

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

  // 先用基准属性铺底，ships.json 到了再刷成真实比例并按价格重排
  const paint = (stats: Record<number, ShipStats>): void => {
    for (const def of SHIP_DEFS) {
      const s = stats[def.id] ?? FALLBACK_STATS;
      const bars = barsByDef.get(def.id);
      if (!bars) continue;
      for (const [key] of STAT_LABELS) {
        const ratio = Math.min(1, s[key] / STAT_MAX[key]);
        bars.get(key)!.style.width = `${Math.round(ratio * 100)}%`;
      }
      const priceEl = priceByDef.get(def.id);
      if (priceEl) priceEl.textContent = s.price ? `💰 ${s.price.toLocaleString()}` : '';
    }
    // 按价格升序重排卡片（append 已有节点 = 移动，选中态跟随 DOM 不受影响）
    const sorted = [...SHIP_DEFS].sort(
      (a, b) => (stats[a.id]?.price ?? 0) - (stats[b.id]?.price ?? 0),
    );
    for (const def of sorted) {
      const card = cardByDef.get(def.id);
      if (card) grid.append(card);
    }
  };
  paint(Object.fromEntries(SHIP_DEFS.map((d) => [d.id, FALLBACK_STATS])));
  void loadShipStats(assetUrl('/data/ships.json')).then(paint);

  // ---- 缩略图队列：每帧一艘，渲染 token 防止重渲请求互相覆盖 ----
  let thumbToken = 0;
  const renderThumb = async (def: ShipDef): Promise<void> => {
    const token = thumbToken;
    const model = await buildThumbModel(def);
    if (!model || token !== thumbToken) return;
    const url = await renderShipThumbnail(model);
    if (!url || token !== thumbToken) return;
    const holder = thumbByDef.get(def.id);
    if (!holder) return;
    const img = document.createElement('img');
    img.src = url;
    img.alt = def.cn;
    img.className = 'shipselect__thumb-img';
    holder.replaceChildren(img);
  };
  const queueThumbs = (defs: ShipDef[]): void => {
    const token = ++thumbToken;
    let i = 0;
    const step = async (): Promise<void> => {
      while (i < defs.length && token === thumbToken) {
        const def = defs[i++];
        // 不在这里查 isConnected：buildShipSelect 是在 replaceChildren 的参数
        // 位置被调用的，首轮迭代时网格还没进 DOM；门关闭由 token/写入检查兜住。
        await renderThumb(def); // 每艘一帧渲染，串行即节流
        await new Promise((r) => requestAnimationFrame(r));
      }
    };
    void step();
  };
  queueThumbs(SHIP_DEFS);

  section.append(
    buildCustomizeRow({
      onFancyChange: () => {
        // 只重渲有真实模型的几张；未勾选回到程序化预览
        queueThumbs(SHIP_DEFS.filter((d) => d.model));
      },
      onTintChange: () => {
        const def = SHIP_DEFS.find((d) => d.id === selected);
        if (def) queueThumbs([def]);
      },
    }),
  );
  return section;
}

/** 定制行：精致模型勾选 + 帆色/船体色 + 船首像。写入 localStorage，Game 启动时读。 */
function buildCustomizeRow(hooks: {
  onFancyChange: () => void;
  onTintChange: () => void;
}): HTMLElement {
  const custom = thumbCustom;
  const row = document.createElement('div');
  row.className = 'shipselect__custom';

  // 精致模型勾选（默认关：模型按需加载，老机器省 40MB 下载与显存）
  const fancyLabel = document.createElement('label');
  fancyLabel.className = 'shipselect__fancy';
  const fancyChk = document.createElement('input');
  fancyChk.type = 'checkbox';
  fancyChk.checked = custom.fancy;
  fancyChk.addEventListener('change', () => {
    storeCustomizationKey('fancy', fancyChk.checked ? '1' : '0');
    thumbCustom = { ...thumbCustom, fancy: fancyChk.checked };
    hooks.onFancyChange();
  });
  fancyLabel.append(fancyChk, document.createTextNode('精致模型（6 艘可用）'));

  const mkColor = (labelText: string, key: 'sailColor' | 'hullColor', initial: string): HTMLElement => {
    const label = document.createElement('label');
    label.className = 'shipselect__color';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = initial;
    input.addEventListener('input', () => {
      storeCustomizationKey(key, input.value);
      thumbCustom = { ...thumbCustom, [key]: input.value };
      hooks.onTintChange();
    });
    label.append(document.createTextNode(labelText), input);
    return label;
  };

  const fhLabel = document.createElement('label');
  fhLabel.className = 'shipselect__fh';
  const fhSelect = document.createElement('select');
  for (const f of FIGUREHEADS) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.cn;
    fhSelect.append(opt);
  }
  fhSelect.value = custom.figurehead;
  fhSelect.addEventListener('change', () => {
    storeCustomizationKey('figurehead', fhSelect.value);
    thumbCustom = { ...thumbCustom, figurehead: fhSelect.value as ShipCustomization['figurehead'] };
  });
  fhLabel.append(document.createTextNode('船首像 '), fhSelect);

  row.append(
    fancyLabel,
    mkColor('帆色', 'sailColor', custom.sailColor ?? '#f3ead5'),
    mkColor('船体色', 'hullColor', custom.hullColor ?? '#7a4f2a'),
    fhLabel,
  );
  return row;
}
