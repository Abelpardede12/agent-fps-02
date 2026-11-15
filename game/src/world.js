// world.js — SUNDER map: one shared collider set drives movement, bullet
// raycasts and bot line-of-sight, so what you see is what the sim uses.
// Arena 64 x 48 (x -32..32, z -24..24). STRIKE spawns west, AEGIS east.
// Mid wall splits the map with a centre gap; long corridors run north and
// south; sites A (north-west) and B (south-east) are walled yards with
// door gaps; crates give cover everywhere in between.
import * as THREE from 'three';

// A solid is an axis-aligned box: [minX, maxX, minZ, maxZ, topY].
// Walls are 4 high, crates 1.1–1.6 high.
const WALL_H = 4;
function box(x0, x1, z0, z1, h = WALL_H) { return [x0, x1, z0, z1, h]; }

export const MAP = { halfX: 32, halfZ: 24, wallH: WALL_H };
export const SITE_A = new THREE.Vector3(-16, 0, -15);
export const SITE_B = new THREE.Vector3(16, 0, 15);
export const SITE_R = 4.5;
export const SPAWN_STRIKE = [
  new THREE.Vector3(-29, 0, -3), new THREE.Vector3(-29, 0, 0),
  new THREE.Vector3(-29, 0, 3), new THREE.Vector3(-27, 0, 0),
];
export const SPAWN_AEGIS = [
  new THREE.Vector3(29, 0, -3), new THREE.Vector3(29, 0, 0),
  new THREE.Vector3(29, 0, 3), new THREE.Vector3(27, 0, 0),
];

function buildSolids() {
  const s = [];
  // Perimeter.
  s.push(box(-33, 33, -25, -24), box(-33, 33, 24, 25));
  s.push(box(-33, -32, -24, 24), box(32, 33, -24, 24));
  // Mid wall at x = 0 with a centre gap (z -4..4 open).
  s.push(box(-0.5, 0.5, -24, -4), box(-0.5, 0.5, 4, 24));
  // Site A yard (north-west): walls with a door gap on the east side
  // (z -16..-12) and on the south side (x -14..-10).
  s.push(box(-24, -8, -22, -21));            // north wall
  s.push(box(-24, -23, -22, -8));            // west wall
  s.push(box(-8, -7, -22, -16), box(-8, -7, -12, -8)); // east wall, gap
  s.push(box(-24, -14, -8, -7), box(-10, -8, -8, -7)); // south wall, gap
  // Site B yard (south-east): door gap on the west side (z 12..16) and
  // on the north side (x 10..14).
  s.push(box(8, 24, 21, 22));                // south wall
  s.push(box(23, 24, 8, 22));                // east wall
  s.push(box(7, 8, 8, 12), box(7, 8, 16, 22)); // west wall, gap
  s.push(box(8, 10, 7, 8), box(14, 24, 7, 8)); // north wall, gap
  // Long-corridor cover: low blocks hugging the north and south lanes.
  s.push(box(-12, -8, -21, -19, 1.4), box(8, 12, -21, -19, 1.4));
  s.push(box(-12, -8, 19, 21, 1.4), box(8, 12, 19, 21, 1.4));
  // Mid crates — the crossfire cover both teams play around. Kept clear of
  // the centre-gap corridor (x -4..4, z -4..4) so the waypoint graph stays
  // connected across the mid wall.
  s.push(box(-7, -4, 5, 8, 1.2), box(4, 7, -8, -5, 1.2));
  s.push(box(-4, -1, 8, 11, 1.5), box(1, 4, -11, -8, 1.5));
  s.push(box(-18, -15, 2, 5, 1.2), box(15, 18, -5, -2, 1.2));
  s.push(box(-10, -7, -14, -11, 1.3), box(7, 10, 11, 14, 1.3));
  return s;
}

export const SOLIDS = buildSolids();

// 2D point-in-solid test (movement uses the XZ footprint).
export function blockedAt(x, z, r = 0.4) {
  for (const b of SOLIDS) {
    if (x + r > b[0] && x - r < b[1] && z + r > b[2] && z - r < b[3]) return true;
  }
  return Math.abs(x) > MAP.halfX - r || Math.abs(z) > MAP.halfZ - r;
}

// Slide a circle (player/bot) along X then Z, stopping at solids.
export function moveCircle(p, dx, dz, r = 0.4) {
  const nx = p.x + dx;
  if (!blockedAt(nx, p.z, r)) p.x = nx;
  const nz = p.z + dz;
  if (!blockedAt(p.x, nz, r)) p.z = nz;
  p.x = Math.max(-MAP.halfX + r, Math.min(MAP.halfX - r, p.x));
  p.z = Math.max(-MAP.halfZ + r, Math.min(MAP.halfZ - r, p.z));
}

