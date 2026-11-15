// main.js — SUNDER: a round-based tactical FPS in three.js.
//
// STRIKE (you + 3 bots) attacks AEGIS (4 bots). Each round: a 12-second buy
// phase, then up to 100 seconds of play. Win by eliminating the other team
// or by planting the charge on site A or B and defending it for 40 seconds;
// AEGIS wins by elimination or by defusing. Kills pay $300, rounds pay win
// or loss bonuses, first team to 9 rounds takes the match.
//
// This file owns the match state machine, the economy, the shared hitscan
// shot resolver (used identically by the player and every bot), tracers and
// impact effects, the HUD, and the deterministic ?shot= screenshot modes
// the screenshots in /screenshots were rendered with.

import * as THREE from 'three';
import { buildWorld, raycastWalls, losClear, siteAt, SITES, SPAWNS } from './world.js';
import { Input, Player, WEAPONS, freshWeapon } from './player.js';
import { Bot } from './bots.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot');
const SEED = Number(params.get('seed') || 1);

// Deterministic screenshots: in shot mode a seeded PRNG replaces
// Math.random before anything is built, so ?shot=play&seed=1 always
// renders the same frame the shipped screenshots show.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
if (SHOT) Math.random = mulberry32(SEED * 7919 + 13);

/* ---------------- audio: tiny synth, no assets ---------------- */
const SFX = {
  ctx: null, master: null,
  init() {
    if (this.ctx || SHOT) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    } catch { /* silent game is fine */ }
  },
  blip(freq, dur, type, vol, slide = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur);
  },
  noise(dur, vol, freq = 1800) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const len = Math.max(1, (dur * this.ctx.sampleRate) | 0);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t);
  },
  shot(vol) { this.noise(0.11, vol, 2600); this.blip(150, 0.07, 'square', vol * 0.5, -80); },
  hit(kill) { this.blip(kill ? 1180 : 880, 0.06, 'sine', 0.25); },
  dry() { this.blip(1900, 0.03, 'square', 0.12); },
  reload() { this.blip(500, 0.05, 'square', 0.15); setTimeout(() => this.blip(340, 0.05, 'square', 0.15), 160); },
  beep(f = 1040) { this.blip(f, 0.07, 'sine', 0.2); },
  boom() { this.noise(0.9, 0.9, 300); this.blip(64, 0.8, 'sine', 0.7, -30); },
  roundEnd(win) { this.blip(win ? 660 : 392, 0.16, 'triangle', 0.25); setTimeout(() => this.blip(win ? 880 : 330, 0.22, 'triangle', 0.22), 130); },
};

/* ---------------- scene ---------------- */
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
$('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9db8cc);
scene.fog = new THREE.Fog(0x9db8cc, 55, 140);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.08, 400);

