/**
 * 小地图：2D canvas 圆形海图，直译自旧 js/main.js 的 drawMinimap。
 * 玩家中心白三角（指示船头）、敌船红点（超程钳到边缘）、补给木/金点、
 * 岛屿绿块、固定指北针；点击切换大小，~15fps 节流由调用方控制。
 *
 * 岛屿数据用基座场景的唯一大岛（scene/Seafloor 的 ISLAND：圆心在 1.4km 外，
 * 半径 500m，只有远程图才扫得到它）。
 */

import { ISLAND } from '../scene/Seafloor';
import type { GameShip } from './GameShip';
import type { Supplies } from './Supplies';

export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private large = false;
  /** 自定义海域的掩码图与换算参数（null = 默认海域，画基座岛屿圆点）。 */
  private terrain: {
    image: HTMLCanvasElement;
    cx: number;
    cz: number;
    sizeX: number;
    sizeZ: number;
  } | null = null;

  /** 自定义海域轮廓图（陆绿海蓝掩码），Game 在地形加载后调用一次。 */
  setTerrain(image: HTMLCanvasElement, cx: number, cz: number, sizeX: number, sizeZ: number): void {
    this.terrain = { image, cx, cz, sizeX, sizeZ };
  }

  constructor(root: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ghud__minimap';
    this.canvas.width = 340; // 后备分辨率，CSS 缩放显示
    this.canvas.height = 340;
    this.canvas.setAttribute('aria-label', 'Chart');
    this.canvas.title = '海图（点击放大）';
    this.canvas.addEventListener('click', () => {
      this.large = !this.large;
      this.canvas.classList.toggle('is-large', this.large);
    });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Minimap: 2D context unavailable');
    this.ctx = ctx;
    root.append(this.canvas);
  }

  draw(player: GameShip, enemies: readonly GameShip[], supplies: Supplies | null): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const cx = W / 2;
    const range = this.large ? 600 : 400; // 海图半径（米）
    const s = (cx - 8) / range;
    const px = player.position.x;
    const pz = player.position.z;
    const rim = cx - 10;

    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cx, cx - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(6, 30, 44, 0.72)';
    ctx.fillRect(0, 0, W, W);

    // 世界 -Z 为北（屏幕上）：世界位移 → 屏幕位移直接映射
    const toMapX = (wx: number): number => cx + (wx - px) * s;
    const toMapY = (wz: number): number => cx + (wz - pz) * s;
    const dot = (x: number, y: number, r: number, color: string): void => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };

    // 岛屿/海岸：自定义海域画掩码图（真实海岸轮廓），默认海域画基座大岛绿点
    if (this.terrain) {
      const t = this.terrain;
      const gw = t.image.width; // GRID
      // 世界范围 → 掩码图源矩形（像素）
      const sx = ((px - range - (t.cx - t.sizeX / 2)) / t.sizeX) * gw;
      const sz = ((pz - range - (t.cz - t.sizeZ / 2)) / t.sizeZ) * gw;
      const sw = ((range * 2) / t.sizeX) * gw;
      const sh = ((range * 2) / t.sizeZ) * gw;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cx, cx - 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(t.image, sx, sz, sw, sh, 4, 4, W - 8, W - 8);
      ctx.restore();
    } else {
      const ir = ISLAND.radius * s;
      if (ir >= 3) dot(toMapX(ISLAND.x), toMapY(ISLAND.z), ir, '#3f7a4f');
    }

    // 补给：修复=木色，宝箱=金色
    if (supplies) {
      for (const item of supplies.items) {
        if (!item.active) continue;
        dot(
          toMapX(item.object.position.x),
          toMapY(item.object.position.z),
          3.5,
          item.kind === 'loot' ? '#ffd76e' : '#b5854a',
        );
      }
    }

    // 敌船：按 archetype 着色；超出范围的钳到边缘指示方向
    for (const e of enemies) {
      if (e.sinking) continue;
      let dx = (e.position.x - px) * s;
      let dy = (e.position.z - pz) * s;
      const d = Math.hypot(dx, dy);
      if (d > rim) {
        dx *= rim / d;
        dy *= rim / d;
      }
      dot(cx + dx, cx + dy, 4.5, e.mapColor);
    }

    // 玩家：中心白色三角，指示船头朝向
    ctx.save();
    ctx.translate(cx, cx);
    ctx.rotate(Math.PI - player.heading); // 船头 forward=(sinθ,cosθ) → 屏幕 (sinθ,cosθ)
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.5, 6);
    ctx.lineTo(-5.5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 指北针（固定世界北 = -Z = 屏幕上方，与相机无关）
    ctx.fillStyle = '#e8a33d';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, 20);
    ctx.restore();
  }

  dispose(): void {
    this.canvas.remove();
  }
}
