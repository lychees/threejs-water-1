// 船：程序化低多边形帆船模型 + 浮力 + 运动/沉船状态
import * as THREE from 'three';

const WORLD_LIMIT = 760; // 活动范围半径（远岛在 ~700m），超出会被挡回

// 命中 debuff 数值表（独立判定，重复触发刷新时间，沉船时清除）
export const DEBUFF_DEFS = {
  fire: { chance: 0.15, duration: 8, dps: 2, label: '着火' },                       // 持续掉血
  leak: { chance: 0.15, duration: 20, speedMul: 0.7, damageTakenMul: 1.25, label: '漏水' }, // 减速+易伤
  sail: { chance: 0.2, duration: 15, maxSail: 0.5, speedMul: 0.6, label: '破帆' },  // 帆量上限+减速
};

// 构建一艘帆船（前进方向为本地 +z），返回 Group；也是真实模型加载失败时的回退外观
export function buildShipModel({ hullColor, sailColor }) {
  const group = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: hullColor, flatShading: true, roughness: 0.9 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0xc9a86a, flatShading: true, roughness: 0.95 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, flatShading: true, roughness: 0.8 });

  // ---- 船体：侧面轮廓沿宽度挤出 ----
  const shape = new THREE.Shape();
  shape.moveTo(4.4, 1.1);                                  // 船头水线上
  shape.lineTo(3.4, -0.8);                                 // 船头底
  shape.quadraticCurveTo(0, -1.4, -3.6, -0.7);             // 船底弧线
  shape.lineTo(-4.2, 1.5);                                 // 船尾（略高）
  shape.lineTo(4.4, 1.1);                                  // 甲板线闭合
  const hullGeo = new THREE.ExtrudeGeometry(shape, {
    depth: 2.2,
    bevelEnabled: true,
    bevelThickness: 0.25,
    bevelSize: 0.25,
    bevelSegments: 1,
  });
  hullGeo.translate(0, 0, -1.1);       // 宽度居中
  hullGeo.rotateY(-Math.PI / 2);       // 长度转到 z 轴，船头朝 +z
  group.add(new THREE.Mesh(hullGeo, woodMat));

  // ---- 甲板 ----
  const deck = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.12, 7.4), deckMat);
  deck.position.set(0, 1.05, -0.1);
  group.add(deck);

  // ---- 舷侧火炮（装饰） ----
  const cannonGeo = new THREE.CylinderGeometry(0.09, 0.12, 0.9, 6);
  for (let i = -1; i <= 1; i++) {
    for (const side of [-1, 1]) {
      const c = new THREE.Mesh(cannonGeo, darkMat);
      c.rotation.z = Math.PI / 2;
      c.position.set(side * 1.15, 0.75, i * 2.0);
      group.add(c);
    }
  }

  // ---- 主桅 + 帆桁 ----
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 7.2, 7), woodMat);
  mast.position.set(0, 4.5, 0.6);
  group.add(mast);
  const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 4.4, 6), woodMat);
  yard.rotation.z = Math.PI / 2;
  yard.position.set(0, 7.7, 0.6);
  group.add(yard);

  // ---- 主帆：平面网格，顶点弯曲模拟鼓风 ----
  const SAIL_W = 3.9;
  const SAIL_H = 4.6;
  const sailGeo = new THREE.PlaneGeometry(SAIL_W, SAIL_H, 10, 8);
  sailGeo.translate(0, -SAIL_H / 2, 0); // 顶边对齐帆桁
  const sailBase = sailGeo.attributes.position.array.slice(); // 备份静止顶点
  const sail = new THREE.Mesh(
    sailGeo,
    new THREE.MeshStandardMaterial({ color: sailColor, side: THREE.DoubleSide, roughness: 0.9 })
  );
  sail.position.set(0, 7.65, 0.55);
  group.add(sail);

  // ---- 船尾小旗 ----
  const flagGeo = new THREE.PlaneGeometry(0.9, 0.5);
  flagGeo.translate(0.45, 0, 0);
  const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: sailColor, side: THREE.DoubleSide }));
  flag.position.set(0, 8.2, 0.6);
  group.add(flag);

  // 鼓帆：amount 0(收帆) ~ 1(满帆)
  function setSailAmount(amount) {
    const pos = sailGeo.attributes.position;
    const bulge = amount * 0.85;
    for (let i = 0; i < pos.count; i++) {
      const bx = sailBase[i * 3];
      const by = sailBase[i * 3 + 1];
      const u = bx / SAIL_W + 0.5;
      const v = (by + SAIL_H) / SAIL_H;
      pos.setZ(i, bulge * Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.15 + v * 0.85)));
    }
    pos.needsUpdate = true;
    sailGeo.computeVertexNormals();
    // 收帆时帆面同时缩短，视觉上像卷起来
    sail.scale.y = 0.2 + 0.8 * amount;
  }
  setSailAmount(1);

  return { group, setSailAmount };
}

