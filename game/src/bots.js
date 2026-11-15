// bots.js — AEGIS and STRIKE bots. Each bot is a low-poly figure (body,
// head, gun) with a name, a weapon, and a small brain: follow a BFS path
// through the waypoint graph, engage only with real line-of-sight inside
// a field of view, fire in strafe bursts after a human-like reaction
// delay, and play the objective — escort the planter, hold a site post,
// rotate on a plant, defuse when it is their job.
import * as THREE from 'three';
import { moveCircle, hasLOS, findPath, SITE_A, SITE_B } from './world.js';
import { WEAPONS, ARMOR_FACTOR } from './player.js';

const NAMES = ['Vex', 'Mara', 'Ilya', 'Kestrel', 'Nox', 'Rook', 'Sable'];
const EYE = 1.55;

function rand(a, b) { return a + Math.random() * (b - a); }

export class Bot {
  constructor(scene, id, team, weaponKey) {
    this.id = id; this.team = team; // 'STRIKE' | 'AEGIS'
    this.name = NAMES[id % NAMES.length];
    this.weaponKey = weaponKey;
    this.weapon = WEAPONS[weaponKey];
    this.hp = 100; this.armor = false;
    this.alive = true;
    this.pos = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.vel = new THREE.Vector3();
    this.path = []; this.pathI = 0;
    this.goal = null;           // {x,z,why}
    this.state = 'idle';
    this.react = 0;             // seconds until the bot may fire at a seen enemy
    this.seen = null;           // current target
    this.seenDist = Infinity;
    this.burstLeft = 0; this.burstPause = 0;
    this.lastShot = -10;
    this.ammo = { mag: this.weapon.mag, reserve: this.weapon.reserve };
    this.reloading = 0;
    this.strafeDir = 1; this.strafeT = 0;
    this.aimErr = 0.02;
    this.kills = 0; this.deaths = 0;
    this.planting = 0; this.defusing = 0;
    this.holdUntil = 0;
    this.group = new THREE.Group();
    const col = team === 'STRIKE' ? 0x3f7d4e : 0x9c4a3c;
    const bodyMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.8 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.7 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.85, 0.38), bodyMat);
    body.position.y = 0.95;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xd8b58a, roughness: 0.7 }));
    head.position.y = 1.58;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.09, 0.05), darkMat);
    visor.position.set(0, 1.6, 0.19);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.7), darkMat);
    gun.position.set(0.25, 1.15, 0.3);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.34), darkMat);
    legs.position.y = 0.28;
    this.group.add(body, head, visor, gun, legs);
    this.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    scene.add(this.group);
    this.headMesh = head; this.bodyMesh = body;
  }

  get eye() { return new THREE.Vector3(this.pos.x, this.pos.y + EYE, this.pos.z); }

  spawn(at, yaw) {
    this.pos.copy(at); this.yaw = yaw; this.pitch = 0;
    this.hp = 100; this.alive = true;
    this.ammo = { mag: this.weapon.mag, reserve: this.weapon.reserve };
    this.path = []; this.goal = null; this.state = 'idle';
    this.seen = null; this.seenDist = Infinity; this.react = 0; this.planting = 0; this.defusing = 0;
    this.group.visible = true;
    this.syncMesh();
  }

  syncMesh() {
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw + Math.PI;
  }

  takeDamage(dmg) {
    if (!this.alive) return;
    if (this.armor) dmg *= ARMOR_FACTOR;
    this.hp -= dmg;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; this.deaths++; this.group.visible = false; }
  }

  // Choose a destination from the match context. ctx: { nodes, bomb, round,
  //   planterId, siteTarget, time }.
  decide(ctx) {
    if (!this.alive) return;
    const bomb = ctx.bomb;
    if (this.team === 'STRIKE') {
      if (bomb.planted) { this.setGoal(ctx, { x: bomb.site.x, z: bomb.site.z, why: 'guard' }); return; }
      if (bomb.dropped) { this.setGoal(ctx, { x: bomb.drop.x, z: bomb.drop.z, why: 'recover' }); return; }
      if (this.id === ctx.planterId) {
        if (this.goal?.why === 'plant') return;
        const site = ctx.siteTarget === 'A' ? SITE_A : SITE_B;
        this.setGoal(ctx, { x: site.x, z: site.z, why: 'plant' });
      } else if (this.state === 'idle' || this.goal?.why === 'guard') {
        if (this.goal?.why === 'escort') return; // keep the post, don't re-roll it
        // Escort: trail the planter's route, one waypoint behind.
        const site = ctx.siteTarget === 'A' ? SITE_A : SITE_B;
        const jitter = this.id * 3 - 3;
        this.setGoal(ctx, { x: site.x + jitter, z: site.z + (this.id % 2 ? 4 : -4), why: 'escort' });
      }
      return;
    }
    // AEGIS: hold a site post until the bomb is planted, then rotate.
    if (bomb.planted) { this.setGoal(ctx, { x: bomb.site.x, z: bomb.site.z, why: 'retake' }); return; }
    if (this.goal?.why === 'hold') return; // keep the post, don't re-roll it
    if (this.state === 'idle' || !this.goal) {
      const post = this.id % 2 === 0 ? SITE_A : SITE_B;
      this.setGoal(ctx, { x: post.x + rand(-3, 3), z: post.z + rand(-3, 3), why: 'hold' });
    }
  }

  setGoal(ctx, goal) {
    if (this.goal && this.goal.why === goal.why && Math.hypot(this.goal.x - goal.x, this.goal.z - goal.z) < 1) return;
    this.goal = goal;
    this.path = findPath(ctx.nodes, this.pos, goal.x, goal.z);
    this.pathI = 0;
  }

  // Scan for a visible enemy. enemies: [{pos, eye, alive, isPlayer}].
  // Returns the best target or null. FOV ~100°, LOS required, and the bot
  // needs a reaction delay before it may shoot.
  scan(enemies, dt) {
    if (!this.alive) { this.seen = null; return; }
    let best = null, bd = Infinity;
    for (const e of enemies) {
      if (!e.alive || e.team === this.team) continue; // only the other team
      const d = e.eye.clone().sub(this.eye);
      const dist = d.length();
      if (dist > 32) continue; // beyond this, close the distance instead of staring
      const ang = Math.atan2(-d.x, -d.z);
      let diff = ang - this.yaw;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      if (Math.abs(diff) > 0.9) continue; // ~103° field of view
      if (!hasLOS(this.eye, e.eye)) continue;
      if (dist < bd) { bd = dist; best = e; }
    }
    if (best && (!this.seen || best.ref !== this.seen.ref)) {
      this.react = rand(0.30, 0.52); // human-like reaction time
      this.aimErr = rand(0.012, 0.03);
    }
    this.seen = best;
    this.seenDist = best ? bd : Infinity;
    if (this.react > 0) this.react -= dt;
  }

  // One fixed step. Returns a shot descriptor (like the player's) or null.
  update(dt, ctx, enemies) {
    if (!this.alive) return null;
    this.scan(enemies, dt);
    // Aim at the seen enemy, or along the path.
    if (this.seen) {
      const t = this.seen.eye;
      const dx = t.x - this.pos.x, dz = t.z - this.pos.z;
      const want = Math.atan2(-dx, -dz);
      let diff = want - this.yaw;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      this.yaw += diff * Math.min(1, dt * 9);
      this.pitch += ((t.y - this.eye.y) / Math.max(1, Math.hypot(dx, dz)) - this.pitch) * Math.min(1, dt * 9);
    } else if (this.pathI < this.path.length) {
      const wp = this.path[this.pathI];
      const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
      if (Math.hypot(dx, dz) < 0.7) { this.pathI++; }
      else {
        const want = Math.atan2(-dx, -dz);
        let diff = want - this.yaw;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        this.yaw += diff * Math.min(1, dt * 6);
      }
    }
    // Movement: strafe while fighting up close, otherwise keep walking the
    // path — at long range, close the distance instead of standing still.
    let mx = 0, mz = 0;
    if (this.seen && this.react <= 0 && this.seenDist < 20) {
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafeDir *= -1; this.strafeT = rand(0.4, 1.1); }
      const s = this.strafeDir;
      mx = Math.cos(this.yaw) * s; mz = -Math.sin(this.yaw) * s;
    } else if (this.pathI < this.path.length) {
      const wp = this.path[this.pathI];
      const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      mx = dx / l; mz = dz / l;
    }
    const speed = this.seen ? 2.2 : 4.4;
    this.vel.x += (mx * speed - this.vel.x) * Math.min(1, dt * 8);
    this.vel.z += (mz * speed - this.vel.z) * Math.min(1, dt * 8);
    moveCircle(this.pos, this.vel.x * dt, this.vel.z * dt, 0.4);
    this.syncMesh();
    // Reload when dry.
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        const take = Math.min(this.weapon.mag - this.ammo.mag, this.ammo.reserve);
        this.ammo.mag += take; this.ammo.reserve -= take;
      }
      return null;
    }
    if (this.ammo.mag === 0) {
      if (this.ammo.reserve > 0) { this.reloading = this.weapon.reload; return null; }
      return null;
    }
    // Fire in bursts of 3–6 with pauses between.
    if (this.seen && this.react <= 0) {
      if (this.burstPause > 0) { this.burstPause -= dt; return null; }
      if (this.burstLeft <= 0) { this.burstLeft = 3 + (Math.random() * 4 | 0); }
      const now = ctx.time;
      if (now - this.lastShot >= 60 / this.weapon.rpm) {
        this.lastShot = now;
        this.ammo.mag--;
        this.burstLeft--;
        if (this.burstLeft <= 0) this.burstPause = rand(0.35, 0.8);
        const dir = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
        const spread = this.aimErr + Math.hypot(this.vel.x, this.vel.z) * 0.004;
        dir.x += (Math.random() * 2 - 1) * spread;
        dir.y += (Math.random() * 2 - 1) * spread;
        dir.z += (Math.random() * 2 - 1) * spread;
        dir.normalize();
        return { origin: this.eye, dir, weapon: this.weapon, key: this.weaponKey, shooter: this };
      }
    }
    return null;
  }
}
