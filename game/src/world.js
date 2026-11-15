// world.js — the SUNDER map: one compact tactical arena, built from boxes.
// Attackers (STRIKE) spawn in the west, defenders (AEGIS) hold two bomb sites
// in the east. Three lanes connect them: Long A along the north wall, Mid
// through the centre, Long B along the south wall, with two short connectors.
//
// Everything solid is an axis-aligned box on the XZ plane with a height.
// The same list drives rendering, movement collision, bullet raycasts and
// bot line-of-sight, so what you see is exactly what blocks you.

import * as THREE from 'three';

// [x1, z1, x2, z2, height, kind] — kind picks the material.
const BOXES = [
  // Perimeter
  [-33, -25, -32, 25, 4.5, 'wallDark'],
  [32, -25, 33, 25, 4.5, 'wallDark'],
  [-33, -25, 33, -24, 4.5, 'wallDark'],
  [-33, 24, 33, 25, 4.5, 'wallDark'],
  // Mid wall — one centre gap at z in [-4, 4]
  [-0.6, -24, 0.6, -4, 3.4, 'wall'],
  [-0.6, 4, 0.6, 24, 3.4, 'wall'],
  // North divider — Long A corridor runs between z=-24 and z=-16; gap at x in [-2, 2] ("A short")
  [-32, -16.6, -2, -16, 3.4, 'wall'],
  [2, -16.6, 16, -16, 3.4, 'wall'],
  // South divider — Long B corridor; gap at x in [-2, 2] ("B short")
  [-32, 16, -2, 16.6, 3.4, 'wall'],
  [2, 16, 16, 16.6, 3.4, 'wall'],
  // Site A room (centre 24,-14): west wall with a door at z in [-15,-12]
  [15.4, -22, 16, -15, 3.4, 'wall'],
  [15.4, -12, 16, -6, 3.4, 'wall'],
  // Site A south wall with a door at x in [20,23]
  [16, -6.6, 20, -6, 3.4, 'wall'],
  [23, -6.6, 32, -6, 3.4, 'wall'],
  // Site B room (centre 24,14): west wall with a door at z in [12,15]
  [15.4, 6, 16, 12, 3.4, 'wall'],
  [15.4, 15, 16, 22, 3.4, 'wall'],
  // Site B north wall with a door at x in [20,23]
  [16, 6, 20, 6.6, 3.4, 'wall'],
  [23, 6, 32, 6.6, 3.4, 'wall'],
  // Spawn cover and lane crates (1.2 = crouch cover you can see over, 2.4 = full cover)
  [-4.2, -2.2, -1.8, 0.2, 1.2, 'crate'],
  [2.8, 6.8, 5.2, 9.2, 2.4, 'crateTall'],
  [2.8, -9.2, 5.2, -6.8, 1.2, 'crate'],
  [19.8, -17.2, 22.2, -14.8, 1.2, 'crate'],
  [25.8, -11.2, 28.2, -8.8, 2.4, 'crateTall'],
  [19.8, 14.8, 22.2, 17.2, 1.2, 'crate'],
  [25.8, 8.8, 28.2, 11.2, 2.4, 'crateTall'],
  [-13.2, -21.2, -10.8, -18.8, 1.2, 'crate'],
  [-13.2, 18.8, -10.8, 21.2, 1.2, 'crate'],
  [-15.2, -11.2, -12.8, -8.8, 2.4, 'crateTall'],
  [-15.2, 8.8, -12.8, 11.2, 2.4, 'crateTall'],
  [11.8, -3.2, 14.2, -0.8, 1.2, 'crate'],
  [11.8, 0.8, 14.2, 3.2, 1.2, 'crate'],
  [-27.2, -8.2, -24.8, -5.8, 1.2, 'crate'],
  [-27.2, 5.8, -24.8, 8.2, 1.2, 'crate'],
  [-8.2, -20.2, -5.8, -17.8, 2.4, 'crateTall'],
  [7.8, 17.8, 10.2, 20.2, 2.4, 'crateTall'],
];

export const SITES = [
  { id: 'A', x: 24, z: -14, r: 5.5 },
  { id: 'B', x: 24, z: 14, r: 5.5 },
];

