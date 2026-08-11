/**
 * 风与洋流环境模型。
 *
 * 风速不另搞一套：来源 = 基座 Panel 滑杆 / preset 的 state.windSpeed（回调注入）。
 * 风向 = preset.sea.windDirection（下风方向，与 meadow.setWind 的 (cos,sin) 矢量
 * 同一约定）+ 缓慢漂移偏移：每 60~180s 偏转 10~30°，~15s 平滑过渡。
 *
 * 洋流：全局矢量，方向/强度极慢漂移——每 5~10 分钟重选目标（角度 ±25° 内游走、
 * 强度 0.4~1.2 m/s），~60s 过渡。所有船 + 漂浮补给每帧叠加 current×dt。
 */

/** 顺风/顶风极速倍率（侧风 = 1）。 */
export const WIND_DOWNWIND_MUL = 1.12;
export const WIND_UPWIND_MUL = 0.78;

export class WindCurrent {
  /** 风向漂移状态（偏移量叠加在 preset 风向上，弧度）。 */
  private driftCur = 0;
  private driftFrom = 0;
  private driftTo = 0;
  private driftT = 0;
  private driftDur = 15;
  private nextWindShift = 20 + Math.random() * 40; // 首次提前，尽早看到变化

  /** 洋流状态。 */
  private curAngle = Math.random() * Math.PI * 2;
  private curFrom = 0;
  private curTo = 0;
  private curT = 0;
  private curDur = 60;
  private curSpeed = 0.8;
  private curSpeedFrom = 0.8;
  private curSpeedTo = 0.8;
  private nextCurShift = 300 + Math.random() * 300;

  constructor(
    /** preset 风向（下风方位角，弧度；(cos,sin) 为下风单位矢量）。 */
    private readonly windDirBase: () => number,
    /** 基座风速 m/s（Panel/Preset）。 */
    private readonly windSpeedFn: () => number,
  ) {
    this.curFrom = this.curTo = this.curAngle;
  }

  update(dt: number): void {
    // ---- 风向漂移：60~180s 一拍，±10~30° 随机游走（总偏移钳 ±50°） ----
    this.driftT += dt;
    if (this.driftT >= this.driftDur) {
      this.nextWindShift -= dt;
      if (this.nextWindShift <= 0) {
        this.nextWindShift = 60 + Math.random() * 120;
        this.driftFrom = this.driftTo;
        const step = (10 + Math.random() * 20) * (Math.PI / 180) * (Math.random() < 0.5 ? -1 : 1);
        this.driftTo = Math.max(-0.9, Math.min(0.9, this.driftTo + step)); // ±50° 内
        this.driftT = 0;
      }
    }
    const wt = Math.min(1, this.driftT / this.driftDur);
    this.driftCur = this.driftFrom + (this.driftTo - this.driftFrom) * (wt * wt * (3 - 2 * wt)); // smoothstep

    // ---- 洋流漂移：300~600s 一拍，角度 ±25°、强度 0.4~1.2，60s 过渡 ----
    this.curT += dt;
    if (this.curT >= this.curDur) {
      this.nextCurShift -= dt;
      if (this.nextCurShift <= 0) {
        this.nextCurShift = 300 + Math.random() * 300;
        this.curFrom = this.curTo;
        this.curTo += (Math.random() - 0.5) * 2 * 25 * (Math.PI / 180);
        this.curSpeedFrom = this.curSpeedTo;
        this.curSpeedTo = 0.4 + Math.random() * 0.8;
        this.curT = 0;
      }
    }
    const ct = Math.min(1, this.curT / this.curDur);
    const ce = ct * ct * (3 - 2 * ct);
    this.curAngle = this.curFrom + (this.curTo - this.curFrom) * ce;
    this.curSpeed = this.curSpeedFrom + (this.curSpeedTo - this.curSpeedFrom) * ce;
  }

  /** 当前风向（下风方位角，弧度）。 */
  get windDirection(): number {
    return this.windDirBase() + this.driftCur;
  }

  get windSpeed(): number {
    return this.windSpeedFn();
  }

  /**
   * 风对帆的极速倍率：船向与下风矢量夹角的余弦连续插值——
   * 顺风（风从船尾来，c=1）×1.12、侧风 ×1.0、顶风（c=-1）×0.78。
   */
  windMulFor(heading: number): number {
    const w = this.windDirection;
    const c = Math.sin(heading) * Math.cos(w) + Math.cos(heading) * Math.sin(w);
    return c >= 0 ? 1 + (WIND_DOWNWIND_MUL - 1) * c : 1 + (1 - WIND_UPWIND_MUL) * c;
  }

  /** 洋流矢量（世界 x/z 分量，m/s）。 */
  get currentX(): number {
    return Math.cos(this.curAngle) * this.curSpeed;
  }

  get currentZ(): number {
    return Math.sin(this.curAngle) * this.curSpeed;
  }

  /** 洋流方位角（显示用）。 */
  get currentAngle(): number {
    return this.curAngle;
  }

  get currentSpeedVal(): number {
    return this.curSpeed;
  }
}
