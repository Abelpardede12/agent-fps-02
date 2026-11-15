// bots.js — the other seven operators. Each bot is a simple articulated
// figure (legs, torso, head, gun) driven by a small state machine:
// follow the team's plan, path along the waypoint graph, and when an enemy
// is seen — really seen, line of sight and field of view — stop, strafe and
// fire disciplined bursts with human-ish reaction time and aim error.
// Attackers push a site and plant; defenders hold posts, then retake and
// defuse once the charge is down. Nobody shoots through walls: perception
// uses the same LOS test as the bullets.

import * as THREE from 'three';
import { collide, findPath, losClear, SITES } from './world.js';
import { WEAPONS, freshWeapon } from './player.js';

const TEAM_COLORS = {
  strike: { torso: 0xc77f2a, trim: 0xffb340, legs: 0x3a3f47 },
  aegis: { torso: 0x3f5a78, trim: 0xff5a4e, legs: 0x2c313a },
};

let botSeq = 0;

export class Bot {
  constructor(scene, world, team, name) {
    this.id = botSeq++;
    this.kind = 'bot';
    this.team = team;
    this.name = name;
    this.world = world;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.hp = 100;
    this.armor = false;
    this.alive = true;
    this.weapon = freshWeapon(WEAPONS.p9);
    this.path = [];
    this.pathI = 0;
    this.objective = null;      // {x, z} current strategic target
    this.postPos = null;        // defender hold position
    this.thinkAt = 0;
    this.repathAt = 0;
    this.visibleEnemy = null;
    this.lastKnown = null;
    this.lastSeenAt = -1e9;
    this.reactionAt = 0;
    this.burstLeft = 0;
    this.nextShotAt = 0;
    this.burstPauseUntil = 0;
    this.reloadUntil = 0;
    this.strafeDir = 1;
    this.strafeFlipAt = 0;
    this.channeling = false;    // planting or defusing; set by main
    this.deadAt = 0;
    this.fallT = 0;
    this.skill = { reaction: 300 + Math.random() * 220, aimSigma: 0.030 + Math.random() * 0.012 };
    this.buildMesh(scene, team);
  }

