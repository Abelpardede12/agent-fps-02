// main.js — SUNDER: a round-based tactical FPS in three.js.
// One Game owns the state (match, economy, bomb, HUD); the simulation runs
// on a fixed 60 Hz step apart from rendering. Player and bots fire through
// the same resolver (resolveShot), so a hit is a hit whoever pulled it.
// Deterministic render modes for screenshots: ?shot=start (menu),
// ?shot=play (live round), ?shot=end (victory screen), with &seed=N.
import * as THREE from 'three';
import { buildScene, buildWaypoints, raycast, hasLOS, SITE_A, SITE_B, SITE_R, SPAWN_STRIKE, SPAWN_AEGIS } from './world.js';
import { Player, WEAPONS, KEVLAR_PRICE } from './player.js';
import { Bot } from './bots.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot');
const SEED = params.get('seed');

// Seeded RNG for deterministic renders (screenshots / smoke tests).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
if (SEED !== null) Math.random = mulberry32(parseInt(SEED, 10) || 1);

// ---- Sound: tiny WebAudio synth, no audio files ----
class Sfx {
  constructor() { this.ctx = null; }
  ensure() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ } }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  blip(freq, dur, type = 'sine', vol = 0.15, slide = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t); o.stop(t + dur);
  }
  noise(dur, vol = 0.25, low = 400) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const len = Math.max(1, (dur * this.ctx.sampleRate) | 0);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = low;
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(f).connect(g).connect(this.ctx.destination);
    src.start(t);
  }
  shot(key) { this.noise(0.09, 0.3, key === 'LONGSHOT' ? 900 : 2400); this.blip(180, 0.06, 'square', 0.08, -120); }
  enemyShot() { this.noise(0.07, 0.12, 1800); }
  hit() { this.blip(1200, 0.05, 'sine', 0.12); }
  kill() { this.blip(880, 0.07, 'sine', 0.14); this.blip(1320, 0.09, 'sine', 0.12); }
  reload() { this.blip(500, 0.04, 'square', 0.07); }
  plant() { this.blip(700, 0.1, 'sine', 0.15); }
  beep() { this.blip(1000, 0.08, 'sine', 0.12); }
  boom() { this.noise(0.7, 0.5, 220); this.blip(60, 0.6, 'sine', 0.3, -30); }
  win() { [523, 659, 784].forEach((f, i) => setTimeout(() => this.blip(f, 0.18, 'sine', 0.15), i * 120)); }
  lose() { [392, 330, 262].forEach((f, i) => setTimeout(() => this.blip(f, 0.2, 'sine', 0.12), i * 140)); }
}

// ---- Shared hitscan resolver: walls first, then bodies ----
// A body is a vertical capsule (r 0.35, y 0.45..1.5) plus a head sphere
// (centre y 1.58, r 0.24). Returns { target, part, dist, point } or null.
function rayVsBody(origin, dir, targetPos) {
  const ox = origin.x - targetPos.x, oz = origin.z - targetPos.z;
  const dx = dir.x, dz = dir.z;
  const a = dx * dx + dz * dz;
  let best = null;
  if (a > 1e-9) {
    const b = 2 * (ox * dx + oz * dz), c = ox * ox + oz * oz - 0.35 * 0.35;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t > 0.001) {
        const y = origin.y + dir.y * t;
        if (y >= 0.45 && y <= 1.5) best = { dist: t, part: 'body' };
      }
    }
  }
  // Head sphere.
  const hx = targetPos.x - origin.x, hy = 1.58 - origin.y, hz = targetPos.z - origin.z;
  const tca = hx * dir.x + hy * dir.y + hz * dir.z;
  if (tca > 0) {
    const d2 = hx * hx + hy * hy + hz * hz - tca * tca;
    if (d2 < 0.24 * 0.24) {
      const t = tca - Math.sqrt(0.24 * 0.24 - d2);
      if (t > 0.001 && (!best || t < best.dist)) best = { dist: t, part: 'head' };
    }
  }
  return best;
}

const WIN_ROUNDS = 9, ROUND_TIME = 100, BUY_TIME = 12;
const ECON = { start: 800, kill: 300, win: 3250, detonate: 3500, loss: 1400, cap: 16000 };