// Ray vs solids (slab test) + floor plane. Returns { dist, point } or null.
export function raycast(origin, dir, maxDist = 200) {
  let best = null;
  if (dir.y < -1e-6) {
    const t = -origin.y / dir.y;
    if (t > 0 && t < maxDist) best = { dist: t, point: origin.clone().addScaledVector(dir, t) };
  }
  for (const b of SOLIDS) {
    let tmin = 0, tmax = maxDist;
    const o = [origin.x, origin.y, origin.z], d = [dir.x, dir.y, dir.z];
    const mn = [b[0], 0, b[2]], mx = [b[1], b[4], b[3]];
    let ok = true;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < mn[i] || o[i] > mx[i]) { ok = false; break; } }
      else {
        let t1 = (mn[i] - o[i]) / d[i], t2 = (mx[i] - o[i]) / d[i];
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { ok = false; break; }
      }
    }
    if (ok && tmin > 0.001 && tmin < maxDist && (!best || tmin < best.dist)) {
      best = { dist: tmin, point: origin.clone().addScaledVector(dir, tmin) };
    }
  }
  return best;
}

// True when nothing solid sits between two eye points.
export function hasLOS(a, b) {
  const d = b.clone().sub(a);
  const len = d.length();
  if (len < 0.01) return true;
  d.divideScalar(len);
  const hit = raycast(a, d, len - 0.15);
  return !hit;
}

// ---- Waypoint graph + BFS (bots navigate the same map the player runs) ----
const STEP = 4;
function gridKey(ix, iz) { return ix + ',' + iz; }

export function buildWaypoints() {
  const nodes = new Map();
  for (let ix = -7; ix <= 7; ix++) for (let iz = -5; iz <= 5; iz++) {
    const x = ix * STEP, z = iz * STEP;
    if (blockedAt(x, z, 0.7)) continue;
    nodes.set(gridKey(ix, iz), { ix, iz, x, z, links: [] });
  }
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const n of nodes.values()) {
    for (const [dx, dz] of dirs) {
      const m = nodes.get(gridKey(n.ix + dx, n.iz + dz));
      if (!m) continue;
      if (dx && dz) { // no cutting corners through a wall
        if (!nodes.get(gridKey(n.ix + dx, n.iz)) || !nodes.get(gridKey(n.ix, n.iz + dz))) continue;
      }
      n.links.push(m);
    }
  }
  return nodes;
}

export function nearestNode(nodes, x, z) {
  let best = null, bd = Infinity;
  for (const n of nodes.values()) {
    const d = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

// BFS from a node to a target point; returns a list of {x,z} waypoints.
export function findPath(nodes, from, tx, tz) {
  const start = nearestNode(nodes, from.x, from.z);
  const goal = nearestNode(nodes, tx, tz);
  if (!start || !goal) return [{ x: tx, z: tz }];
  const prev = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === goal) break;
    for (const nb of cur.links) if (!prev.has(nb)) { prev.set(nb, cur); queue.push(nb); }
  }
  if (!prev.has(goal)) return [{ x: tx, z: tz }];
  const out = [];
  for (let n = goal; n; n = prev.get(n)) out.unshift({ x: n.x, z: n.z });
  out.push({ x: tx, z: tz });
  return out;
}

// ---- Scene dressing (visual only; colliders above are the truth) ----
export function buildScene(scene) {
  const matFloor = new THREE.MeshStandardMaterial({ color: 0x3d4149, roughness: 0.95 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(66, 50), matFloor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const matWall = new THREE.MeshStandardMaterial({ color: 0x59606e, roughness: 0.85 });
  const matWallB = new THREE.MeshStandardMaterial({ color: 0x4a4f5c, roughness: 0.85 });
  const matCrate = new THREE.MeshStandardMaterial({ color: 0x8a6d3b, roughness: 0.8 });
  const matCrateB = new THREE.MeshStandardMaterial({ color: 0x5d7a52, roughness: 0.8 });
  const geoBox = new THREE.BoxGeometry(1, 1, 1);
  for (const b of SOLIDS) {
    const w = b[1] - b[0], h = b[4], d = b[3] - b[2];
    const m = new THREE.Mesh(geoBox, h >= WALL_H ? (Math.abs(b[0] + b[1]) < 2 ? matWallB : matWall) : (w > 2.5 ? matCrateB : matCrate));
    m.scale.set(w, h, d);
    m.position.set((b[0] + b[1]) / 2, h / 2, (b[2] + b[3]) / 2);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  }
  // Site markers: glowing floor rings so the objective reads at a glance.
  for (const [site, color] of [[SITE_A, 0xffb020], [SITE_B, 0x20c8ff]]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(SITE_R - 0.35, SITE_R, 40),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.75 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(site.x, 0.02, site.z);
    scene.add(ring);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.2, 8),
      new THREE.MeshBasicMaterial({ color }));
    pole.position.set(site.x, 1.6, site.z);
    scene.add(pole);
  }
  // Site letters on a canvas texture (no network).
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = '#20242c'; g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#ffb020'; g.font = 'bold 44px sans-serif'; g.textAlign = 'center';
  g.fillText('A', 64, 50); g.fillStyle = '#20c8ff'; g.fillText('B', 192, 50);
  const tex = new THREE.CanvasTexture(canvas);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(8, 2),
    new THREE.MeshBasicMaterial({ map: tex }));
  sign.position.set(0, 3.4, -24.4);
  scene.add(sign);
}
