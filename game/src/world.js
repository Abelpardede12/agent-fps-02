// SUNDER — world.js
// The map, its colliders, raycasts and bot navigation. One job: geometry + queries.
// Map: 64 x 48 m. x in [-32, 32], z in [-24, 24]. A site north-east, B site south-east,
// a mid wall with a centre gap, long north/south corridors, crates for cover.
// STRIKE spawns west, AEGIS east. All distances in metres, y up.
import * as THREE from 'three';

export const MAP_W = 64;
export const MAP_D = 48;
export const WALL_H = 3.4;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Full-height walls: {x0, z0, x1, z1}
export const WALLS = [
  // outer ring
  { x0: -33, z0: -25, x1: 33, z1: -24 },
  { x0: -33, z0: 24, x1: 33, z1: 25 },
  { x0: -33, z0: -24, x1: -32, z1: 24 },
  { x0: 32, z0: -24, x1: 33, z1: 24 },
  // mid wall, centre gap z in [-5, 5]
  { x0: -0.75, z0: -24, x1: 0.75, z1: -5 },
  { x0: -0.75, z0: 5, x1: 0.75, z1: 24 },
  // A site (north-east): west wall with door gap z [-17.5, -14], south wall gap x [21, 24]
  { x0: 15.5, z0: -22, x1: 16.5, z1: -17.5 },
  { x0: 15.5, z0: -14, x1: 16.5, z1: -10 },
  { x0: 16.5, z0: -10.5, x1: 21, z1: -9.5 },
  { x0: 24, z0: -10.5, x1: 32, z1: -9.5 },
  // B site (south-east): west wall door gap z [14, 17.5], north wall gap x [21, 24]
  { x0: 15.5, z0: 10, x1: 16.5, z1: 14 },
  { x0: 15.5, z0: 17.5, x1: 16.5, z1: 22 },
  { x0: 16.5, z0: 9.5, x1: 21, z1: 10.5 },
  { x0: 24, z0: 9.5, x1: 32, z1: 10.5 },
  // freestanding cover walls
  { x0: -11, z0: -14, x1: -10, z1: -10 },
  { x0: -11, z0: 10, x1: -10, z1: 14 },
  { x0: 7, z0: -3, x1: 8, z1: 0.5 },
  { x0: -8, z0: -0.5, x1: -7, z1: 3 },
];

// Crates: {x, z, s, h} — low cover, blocks movement and bullets.
export const CRATES = [
  { x: -4, z: -16, s: 2.0, h: 1.2 }, { x: -4, z: 16, s: 2.0, h: 1.2 },
  { x: 4, z: -16, s: 2.0, h: 1.2 }, { x: 4, z: 16, s: 2.0, h: 1.2 },
  { x: -16, z: -6, s: 2.0, h: 1.2 }, { x: -16, z: 6, s: 2.0, h: 1.2 },
  { x: 12, z: -6, s: 2.0, h: 1.2 }, { x: 12, z: 6, s: 2.0, h: 1.2 },
  { x: 20, z: -16, s: 2.4, h: 1.2 }, { x: 20, z: 16, s: 2.4, h: 1.2 },
  { x: -24, z: -12, s: 2.0, h: 1.2 }, { x: -24, z: 12, s: 2.0, h: 1.2 },
  { x: 26, z: -6, s: 2.0, h: 1.2 }, { x: 26, z: 6, s: 2.0, h: 1.2 },
  { x: -27, z: 0, s: 2.4, h: 1.2 },
];

// One collider list drives movement, bullet raycast and bot line-of-sight.
export function buildColliders() {
  const out = [];
  for (const w of WALLS) out.push({ x0: w.x0, z0: w.z0, x1: w.x1, z1: w.z1, y0: 0, y1: WALL_H });
  for (const c of CRATES) {
    const h = c.s / 2;
    out.push({ x0: c.x - h, z0: c.z - h, x1: c.x + h, z1: c.z + h, y0: 0, y1: c.h });
  }
  return out;
}

export const SITES = {
  A: { x0: 18, z0: -20, x1: 28, z1: -12, cx: 23, cz: -16 },
  B: { x0: 18, z0: 12, x1: 28, z1: 20, cx: 23, cz: 16 },
};

export const SPAWNS = {
  strike: [[-28, 0], [-28, -3], [-28, 3], [-26, -1.5]],
  aegis: [[28, 0], [28, -3], [28, 3], [26, 1.5]],
};

