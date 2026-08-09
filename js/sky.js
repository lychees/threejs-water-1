// 天空：渐变穹顶 + 太阳/光照 + 云 + 远处小岛点缀
import * as THREE from 'three';

// 太阳方向（全局共用：水面高光、平行光位置、天空光晕都用它）
export const SUN_DIR = new THREE.Vector3(-0.55, 0.38, -0.74).normalize();

// 天空配色（天空穹顶与水面反射共用，保证水天一致；horizon 必须等于雾色）
export const SKY_COLORS = {
  zenith: new THREE.Color(0x2a76c2),
  horizon: new THREE.Color(0xcfe9f3),
  sun: new THREE.Color(0xffe6b0),
};

// 共用 GLSL：天空渐变 + 太阳圆盘 + 光晕（水面反射也调用它，保持水天无缝）
// 注意：uniform 声明也在这里，引入方不要再重复声明这几个 uniform
export const SKY_GLSL = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;

  vec3 skyColor(vec3 dir) {
    vec3 d = normalize(dir);
    // 地平线 -> 天顶渐变
    float t = pow(max(d.y, 0.0), 0.55);
    vec3 col = mix(uHorizon, uZenith, t);
    float s = max(dot(d, uSunDir), 0.0);
    // 太阳圆盘 + 光晕
    col += uSunColor * (pow(s, 600.0) * 2.5 + pow(s, 24.0) * 0.25);
    // 向阳一侧靠近地平线的暖调
    col += uSunColor * pow(s, 3.0) * 0.10 * (1.0 - t);
    return col;
  }
`;

const skyVertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const skyFragmentShader = /* glsl */ `
  ${SKY_GLSL}
  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);
    vec3 col = skyColor(d);
    // 海平面以下给一点深色，避免穿帮
    col = mix(col, uHorizon * 0.85, smoothstep(0.0, -0.15, d.y));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// 程序化低多边形小岛：岩锥 + 绿植 + 几棵棕榈
function createIsland(scale) {
  const g = new THREE.Group();

  const rockMat = new THREE.MeshLambertMaterial({ color: 0x9a8563, flatShading: true });
  const sandMat = new THREE.MeshLambertMaterial({ color: 0xe0cf9a, flatShading: true });
  const leafMat = new THREE.MeshLambertMaterial({ color: 0x3f8f4f, flatShading: true });
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x7a5a38, flatShading: true });

  // 沙滩底座
  const sand = new THREE.Mesh(new THREE.CylinderGeometry(16, 20, 3, 9), sandMat);
  sand.position.y = -0.5;
  g.add(sand);
  // 岩山
  const rock = new THREE.Mesh(new THREE.ConeGeometry(12, 12, 8), rockMat);
  rock.position.y = 6;
  g.add(rock);
  // 山顶植被
  const top = new THREE.Mesh(new THREE.ConeGeometry(6, 5, 7), leafMat);
  top.position.y = 12.5;
  g.add(top);
  // 棕榈树（斜树干 + 几片大叶）
  for (let i = 0; i < 3; i++) {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 5, 5), trunkMat);
    trunk.position.y = 2.5;
    trunk.rotation.z = 0.15;
    tree.add(trunk);
    for (let j = 0; j < 5; j++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.5, 3.2, 4), leafMat);
      const a = (j / 5) * Math.PI * 2;
      leaf.position.set(Math.cos(a) * 1.1, 5.2, Math.sin(a) * 1.1);
      leaf.rotation.set(Math.sin(a) * 1.2, 0, -Math.cos(a) * 1.2);
      tree.add(leaf);
    }
    const ang = (i / 3) * Math.PI * 2 + 0.7;
    tree.position.set(Math.cos(ang) * 12, 0.8, Math.sin(ang) * 12);
    g.add(tree);
  }

  g.scale.setScalar(scale);
  return g;
}

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

  // 天空穹顶
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: skyVertexShader,
    fragmentShader: skyFragmentShader,
    uniforms: {
      uZenith: { value: SKY_COLORS.zenith },
      uHorizon: { value: SKY_COLORS.horizon },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: SKY_COLORS.sun },
    },
    side: THREE.BackSide,
    depthWrite: false,
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(880, 24, 16), skyMat);
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

  // 远处两座小岛
  const island1 = createIsland(1.2);
  island1.position.set(-260, 0, -190);
  scene.add(island1);
  const island2 = createIsland(0.8);
  island2.position.set(300, 0, 160);
  scene.add(island2);

  return {
    update(dt) {
      // 云缓慢漂移，飘远了绕回另一侧
      for (const c of clouds) {
        c.position.x += c.userData.drift * dt;
        if (c.position.x > 450) c.position.x = -450;
      }
    },
  };
}