  buildMesh(scene, team) {
    const c = TEAM_COLORS[team];
    const g = new THREE.Group();
    const mat = (color, rough = 0.8) => new THREE.MeshStandardMaterial({ color, roughness: rough });
    this.mats = { torso: mat(c.torso), legs: mat(c.legs), head: mat(0xc9a183, 0.65), dark: mat(0x1d2025, 0.6) };
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.52, 0.2), this.mats.legs);
    legL.position.set(-0.11, 0.26, 0);
    const legR = legL.clone(); legR.position.x = 0.11;
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.62, 0.3), this.mats.torso);
    torso.position.y = 0.83;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.09, 0.31), mat(c.trim, 0.5));
    stripe.position.y = 1.02;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.27, 0.27), this.mats.head);
    head.position.y = 1.36;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.07, 0.02), this.mats.dark);
    visor.position.set(0, 1.39, -0.14);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.62), this.mats.dark);
    gun.position.set(0.18, 1.06, -0.3);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.4, 0.11), this.mats.torso);
    arm.position.set(0.18, 0.98, -0.08);
    arm.rotation.x = -0.7;
    g.add(legL, legR, torso, stripe, head, visor, gun, arm);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.mesh = g;
    this.legL = legL; this.legR = legR;
    scene.add(g);
  }

  reset(spawn, weaponId, armor) {
    this.pos.set(spawn.x, 0, spawn.z);
    this.yaw = spawn.yaw;
    this.hp = 100;
    this.alive = true;
    this.armor = !!armor;
    this.weapon = freshWeapon(WEAPONS[weaponId] || WEAPONS.p9);
    this.path = []; this.pathI = 0;
    this.objective = null;
    this.visibleEnemy = null; this.lastKnown = null;
    this.channeling = false;
    this.fallT = 0; this.deadAt = 0;
    this.mesh.rotation.set(0, this.yaw, 0);
    this.mesh.position.copy(this.pos);
    this.mesh.visible = true;
    for (const m of Object.values(this.mats)) { m.transparent = false; m.opacity = 1; }
  }

  eyePos() { return new THREE.Vector3(this.pos.x, 1.5, this.pos.z); }
  chestPos() { return new THREE.Vector3(this.pos.x, 1.0, this.pos.z); }

  // Sphere test used by the shared shot resolver: head, chest, legs.
  rayHit(origin, dir, maxDist) {
    const parts = [
      { y: 1.38, r: 0.21, head: true },
      { y: 0.92, r: 0.40, head: false },
      { y: 0.38, r: 0.36, head: false },
    ];
    let best = null;
    for (const p of parts) {
      const cx = this.pos.x, cy = p.y, cz = this.pos.z;
      const ox = cx - origin.x, oy = cy - origin.y, oz = cz - origin.z;
      const t = ox * dir.x + oy * dir.y + oz * dir.z;
      if (t < 0 || t > maxDist) continue;
      const px = origin.x + dir.x * t, py = origin.y + dir.y * t, pz = origin.z + dir.z * t;
      const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
      if (d2 <= p.r * p.r && (!best || t < best.dist)) best = { dist: t, head: p.head };
    }
    return best;
  }

  takeDamage(amount) {
    if (!this.alive) return false;
    const dmg = this.armor ? amount * 0.55 : amount;
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.hp = 0; this.alive = false;
      this.deadAt = performance.now();
      return true;
    }
    return false;
  }

  setObjective(x, z, now) {
    if (this.objective && Math.hypot(this.objective.x - x, this.objective.z - z) < 0.5 && this.path.length) return;
    this.objective = { x, z };
    this.path = findPath(this.world.nodes, this.pos.x, this.pos.z, x, z);
    this.pathI = 0;
    this.repathAt = now + 2600;
  }

  update(dt, now, ctx) {
    if (!this.alive) {
      // Death: topple, then sink away after a few seconds.
      if (this.fallT < 1) {
        this.fallT = Math.min(1, this.fallT + dt * 2.6);
        this.mesh.rotation.x = -Math.PI / 2 * this.fallT;
        this.mesh.position.y = -0.1 * this.fallT;
      } else if (now - this.deadAt > 4200) {
        this.mesh.position.y = Math.max(-1.7, this.mesh.position.y - dt * 0.5);
      }
      return;
    }
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw;

    if (this.channeling) return; // planting/defusing: rooted, main runs the clock

    if (now >= this.thinkAt) {
      this.thinkAt = now + 110 + Math.random() * 40;
      this.perceive(now, ctx);
      this.decide(now, ctx);
    }
    this.act(dt, now, ctx);
  }

  perceive(now, ctx) {
    const eye = this.eyePos();
    let best = null, bestD = Infinity;
    for (const e of ctx.enemies) {
      if (!e.alive) continue;
      const ep = e.kind === 'player' ? e.eyePos() : e.chestPos();
      const d = Math.hypot(ep.x - eye.x, ep.z - eye.z);
      if (d > 58) continue;
      // Field of view: 110°, unless the enemy is close enough to hear.
      const ang = Math.atan2(-(ep.x - eye.x), -(ep.z - eye.z));
      let da = Math.abs(((ang - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (da > 1.9 && d > 6) continue;
      if (!losClear(ctx.colliders, eye.x, eye.z, ep.x, ep.z)) continue;
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best) {
      if (this.visibleEnemy !== best) this.reactionAt = now + this.skill.reaction;
      this.visibleEnemy = best;
      this.lastKnown = { x: best.pos.x, z: best.pos.z };
      this.lastSeenAt = now;
    } else if (now - this.lastSeenAt > 2600) {
      this.visibleEnemy = null;
    }
  }

  decide(now, ctx) {
    const g = ctx.game;
    if (this.visibleEnemy) return; // combat is handled in act()
    if (this.team === 'strike') {
      if (g.bombState === 'planted') {
        // Defend the charge: hold a ring around the site.
        const s = SITES[g.bombSite];
        const slot = ctx.defendSlot(this, s);
        this.setObjective(slot.x, slot.z, now);
      } else if (g.planter === this && g.bombState === 'carried') {
        const s = SITES[g.targetSite];
        this.setObjective(s.x, s.z, now);
        if (Math.hypot(this.pos.x - s.x, this.pos.z - s.z) < 2.2) ctx.requestPlant(this);
      } else if (g.bombState === 'dropped' && g.bombPos) {
        // The charge is on the ground: go and pick it up.
        this.setObjective(g.bombPos.x, g.bombPos.z, now);
      } else if (this.lastKnown && now - this.lastSeenAt < 5000) {
        this.setObjective(this.lastKnown.x, this.lastKnown.z, now);
      } else {
        // Escort: move with the push toward the target site, fanned out.
        const s = SITES[g.targetSite];
        const slot = ctx.escortSlot(this, s);
        this.setObjective(slot.x, slot.z, now);
      }
    } else {
      // AEGIS
      if (g.bombState === 'planted') {
        const bp = g.bombPos;
        if (Math.hypot(this.pos.x - bp.x, this.pos.z - bp.z) < 1.4) ctx.requestDefuse(this);
        else this.setObjective(bp.x, bp.z, now);
      } else if (g.bombState === 'dropped' && g.bombPos) {
        // Camp the dropped charge from a few metres out.
        const a = (this.id * 1.7) % (Math.PI * 2);
        this.setObjective(g.bombPos.x + Math.cos(a) * 6, g.bombPos.z + Math.sin(a) * 6, now);
      } else if (this.lastKnown && now - this.lastSeenAt < 5000) {
        this.setObjective(this.lastKnown.x, this.lastKnown.z, now);
      } else if (this.postPos) {
        this.setObjective(this.postPos.x, this.postPos.z, now);
      }
    }
    if (now >= this.repathAt && this.objective) {
      this.path = findPath(this.world.nodes, this.pos.x, this.pos.z, this.objective.x, this.objective.z);
      this.pathI = 0;
      this.repathAt = now + 2600;
    }
  }

  act(dt, now, ctx) {
    const enemy = this.visibleEnemy;
    if (enemy && enemy.alive) {
      // Face the enemy, strafe in short jinks, fire bursts once reacted.
      const ep = enemy.kind === 'player' ? enemy.eyePos() : enemy.chestPos();
      const wantYaw = Math.atan2(-(ep.x - this.pos.x), -(ep.z - this.pos.z));
      this.turnToward(wantYaw, dt * 9);
      const dist = Math.hypot(ep.x - this.pos.x, ep.z - this.pos.z);
      if (now >= this.strafeFlipAt) {
        this.strafeFlipAt = now + 650 + Math.random() * 800;
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
        if (dist < 7) this.strafeDir = 0; // too close: hold and shoot
      }
      if (this.strafeDir !== 0) {
        const px = Math.cos(this.yaw) * this.strafeDir, pz = -Math.sin(this.yaw) * this.strafeDir;
        this.move(px, pz, 2.1, dt);
      }
      this.combatFire(now, ctx, enemy, dist);
      return;
    }
    // Travel along the path.
    if (this.pathI < this.path.length) {
      const t = this.path[this.pathI];
      const dx = t.x - this.pos.x, dz = t.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.75) { this.pathI++; return; }
      const wantYaw = Math.atan2(-dx, -dz);
      this.turnToward(wantYaw, dt * 7);
      this.move(dx / d, dz / d, 4.6, dt);
      // Walk cycle: swing the legs while travelling.
      const sw = Math.sin(now * 0.011) * 0.5;
      this.legL.rotation.x = sw; this.legR.rotation.x = -sw;
    } else {
      this.legL.rotation.x = 0; this.legR.rotation.x = 0;
      // Holding a post: scan slowly.
      if (this.team === 'aegis' && !this.objective) return;
      this.yaw += Math.sin(now * 0.0006 + this.id * 2.1) * dt * 0.25;
    }
  }

  combatFire(now, ctx, enemy, dist) {
    const w = this.weapon;
    if (this.reloadUntil) {
      if (now >= this.reloadUntil) {
        const need = w.def.mag - w.mag;
        const take = Math.min(need, w.reserve);
        w.mag += take; w.reserve -= take;
        this.reloadUntil = 0;
      } else return;
    }
    if (now < this.reactionAt || now < this.burstPauseUntil) return;
    if (w.mag <= 0) { this.reloadUntil = now + w.def.reloadMs; return; }
    if (now < this.nextShotAt) return;
    this.nextShotAt = now + w.def.rofMs;
    if (this.burstLeft <= 0) this.burstLeft = 3 + (Math.random() * 3 | 0);
    this.burstLeft--;
    if (this.burstLeft === 0) this.burstPauseUntil = now + 380 + Math.random() * 420;
    w.mag -= 1;
    // Aim at chest, sometimes the head; error grows with range and target speed.
    const target = enemy.kind === 'player' ? enemy.eyePos() : enemy.chestPos();
    target.y -= enemy.kind === 'player' ? 0.28 : 0;
    if (Math.random() < 0.22) target.y += 0.42; // head attempt
    const origin = this.eyePos(); origin.y -= 0.12;
    const dir = target.sub(origin).normalize();
    const sigma = this.skill.aimSigma * (dist > 25 ? 1.35 : 1);
    dir.x += (Math.random() + Math.random() - 1) * sigma;
    dir.y += (Math.random() + Math.random() - 1) * sigma * 0.7;
    dir.z += (Math.random() + Math.random() - 1) * sigma;
    dir.normalize();
    ctx.events.shoot(this, origin, dir, w);
  }

  turnToward(want, speed) {
    let d = ((want - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.yaw += THREE.MathUtils.clamp(d, -speed, speed);
  }

  move(dx, dz, speed, dt) {
    const nx = this.pos.x + dx * speed * dt;
    const nz = this.pos.z + dz * speed * dt;
    const [cx, cz] = collide(this.world.colliders, nx, nz, 0.45);
    this.pos.x = cx; this.pos.z = cz;
  }
}