export function inSite(site, x, z) {
  return x >= site.x0 && x <= site.x1 && z >= site.z0 && z <= site.z1;
}

// ---- 2D collision: circle vs expanded AABBs, axis-separated so agents slide ----
export function circleHits(x, z, r, colliders) {
  for (const c of colliders) {
    if (x >= c.x0 - r && x <= c.x1 + r && z >= c.z0 - r && z <= c.z1 + r) return true;
  }
  return false;
}

export function moveCircle(px, pz, dx, dz, r, colliders) {
  let nx = px + dx;
  if (circleHits(nx, pz, r, colliders)) nx = px;
  let nz = pz + dz;
  if (circleHits(nx, nz, r, colliders)) nz = pz;
  return { x: nx, z: nz };
}

// ---- 3D ray vs colliders: nearest t in [0, maxDist], or -1 ----
export function rayHit(ox, oy, oz, dx, dy, dz, maxDist, colliders) {
  let best = maxDist;
  for (const c of colliders) {
    let t0 = 0, t1 = best;
    let ok = true;
    const axes = [
      [ox, dx, c.x0, c.x1],
      [oy, dy, c.y0, c.y1],
      [oz, dz, c.z0, c.z1],
    ];
    for (const [o, d, lo, hi] of axes) {
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) { ok = false; break; }
      } else {
        let ta = (lo - o) / d, tb = (hi - o) / d;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) { ok = false; break; }
      }
    }
    if (ok && t0 < best && t1 >= 0) best = Math.max(t0, 0);
  }
  return best < maxDist ? best : -1;
}

// ---- 2D segment vs AABBs expanded by `clear` (waypoint edges, movement checks) ----
export function segmentClear(ax, az, bx, bz, clear, colliders) {
  const dx = bx - ax, dz = bz - az;
  for (const c of colliders) {
    const x0 = c.x0 - clear, x1 = c.x1 + clear, z0 = c.z0 - clear, z1 = c.z1 + clear;
    let t0 = 0, t1 = 1, ok = true;
    const axes = [[ax, dx, x0, x1], [az, dz, z0, z1]];
    for (const [o, d, lo, hi] of axes) {
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) { ok = false; break; }
      } else {
        let ta = (lo - o) / d, tb = (hi - o) / d;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) { ok = false; break; }
      }
    }
    if (ok) return false;
  }
  return true;
}

export function hasLOS(ax, ay, az, bx, by, bz, colliders) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return true;
  const t = rayHit(ax, ay, az, dx / dist, dy / dist, dz / dist, dist - 0.05, colliders);
  return t === -1;
}

// ---- Waypoint graph + BFS (bots only; built once per match) ----
export function buildGraph(colliders) {
  const nodes = [];
  const add = (x, z) => {
    if (!circleHits(x, z, 0.7, colliders)) nodes.push({ x, z });
  };
  for (let x = -28; x <= 28; x += 4) {
    for (let z = -20; z <= 20; z += 4) add(x, z);
  }
  // Door gaps and site interiors the 4 m grid misses.
  add(16, -15.75); add(16, 15.75); // site west doors
  add(22.5, -10); add(22.5, 10);   // site south/north gaps
  add(0, -4); add(0, 4);           // mid gap
  add(23, -16); add(23, 16);       // site centres
  const adj = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d <= 5.2 && segmentClear(a.x, a.z, b.x, b.z, 0.55, colliders)) {
        adj[i].push({ to: j, cost: d });
        adj[j].push({ to: i, cost: d });
      }
    }
  }
  return { nodes, adj };
}

function nearestNode(graph, x, z) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i];
    const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

export function findPath(graph, sx, sz, tx, tz) {
  const si = nearestNode(graph, sx, sz);
  const ti = nearestNode(graph, tx, tz);
  if (si < 0 || ti < 0) return null;
  if (si === ti) return [{ x: tx, z: tz }];
  const prev = new Array(graph.nodes.length).fill(-1);
  const queue = [si];
  prev[si] = si;
  while (queue.length) {
    const cur = queue.shift();
    if (cur === ti) break;
    for (const e of graph.adj[cur]) {
      if (prev[e.to] === -1) { prev[e.to] = cur; queue.push(e.to); }
    }
  }
  if (prev[ti] === -1) return null;
  const path = [];
  let cur = ti;
  while (cur !== si) { path.push(graph.nodes[cur]); cur = prev[cur]; }
  path.reverse();
  path.push({ x: tx, z: tz });
  return path;
}