export class Ship {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts hullColor/sailColor/hp/maxSpeed/turnRate
   */
  constructor(scene, opts = {}) {
    const {
      hullColor = 0x7a4f2a,
      sailColor = 0xf3ead5,
      hp = 100,
      maxSpeed = 15,
      turnRate = 1.0,
      cannons = 3,        // 每侧舷炮数量
      lengthScale = 1,    // 相对基准船长（9m）的倍数，影响浮力采样与命中半径
    } = opts;

    // group 是纯变换节点（浮力/朝向都作用在它上面），外观作为子节点可整体替换
    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';
    scene.add(this.group);
    this._visual = null;
    this.setSailAmount = () => {}; // 默认空操作，由具体外观提供

    // 默认外观：程序化低模帆船（真实模型加载失败时的回退）
    const model = buildShipModel({ hullColor, sailColor });
    this.setVisual(model.group, model.setSailAmount);

    this.scene = scene;
    this.maxHp = hp;
    this.hp = hp;
    this.maxSpeed = maxSpeed;
    this.turnRate = turnRate;
    this.cannons = cannons;
    this.lengthScale = lengthScale;
    this.hitRadius = 3.4 * lengthScale; // 与 combat.js 的基准命中半径一致

    this.heading = 0;   // 朝向角：forward = (sin, 0, cos)
    this.speed = 0;
    this.pitch = 0;     // 浮力俯仰（平滑后）
    this.roll = 0;      // 浮力横摇（平滑后）
    this.baseY = 0.25;  // 吃水线偏移

    this.sinking = false;
    this.sinkT = 0;
    this.sinkDir = 1;
    this.dead = false;  // 沉船动画播完，可移除

    this.debuff = { fire: 0, leak: 0, sail: 0 }; // 各 debuff 剩余秒数
    this.hurtT = 0;     // 被玩家攻击后血条显示剩余秒数（main 驱动）
  }

  // 速度乘区（漏水 ×0.7、破帆 ×0.6，乘法叠加）
  get speedMul() {
    let m = 1;
    if (this.debuff.leak > 0) m *= DEBUFF_DEFS.leak.speedMul;
    if (this.debuff.sail > 0) m *= DEBUFF_DEFS.sail.speedMul;
    return m;
  }

  // 帆量上限（破帆时压到 50%）
  get sailCap() {
    return this.debuff.sail > 0 ? DEBUFF_DEFS.sail.maxSail : 1;
  }

  // 命中后按概率独立判定 debuff，返回本次触发的 key 列表
  // skipFire：下雨天（风暴中）不附加着火
  rollDebuffs(skipFire = false) {
    const applied = [];
    for (const [key, def] of Object.entries(DEBUFF_DEFS)) {
      if (key === 'fire' && skipFire) continue;
      if (Math.random() < def.chance) {
        this.debuff[key] = def.duration; // 重复触发刷新时间
        applied.push(key);
      }
    }
    return applied;
  }