export const SPAWNS = {
  strike: [
    { x: -28, z: 0, yaw: -Math.PI / 2 },   // the player
    { x: -28, z: -5, yaw: -Math.PI / 2 },
    { x: -28, z: 5, yaw: -Math.PI / 2 },
    { x: -29.5, z: -2.5, yaw: -Math.PI / 2 },
  ],
  aegis: [
    { x: 27, z: -19, yaw: Math.PI / 2 },
    { x: 20, z: -8, yaw: Math.PI / 2 },
    { x: 27, z: 19, yaw: Math.PI / 2 },
    { x: 20, z: 8, yaw: Math.PI / 2 },
  ],
};

// Hand-placed navigation nodes; edges are derived from distance + line of sight.
const WAYPOINTS = [
  [-28, 0], [-24, -3], [-20, -6], [-20, 6], [-24, 3],
  [-14, -20], [0, -20], [12, -20],
  [-14, 20], [0, 20], [12, 20],
  [-14, -10], [-6, -10], [4, -10], [12, -9],
  [0, -13], [0, 13],
  [-14, 10], [-6, 10], [4, 10], [12, 9],
  [-14, 0], [-6, 0], [2, 0], [8, 0], [13, 0],
  [18, -13.5], [24, -14], [21, -8], [28, -19], [17, -3],
  [18, 13.5], [24, 14], [21, 8], [28, 19], [17, 3],
  [24, -20], [24, 20], [-24, -18], [-24, 18],
];

function concreteTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#878d94'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = `rgba(${40 + Math.random() * 40 | 0},${42 + Math.random() * 40 | 0},${48 + Math.random() * 40 | 0},0.12)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  g.strokeStyle = 'rgba(30,32,36,0.35)'; g.lineWidth = 3;
  g.strokeRect(1, 1, 254, 254);
  g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 256); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function floorTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#5d6066'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 70 + Math.random() * 50 | 0;
    g.fillStyle = `rgba(${v},${v},${v + 6},0.16)`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  g.strokeStyle = 'rgba(28,30,34,0.5)'; g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, 512); g.stroke();
    g.beginPath(); g.moveTo(0, i * 128); g.lineTo(512, i * 128); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(8, 6);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function siteDecal(site, color) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.strokeStyle = color; g.lineWidth = 10;
  g.beginPath(); g.arc(128, 128, 108, 0, Math.PI * 2); g.stroke();
  g.fillStyle = color;
  g.font = '700 150px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(site.id, 128, 136);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(site.r * 2, site.r * 2),
    new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.85, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(site.x, 0.02, site.z);
  return m;
}

export function buildWorld(scene) {
  const colliders = BOXES.map(([x1, z1, x2, z2, h, kind]) => ({ x1, z1, x2, z2, h, kind }));

  const concrete = concreteTexture();
  const mats = {
    wall: new THREE.MeshStandardMaterial({ map: concrete, color: 0xb9bec6, roughness: 0.95 }),
    wallDark: new THREE.MeshStandardMaterial({ map: concrete, color: 0x7d848e, roughness: 0.97 }),
    crate: new THREE.MeshStandardMaterial({ color: 0x9a6b3f, roughness: 0.85 }),
    crateTall: new THREE.MeshStandardMaterial({ color: 0x5c6e46, roughness: 0.85 }),
  };

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(66, 50),
    new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.96 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Apron outside the walls, and a few distant towers for the skyline.
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 1 }),
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.05;
  scene.add(apron);
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x3a434f, roughness: 1 });
  const towerGeo = new THREE.BoxGeometry(10, 30, 10);
  [[-52, -30], [-48, 22], [50, -34], [54, 18], [0, -52], [-20, 50], [26, 52], [58, -6]].forEach(([x, z], i) => {
    const t = new THREE.Mesh(towerGeo, towerMat);
    t.position.set(x, 10 + (i % 3) * 4, z);
    t.scale.y = 0.8 + (i % 4) * 0.25;
    scene.add(t);
  });

  for (const b of colliders) {
    const w = b.x2 - b.x1, d = b.z2 - b.z1;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, b.h, d), mats[b.kind]);
    mesh.position.set((b.x1 + b.x2) / 2, b.h / 2, (b.z1 + b.z2) / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    // A lighter cap strip on full-height walls reads as a parapet in screenshots.
    if (b.h >= 3) {
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.15, 0.18, d + 0.15),
        new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.8 }),
      );
      cap.position.set(mesh.position.x, b.h + 0.09, mesh.position.z);
      scene.add(cap);
    }
  }

  scene.add(siteDecal(SITES[0], '#ffb340'));
  scene.add(siteDecal(SITES[1], '#35c4b5'));

  // Waypoint graph: connect neighbours that can see each other.
  const nodes = WAYPOINTS.map(([x, z]) => ({ x, z, edges: [] }));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 15 && losClear(colliders, a.x, a.z, b.x, b.z)) {
        a.edges.push(j); b.edges.push(i);
      }
    }
  }

  return { colliders, nodes };
}

