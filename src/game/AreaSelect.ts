/**
 * 自定义海域选区：Leaflet 地图弹层，拖拽框选矩形（经纬度 bbox）。
 *
 * 瓦片用 OSM 标准瓦片（带署名）。框选交互：进入弹层即框选模式（地图拖拽
 * 关闭），mousedown 起点、拖动出矩形、mouseup 完成；确认写入 localStorage，
 * 「用回迷雾岛」清除。bbox 边长限制 ~0.2°（约 20km，Overpass 查询与高度场
 * 分辨率共同的甜区）。
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { storeBBox } from './terrain/Terrain';
import type { BBox } from './terrain/overpass';

const MAX_SPAN = 0.2;

export interface AreaSelectResult {
  /** 用户确认了新选区（null = 恢复默认迷雾岛）；取消 = undefined。 */
  bbox: BBox | null | undefined;
}

export function openAreaSelect(): Promise<AreaSelectResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'areaselect';
    overlay.innerHTML = `
      <div class="areaselect__box">
        <div class="areaselect__title">框选一片海域（有岛有海最好打）</div>
        <div class="areaselect__map" id="areaselect-map"></div>
        <div class="areaselect__status">拖动框选；边长不能超过约 20km</div>
        <div class="areaselect__actions">
          <button type="button" class="btn areaselect__use" disabled>用这片海域</button>
          <button type="button" class="btn areaselect__default">用回迷雾岛</button>
          <button type="button" class="btn areaselect__cancel">取消</button>
        </div>
        <div class="areaselect__credit">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors</div>
      </div>`;
    document.body.append(overlay);

    let settled = false;
    const done = (bbox: BBox | null | undefined): void => {
      if (settled) return;
      settled = true;
      map.remove();
      overlay.remove();
      resolve({ bbox });
    };

    const map = L.map('areaselect-map', {
      center: [22.28, 114.16], // 默认视野：香港海域（岛多）
      zoom: 11,
      dragging: false, // 框选模式：拖拽留给矩形；平移用滚轮+双击缩放外的手段（下方说明）
      scrollWheelZoom: true,
      doubleClickZoom: true,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);

    const statusEl = overlay.querySelector<HTMLElement>('.areaselect__status')!;
    const useBtn = overlay.querySelector<HTMLButtonElement>('.areaselect__use')!;
    let rect: L.Rectangle | null = null;
    let current: BBox | null = null;
    let startLatLng: L.LatLng | null = null;

    const mapEl = overlay.querySelector<HTMLElement>('#areaselect-map')!;
    mapEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      startLatLng = map.mouseEventToLatLng(e as MouseEvent);
      e.preventDefault();
    });
    mapEl.addEventListener('mousemove', (e) => {
      if (!startLatLng) return;
      const now = map.mouseEventToLatLng(e as MouseEvent);
      const bounds = L.latLngBounds(startLatLng, now);
      if (!rect) {
        rect = L.rectangle(bounds, { color: '#e8503a', weight: 2, fillOpacity: 0.08 }).addTo(map);
      } else {
        rect.setBounds(bounds);
      }
      const s = bounds.getSouth();
      const w = bounds.getWest();
      const n = bounds.getNorth();
      const ee = bounds.getEast();
      const tooBig = n - s > MAX_SPAN || ee - w > MAX_SPAN;
      current = tooBig ? null : { s, w, n, e: ee };
      useBtn.disabled = current === null;
      statusEl.textContent = tooBig
        ? '太大了——边长不能超过约 20km'
        : `${((n - s) * 111).toFixed(1)} × ${((ee - w) * 111 * Math.cos(((s + n) / 2) * Math.PI / 180)).toFixed(1)} km`;
    });
    const finish = (): void => {
      startLatLng = null;
    };
    mapEl.addEventListener('mouseup', finish);
    mapEl.addEventListener('mouseleave', finish);

    useBtn.addEventListener('click', () => {
      if (!current) return;
      storeBBox(current);
      done(current);
    });
    overlay.querySelector('.areaselect__default')!.addEventListener('click', () => {
      storeBBox(null);
      done(null);
    });
    overlay.querySelector('.areaselect__cancel')!.addEventListener('click', () => done(undefined));
  });
}