const hemi = new THREE.HemisphereLight(0xcfe4f5, 0x3d3830, 1.2);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d8, 2.35);
sun.position.set(34, 46, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -42; sun.shadow.camera.right = 42;
sun.shadow.camera.top = 42; sun.shadow.camera.bottom = -42;
sun.shadow.camera.far = 130;
sun.shadow.bias = -0.0006;
scene.add(sun);

const world = buildWorld(scene);
const input = new Input(renderer.domElement);
const player = new Player(scene, camera, world, input);
player.kind = 'player'; player.team = 'strike'; player.name = 'YOU';

/* ---------------- effects: tracers, impacts, flashes ---------------- */
const tracerPool = [];
{
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  for (let i = 0; i < 40; i++) {
    const mat = new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.Line(geo.clone(), mat);
    line.visible = false; line.frustumCulled = false;
    scene.add(line);
    tracerPool.push({ line, until: 0 });
  }
}
function spawnTracer(origin, dir, dist, color) {
  const t = tracerPool.find((x) => !x.line.visible) || tracerPool[0];
  const p = t.line.geometry.attributes.position;
  p.setXYZ(0, origin.x, origin.y, origin.z);
  p.setXYZ(1, origin.x + dir.x * dist, origin.y + dir.y * dist, origin.z + dir.z * dist);
  p.needsUpdate = true;
  t.line.material.color.setHex(color);
  t.line.material.opacity = 0.75;
  t.line.visible = true;
  t.until = performance.now() + 55;
}

const PMAX = 260;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(PMAX * 3);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
const pMat = new THREE.PointsMaterial({ color: 0xe8dcc0, size: 0.09, transparent: true, opacity: 0.95, depthWrite: false });
const points = new THREE.Points(pGeo, pMat);
points.frustumCulled = false;
scene.add(points);
const particles = Array.from({ length: PMAX }, () => ({ life: 0, vx: 0, vy: 0, vz: 0, x: 0, y: -10, z: 0 }));
let pCursor = 0;
function spawnImpact(at, color, n = 7) {
  pMat.color.setHex(color);
  for (let i = 0; i < n; i++) {
    const p = particles[pCursor]; pCursor = (pCursor + 1) % PMAX;
    p.x = at.x; p.y = at.y; p.z = at.z; p.life = 0.32 + Math.random() * 0.2;
    p.vx = (Math.random() - 0.5) * 2.6; p.vy = Math.random() * 2.4; p.vz = (Math.random() - 0.5) * 2.6;
  }
}
function updateParticles(dt) {
  for (let i = 0; i < PMAX; i++) {
    const p = particles[i];
    if (p.life > 0) {
      p.life -= dt;
      p.vy -= 6 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.02) { p.y = 0.02; p.vy = 0; }
    }
    pPos[i * 3] = p.x; pPos[i * 3 + 1] = p.life > 0 ? p.y : -10; pPos[i * 3 + 2] = p.z;
  }
  pGeo.attributes.position.needsUpdate = true;
  const now = performance.now();
  for (const t of tracerPool) if (t.line.visible && now > t.until) t.line.visible = false;
}

