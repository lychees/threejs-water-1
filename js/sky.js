// 天空：渐变穹顶（TSL NodeMaterial）+ 太阳/光照 + 云
import * as THREE from 'three';
import { Fn, uniform, normalize, pow, max, mix, dot, smoothstep, positionWorld, cameraPosition } from 'three/tsl';

// 太阳方向（初始值；daytime.js 每帧通过 uniform 更新）
export const SUN_DIR = new THREE.Vector3(-0.55, 0.38, -0.74).normalize();

// 天空配色（horizon 必须等于雾色，保证水天无缝）
export const SKY_COLORS = {
  zenith: new THREE.Color(0x2a76c2),
  horizon: new THREE.Color(0xcfe9f3),
  sun: new THREE.Color(0xffe6b0),
};

// 天空 uniform 节点：天空穹顶与水面共享同一组（uZenith/uHorizon），
// 天气/昼夜只写一处，两边同时生效；uSunDir/uSunColor 双方各自持有（水面用日月混合光源）
export const SKY_UNIFORMS = {
  uZenith: uniform(SKY_COLORS.zenith.clone()),
  uHorizon: uniform(SKY_COLORS.horizon.clone()),
  uSunDir: uniform(SUN_DIR.clone()),
  uSunColor: uniform(SKY_COLORS.sun.clone()),
};

// 天空渐变 + 太阳圆盘 + 光晕 + 向阳暖调（TSL 版 skyColor；U 为四个 uniform 节点）
export const makeSkyColor = (U) => Fn(([dir]) => {
  const d = normalize(dir);
  // 地平线 -> 天顶渐变
  const t = pow(max(d.y, 0.0), 0.55);
  const col = mix(U.uHorizon, U.uZenith, t).toVar();
  const s = max(dot(d, U.uSunDir), 0.0);
  // 太阳圆盘 + 光晕
  col.addAssign(U.uSunColor.mul(pow(s, 600.0).mul(2.5).add(pow(s, 24.0).mul(0.25))));
  // 向阳一侧靠近地平线的暖调
  col.addAssign(U.uSunColor.mul(pow(s, 3.0).mul(0.10).mul(t.oneMinus())));
  return col;
});

// 程序化云：几个压扁的球拼一簇，缓慢漂移
function createCloud() {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const r = 4 + Math.random() * 5;
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 7, 5), mat);
    puff.position.set((i - n / 2) * r * 1.1, Math.random() * 2, (Math.random() - 0.5) * 4);
    puff.scale.y = 0.55;
    g.add(puff);
  }
  return g;
}

export function createSky(scene) {
  // 雾：远处水面融入天际（颜色与天空地平线色严格一致）
  scene.fog = new THREE.Fog(SKY_COLORS.horizon.getHex(), 90, 460);

  // 天空穹顶（TSL；海平面以下略压暗防穿帮）
  // 注意：fragment 里必须用 positionWorld（官方 SkyMesh 同款取法）；
  // positionLocal 是顶点属性，WGSL 片元阶段不可用——曾导致整片天空输出黑
  const skyColor = makeSkyColor(SKY_UNIFORMS);
  const skyMat = new THREE.NodeMaterial({ side: THREE.BackSide, depthWrite: false });
  skyMat.fog = false;
  skyMat.colorNode = Fn(() => {
    const d = normalize(positionWorld.sub(cameraPosition));
    const col = skyColor(d).toVar();
    // 海平面以下压暗防穿帮（WGSL smoothstep 要求 low < high，用取反写法）
    col.assign(mix(col, SKY_UNIFORMS.uHorizon.mul(0.85), smoothstep(0.0, 0.15, d.y.negate())));
    return col;
  })();

  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(880, 24, 16), skyMat);
  skyDome.frustumCulled = false; // 保险：大穹顶永不被剔除
  scene.add(skyDome);

  // 光照：暖阳平行光 + 半球环境光
  const sun = new THREE.DirectionalLight(0xffe0b3, 2.4);
  sun.position.copy(SUN_DIR).multiplyScalar(200);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0x9fd8ff, 0x1a4a5e, 0.9);
  scene.add(hemi);

  // 云
  const clouds = [];
  for (let i = 0; i < 7; i++) {
    const c = createCloud();
    const a = Math.random() * Math.PI * 2;
    const r = 160 + Math.random() * 240;
    c.position.set(Math.cos(a) * r, 45 + Math.random() * 40, Math.sin(a) * r);
    c.userData.drift = 0.8 + Math.random() * 0.8;
    scene.add(c);
    clouds.push(c);
  }

  return {
    uniforms: SKY_UNIFORMS, // 天气/昼夜系统写 .value 驱动天空颜色
    sun,
    hemi,
    update(dt) {
      // 云缓慢漂移，飘远了绕回另一侧
      for (const c of clouds) {
        c.position.x += c.userData.drift * dt;
        if (c.position.x > 450) c.position.x = -450;
      }
    },
  };
}