// ---- Rendering: floor, walls, crates, site paint, skyline silhouettes ----
function letterTexture(letter, color) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 256;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = color;
  g.font = 'bold 200px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(letter, 128, 138);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}

export function buildMap(scene) {
  const colliders = buildColliders();
  const matFloor = new THREE.MeshStandardMaterial({ color: 0x2b2e34, roughness: 0.95, metalness: 0.05 });
  const matWall = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.9, metalness: 0.08 });
  const matWallSite = new THREE.MeshStandardMaterial({ color: 0x44403a, roughness: 0.9, metalness: 0.08 });
  const matCrate = new THREE.MeshStandardMaterial({ color: 0x7a6238, roughness: 0.85, metalness: 0.1 });
  const matCrateDark = new THREE.MeshStandardMaterial({ color: 0x4d4a42, roughness: 0.9, metalness: 0.05 });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(MAP_W + 2, MAP_D + 2), matFloor);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  for (const w of WALLS) {
    const m = new THREE.Mesh(boxGeo, (w.x0 >= 15.5) ? matWallSite : matWall);
    m.scale.set(w.x1 - w.x0, WALL_H, w.z1 - w.z0);
    m.position.set((w.x0 + w.x1) / 2, WALL_H / 2, (w.z0 + w.z1) / 2);
    scene.add(m);
  }
  CRATES.forEach((c, i) => {
    const m = new THREE.Mesh(boxGeo, i % 2 ? matCrate : matCrateDark);
    m.scale.set(c.s, c.h, c.s);
    m.position.set(c.x, c.h / 2, c.z);
    scene.add(m);
    const lid = new THREE.Mesh(boxGeo, matCrateDark);
    lid.scale.set(c.s * 0.92, 0.08, c.s * 0.92);
    lid.position.set(c.x, c.h + 0.04, c.z);
    scene.add(lid);
  });

  // Site floor paint + big letters.
  for (const [key, s] of Object.entries(SITES)) {
    const tint = new THREE.Mesh(
      new THREE.PlaneGeometry(s.x1 - s.x0, s.z1 - s.z0),
      new THREE.MeshBasicMaterial({
        color: key === 'A' ? 0xf0a830 : 0x35c4b5, transparent: true, opacity: 0.10, depthWrite: false,
      }),
    );
    tint.rotation.x = -Math.PI / 2;
    tint.position.set(s.cx, 0.02, s.cz);
    scene.add(tint);
    const letter = new THREE.Mesh(
      new THREE.PlaneGeometry(5, 5),
      new THREE.MeshBasicMaterial({
        map: letterTexture(key, key === 'A' ? '#f0a830' : '#35c4b5'),
        transparent: true, opacity: 0.55, depthWrite: false,
      }),
    );
    letter.rotation.x = -Math.PI / 2;
    letter.position.set(s.cx, 0.03, s.cz);
    scene.add(letter);
  }

  // Spawn pads.
  const padS = new THREE.Mesh(new THREE.PlaneGeometry(7, 7),
    new THREE.MeshBasicMaterial({ color: 0xf0a830, transparent: true, opacity: 0.08, depthWrite: false }));
  padS.rotation.x = -Math.PI / 2; padS.position.set(-28, 0.02, 0); scene.add(padS);
  const padA = new THREE.Mesh(new THREE.PlaneGeometry(7, 7),
    new THREE.MeshBasicMaterial({ color: 0x35c4b5, transparent: true, opacity: 0.08, depthWrite: false }));
  padA.rotation.x = -Math.PI / 2; padA.position.set(28, 0.02, 0); scene.add(padA);

  // Mid stripe.
  const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.5, MAP_D),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, depthWrite: false }));
  stripe.rotation.x = -Math.PI / 2; stripe.position.set(0, 0.015, 0); scene.add(stripe);

  // Distant skyline silhouettes so the horizon is not void.
  const matSky = new THREE.MeshStandardMaterial({ color: 0x1c1f26, roughness: 1 });
  const rng = mulberry32(99);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + rng() * 0.3;
    const r = 52 + rng() * 22;
    const w = 6 + rng() * 10, h = 8 + rng() * 22;
    const m = new THREE.Mesh(boxGeo, matSky);
    m.scale.set(w, h, w);
    m.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
    scene.add(m);
  }
  return colliders;
}