const boomLight = new THREE.PointLight(0xffa050, 0, 60);
scene.add(boomLight);
const boomBall = new THREE.Mesh(
  new THREE.SphereGeometry(1, 20, 14),
  new THREE.MeshBasicMaterial({ color: 0xffc37a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
);
boomBall.visible = false;
scene.add(boomBall);
let boomT = -1;
function explode(at) {
  boomT = 0;
  boomBall.position.copy(at).setY(1.2);
  boomBall.visible = true;
  boomLight.position.copy(at).setY(2);
  SFX.boom();
}

/* ---------------- actors & the shared shot resolver ---------------- */
const bots = [];
const BOT_NAMES = {
  strike: ['Rook', 'Vela', 'Onyx'],
  aegis: ['Bastion', 'Havoc', 'Sable', 'Vex'],
};
for (const n of BOT_NAMES.strike) bots.push(new Bot(scene, world, 'strike', n));
for (const n of BOT_NAMES.aegis) bots.push(new Bot(scene, world, 'aegis', n));
for (const b of bots) { b.money = 800; b.primaryId = null; b.stats = { k: 0, d: 0 }; }
const playerStats = { k: 0, d: 0 };

function allActors() { return [player, ...bots]; }
function teamAlive(team) { return allActors().filter((a) => a.team === team && a.alive); }

function sphereHit(origin, dir, cx, cy, cz, r, maxDist) {
  const ox = cx - origin.x, oy = cy - origin.y, oz = cz - origin.z;
  const t = ox * dir.x + oy * dir.y + oz * dir.z;
  if (t < 0 || t > maxDist) return -1;
  const px = origin.x + dir.x * t, py = origin.y + dir.y * t, pz = origin.z + dir.z * t;
  const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
  return d2 <= r * r ? t : -1;
}

function rayHitActor(a, origin, dir, maxDist) {
  if (a.kind === 'bot') return a.rayHit(origin, dir, maxDist);
  // The player: head rides at eye height, chest scales with the crouch.
  const parts = [
    { y: a.pos.y + a.eye - 0.1, r: 0.21, head: true },
    { y: a.pos.y + a.eye * 0.55, r: 0.40, head: false },
    { y: a.pos.y + 0.36, r: 0.36, head: false },
  ];
  let best = null;
  for (const p of parts) {
    const t = sphereHit(origin, dir, a.pos.x, p.y, a.pos.z, p.r, maxDist);
    if (t >= 0 && (!best || t < best.dist)) best = { dist: t, head: p.head };
  }
  return best;
}

// One resolver for every gun in the game: wall first, then the nearest
// opposing body along the ray, damage with headshot multiplier and
// distance falloff. Nobody — player or bot — shoots through a wall.
function resolveShot(shooter, origin, dir, w) {
  const wallDist = raycastWalls(world.colliders, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, w.def.range);
  let bestTarget = null, bestHit = null;
  for (const t of allActors()) {
    if (t === shooter || !t.alive || t.team === shooter.team) continue;
    const hit = rayHitActor(t, origin, dir, Math.min(wallDist, w.def.range));
    if (hit && (!bestHit || hit.dist < bestHit.dist)) { bestHit = hit; bestTarget = t; }
  }
  const endDist = bestHit ? bestHit.dist : wallDist;
  // Tracers start a step in front of the muzzle so they don't cross the eye.
  const start = origin.clone().addScaledVector(dir, 0.55);
  spawnTracer(start, dir, Math.max(0.1, endDist - 0.55), w.def.tracer);
  const end = origin.clone().addScaledVector(dir, endDist);
  if (bestTarget) {
    let dmg = w.def.damage * (bestHit.head ? w.def.headMult : 1);
    const d = bestHit.dist;
    dmg *= d <= 12 ? 1 : Math.max(0.45, 1 - ((d - 12) / w.def.range) * 0.55);
    const died = bestTarget.takeDamage(dmg);
    spawnImpact(end, bestHit.head ? 0xff5a4e : 0xe6cf9e, died ? 16 : 8);
    if (shooter === player) {
      hitmark(died);
      SFX.hit(died);
      flashVignette(0.25);
    }
    if (died) onKill(shooter, bestTarget, bestHit.head, w.def);
  } else if (wallDist < w.def.range) {
    spawnImpact(end, 0xcfd4da, 6);
  }
  const distToCam = origin.distanceTo(camera.position);
  SFX.shot(shooter === player ? 0.5 : Math.max(0.03, 0.4 - distToCam * 0.007));
}

function onKill(killer, victim, head, wdef) {
  killer.money = Math.min(16000, (killer.money ?? G.money) + 300);
  if (killer.kind === 'player') { G.money = killer.money; playerStats.k++; }
  else killer.stats.k++;
  if (G.planter === victim && G.bombState === 'carried') dropBomb(victim);
  if (victim.kind === 'player') { playerStats.d++; onPlayerDeath(); }
  else victim.stats.d++;
  addKillfeed(killer, victim, head, wdef);
  checkRoundEnd();
}

/* ---------------- match state ---------------- */
const G = {
  phase: 'menu',
  round: 0,
  wins: { strike: 0, aegis: 0 },
  money: 800,
  roundT: 0, buyT: 0, postT: 0,
  targetSite: 0,
  planter: null,          // actor carrying the charge
  bombState: 'carried',   // carried | dropped | planted | done
  bombPos: null, bombSite: 0, bombT: 0, beepAt: 0,
  channel: null,          // {actor, kind, startAt, endAt} — a bot planting/defusing
  playerChannel: 0,       // 0..1 — the player's own plant progress
  roundOver: false,
  playerDiedLastRound: false,
};

const strikeBots = bots.filter((b) => b.team === 'strike');
const aegisBots = bots.filter((b) => b.team === 'aegis');
const AEGIS_POSTS = [
  { x: 19.5, z: -9.5 }, { x: 26.5, z: -17.5 }, { x: 19.5, z: 9.5 }, { x: 16.5, z: 0 },
];

function slotAround(center, idx, offsets) {
  const o = offsets[idx % offsets.length];
  return {
    x: THREE.MathUtils.clamp(center.x + o[0], -30, 30),
    z: THREE.MathUtils.clamp(center.z + o[1], -22, 22),
  };
}

function ctxFor(bot) {
  const opp = bot.team === 'strike' ? 'aegis' : 'strike';
  const sIdx = strikeBots.indexOf(bot);
  return {
    colliders: world.colliders,
    enemies: allActors().filter((a) => a.team === opp),
    game: G,
    events: { shoot: (b, o, d, w) => resolveShot(b, o, d, w) },
    defendSlot: (b, s) => slotAround(s, sIdx < 0 ? 0 : sIdx, [[-3.5, -2.5], [3.5, -2.5], [-3.5, 2.5], [3.5, 2.5]]),
    escortSlot: (b, s) => slotAround(s, sIdx < 0 ? 0 : sIdx, [[-7, -4], [-7, 4], [-12, 0], [-4, -7]]),
    requestPlant(b) {
      if (G.bombState === 'carried' && G.planter === b && !G.channel) {
        b.channeling = true;
        const now = performance.now();
        G.channel = { actor: b, kind: 'plant', startAt: now, endAt: now + 3000 };
      }
    },
    requestDefuse(b) {
      if (G.bombState === 'planted' && !G.channel) {
        b.channeling = true;
        const now = performance.now();
        G.channel = { actor: b, kind: 'defuse', startAt: now, endAt: now + 5000 };
      }
    },
  };
}

function botBuy(b) {
  if (!b.primaryId) {
    if (b.money >= 2700) { b.primaryId = 'ar7'; b.money -= 2700; }
    else if (b.money >= 1400) { b.primaryId = 'vk9'; b.money -= 1400; }
  }
  if (!b.armor && b.money >= 650) { b.armor = true; b.money -= 650; }
}

function startMatch() {
  G.wins = { strike: 0, aegis: 0 };
  G.round = 0;
  G.money = 800;
  player.money = 800;
  playerStats.k = 0; playerStats.d = 0;
  for (const b of bots) { b.money = 800; b.primaryId = null; b.armor = false; b.stats = { k: 0, d: 0 }; }
  G.playerDiedLastRound = false;
  $('menu').hidden = true;
  $('end').hidden = true;
  $('hud').hidden = false;
  player.gun.visible = true;
  nextRound();
}

function nextRound() {
  G.round++;
  G.phase = 'buy';
  G.buyT = 12;
  G.roundOver = false;
  G.bombState = 'carried';
  G.bombPos = null; G.channel = null; G.playerChannel = 0;
  G.targetSite = Math.random() < 0.5 ? 0 : 1;

  // Player: death last round costs the primary and the armor.
  if (G.playerDiedLastRound) {
    player.loadout.primary = null;
    player.loadout.current = 'pistol';
    player.armor = false;
  }
  player.spawn(SPAWNS.strike[0]);
  player.setWeaponVisual(player.weapon.def.id);
  for (const slot of ['primary', 'pistol']) {
    const w = player.loadout[slot];
    if (w) { w.mag = w.def.mag; w.reserve = w.def.reserveStart; }
  }
  G.planter = player;

  strikeBots.forEach((b, i) => {
    if (!b.alive) b.primaryId = null;
    botBuy(b);
    b.reset(SPAWNS.strike[i + 1], b.primaryId || 'p9', b.armor);
  });
  aegisBots.forEach((b, i) => {
    if (!b.alive) b.primaryId = null;
    botBuy(b);
    b.reset(SPAWNS.aegis[i], b.primaryId || 'p9', b.armor);
    b.postPos = AEGIS_POSTS[i];
  });

  $('killfeed').innerHTML = '';
  document.exitPointerLock?.();
  renderBuy();
  $('buy').hidden = false;
  input.enabled = false;
  showBanner(`ROUND ${G.round}`, `First to 9 · ${G.targetSite === 0 ? 'STRIKE makes the call: site A' : 'STRIKE makes the call: site B'}`, 2400);
}

function startLive() {
  if (G.phase !== 'buy') return;
  G.phase = 'live';
  G.roundT = 100;
  $('buy').hidden = true;
  input.enabled = true;
  input.lock();
}

function endRound(winner, reason, bonusOverride) {
  if (G.roundOver) return;
  G.roundOver = true;
  G.phase = 'post';
  G.postT = 4.5;
  G.wins[winner]++;
  G.playerDiedLastRound = !player.alive;
  const winBonus = bonusOverride ?? 3250, loseBonus = 1400;
  const sb = winner === 'strike' ? winBonus : loseBonus;
  const ab = winner === 'aegis' ? winBonus : loseBonus;
  G.money = Math.min(16000, G.money + sb);
  player.money = G.money;
  for (const b of strikeBots) b.money = Math.min(16000, b.money + sb);
  for (const b of aegisBots) b.money = Math.min(16000, b.money + ab);
  if (G.channel) { G.channel.actor.channeling = false; G.channel = null; }
  input.enabled = false;
  document.exitPointerLock?.();
  showBanner(
    winner === 'strike' ? 'ROUND WON' : 'ROUND LOST',
    `${reason} · STRIKE ${G.wins.strike} — ${G.wins.aegis} AEGIS`,
    4200,
  );
  SFX.roundEnd(winner === 'strike');
}

function checkRoundEnd() {
  if (G.phase !== 'live' || G.roundOver) return;
  const s = teamAlive('strike').length, a = teamAlive('aegis').length;
  if (G.bombState === 'planted') {
    if (a === 0) endRound('strike', 'AEGIS eliminated — the charge is safe');
    // STRIKE wiped after the plant: the round runs on to detonation or defuse.
  } else {
    if (s === 0) endRound('aegis', 'STRIKE eliminated');
    else if (a === 0) endRound('strike', 'AEGIS eliminated');
  }
}

function onPlayerDeath() {
  input.enabled = false;
  if (G.planter === player && G.bombState === 'carried') dropBomb(player);
  showPrompt('You are down — your team fights on', 4000);
}

function dropBomb(from) {
  G.bombState = 'dropped';
  G.bombPos = { x: from.pos.x, z: from.pos.z };
  G.planter = null;
}

function plantBomb(actor) {
  const s = siteAt(actor.pos.x, actor.pos.z);
  if (!s) return;
  actor.channeling = false;
  G.channel = null;
  G.bombState = 'planted';
  G.bombSite = SITES.indexOf(s);
  G.bombPos = { x: actor.pos.x, z: actor.pos.z };
  G.bombT = 40;
  G.beepAt = 0;
  G.planter = null;
  if (actor === player) { G.money = Math.min(16000, G.money + 300); player.money = G.money; }
  else actor.money = Math.min(16000, actor.money + 300);
  showPrompt(`CHARGE PLANTED — SITE ${s.id}`, 3000);
  SFX.beep(1320);
}

function defuseBomb() {
  G.bombState = 'done';
  if (G.channel) { G.channel.actor.channeling = false; G.channel = null; }
  endRound('aegis', 'The charge was defused');
}

function updateChannels(now) {
  if (!G.channel) return;
  const ch = G.channel;
  if (!ch.actor.alive) { ch.actor.channeling = false; G.channel = null; return; }
  if (now >= ch.endAt) {
    if (ch.kind === 'plant') plantBomb(ch.actor);
    else defuseBomb();
  }
}

function updatePlayerPlant(dt) {
  const canPlant = G.planter === player && G.bombState === 'carried' && player.alive
    && siteAt(player.pos.x, player.pos.z) && input.down('KeyE');
  if (canPlant) {
    G.playerChannel += dt / 3;
    if (G.playerChannel >= 1) { G.playerChannel = 0; plantBomb(player); }
  } else {
    G.playerChannel = Math.max(0, G.playerChannel - dt * 2);
  }
}

function updateBombPickup() {
  if (G.bombState !== 'dropped' || !G.bombPos) return;
  for (const a of allActors()) {
    if (a.team !== 'strike' || !a.alive) continue;
    if (Math.hypot(a.pos.x - G.bombPos.x, a.pos.z - G.bombPos.z) < 1.3) {
      G.planter = a;
      G.bombState = 'carried';
      if (a === player) showPrompt('You have the charge', 2200);
      break;
    }
  }
}

/* ---------------- buy menu ---------------- */
const SHOP = [
  { key: '1', id: 'vk9', desc: 'Fast, forgiving, close range' },
  { key: '2', id: 'ar7', desc: 'The all-round rifle' },
  { key: '3', id: 'longshot', desc: 'One-shot power · RMB scope' },
  { key: '4', id: 'armor', name: 'KEVLAR + HELMET', desc: 'Damage taken × 0.55', price: 650 },
];
function renderBuy() {
  $('buy-money').textContent = `$${G.money}`;
  const box = $('buy-items');
  box.innerHTML = '';
  for (const item of SHOP) {
    const isArmor = item.id === 'armor';
    const def = isArmor ? null : WEAPONS[item.id];
    const price = isArmor ? item.price : def.price;
    const owned = isArmor ? player.armor : player.loadout.primary?.def.id === item.id;
    const div = document.createElement('div');
    div.className = 'buy-item' + (owned ? ' owned' : G.money < price ? ' cant' : '');
    div.innerHTML = `<span><span class="nm">[${item.key}] ${isArmor ? item.name : def.name}</span><span class="ds">${item.desc}</span></span><span class="pr">${owned ? 'OWNED' : '$' + price}</span>`;
    div.addEventListener('click', () => buyItem(item));
    box.appendChild(div);
  }
}
function buyItem(item) {
  if (G.phase !== 'buy') return;
  if (item.id === 'armor') {
    if (player.armor || G.money < item.price) return;
    G.money -= item.price; player.armor = true;
  } else {
    const def = WEAPONS[item.id];
    if (player.loadout.primary?.def.id === item.id || G.money < def.price) return;
    G.money -= def.price;
    player.givePrimary(item.id);
  }
  player.money = G.money;
  SFX.beep(740);
  renderBuy();
}

/* ---------------- HUD ---------------- */
const fmt = (t) => `${Math.floor(Math.max(0, t) / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, '0')}`;
let bannerTimer = 0, promptTimer = 0, hitTimer = 0;
function showBanner(big, sub, ms) {
  $('banner-big').textContent = big;
  $('banner-sub').textContent = sub;
  $('banner').hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { $('banner').hidden = true; }, ms);
}
function showPrompt(text, ms) {
  $('prompt').textContent = text;
  $('prompt').hidden = false;
  clearTimeout(promptTimer);
  promptTimer = setTimeout(() => { $('prompt').hidden = true; }, ms);
}
function hitmark(kill) {
  const h = $('hitmarker');
  h.classList.add('on');
  h.classList.toggle('kill', kill);
  clearTimeout(hitTimer);
  hitTimer = setTimeout(() => h.classList.remove('on'), 110);
}
function flashVignette(v) {
  $('vignette').style.opacity = String(Math.max(Number($('vignette').style.opacity || 0), v));
}
function addKillfeed(killer, victim, head, wdef) {
  const feed = $('killfeed');
  const div = document.createElement('div');
  div.className = 'kf';
  const kc = killer.team === 'strike' ? 's' : 'a';
  const vc = victim.team === 'strike' ? 's' : 'a';
  div.innerHTML = `<b class="${kc}">${killer.name}</b> · ${wdef.name}${head ? ' ⌖' : ''} ▸ <b class="${vc}">${victim.name}</b>`;
  feed.prepend(div);
  while (feed.children.length > 5) feed.lastChild.remove();
  setTimeout(() => div.remove(), 5200);
}

function updateHUD() {
  if ($('hud').hidden) return;
  $('hp').textContent = String(Math.ceil(player.hp));
  $('hp').classList.toggle('low', player.hp <= 30);
  $('hp-fill').style.width = `${player.hp}%`;
  const tag = $('armor-tag');
  tag.textContent = player.armor ? 'KEVLAR' : 'NO ARMOR';
  tag.classList.toggle('on', player.armor);
  $('money').textContent = `$${G.money}`;
  const w = player.weapon;
  $('weapon-name').textContent = w ? w.def.name : '—';
  $('ammo-mag').textContent = w ? String(w.mag) : '–';
  $('ammo-mag').classList.toggle('empty', !!w && w.mag === 0);
  $('ammo-res').textContent = w ? `/ ${w.reserve}` : '';
  $('wins-strike').textContent = String(G.wins.strike);
  $('wins-aegis').textContent = String(G.wins.aegis);
  $('clock-round').textContent = `ROUND ${G.round}`;
  const clockEl = $('clock-time');
  if (G.bombState === 'planted') { clockEl.textContent = fmt(G.bombT); clockEl.classList.add('low'); }
  else if (G.phase === 'live') { clockEl.textContent = fmt(G.roundT); clockEl.classList.toggle('low', G.roundT < 10); }
  else if (G.phase === 'buy') { clockEl.textContent = fmt(G.buyT); clockEl.classList.remove('low'); }
  $('crosshair').style.setProperty('--sp', `${player.spreadPixels().toFixed(1)}px`);
  $('scope').hidden = !(w?.def.zoomFov && input.scoping && player.alive);
  // Context prompt + channel bar.
  const ch = $('channel');
  if (G.playerChannel > 0) {
    ch.hidden = false;
    $('channel-lbl').textContent = 'PLANTING THE CHARGE';
    $('channel-fill').style.width = `${G.playerChannel * 100}%`;
  } else if (G.channel) {
    ch.hidden = false;
    const c = G.channel;
    $('channel-lbl').textContent = c.kind === 'plant' ? `${c.actor.name} IS PLANTING` : `${c.actor.name} IS DEFUSING`;
    $('channel-fill').style.width = `${Math.min(100, ((performance.now() - c.startAt) / (c.endAt - c.startAt)) * 100)}%`;
  } else ch.hidden = true;
  // Damage vignette decay toward the low-health floor.
  const vEl = $('vignette');
  const cur = Number(vEl.style.opacity || 0);
  const floor = player.alive && player.hp <= 30 && G.phase === 'live' ? 0.3 : 0;
  if (cur > floor) vEl.style.opacity = String(Math.max(floor, cur - 0.03));
}

/* ---------------- match end ---------------- */
function showEnd() {
  G.phase = 'over';
  const won = G.wins.strike > G.wins.aegis;
  $('end-title').textContent = won ? 'VICTORY' : 'DEFEAT';
  $('end-sub').textContent = `STRIKE ${G.wins.strike} — ${G.wins.aegis} AEGIS · ${won ? 'The sites are yours.' : 'AEGIS holds the sites.'}`;
  const rows = [
    { name: 'YOU', team: 'strike', ...playerStats },
    ...bots.map((b) => ({ name: b.name, team: b.team, ...b.stats })),
  ].sort((a, b) => b.k - a.k);
  $('stats-body').innerHTML = rows.map((r) =>
    `<tr><td>${r.name}</td><td class="${r.team === 'strike' ? 'team-s' : 'team-a'}">${r.team.toUpperCase()}</td><td class="num">${r.k}</td><td class="num">${r.d}</td><td class="num">${r.k - r.d}</td></tr>`,
  ).join('');
  $('end').hidden = false;
}

/* ---------------- input wiring ---------------- */
$('play-btn').addEventListener('click', () => { SFX.init(); startMatch(); });
$('again-btn').addEventListener('click', () => { SFX.init(); startMatch(); });
$('buy-done').addEventListener('click', () => startLive());
renderer.domElement.addEventListener('click', () => {
  if (G.phase === 'live' && player.alive && !input.locked) input.lock();
});
document.addEventListener('keydown', (e) => {
  const now = performance.now();
  if (G.phase === 'buy') {
    const item = SHOP.find((s) => s.key === e.key);
    if (item) buyItem(item);
    if (e.code === 'Enter' || e.code === 'Space') startLive();
    return;
  }
  if (G.phase !== 'live' || !player.alive) return;
  if (e.code === 'KeyR') player.startReload(now);
  if (e.code === 'Digit1') player.switchTo('primary');
  if (e.code === 'Digit2') player.switchTo('pistol');
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ---------------- screenshot modes ---------------- */
function poseBot(b, x, z, yaw, dead = false) {
  b.pos.set(x, 0, z);
  b.yaw = yaw;
  b.mesh.position.copy(b.pos);
  b.mesh.rotation.set(dead ? -Math.PI / 2 : 0, yaw, 0);
  if (dead) { b.alive = false; b.mesh.position.y = -0.1; }
}
function setupShot(mode) {
  G.phase = 'shot';
  input.enabled = false;
  player.spawn(SPAWNS.strike[0]);
  player.givePrimary('ar7');
  player.armor = true;
  strikeBots.forEach((b, i) => b.reset(SPAWNS.strike[i + 1], 'ar7', true));
  aegisBots.forEach((b, i) => b.reset(SPAWNS.aegis[i], 'ar7', true));

  if (mode === 'start') {
    camera.position.set(9, 8.5, 16);
    camera.lookAt(4, 0, -6);
    player.gun.visible = false;
    return; // the menu overlay is already up in the markup
  }
  $('menu').hidden = true;
  if (mode === 'play') {
    $('hud').hidden = false;
    G.round = 6; G.wins = { strike: 3, aegis: 2 };
    G.money = 2450; G.roundT = 47; G.phase = 'live'; // for the clock only; loop stays frozen
    player.pos.set(1.5, 0, -2);
    player.yaw = Math.atan2(-(14 - 1.5), -(-4 + 2));
    player.pitch = -0.015;
    player.hp = 72;
    player.weapon.mag = 17; player.weapon.reserve = 63;
    player.update(0.001, performance.now());
    G.phase = 'shot';
    poseBot(strikeBots[0], -1.2, 2.6, -Math.PI / 2 + 0.3);
    poseBot(aegisBots[3], 12.8, -3.2, Math.atan2(-(1.5 - 12.8), -(-2 + 3.2)));
    poseBot(aegisBots[1], 21, -9, -Math.PI / 2);
    addKillfeed(player, aegisBots[2], false, WEAPONS.ar7);
    updateHUD();
    $('clock-time').textContent = '0:47';
    return;
  }
  if (mode === 'end') {
    player.gun.visible = false;
    G.wins = { strike: 9, aegis: 6 };
    playerStats.k = 14; playerStats.d = 9;
    const line = [[11, 10], [9, 11], [7, 12], [12, 10], [10, 11], [8, 12], [6, 13]];
    bots.forEach((b, i) => { b.stats = { k: line[i][0], d: line[i][1] }; });
    poseBot(strikeBots[0], 21, -11, 0.6);
    poseBot(strikeBots[1], 26, -16, -0.8);
    poseBot(aegisBots[0], 24, -13, 0, true);
    poseBot(aegisBots[2], 27, -18, 0, true);
    camera.position.set(12.5, 10.5, -1.5);
    camera.lookAt(24, 0, -14);
    showEnd();
  }
}

/* ---------------- boot & main loop ---------------- */
strikeBots.forEach((b, i) => b.reset(SPAWNS.strike[i + 1], 'ar7', false));
aegisBots.forEach((b, i) => b.reset(SPAWNS.aegis[i], 'ar7', false));
player.gun.visible = false;
camera.position.set(9, 8.5, 16);
camera.lookAt(4, 0, -6);
if (SHOT) setupShot(SHOT);

let last = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (G.phase === 'buy') {
    G.buyT -= dt;
    $('buy-timer').textContent = String(Math.ceil(Math.max(0, G.buyT)));
    if (G.buyT <= 0) startLive();
  } else if (G.phase === 'live') {
    G.roundT -= dt;
    if (G.bombState === 'planted') {
      G.bombT -= dt;
      const interval = G.bombT > 20 ? 1000 : G.bombT > 10 ? 500 : 250;
      if (now >= G.beepAt) { G.beepAt = now + interval; SFX.beep(G.bombT < 10 ? 1560 : 1180); }
      if (G.bombT <= 0 && !G.roundOver) {
        explode(new THREE.Vector3(G.bombPos.x, 0, G.bombPos.z));
        G.bombState = 'done';
        endRound('strike', 'The charge detonated', 3500);
      }
    } else if (G.roundT <= 0 && !G.roundOver) {
      endRound('aegis', 'Time — the charge was never planted');
    }
    if (player.alive) player.update(dt, now);
    else {
      // Death cam: slump where you fell.
      camera.position.lerp(new THREE.Vector3(player.pos.x, 0.55, player.pos.z), Math.min(1, dt * 5));
      camera.rotation.z += (0.42 - camera.rotation.z) * Math.min(1, dt * 4);
    }
    updateChannels(now);
    updatePlayerPlant(dt);
    updateBombPickup();
    for (const b of bots) if (G.phase === 'live' || G.phase === 'post') b.update(dt, now, ctxFor(b));
    if (G.phase === 'live' && player.alive && !input.locked && !SHOT) {
      showPromptOnce('Click the screen to aim');
    }
  } else if (G.phase === 'post') {
    G.postT -= dt;
    if (G.postT <= 0) {
      if (G.wins.strike >= 9 || G.wins.aegis >= 9) showEnd();
      else nextRound();
    }
  }

  if (boomT >= 0) {
    boomT += dt;
    const k = boomT / 0.9;
    if (k >= 1) { boomT = -1; boomBall.visible = false; boomLight.intensity = 0; }
    else {
      boomBall.scale.setScalar(1 + k * 16);
      boomBall.material.opacity = 0.55 * (1 - k);
      boomLight.intensity = 260 * (1 - k);
    }
  }
  updateParticles(dt);
  updateHUD();
  renderer.render(scene, camera);
}
let promptOnceAt = 0;
function showPromptOnce(text) {
  const now = performance.now();
  if (now - promptOnceAt < 4000) return;
  promptOnceAt = now;
  showPrompt(text, 1800);
}
frame();

