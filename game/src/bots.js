// SUNDER — bots.js
// The seven bot opponents/teammates: their figures and their AI. One job: make a bot
// that moves through the map, sees, reacts and shoots back — and plays the objective.
// Bots share the map, the waypoint graph and the shot resolver with the player.
import * as THREE from 'three';
import { WEAPONS } from './player.js';
import { SITES as SITES_OF, findPath, hasLOS, inSite, moveCircle } from './world.js';

export const BOT_EYE = 1.55;
const BOT_RADIUS = 0.4;

const NAMES_STRIKE = ['VEX', 'ORIN', 'KESS'];
const NAMES_AEGIS = ['HALD', 'MIRA', 'SORREN', 'TAMSIN'];

const SPEEDS = { P9: 4.4, VK9: 4.2, AR7: 3.8, LONGSHOT: 3.2 };

// How a bot aims: angular error in radians, shrinks the longer it sees its target.
function aimError(bot, dist, targetSpeed) {
  const base = bot.skill * 0.032 + dist * 0.0006 + targetSpeed * 0.004;
  const settle = Math.max(0.3, 1 - bot.seenFor * 0.8);
  return base * settle;
}

export class Bot {
  constructor(id, team, name, color) {
    this.id = id;
    this.team = team; // 'strike' | 'aegis'
    this.name = name;
    this.color = color;
    this.pos = new THREE.Vector3(0, 0, 0);
    this.yaw = 0;
    this.hp = 100;
    this.armor = false;
    this.alive = true;
    this.kills = 0;
    this.deaths = 0;
    this.weaponId = 'P9';
    this.mag = 12;
    this.cooldown = 0;
    this.reloadTimer = 0;
    this.skill = 0.6 + Math.random() * 0.5; // 0.6..1.1, higher = worse aim
    // AI state
    this.state = 'idle'; // idle | move | engage | plant | defuse | hold
    this.path = null;
    this.pathIdx = 0;
    this.repathAt = 0;
    this.objective = null; // {x, z, kind}
    this.target = null; // agent currently engaged
    this.seenFor = 0;
    this.reactAt = 0;
    this.burstLeft = 0;
    this.burstTimer = 0;
    this.strafeDir = 1;
    this.strafeAt = 0;
    this.blindUntil = 0;
    this.lastKnown = null; // {x, z} of last shooter / seen enemy
    this.plantProgress = 0;
    this.defuseProgress = 0;
    this.stuckAt = 0;
    this.stuckPos = new THREE.Vector3();
    this.post = null; // hold position {x, z}
    this.mesh = this.buildMesh();
  }