export class Game {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    document.getElementById('app').appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14161c);
    this.scene.fog = new THREE.Fog(0x14161c, 30, 95);
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.08, 220);
    const hemi = new THREE.HemisphereLight(0xd8e2f2, 0x4a4238, 1.5);
    const sun = new THREE.DirectionalLight(0xffe6b0, 2.4);
    sun.position.set(18, 30, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 30, bottom: -30, far: 90 });
    this.scene.add(hemi, sun);
    buildScene(this.scene);
    this.nodes = buildWaypoints();
    this.player = new Player(this.scene, this.camera);
    this.bots = [];
    const botWeapons = ['VK9', 'AR7', 'VK9'];
    for (let i = 0; i < 3; i++) this.bots.push(new Bot(this.scene, i, 'STRIKE', botWeapons[i]));
    for (let i = 0; i < 4; i++) this.bots.push(new Bot(this.scene, i + 3, 'AEGIS', i % 2 ? 'AR7' : 'VK9'));
    this.sfx = new Sfx();
    this.time = 0;
    this.phase = 'menu'; // menu | buy | live | roundEnd | matchEnd
    this.phaseT = 0;
    this.round = 0;
    this.score = { STRIKE: 0, AEGIS: 0 };
    this.siteTarget = 'A';
    this.planterId = 0;
    this.bomb = { carrier: null, planted: false, site: null, fuse: 0, dropped: null, plantT: 0, defuseT: 0 };
    this.killfeed = [];
    this.tracers = [];
    this.grenades = [];
    this.keys = { f: false, b: false, l: false, r: false, jump: false, crouch: false, walk: false };
    this.firing = false;
    this.buyOpen = false;
    this.plantHeld = false;
    this.bannerT = 0;
    this.stats = new Map(); // name -> {k,d}
    this.acc = 0;
    this.bindInput();
    this.bindUI();
    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  // ---- Match flow ----
  startMatch() {
    this.score = { STRIKE: 0, AEGIS: 0 };
    this.round = 0;
    this.stats = new Map();
    for (const b of this.bots) { b.kills = 0; b.deaths = 0; }
    this.player.kills = 0; this.player.deaths = 0;
    this.player.money = ECON.start;
    this.nextRound();
  }

  nextRound() {
    this.round++;
    this.phase = 'buy'; this.phaseT = BUY_TIME;
    this.siteTarget = Math.random() < 0.5 ? 'A' : 'B';
    this.bomb = { carrier: null, planted: false, site: null, fuse: 0, dropped: null, plantT: 0, defuseT: 0 };
    // Spawn: player + STRIKE bots west, AEGIS east.
    this.player.spawn(SPAWN_STRIKE[0], -Math.PI / 2);
    this.player.hp = 100; this.player.armor = false;
    for (const b of this.bots) {
      if (b.team === 'STRIKE') b.spawn(SPAWN_STRIKE[1 + (b.id % 3)], -Math.PI / 2);
      else b.spawn(SPAWN_AEGIS[b.id - 3], Math.PI / 2);
      b.armor = Math.random() < 0.3;
      if (Math.random() < 0.5) { b.weaponKey = 'AR7'; b.weapon = WEAPONS.AR7; }
    }
    // Bomb carrier: a random living STRIKE bot (never the player, so the
    // objective is visible in the killfeed and the player can escort).
    const carriers = this.bots.filter((b) => b.team === 'STRIKE');
    this.planterId = carriers[(Math.random() * carriers.length) | 0].id;
    this.bomb.carrier = this.planterId;
    this.setBanner(`ROUND ${this.round} — ${this.siteTarget === 'A' ? 'SITE A (north)' : 'SITE B (south)'}`, 'Buy up. B opens the shop.');
    this.openBuy(true);
    this.updateHUD();
  }

  startLive() {
    this.phase = 'live'; this.phaseT = ROUND_TIME;
    this.openBuy(false);
    this.setBanner('GO — take the site', '');
    for (const b of this.bots) b.decide(this.botCtx());
  }

  endRound(winner, reason) {
    if (this.phase === 'roundEnd' || this.phase === 'matchEnd') return;
    this.score[winner]++;
    const won = winner === 'STRIKE';
    const reward = reason === 'detonation' ? ECON.detonate : ECON.win;
    this.player.money = clamp(this.player.money + (won ? reward : ECON.loss), 0, ECON.cap);
    this.setBanner(won ? 'STRIKE TAKES THE ROUND' : 'AEGIS HOLDS THE ROUND', reason);
    if (won) this.sfx.win(); else this.sfx.lose();
    if (this.score[winner] >= WIN_ROUNDS) { this.endMatch(winner); return; }
    this.phase = 'roundEnd'; this.phaseT = 4;
  }

  endMatch(winner) {
    this.phase = 'matchEnd'; this.phaseT = 0;
    document.exitPointerLock?.();
    $('endTitle').textContent = winner === 'STRIKE' ? 'STRIKE WINS THE MATCH' : 'AEGIS WINS THE MATCH';
    $('endTitle').style.color = winner === 'STRIKE' ? '#7ee787' : '#ff7b72';
    $('endScore').textContent = `STRIKE ${this.score.STRIKE} — ${this.score.AEGIS} AEGIS`;
    const rows = [['YOU', this.player.kills, this.player.deaths]];
    for (const b of this.bots) rows.push([b.name + (b.team === 'STRIKE' ? ' (S)' : ' (A)'), b.kills, b.deaths]);
    rows.sort((a, b) => b[1] - a[1]);
    $('kdTable').innerHTML = rows.map(([n, k, d]) =>
      `<tr><td>${n}</td><td>${k}</td><td>${d}</td><td>${(k / Math.max(1, d)).toFixed(2)}</td></tr>`).join('');
    $('endScreen').classList.remove('hidden');
    if (winner === 'STRIKE') this.sfx.win(); else this.sfx.lose();
  }

  botCtx() {
    return { nodes: this.nodes, bomb: this.bomb, planterId: this.planterId, siteTarget: this.siteTarget, time: this.time };
  }

  // ---- Combat: the one resolver for player and bots ----
  allTargets() {
    const out = [];
    if (this.player.alive) out.push({ pos: this.player.pos, eye: this.player.eye, alive: true, isPlayer: true, ref: this.player, team: 'STRIKE' });
    for (const b of this.bots) if (b.alive) out.push({ pos: b.pos, eye: b.eye, alive: true, isPlayer: false, ref: b, team: b.team });
    return out;
  }

  resolveShot(shot) {
    const wall = raycast(shot.origin, shot.dir, shot.weapon.range);
    const wallDist = wall ? wall.dist : Infinity;
    let best = null;
    const shooterTeam = shot.shooter === 'player' ? 'STRIKE' : shot.shooter.team;
    for (const t of this.allTargets()) {
      if (t.team === shooterTeam) continue;
      if (shot.shooter !== 'player' && t.ref === shot.shooter) continue;
      const hit = rayVsBody(shot.origin, shot.dir, t.pos);
      if (hit && hit.dist < wallDist && (!best || hit.dist < best.dist)) best = { ...hit, target: t };
    }
    const end = best
      ? shot.origin.clone().addScaledVector(shot.dir, best.dist)
      : (wall ? wall.point : shot.origin.clone().addScaledVector(shot.dir, shot.weapon.range));
    this.addTracer(shot.origin, end, shot.shooter === 'player');
    if (best) {
      const dmg = shot.weapon.dmg * (best.part === 'head' ? shot.weapon.head : 1);
      const wasAlive = best.target.ref.alive;
      best.target.ref.takeDamage(dmg);
      if (shot.shooter === 'player') { this.sfx.hit(); this.flashHitmarker(best.part === 'head'); }
      if (wasAlive && !best.target.ref.alive) this.onKill(shot.shooter, best.target);
    }
    return best;
  }

  onKill(shooter, victim) {
    const sName = shooter === 'player' ? 'YOU' : shooter.name;
    const vName = victim.isPlayer ? 'YOU' : victim.ref.name;
    this.feed(`${sName} ▸ ${vName}`);
    if (shooter === 'player') { this.player.money = clamp(this.player.money + ECON.kill, 0, ECON.cap); this.player.kills++; this.sfx.kill(); }
    else shooter.kills++;
    // Deaths are counted once, inside takeDamage.
    // Bomb drops when its carrier dies.
    if (this.bomb.carrier !== null && !victim.isPlayer && victim.ref.id === this.bomb.carrier && !this.bomb.planted) {
      this.bomb.carrier = null;
      this.bomb.dropped = { x: victim.pos.x, z: victim.pos.z };
      this.feed('CHARGE DROPPED — pick it up');
    }
    this.checkElimination();
  }

  checkElimination() {
    if (this.phase !== 'live') return;
    const strikeAlive = this.player.alive || this.bots.some((b) => b.team === 'STRIKE' && b.alive);
    const aegisAlive = this.bots.some((b) => b.team === 'AEGIS' && b.alive);
    if (this.bomb.planted) { if (!aegisAlive) this.endRound('STRIKE', 'elimination'); return; }
    if (!strikeAlive) this.endRound('AEGIS', 'elimination');
    else if (!aegisAlive) this.endRound('STRIKE', 'elimination');
  }

  // ---- Grenades ----
  throwGrenade() {
    if (this.player.grenades <= 0 || !this.player.alive) return;
    this.player.grenades--;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a5f2a, roughness: 0.5 }));
    mesh.position.copy(this.player.eye).addScaledVector(dir, 0.5);
    this.scene.add(mesh);
    this.grenades.push({ mesh, vel: dir.multiplyScalar(13).add(new THREE.Vector3(0, 3, 0)), t: 0 });
    this.sfx.blip(300, 0.08, 'square', 0.1);
    this.updateHUD();
  }

  updateGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.t += dt;
      g.vel.y -= 14 * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      if (g.mesh.position.y < 0.09) { g.mesh.position.y = 0.09; g.vel.y *= -0.4; g.vel.x *= 0.7; g.vel.z *= 0.7; }
      if (g.t >= 1.2) {
        const p = g.mesh.position.clone();
        this.scene.remove(g.mesh);
        this.grenades.splice(i, 1);
        this.sfx.boom();
        const flash = new THREE.PointLight(0xffa040, 60, 18, 1.6);
        flash.position.copy(p); this.scene.add(flash);
        setTimeout(() => this.scene.remove(flash), 180);
        for (const t of this.allTargets()) {
          const d = t.pos.distanceTo(p);
          if (d < 7) {
            const dmg = (1 - d / 7) * 95;
            const eye = t.eye.clone(); eye.y = 0.9;
            if (hasLOS(p, eye)) t.ref.takeDamage(dmg);
          }
        }
        this.checkElimination();
      }
    }
  }

  addTracer(from, to, friendly) {
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: friendly ? 0xffe08a : 0xff8a6a, transparent: true, opacity: 0.9,
    }));
    this.scene.add(line);
    this.tracers.push({ line, t: 0.07 });
  }

  updateTracers(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.t -= dt;
      if (tr.t <= 0) { this.scene.remove(tr.line); tr.line.geometry.dispose(); this.tracers.splice(i, 1); }
    }
  }

  // ---- Bomb: plant / fuse / defuse / pickup ----
  updateBomb(dt) {
    const b = this.bomb;
    if (b.planted) {
      b.fuse -= dt;
      if (b.fuse <= 0) { this.sfx.boom(); this.endRound('STRIKE', 'detonation'); return; }
      // AEGIS bots that reach the site defuse.
      for (const bot of this.bots) {
        if (bot.team !== 'AEGIS' || !bot.alive) continue;
        if (Math.hypot(bot.pos.x - b.site.x, bot.pos.z - b.site.z) < 2.2) {
          bot.defusing += dt;
          if (bot.defusing >= 5) { bot.defusing = 0; b.planted = false; this.feed('CHARGE DEFUSED'); this.endRound('AEGIS', 'defuse'); return; }
        } else bot.defusing = 0;
      }
      return;
    }
    // Player plant: hold E inside a site while carrying the charge.
    if (this.phase === 'live' && this.player.alive && this.plantHeld && b.carrier === 'player') {
      const site = this.inSite(this.player.pos);
      if (site) {
        b.plantT += dt;
        if (Math.floor(b.plantT * 4) !== Math.floor((b.plantT - dt) * 4)) this.sfx.beep();
        if (b.plantT >= 3) {
          b.planted = true; b.site = site; b.fuse = 40; b.plantT = 0;
          this.feed('CHARGE PLANTED — 40s fuse'); this.sfx.plant();
          for (const bot of this.bots) bot.decide(this.botCtx());
        }
      } else b.plantT = 0;
    } else b.plantT = 0;
    // Carrier bot plants when it reaches its site.
    if (b.carrier !== null && b.carrier !== 'player') {
      const bot = this.bots[b.carrier];
      if (bot && bot.alive) {
        const site = this.inSite(bot.pos);
        if (site && bot.goal?.why === 'plant') {
          bot.planting += dt;
          if (bot.planting >= 3) {
            b.planted = true; b.site = site; b.fuse = 40; b.planting = 0;
            this.feed(`${bot.name} PLANTED THE CHARGE`); this.sfx.plant();
            for (const o of this.bots) o.decide(this.botCtx());
          }
        } else bot.planting = 0;
      }
    }
    // Pickup of a dropped charge.
    if (b.dropped && this.player.alive) {
      if (Math.hypot(this.player.pos.x - b.dropped.x, this.player.pos.z - b.dropped.z) < 1.4) {
        b.carrier = 'player'; b.dropped = null;
        this.feed('YOU PICKED UP THE CHARGE'); this.sfx.beep();
      }
    }
  }

  inSite(p) {
    if (Math.hypot(p.x - SITE_A.x, p.z - SITE_A.z) < SITE_R) return SITE_A;
    if (Math.hypot(p.x - SITE_B.x, p.z - SITE_B.z) < SITE_R) return SITE_B;
    return null;
  }

  // ---- Fixed-step update ----
  step(dt) {
    this.time += dt;
    if (this.phase === 'buy') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) this.startLive();
    } else if (this.phase === 'live') {
      this.phaseT -= dt;
      if (this.phaseT <= 0 && !this.bomb.planted) { this.endRound('AEGIS', 'time'); return; }
      if (this.phaseT <= 0 && this.bomb.planted) { /* fuse handles it */ }
    } else if (this.phase === 'roundEnd') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) this.nextRound();
    }
    if (this.phase === 'live' || this.phase === 'buy') {
      this.player.update(dt, this.keys, this.time);
      if (this.firing && this.phase === 'live') {
        const shot = this.player.fire(this.time);
        if (shot) { this.resolveShot(shot); this.sfx.shot(shot.key); }
        else if (this.player.ammo[this.player.weaponKey].mag === 0 && this.player.reloading <= 0) this.player.reload();
      }
      const ctx = this.botCtx();
      const enemies = this.allTargets();
      for (const bot of this.bots) {
        if (this.phase === 'live' && Math.random() < 0.02) bot.decide(ctx);
        const shot = bot.update(dt, ctx, enemies);
        if (shot) { this.resolveShot(shot); if (Math.random() < 0.5) this.sfx.enemyShot(); }
      }
      this.updateBomb(dt);
      this.updateGrenades(dt);
    }
    this.updateTracers(dt);
    if (this.bannerT > 0) this.bannerT -= dt;
    this.updateHUD();
  }

  frame() {
    const now = performance.now() / 1000;
    let dt = Math.min(0.1, now - (this.lastFrame ?? now));
    this.lastFrame = now;
    this.acc += dt;
    const STEP = 1 / 60;
    let n = 0;
    while (this.acc >= STEP && n < 5) { this.step(STEP); this.acc -= STEP; n++; }
    if (n === 5) this.acc = 0;
    this.renderer.render(this.scene, this.camera);
  }

  // ---- HUD ----
  setBanner(main, sub) {
    $('bannerMain').textContent = main;
    $('bannerSub').textContent = sub || '';
    $('banner').classList.remove('hidden');
    this.bannerT = 3.2;
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => $('banner').classList.add('hidden'), 3200);
  }

  feed(text) {
    this.killfeed.unshift({ text, t: this.time });
    if (this.killfeed.length > 5) this.killfeed.pop();
    $('killfeed').innerHTML = this.killfeed.map((k) => `<div>${k.text}</div>`).join('');
  }

  flashHitmarker(head) {
    const hm = $('hitmarker');
    hm.classList.remove('hidden');
    hm.style.color = head ? '#ff5040' : '#ffffff';
    clearTimeout(this.hmTimer);
    this.hmTimer = setTimeout(() => hm.classList.add('hidden'), 120);
  }

  updateHUD() {
    const p = this.player;
    $('scoreStrike').textContent = this.score.STRIKE;
    $('scoreAegis').textContent = this.score.AEGIS;
    $('roundNum').textContent = this.phase === 'menu' ? '—' : this.round;
    const t = Math.max(0, Math.ceil(this.phaseT));
    $('timer').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    $('phaseLabel').textContent = { menu: 'MENU', buy: 'BUY PHASE', live: 'LIVE', roundEnd: 'ROUND OVER', matchEnd: 'MATCH OVER' }[this.phase];
    $('hp').textContent = Math.ceil(p.hp);
    $('hp').style.color = p.hp > 50 ? '#7ee787' : p.hp > 25 ? '#ffb020' : '#ff5040';
    $('armor').textContent = p.armor ? 'KEVLAR' : '—';
    $('money').textContent = '$' + p.money;
    $('weaponName').textContent = p.weapon.name;
    const a = p.ammo[p.weaponKey];
    $('ammoMag').textContent = p.reloading > 0 ? '––' : a.mag;
    $('ammoRes').textContent = a.reserve;
    $('grenades').textContent = '✦'.repeat(p.grenades);
    const site = this.inSite(p.pos);
    const b = this.bomb;
    $('bombStatus').textContent = b.planted ? `CHARGE LIVE ${Math.ceil(b.fuse)}s`
      : b.carrier === 'player' ? (site ? 'HOLD E TO PLANT' : 'CARRYING CHARGE — reach a site')
      : b.dropped ? 'CHARGE DROPPED' : (b.carrier !== null ? `${this.bots[b.carrier]?.name ?? ''} HAS THE CHARGE` : '—');
    // Plant / defuse progress bar.
    const prog = b.planted ? (40 - b.fuse) / 40 : clamp(b.plantT / 3, 0, 1);
    $('plantFill').style.width = `${prog * 100}%`;
    $('plantBar').classList.toggle('hidden', !(b.planted || b.plantT > 0));
    // Dynamic crosshair: gap grows with spread.
    const gap = 4 + p.spreadNow() * 900;
    document.documentElement.style.setProperty('--xgap', `${gap}px`);
    $('crosshair').classList.toggle('hidden', this.phase === 'menu' || !p.alive);
    // Buy menu prices / affordability.
    for (const el of document.querySelectorAll('[data-buy]')) {
      const key = el.dataset.buy;
      const price = key === 'KEVLAR' ? KEVLAR_PRICE : key === 'GRENADE' ? 300 : WEAPONS[key].price;
      el.querySelector('.price').textContent = '$' + price;
      el.classList.toggle('cant', p.money < price || (key !== 'KEVLAR' && key !== 'GRENADE' && p.weapons.includes(key)));
    }
  }

  openBuy(open) {
    this.buyOpen = open;
    $('buyMenu').classList.toggle('hidden', !open);
  }

  // ---- Input ----
  bindInput() {
    const c = this.renderer.domElement;
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'arrowup') this.keys.f = true;
      if (k === 's' || k === 'arrowdown') this.keys.b = true;
      if (k === 'a' || k === 'arrowleft') this.keys.l = true;
      if (k === 'd' || k === 'arrowright') this.keys.r = true;
      if (k === ' ') { this.keys.jump = true; e.preventDefault(); }
      if (k === 'control' || k === 'c') this.keys.crouch = true;
      if (k === 'shift') this.keys.walk = true;
      if (k === 'r') { if (this.player.reload()) this.sfx.reload(); }
      if (k === 'e') this.plantHeld = true;
      if (k === 'g') this.throwGrenade();
      if (k === 'b' && (this.phase === 'buy' || this.phase === 'live')) {
        this.openBuy(!this.buyOpen);
        if (this.buyOpen) document.exitPointerLock?.();
      }
      if (k === '1') this.player.switchSlot(0);
      if (k === '2') this.player.switchSlot(1);
      if (k === '3') this.player.switchSlot(2);
      if (this.buyOpen) {
        if (k === '4') this.buyItem('VK9');
        if (k === '5') this.buyItem('AR7');
        if (k === '6') this.buyItem('LONGSHOT');
        if (k === '7') this.buyItem('KEVLAR');
        if (k === '8') this.buyItem('GRENADE');
      }
    });
    addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'arrowup') this.keys.f = false;
      if (k === 's' || k === 'arrowdown') this.keys.b = false;
      if (k === 'a' || k === 'arrowleft') this.keys.l = false;
      if (k === 'd' || k === 'arrowright') this.keys.r = false;
      if (k === ' ') this.keys.jump = false;
      if (k === 'control' || k === 'c') this.keys.crouch = false;
      if (k === 'shift') this.keys.walk = false;
      if (k === 'e') this.plantHeld = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== c || !this.player.alive) return;
      this.player.yaw -= e.movementX * 0.0022;
      this.player.pitch = clamp(this.player.pitch - e.movementY * 0.0022, -1.5, 1.5);
    });
    c.addEventListener('mousedown', (e) => {
      this.sfx.ensure();
      if (this.phase !== 'live' || !this.player.alive) return;
      if (document.pointerLockElement !== c) { c.requestPointerLock()?.catch?.(() => {}); return; }
      if (e.button === 0) this.firing = true;
      if (e.button === 2) this.player.scoped = this.player.weaponKey === 'LONGSHOT';
    });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.firing = false; if (e.button === 2) this.player.scoped = false; });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  buyItem(key) {
    let ok = false;
    if (key === 'KEVLAR') ok = this.player.buyKevlar();
    else if (key === 'GRENADE') ok = this.player.buyGrenade();
    else ok = this.player.buy(key);
    if (ok) { this.sfx.beep(); this.updateHUD(); }
    return ok;
  }

  bindUI() {
    $('deployBtn').addEventListener('click', () => {
      this.sfx.ensure();
      $('menu').classList.add('hidden');
      this.renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
      this.startMatch();
    });
    $('againBtn').addEventListener('click', () => {
      $('endScreen').classList.add('hidden');
      $('menu').classList.remove('hidden');
      this.phase = 'menu';
      this.updateHUD();
    });
    for (const el of document.querySelectorAll('[data-buy]')) {
      el.addEventListener('click', () => this.buyItem(el.dataset.buy));
    }
  }
}