// Does the 2D segment pass through any sight-blocking box (height >= 1.5)?
export function losClear(colliders, x1, z1, x2, z2) {
  for (const b of colliders) {
    if (b.h < 1.5) continue;
    if (segmentHitsBox(x1, z1, x2, z2, b)) return false;
  }
  return true;
}

function segmentHitsBox(x1, z1, x2, z2, b) {
  // Slab test in 2D; a segment starting or ending inside counts as blocked.
  const dx = x2 - x1, dz = z2 - z1;
  let tmin = 0, tmax = 1;
  if (Math.abs(dx) < 1e-9) { if (x1 < b.x1 || x1 > b.x2) return false; }
  else {
    let t1 = (b.x1 - x1) / dx, t2 = (b.x2 - x1) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-9) { if (z1 < b.z1 || z1 > b.z2) return false; }
  else {
    let t1 = (b.z1 - z1) / dz, t2 = (b.z2 - z1) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

// 3D ray vs every collider box (and the floor). Returns nearest distance or Infinity.
export function raycastWalls(colliders, ox, oy, oz, dx, dy, dz, maxDist) {
  let best = maxDist;
  if (dy < -1e-9) {
    const t = -oy / dy;
    if (t > 0 && t < best) best = t;
  }
  for (const b of colliders) {
    let tmin = 0, tmax = best;
    // X slab
    if (Math.abs(dx) < 1e-9) { if (ox < b.x1 || ox > b.x2) continue; }
    else {
      let t1 = (b.x1 - ox) / dx, t2 = (b.x2 - ox) / dx;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    // Y slab (box spans 0..h)
    if (Math.abs(dy) < 1e-9) { if (oy < 0 || oy > b.h) continue; }
    else {
      let t1 = (0 - oy) / dy, t2 = (b.h - oy) / dy;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    // Z slab
    if (Math.abs(dz) < 1e-9) { if (oz < b.z1 || oz > b.z2) continue; }
    else {
      let t1 = (b.z1 - oz) / dz, t2 = (b.z2 - oz) / dz;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    if (tmin > 0 && tmin < best) best = tmin;
  }
  return best;
}

// Push a circle (x, z, radius r) out of every collider; returns corrected [x, z].
export function collide(colliders, x, z, r) {
  for (const b of colliders) {
    const cx = Math.max(b.x1, Math.min(x, b.x2));
    const cz = Math.max(b.z1, Math.min(z, b.z2));
    let dx = x - cx, dz = z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > r * r) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      x = cx + (dx / d) * r;
      z = cz + (dz / d) * r;
    } else {
      // Centre inside the box: push out along the smallest penetration axis.
      const pl = x - b.x1, pr = b.x2 - x, pn = z - b.z1, pf = b.z2 - z;
      const m = Math.min(pl, pr, pn, pf);
      if (m === pl) x = b.x1 - r;
      else if (m === pr) x = b.x2 + r;
      else if (m === pn) z = b.z1 - r;
      else z = b.z2 + r;
    }
  }
  return [x, z];
}

// Breadth-first path over the waypoint graph. Returns a list of {x, z} to walk.
export function findPath(nodes, sx, sz, tx, tz) {
  const nearest = (x, z) => {
    let bi = 0, bd = Infinity;
    nodes.forEach((n, i) => {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    });
    return bi;
  };
  const start = nearest(sx, sz), goal = nearest(tx, tz);
  if (start === goal) return [{ x: tx, z: tz }];
  const prev = new Array(nodes.length).fill(-1);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === goal) break;
    for (const e of nodes[cur].edges) {
      if (!seen.has(e)) { seen.add(e); prev[e] = cur; queue.push(e); }
    }
  }
  if (!seen.has(goal)) return [{ x: tx, z: tz }];
  const path = [];
  for (let c = goal; c !== -1; c = prev[c]) path.push({ x: nodes[c].x, z: nodes[c].z });
  path.reverse();
  path.push({ x: tx, z: tz });
  return path;
}

export function siteAt(x, z) {
  for (const s of SITES) {
    if (Math.hypot(x - s.x, z - s.z) <= s.r) return s;
  }
  return null;
}