  buildMesh() {
    const g = new THREE.Group();
    const suit = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.7, metalness: 0.15 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.8, metalness: 0.2 });
    const visor = new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.25, metalness: 0.7 });
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.72, 0.32), dark);
    legs.position.y = 0.36;
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.72, 0.38), suit);
    torso.position.y = 1.06;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.32, 0.34), dark);
    head.position.y = 1.6;
    const visorM = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.05), visor);
    visorM.position.set(0, 1.62, -0.17);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.62), dark);
    gun.position.set(0.2, 1.15, -0.3);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.06, 0.4),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: this.color, emissiveIntensity: 0.5 }));
    stripe.position.y = 1.28;
    g.add(legs, torso, head, visorM, gun, stripe);
    g.userData.head = head;
    g.userData.torso = torso;
    return g;
  }

  resetRound(x, z, yaw, weaponId, armor) {
    this.pos.set(x, 0, z);
    this.yaw = yaw;
    this.hp = 100;
    this.armor = armor;
    this.alive = true;
    this.weaponId = weaponId;
    this.mag = WEAPONS[weaponId].mag;
    this.cooldown = 0;
    this.reloadTimer = 0;
    this.state = 'idle';
    this.path = null;
    this.target = null;
    this.seenFor = 0;
    this.burstLeft = 0;
    this.blindUntil = 0;
    this.plantProgress = 0;
    this.defuseProgress = 0;
    this.mesh.visible = true;
    this.mesh.rotation.set(0, yaw, 0);
    this.mesh.position.set(x, 0, z);
  }

  weapon() { return WEAPONS[this.weaponId]; }

  eyePos() { return new THREE.Vector3(this.pos.x, BOT_EYE, this.pos.z); }

  takeDamage(amount, isHead) {
    if (!this.alive) return 0;
    let dmg = amount;
    if (this.armor) dmg *= isHead ? 0.7 : 0.55;
    this.hp -= dmg;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; this.deaths += 1; }
    return dmg;
  }

  die() {
    this.alive = false;
    this.mesh.rotation.set(0, this.yaw, Math.PI / 2);
    this.mesh.position.y = 0.25;
  }

  setObjective(kind, x, z) {
    if (!this.objective || this.objective.kind !== kind || this.objective.x !== x || this.objective.z !== z) {
      this.objective = { kind, x, z };
      this.path = null;
    }
  }

  followPath(dt, ctx, speed) {
    if (!this.path || this.pathIdx >= this.path.length) return true; // arrived
    const wp = this.path[this.pathIdx];
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.6) { this.pathIdx += 1; return this.pathIdx >= this.path.length; }
    const vx = (dx / d) * speed, vz = (dz / d) * speed;
    const moved = moveCircle(this.pos.x, this.pos.z, vx * dt, vz * dt, BOT_RADIUS, ctx.colliders);
    this.pos.x = moved.x;
    this.pos.z = moved.z;
    this.yaw = Math.atan2(-vx, -vz);
    return false;
  }

  // Pick the best visible enemy: real line-of-sight, inside a 100-degree cone, < 45 m.
  scanEnemies(ctx) {
    const eye = this.eyePos();
    let best = null, bestD = Infinity;
    for (const other of ctx.agents) {
      if (other === this || !other.alive || other.team === this.team) continue;
      const op = other.eyePos ? other.eyePos() : other.pos;
      const dx = op.x - eye.x, dy = op.y - eye.y, dz = op.z - eye.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 45 || d < 0.5) continue;
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const dot = (dx * fx + dz * fz) / d;
      if (dot < 0.25) continue; // outside ~100-degree field of view
      if (!hasLOS(eye.x, eye.y, eye.z, op.x, op.y - 0.25, op.z, ctx.colliders)) continue;
      if (d < bestD) { bestD = d; best = other; }
    }
    return best ? { enemy: best, dist: bestD } : null;
  }

  update(dt, ctx) {
    const now = ctx.now;
    if (!this.alive) return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this.mag = this.weapon().mag;
    }
    const blinded = now < this.blindUntil;
    // --- perception ---
    const seen = blinded ? null : this.scanEnemies(ctx);
    if (seen) {
      if (this.target !== seen.enemy) {
        this.target = seen.enemy;
        this.seenFor = 0;
        this.reactAt = now + 0.3 + ctx.rng() * 0.22; // 300-520 ms reaction
        this.burstLeft = 0;
      } else {
        this.seenFor += dt;
      }
      const tp = seen.enemy.pos;
      this.lastKnown = { x: tp.x, z: tp.z };
    } else if (this.target) {
      this.seenFor = 0;
      if (this.target.alive === false) this.target = null;
      else if (now - (this.targetSeenAt || 0) > 1.2) this.target = null;
    }
    if (seen) this.targetSeenAt = now;

    // --- combat: strafe bursts once reacted ---
    if (this.target && this.target.alive && !blinded && now >= this.reactAt) {
      this.state = 'engage';
      const tp = this.target.pos;
      const dx = tp.x - this.pos.x, dz = tp.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const wantYaw = Math.atan2(-dx, -dz);
      this.yaw = wantYaw;
      if (now > this.strafeAt) { this.strafeDir *= -1; this.strafeAt = now + 0.5 + ctx.rng() * 0.7; }
      // Strafe sideways while firing, slow down to aim.
      const px = -dz / (d || 1), pz = dx / (d || 1);
      const sp = SPEEDS[this.weaponId] * 0.45;
      const moved = moveCircle(this.pos.x, this.pos.z,
        px * this.strafeDir * sp * dt, pz * this.strafeDir * sp * dt, BOT_RADIUS, ctx.colliders);
      this.pos.x = moved.x; this.pos.z = moved.z;
      if (this.burstLeft <= 0 && this.burstTimer <= 0) {
        this.burstLeft = 4 + Math.floor(ctx.rng() * 3);
        this.burstTimer = 0.45 + ctx.rng() * 0.45;
      }
      if (this.burstLeft > 0 && this.cooldown <= 0 && this.reloadTimer <= 0) {
        if (this.mag <= 0) {
          this.reloadTimer = this.weapon().reload;
          this.burstLeft = 0;
        } else {
          const w = this.weapon();
          const err = aimError(this, d, this.target.speed2d || 0);
          const spread = (this.weaponId === 'LONGSHOT' ? 0.004 : w.spread * 1.2) + err;
          const eye = this.eyePos();
          const aimAt = new THREE.Vector3(tp.x, tp.y + 1.2, tp.z);
          const dir = aimAt.sub(eye).normalize();
          const yaw = Math.atan2(-dir.x, -dir.z) + (ctx.rng() * 2 - 1) * spread;
          const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y))) + (ctx.rng() * 2 - 1) * spread;
          const shot = new THREE.Vector3(
            -Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
          ctx.shoot(this, eye, shot, this.weaponId);
          this.mag -= 1;
          this.cooldown = 60 / w.rpm;
          this.burstLeft -= 1;
          if (this.burstLeft <= 0) this.burstTimer = 0.5 + ctx.rng() * 0.5;
        }
      }
      this.burstTimer = Math.max(0, this.burstTimer - dt);
      this.syncMesh();
      return;
    }
    this.burstTimer = Math.max(0, this.burstTimer - dt);

    // --- objective behaviour ---
    if (blinded) {
      // Flashed: hold still, no shooting.
      this.syncMesh();
      return;
    }
    const bomb = ctx.bomb;
    if (this.team === 'strike') {
      if (bomb.state === 'planted') {
        // Guard the planted charge: hold inside the site.
        const site = SITES_OF[bomb.site];
        this.setObjective('hold', site.cx + (ctx.rng() - 0.5) * 4, site.cz + (ctx.rng() - 0.5) * 3);
        this.moveToObjective(dt, ctx);
      } else if (bomb.carrier === this && bomb.state === 'carried') {
        // Carry to the assigned site and plant.
        const site = SITES_OF[this.siteKey];
        if (inSite(site, this.pos.x, this.pos.z)) {
          this.state = 'plant';
          this.plantProgress += dt;
          this.faceSiteCentre(site);
          if (this.plantProgress >= 3) ctx.onPlant(this);
        } else {
          this.setObjective('site', site.cx, site.cz);
          this.moveToObjective(dt, ctx);
        }
      } else if (bomb.state === 'dropped') {
        this.setObjective('charge', bomb.pos.x, bomb.pos.z);
        this.moveToObjective(dt, ctx);
        if (Math.hypot(bomb.pos.x - this.pos.x, bomb.pos.z - this.pos.z) < 1.4) ctx.onPickup(this);
      } else {
        // Escort the carrier (or the player carrier): trail 4 m behind.
        const c = ctx.carrierAgent();
        if (c && c !== this) {
          const ox = c.pos.x - 4 * Math.sin(c.yaw || 0), oz = c.pos.z - 4 * Math.cos(c.yaw || 0);
          this.setObjective('escort', ox, oz);
          this.moveToObjective(dt, ctx);
        } else {
          const site = SITES_OF[this.siteKey];
          this.setObjective('site', site.cx, site.cz);
          this.moveToObjective(dt, ctx);
        }
      }
    } else {
      // AEGIS
      if (bomb.state === 'planted') {
        if (Math.hypot(bomb.pos.x - this.pos.x, bomb.pos.z - this.pos.z) < 1.8) {
          this.state = 'defuse';
          this.defuseProgress += dt;
          if (this.defuseProgress >= 5) ctx.onDefuse(this);
        } else {
          this.setObjective('bomb', bomb.pos.x, bomb.pos.z);
          this.moveToObjective(dt, ctx);
        }
      } else if (this.post) {
        // Hold the assigned post; rotate to the other site on plant handled above.
        if (Math.hypot(this.post.x - this.pos.x, this.post.z - this.pos.z) > 1.2) {
          this.setObjective('post', this.post.x, this.post.z);
          this.moveToObjective(dt, ctx);
        } else {
          this.state = 'hold';
          this.yaw += dt * 0.25; // slow scan
        }
      }
    }
    this.syncMesh();
  }

  moveToObjective(dt, ctx) {
    this.state = 'move';
    if (!this.path || ctx.now > this.repathAt) {
      const o = this.objective;
      this.path = findPath(ctx.graph, this.pos.x, this.pos.z, o.x, o.z);
      this.pathIdx = 0;
      this.repathAt = ctx.now + 2.5;
      this.stuckAt = ctx.now;
      this.stuckPos.copy(this.pos);
    }
    const arrived = this.followPath(dt, ctx, SPEEDS[this.weaponId]);
    if (arrived) this.path = null;
    // Stuck detection: barely moved in 2 s -> repath with a jittered target.
    if (ctx.now - this.stuckAt > 2) {
      const moved = Math.hypot(this.pos.x - this.stuckPos.x, this.pos.z - this.stuckPos.z);
      if (moved < 0.3 && this.objective) {
        const o = this.objective;
        this.path = findPath(ctx.graph, this.pos.x, this.pos.z,
          o.x + (ctx.rng() - 0.5) * 6, o.z + (ctx.rng() - 0.5) * 6);
        this.pathIdx = 0;
      }
      this.stuckAt = ctx.now;
      this.stuckPos.copy(this.pos);
    }
  }

  faceSiteCentre(site) {
    const dx = site.cx - this.pos.x, dz = site.cz - this.pos.z;
    this.yaw = Math.atan2(-dx, -dz);
  }

  syncMesh() {
    this.mesh.position.set(this.pos.x, 0, this.pos.z);
    this.mesh.rotation.set(0, this.yaw, 0);
  }
}

export function makeBots(scene) {
  const bots = [];
  NAMES_STRIKE.forEach((n, i) => {
    const b = new Bot(`s${i}`, 'strike', n, 0xf0a830);
    scene.add(b.mesh);
    bots.push(b);
  });
  NAMES_AEGIS.forEach((n, i) => {
    const b = new Bot(`a${i}`, 'aegis', n, 0x35c4b5);
    scene.add(b.mesh);
    bots.push(b);
  });
  return bots;
}
