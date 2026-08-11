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
  BOW_RELOAD: 1.6, // 艏炮独立冷却
  BOW_SPEED: 62, // 艏炮初速（比舷炮略高，弹道平直）
  BROADSIDE_SPEED: 56, // 舷炮初速基准（满蓄力 ×1.5 = 84）
  RELOAD_TIME: 2.4, // 舷炮装填
  PRIME_TIME: 1.2, // 装填满后再等 1.2s（半格）进入满装填
  PRIME_SPEED_MUL: 1.2, // 满装填：初速/射程加成
  PRIME_DAMAGE_MUL: 1.4, // 满装填：伤害加成
  RUDDER_CURVE: 1.5, // 舵效 ∝ (航速/极速)^RUDDER_CURVE（舵是翼面）
  RUDDER_MIN_EFF: 0.05, // 静止时的残存舵效
} as const;
