/**
 * 航海罗盘条：屏幕顶部一条滚动刻度带，中央固定指针 = 当前船头航向。
 *
 * 刻度带随船向滚动：N/E/S/W 主方位 + 30° 度数 + 5° 细刻度；上叠方位标记
 * （敌船按 archetype 颜色三角、补给金点、陆地方向绿标），超界钳到边缘成箭头。
 *
 * 方位约定：世界 -Z 为北、+X 为东（与小地图一致）。bearing = atan2(dx, -dz)。
 * 隔帧绘制由调用方节流（Game 每 2 帧一次）。
 */

export interface CompassMark {
  /** 绝对方位角（弧度，atan2(dx, -dz) 约定）。 */
  bearing: number;
  color: string;
  kind: 'tri' | 'dot' | 'sq';
}

/** 可视半宽（度数）：中央 ±70°。 */
const HALF_SPAN_DEG = 70;
const CARDINALS: readonly [number, string][] = [
  [0, 'N'],
  [45, 'NE'],
  [90, 'E'],
  [135, 'SE'],
  [180, 'S'],
  [225, 'SW'],
  [270, 'W'],
  [315, 'NW'],
];

const wrap180 = (deg: number): number => {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
};

export class Compass {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(root: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ghud__compass';
    this.canvas.width = 480; // 后备分辨率，CSS 缩放显示
    this.canvas.height = 44;
    this.canvas.setAttribute('aria-label', 'Compass');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Compass: 2D context unavailable');
    this.ctx = ctx;
    root.append(this.canvas);
  }

  /**
   * @param headingRad 船头航向（GameShip.heading，旧版 (sin,cos) 约定）
   * @param marks     本帧的方位标记
   */
  draw(headingRad: number, marks: readonly CompassMark[]): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    // 船头罗盘读数：forward=(sinθ,cosθ)，北=-Z → heading = atan2(sinθ, -cosθ)
    const headingDeg = (180 - (headingRad * 180) / Math.PI + 360) % 360;
    const pxPerDeg = W / (HALF_SPAN_DEG * 2);
    const toX = (deg: number): number => W / 2 + deg * pxPerDeg;

    ctx.clearRect(0, 0, W, H);
    // 半透明暗底（中央略深，视觉聚焦）
    ctx.fillStyle = 'rgba(10, 8, 6, 0.55)';
    ctx.fillRect(0, 0, W, H);

    // ---- 刻度带 ----
    ctx.textAlign = 'center';
    const firstTick = Math.floor((headingDeg - HALF_SPAN_DEG) / 5) * 5;
    for (let d = firstTick; d <= headingDeg + HALF_SPAN_DEG; d += 5) {
      const deg360 = (d + 360) % 360;
      const x = toX(wrap180(d - headingDeg));
      if (x < 2 || x > W - 2) continue;
      const isCardinal = deg360 % 45 === 0;
      const isLabeled = deg360 % 30 === 0;
      ctx.strokeStyle = isCardinal ? '#e9dfcb' : 'rgba(233, 223, 203, 0.5)';
      ctx.lineWidth = isCardinal ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, H - 6);
      ctx.lineTo(x, H - (isCardinal ? 22 : isLabeled ? 16 : 10));
      ctx.stroke();
      if (isCardinal) {
        const name = CARDINALS.find(([a]) => a === deg360)?.[1] ?? '';
        ctx.fillStyle = deg360 === 0 ? '#e8503a' : '#e9dfcb'; // 北用主题红
        ctx.font = 'bold 13px Georgia, serif';
        ctx.fillText(name, x, 14);
      } else if (isLabeled) {
        ctx.fillStyle = 'rgba(233, 223, 203, 0.65)';
        ctx.font = '10px Georgia, serif';
        ctx.fillText(String(deg360), x, 14);
      }
    }

    // ---- 方位标记（刻度带上方一排） ----
    for (const m of marks) {
      const delta = wrap180((m.bearing * 180) / Math.PI - headingDeg);
      const clamped = Math.max(-HALF_SPAN_DEG + 4, Math.min(HALF_SPAN_DEG - 4, delta));
      const x = toX(clamped);
      const y = 24;
      ctx.fillStyle = m.color;
      if (m.kind === 'tri') {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 4, y + 7);
        ctx.lineTo(x + 4, y + 7);
        ctx.closePath();
        ctx.fill();
      } else if (m.kind === 'dot') {
        ctx.beginPath();
        ctx.arc(x, y + 4, 3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(x - 3, y + 1, 6, 6);
      }
      // 超界指示小箭头
      if (delta !== clamped) {
        ctx.beginPath();
        const dir = delta > 0 ? 1 : -1;
        ctx.moveTo(x + dir * 7, y + 1);
        ctx.lineTo(x + dir * 2, y + 4);
        ctx.lineTo(x + dir * 7, y + 7);
        ctx.closePath();
        ctx.fill();
      }
    }

    // ---- 中央固定指针 ----
    ctx.fillStyle = '#e8503a';
    ctx.beginPath();
    ctx.moveTo(W / 2, 30);
    ctx.lineTo(W / 2 - 5, H - 2);
    ctx.lineTo(W / 2 + 5, H - 2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(232, 80, 58, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W / 2, 2);
    ctx.lineTo(W / 2, 30);
    ctx.stroke();
  }

  dispose(): void {
    this.canvas.remove();
  }
}
