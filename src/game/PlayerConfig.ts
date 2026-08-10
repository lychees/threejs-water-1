/**
 * 操控/战斗手感参数，集中一处。
 *
 * 数值照抄旧版（js/main.js），是 B1/B2 的手感基线。
 * 玩家属性（hp/极速/舵率/炮数）自 B2 起由 Shipyard 的 25 船表 +
 * ships.json 映射提供（见 Shipyard.ts 的 computeStats / loadShipStats）。
 */

/** 操控与火炮手感（旧 js/main.js 顶部常量区）。 */
export const FEEL = {
  ASTERN_MAX: 0.3, // 倒车最大帆量幅度（负帆量）
  SAIL_RATE: 1 / 2.5, // 帆量每秒变化（0 → 满帆约 2.5s）
  ASTERN_HOLD: 0.4, // 帆量降到 0 后 S 继续按住进入倒车的延迟
  CHARGE_TIME: 1.2, // 火炮蓄力满所需秒数
  BOW_RELOAD: 2.0, // 艏炮独立冷却
  BOW_SPEED: 45, // 艏炮初速（比舷炮略高，弹道平直）
  BROADSIDE_SPEED: 40, // 舷炮初速基准（满蓄力 ×1.5 = 60）
  RELOAD_TIME: 3.2, // 舷炮装填
  RUDDER_CURVE: 1.5, // 舵效 ∝ (航速/极速)^RUDDER_CURVE（舵是翼面）
  RUDDER_MIN_EFF: 0.05, // 静止时的残存舵效
} as const;