  // 热替换外观（真实模型加载完成后换掉程序化船），运动/浮力逻辑不受影响
  setVisual(group, sailSetter) {
    if (this._visual) this.group.remove(this._visual);
    this._visual = group;
    this.group.add(group);
    this.setSailAmount = sailSetter || (() => {});
  }

  get forward() {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  get position() {
    return this.group.position;
  }

  startSinking() {
    if (this.sinking) return;
    this.sinking = true;
    this.sinkT = 0;
    this.sinkDir = Math.random() < 0.5 ? 1 : -1;
    this.debuff.fire = this.debuff.leak = this.debuff.sail = 0; // 沉船清除 debuff
  }

  takeDamage(dmg) {
    if (this.sinking) return false;
    if (this.debuff.leak > 0) dmg *= DEBUFF_DEFS.leak.damageTakenMul; // 漏水易伤
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.hp = 0;
      this.startSinking();
      return true; // 被击沉
    }
    return false;
  }

  update(dt, time, waveFn) {
    const p = this.group.position;

    if (this.sinking) {
      // 沉船动画：倾斜 + 缓慢下沉 + 减速
      this.sinkT += dt;
      this.roll += dt * 0.35 * this.sinkDir;
      this.pitch += dt * 0.12;
      p.y -= dt * (0.5 + this.sinkT * 0.3);
      this.speed = Math.max(0, this.speed - dt * 4);
      this._applyMotion(dt);
      if (this.sinkT > 5) this.dead = true;
      return;
    }

    // ---- debuff 计时（着火持续掉血，可致命） ----
    if (this.debuff.fire > 0) {
      this.debuff.fire -= dt;
      this.hp -= DEBUFF_DEFS.fire.dps * dt;
      if (this.hp <= 0) {
        this.hp = 0;
        this.startSinking();
        return;
      }
    }
    if (this.debuff.leak > 0) this.debuff.leak -= dt;
    if (this.debuff.sail > 0) this.debuff.sail -= dt;

    // ---- 浮力：采样船头/船尾/左舷/右舷四点波高（随船长缩放） ----
    const ls = this.lengthScale;
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const hBow = waveFn(p.x + sinH * 3.5 * ls, p.z + cosH * 3.5 * ls, time);
    const hStern = waveFn(p.x - sinH * 3.5 * ls, p.z - cosH * 3.5 * ls, time);
    const hPort = waveFn(p.x - cosH * 2.0 * ls, p.z + sinH * 2.0 * ls, time);
    const hStar = waveFn(p.x + cosH * 2.0 * ls, p.z - sinH * 2.0 * ls, time);

    const targetY = (hBow + hStern + hPort + hStar) / 4 + this.baseY;
    const targetPitch = Math.atan2(hStern - hBow, 7.0 * ls);
    const targetRoll = Math.atan2(hStar - hPort, 4.0 * ls);

    // 平滑插值，漂浮感
    const k = 1 - Math.exp(-3 * dt);
    p.y += (targetY - p.y) * k;
    this.pitch += (targetPitch - this.pitch) * k;
    this.roll += (targetRoll - this.roll) * k;

    this._applyMotion(dt);
  }

  // 位移 + 姿态应用（普通与沉船状态共用）
  _applyMotion(dt) {
    const p = this.group.position;
    const f = this.forward;
    p.x += f.x * this.speed * dt;
    p.z += f.z * this.speed * dt;

    // 限制活动范围
    const r = Math.hypot(p.x, p.z);
    if (r > WORLD_LIMIT) {
      p.x *= WORLD_LIMIT / r;
      p.z *= WORLD_LIMIT / r;
    }

    this.group.rotation.set(this.pitch, this.heading, this.roll);
  }

  // 朝目标角度转向，返回剩余角差
  turnToward(targetHeading, dt, rateScale = 1) {
    let diff = targetHeading - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const maxTurn = this.turnRate * rateScale * dt;
    this.heading += THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);
    return diff;
  }
}
