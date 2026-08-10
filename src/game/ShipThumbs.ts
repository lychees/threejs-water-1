/**
 * 选船卡片 3D 缩略图：共享一个小型离屏渲染器，对每艘船渲染一帧 3/4 侧视图
 * 转 dataURL。移植自旧 js/shipyard.js 的 renderShipThumbnail。
 *
 * 主渲染器是 WebGPU 构建（three r185 没有独立的 WebGLRenderer），所以缩略图
 * 用第二个 `WebGPURenderer({ forceWebGL: true })`——220×110 的 canvas 很小，
 * 初始化一次后每艘一帧，成本可忽略。r185 的 WebGPURenderer 不再收
 * preserveDrawingBuffer；render() 之后同一任务内 toDataURL，帧仍然读得到。
 *
 * 生命周期：懒初始化，整个选船门存续期间复用（勾选精致模型/换染色要重渲），
 * 渲染失败一律 resolve(null)，调用方回退纯文字卡。
 */

import * as THREE from 'three/webgpu';

let thumbRenderer: THREE.WebGPURenderer | null = null;
let thumbRendererReady: Promise<THREE.WebGPURenderer> | null = null;

function getThumbRenderer(): Promise<THREE.WebGPURenderer> {
  if (!thumbRenderer) {
    console.info('[thumbs] creating offscreen renderer');
    thumbRenderer = new THREE.WebGPURenderer({
      antialias: true,
      forceWebGL: true,
    });
    thumbRenderer.setSize(220, 110);
    thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    thumbRenderer.toneMappingExposure = 1.1;
    thumbRendererReady = thumbRenderer.init().then(() => {
      console.info('[thumbs] renderer ready');
      return thumbRenderer!;
    });
  }
  return thumbRendererReady!;
}

/**
 * 渲染一艘船的缩略图。输入 group 必须是可抛弃的副本：
 * 渲染完只释放几何体（材质是 Shipyard 共享缓存的，不能动）。
 * 返回 dataURL；失败为 null。
 */
export async function renderShipThumbnail(group: THREE.Group): Promise<string | null> {
  try {
    const renderer = await getThumbRenderer();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d2f45);
    scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x2a4a3a, 1.2));
    const dl = new THREE.DirectionalLight(0xfff0d0, 2.2);
    dl.position.set(3, 5, 4);
    scene.add(dl);
    scene.add(group);

    // 按包围盒取景（固定 3/4 侧视角度）
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z);
    const cam = new THREE.PerspectiveCamera(35, 2, 0.1, 1000);
    cam.position.set(center.x + r * 1.1, center.y + r * 0.5, center.z + r * 1.15);
    cam.lookAt(center);

    renderer.render(scene, cam);
    const url = renderer.domElement.toDataURL('image/png');

    scene.remove(group);
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    return url;
  } catch (error) {
    console.warn('[shipyard] 缩略图渲染失败：', error);
    return null;
  }
}
