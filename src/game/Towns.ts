/**
 * 沿海城镇：程序化低模房屋群 + 灯塔。
 *
 * 点位来源：自定义海域用 Overpass 的 place 节点（city/town/village，落在陆地
 * 掩码内才用）；默认迷雾岛或点位缺失时，在近岸带（距岸 50~300m、地面 2~12m）
 * 程序化自选。
 *
 * 性能：全部房屋共用两个 InstancedMesh（墙体盒 + 四棱锥屋顶），instanceColor
 * 做暖色墙变化；灯塔独一件（圆柱 + 自发光顶灯）。
 */

import * as THREE from 'three/webgpu';

export interface GroundSampler {
  /** 地面高度（世界坐标，负 = 水下）。 */
  height(x: number, z: number): number;
}

export interface TownSite {
  x: number;
  z: number;
  name: string | null;
}

const HOUSES_PER_TOWN_MIN = 10;
const HOUSES_PER_TOWN_MAX = 25;
const WALL_COLORS = [0xd8b890, 0xc9a878, 0xbfae8e, 0xa89070, 0xd0c0a0];

/**
 * 在近岸带找城镇点位：陆地上、高度 2~12m、距岸（高度场 0 等值线）50~300m。
 * 从候选中心向外螺旋采样。
 */
function findShoreSite(ground: GroundSampler, cx: number, cz: number, maxR: number): THREE.Vector2 | null {
  for (let r = 0; r < maxR; r += 45) {
    const steps = Math.max(8, Math.round(r / 22));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const h = ground.height(x, z);
      if (h < 2 || h > 12) continue;
      // 距岸估算：周围 ±60m 内有水即近岸
      const near =
        ground.height(x + 60, z) < 0 ||
        ground.height(x - 60, z) < 0 ||
        ground.height(x, z + 60) < 0 ||
        ground.height(x, z - 60) < 0;
      if (near) return new THREE.Vector2(x, z);
    }
  }
  return null;
}

export class Towns {
  readonly object = new THREE.Group();
  readonly sites: TownSite[] = [];
  /** 灯塔位置（岸防炮/罗盘标记复用）。 */
  readonly lighthouses: THREE.Vector3[] = [];

  /**
   * @param ground 地面采样（自定义：terrain.heightWorld；默认：seafloorHeight）
   * @param sites  真实城镇点位（世界坐标，Game 已用 latLonToWorld 转换并滤掉海里
   *               的）；空数组走程序化自选
   * @param fallbackCenter 程序化自选时的参考中心（默认：ISLAND 中心）
   */
  constructor(ground: GroundSampler, sites: TownSite[], fallbackCenter: { x: number; z: number }) {
    this.object.name = 'towns';

    // ---- 点位解析：真实点位优先，程序化补齐到至少 2 个 ----
    const candidates: TownSite[] = [...sites];
    if (candidates.length < 2) {
      for (let i = 0; i < 6 && candidates.length < 2; i++) {
        const a = Math.random() * Math.PI * 2;
        const site = findShoreSite(
          ground,
          fallbackCenter.x + Math.cos(a) * 200,
          fallbackCenter.z + Math.sin(a) * 200,
          600,
        );
        if (site) candidates.push({ x: site.x, z: site.y, name: null });
      }
    }

    // ---- 房屋群（两个共享 InstancedMesh） ----
    const wallGeo = new THREE.BoxGeometry(1, 1, 1);
    wallGeo.translate(0, 0.5, 0); // 底部对齐地面
    const roofGeo = new THREE.ConeGeometry(0.72, 0.5, 4); // 四棱锥（rotY π/4 成方顶）
    roofGeo.rotateY(Math.PI / 4);
    roofGeo.translate(0, 1.25, 0);
    const wallMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3a3230, roughness: 0.85 });

    const walls: THREE.Matrix4[] = [];
    const wallColors: THREE.Color[] = [];
    const roofs: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);

    for (const site of candidates) {
      const count = HOUSES_PER_TOWN_MIN + Math.floor(Math.random() * (HOUSES_PER_TOWN_MAX - HOUSES_PER_TOWN_MIN));
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        // 外环带 38~100m：镇中心留给 Scenery 的真实房屋模型，程序化盒子当远景/郊区
        const r = 38 + Math.random() * 62;
        const x = site.x + Math.cos(a) * r;
        const z = site.z + Math.sin(a) * r;
        const h = ground.height(x, z);
        if (h < 1) continue; // 不下水
        const w = 3 + Math.random() * 3.5;
        const hh = 2.2 + Math.random() * 1.8;
        const d = 3 + Math.random() * 3;
        q.setFromAxisAngle(up, Math.random() * Math.PI * 2);
        m.compose(new THREE.Vector3(x, h - 0.15, z), q, new THREE.Vector3(w, hh, d));
        walls.push(m.clone());
        roofs.push(m.clone());
        wallColors.push(new THREE.Color(WALL_COLORS[Math.floor(Math.random() * WALL_COLORS.length)]));
      }
      this.sites.push(site);
    }

    if (walls.length > 0) {
      const wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, walls.length);
      const roofMesh = new THREE.InstancedMesh(roofGeo, roofMat, walls.length);
      for (let i = 0; i < walls.length; i++) {
        wallMesh.setMatrixAt(i, walls[i]);
        wallMesh.setColorAt(i, wallColors[i]);
        roofMesh.setMatrixAt(i, roofs[i]);
      }
      wallMesh.castShadow = true;
      wallMesh.receiveShadow = true;
      wallMesh.name = 'town-walls';
      roofMesh.name = 'town-roofs';
      this.object.add(wallMesh, roofMesh);
    }

    // ---- 灯塔：最突出的近岸点（第一个点位附近最高处）；找不到就立在点位本身 ----
    if (this.sites.length > 0) {
      const s = this.sites[0];
      let best: THREE.Vector3 | null = null;
      let bestH = -Infinity;
      for (let i = 0; i < 120; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 40 + Math.random() * 220;
        const x = s.x + Math.cos(a) * r;
        const z = s.z + Math.sin(a) * r;
        const h = ground.height(x, z);
        // 灯塔要临海：±60m 内有水的高地
        const nearWater =
          ground.height(x + 60, z) < 0 ||
          ground.height(x - 60, z) < 0 ||
          ground.height(x, z + 60) < 0 ||
          ground.height(x, z - 60) < 0;
        if (h > 2 && h < 24 && nearWater && h > bestH) {
          bestH = h;
          best = new THREE.Vector3(x, h, z);
        }
      }
      if (!best) best = new THREE.Vector3(s.x, ground.height(s.x, s.z), s.z);
      const tower = new THREE.Mesh(
        new THREE.CylinderGeometry(1.6, 2.2, 11, 8),
        new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.8 }),
      );
      tower.position.set(best.x, best.y + 5.5, best.z);
      tower.castShadow = true;
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xffe9a8 }), // 常明顶灯（夜里自然发光感）
      );
      lamp.position.set(best.x, best.y + 11.8, best.z);
      this.object.add(tower, lamp);
      this.lighthouses.push(new THREE.Vector3(best.x, best.y, best.z));
    }
  }
}