// ---- Boot + deterministic render modes ----
const game = new Game();
window.__sunder = game; // dev hook for smoke tests (not part of play)
if (SHOT === 'play') {
  $('menu').classList.add('hidden');
  game.startMatch();
  game.phase = 'live'; game.phaseT = ROUND_TIME; game.openBuy(false);
  // Put the fight on screen: bots converge on mid, player watches the gap.
  game.player.spawn(new THREE.Vector3(-6, 0, 0), -Math.PI / 2);
  for (const b of game.bots) {
    const mid = b.team === 'STRIKE' ? new THREE.Vector3(-4, 0, 2) : new THREE.Vector3(4, 0, -2);
    b.spawn(mid, b.team === 'STRIKE' ? -Math.PI / 2 : Math.PI / 2);
    b.decide(game.botCtx());
  }
} else if (SHOT === 'end') {
  $('menu').classList.add('hidden');
  game.score = { STRIKE: 9, AEGIS: 4 };
  game.round = 13;
  game.player.kills = 18; game.player.deaths = 9;
  game.bots[0].kills = 11; game.bots[0].deaths = 8;
  game.bots[3].kills = 12; game.bots[3].deaths = 10;
  game.endMatch('STRIKE');
}
(function loop() { requestAnimationFrame(loop); game.frame(); })();

