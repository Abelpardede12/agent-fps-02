// SUNDER — main.js
// The match: state machine, economy, the charge, the one shared hitscan resolver
// player and bots both shoot through, WebAudio synth SFX, HUD, and the deterministic
// ?shot= render modes the screenshots use. Fixed-step simulation, rendering apart.
import * as THREE from 'three';
import {
  buildGraph, buildMap, hasLOS, inSite, mulberry32, rayHit, SITES, SPAWNS,
} from './world.js';
import {
  DETONATION_WIN, FLASH_PRICE, KEVLAR_PRICE, KILL_REWARD, MAX_MONEY,
  Player, ROUND_LOSS, ROUND_WIN, START_MONEY, WEAPONS,
} from './player.js';
import { makeBots } from './bots.js';

window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot');
const SEED = parseInt(params.get('seed') || '1', 10) || 1;
const rng = mulberry32(SHOT ? SEED : (Date.now() % 2147483647));

// ---- renderer / scene ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
scene.fog = new THREE.Fog(0x14161a, 45, 110);
const camera = new THREE.PerspectiveCamera(90, innerWidth / innerHeight, 0.05, 220);
camera.rotation.order = 'YXZ';
scene.add(camera);

scene.add(new THREE.HemisphereLight(0xbfd0e0, 0x2a241c, 1.15));
const sun = new THREE.DirectionalLight(0xffe0b0, 1.6);
sun.position.set(20, 38, -14);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x7fb4ff, 0.35);
fill.position.set(-18, 24, 20);
scene.add(fill);

const colliders = buildMap(scene);
const graph = buildGraph(colliders);

// ---- agents ----
const player = new Player(camera);
const bots = makeBots(scene);
const agents = [player, ...bots];
for (const a of agents) a.team = a === player ? 'strike' : a.team;

// ---- match state (one place) ----
const G = {
  phase: 'menu', // menu | buy | live | roundEnd | matchEnd
  round: 1,
  scoreS: 0,
  scoreA: 0,
  roundTime: 0,
  endTimer: 0,
  endReason: '',
  now: 0,
  sitePick: 'A',
  winner: null,
};
const bomb = {
  state: 'none', // carried | dropped | planted | none
  carrier: null,
  site: 'A',
  pos: new THREE.Vector3(0, 0, 0),
  plantProgress: 0,
  fuse: 0,
  beepAt: 0,
};
const botMoney = new Map(bots.map((b) => [b, START_MONEY]));

// Bomb mesh: a small charge with a blinking light, shown when dropped/planted.
const bombMesh = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.22, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.5, metalness: 0.5 }));
  const light = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.1),
    new THREE.MeshStandardMaterial({ color: 0xff4444, emissive: 0xff2222, emissiveIntensity: 2 }));
  light.position.set(0.12, 0.14, 0);
  bombMesh.add(body, light);
  bombMesh.userData.light = light;
  bombMesh.visible = false;
  scene.add(bombMesh);
}

// ---- tracers (pooled lines, no per-frame allocation) ----
const tracers = [];
for (let i = 0; i < 16; i++) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
    color: 0xffd27a, transparent: true, opacity: 0,
  }));
  line.frustumCulled = false;
  line.userData.life = 0;
  scene.add(line);
  tracers.push(line);
}
let tracerIdx = 0;
function spawnTracer(from, to) {
  const line = tracers[tracerIdx];
  tracerIdx = (tracerIdx + 1) % tracers.length;
  const attr = line.geometry.getAttribute('position');
  attr.setXYZ(0, from.x, from.y, from.z);
  attr.setXYZ(1, to.x, to.y, to.z);
  attr.needsUpdate = true;
  line.material.opacity = 0.9;
  line.userData.life = 0.08;
}

// ---- grenades ----
const grenades = [];
const grenadeGeo = new THREE.SphereGeometry(0.09, 10, 8);
const grenadeMat = new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.6, metalness: 0.5 });

// ---- audio: tiny WebAudio synth, no assets ----
let AC = null;
function audio() {
  if (!AC) {
    try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
  }
  if (AC && AC.state === 'suspended') AC.resume().catch(() => {});
  return AC;
}
function tone(freq, dur, type, vol, slideTo) {
  const ac = audio();
  if (!ac) return;
  try {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, ac.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), ac.currentTime + dur);
    g.gain.setValueAtTime(vol, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    o.connect(g).connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + dur + 0.02);
  } catch (e) { /* audio is garnish */ }
}
function noise(dur, vol, cutoff) {
  const ac = audio();
  if (!ac) return;
  try {
    const len = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = cutoff || 3000;
    const g = ac.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(ac.destination);
    src.start();
  } catch (e) { /* ignore */ }
}
const sfx = {
  shot(w, dist) {
    const v = dist == null ? 0.5 : Math.max(0.06, 0.5 / (1 + dist * 0.09));
    noise(0.09, v, w === 'LONGSHOT' ? 1800 : 3200);
    tone(w === 'LONGSHOT' ? 130 : 190, 0.08, 'square', v * 0.5, 55);
  },
  dry() { tone(1400, 0.03, 'square', 0.12); },
  reload() { tone(900, 0.04, 'square', 0.12); setTimeout(() => tone(620, 0.04, 'square', 0.12), 160); },
  hit() { tone(1250, 0.05, 'sine', 0.22); },
  kill() { tone(880, 0.07, 'sine', 0.22); setTimeout(() => tone(1320, 0.09, 'sine', 0.22), 80); },
  hurt() { tone(220, 0.12, 'sawtooth', 0.18, 110); },
  beep() { tone(1050, 0.06, 'sine', 0.2); },
  plant() { tone(700, 0.1, 'sine', 0.2); setTimeout(() => tone(1050, 0.12, 'sine', 0.2), 120); },
  explosion() { noise(0.9, 0.9, 700); tone(55, 0.7, 'sine', 0.7, 28); },
  win() { [523, 659, 784].forEach((f, i) => setTimeout(() => tone(f, 0.16, 'sine', 0.2), i * 110)); },
  lose() { [392, 311].forEach((f, i) => setTimeout(() => tone(f, 0.2, 'sine', 0.18), i * 140)); },
  buy() { tone(990, 0.06, 'sine', 0.16); },
};

// ---- HUD ----
const hud = {
  score: $('hud-score'), clock: $('hud-clock'), phase: $('hud-phase'),
  feed: $('killfeed'), hp: $('hp-num'), hpBar: $('hp-bar'), armor: $('armor'),
  money: $('money'), wname: $('weapon-name'), mag: $('ammo-mag'), res: $('ammo-res'),
  nades: $('grenades'), cross: $('crosshair'), hit: $('hitmarker'),
  banner: $('banner'), channel: $('channel'), channelFill: $('channel-fill'),
  channelLabel: $('channel-label'), charge: $('charge-chip'), hint: $('lock-hint'),
  flash: $('flash'),
};
let lastHud = {};
function setText(el, key, val) {
  if (lastHud[key] !== val) { lastHud[key] = val; el.textContent = val; }
}
function banner(text, sub, ms) {
  hud.banner.innerHTML = text + (sub ? `<span>${sub}</span>` : '');
  hud.banner.classList.add('show');
  clearTimeout(banner._t);
  banner._t = setTimeout(() => hud.banner.classList.remove('show'), ms || 2600);
}
function killfeed(killer, victim, weapon, head) {
  const row = document.createElement('div');
  row.className = 'feed-row';
  row.innerHTML = `<b class="${killer.team}">${killer.name}</b> <i>${weapon}${head ? ' ◉' : ''}</i> <b class="${victim.team}">${victim.name}</b>`;
  hud.feed.prepend(row);
  while (hud.feed.children.length > 5) hud.feed.lastChild.remove();
  setTimeout(() => row.classList.add('fade'), 4200);
  setTimeout(() => row.remove(), 5200);
}
function hitmarker(kill) {
  hud.hit.classList.add(kill ? 'kill' : 'on');
  clearTimeout(hitmarker._t);
  hitmarker._t = setTimeout(() => hud.hit.classList.remove('on', 'kill'), 130);
}

// ---- input ----
const input = {
  forward: false, back: false, left: false, right: false,
  jump: false, crouch: false, walk: false, interact: false,
  lookX: 0, lookY: 0, fireHeld: false,
};
const KEYMAP = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  ShiftLeft: 'walk', ShiftRight: 'walk', ControlLeft: 'crouch', KeyC: 'crouch',
  Space: 'jump', KeyE: 'interact',
};
addEventListener('keydown', (e) => {
  if (e.code === 'Space') e.preventDefault();
  const k = KEYMAP[e.code];
  if (k) input[k] = true;
  if (e.code === 'KeyR') tryReload();
  if (e.code === 'KeyB') toggleBuy();
  if (e.code === 'KeyG') throwFlash();
  // Number keys buy while the buy menu is open, switch weapons otherwise.
  if ($('buy-menu').classList.contains('open')) {
    if (e.code === 'Digit1') buy('VK9');
    if (e.code === 'Digit2') buy('AR7');
    if (e.code === 'Digit3') buy('LONGSHOT');
    if (e.code === 'Digit4') buy('KEVLAR');
    if (e.code === 'Digit5') buy('FLASH');
    return;
  }
  if (e.code === 'Digit1') switchWeapon(0);
  if (e.code === 'Digit2') switchWeapon(1);
  if (e.code === 'Enter' && G.phase === 'menu') deploy();
});
addEventListener('keyup', (e) => {
  const k = KEYMAP[e.code];
  if (k) input[k] = false;
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement) {
    input.lookX += e.movementX;
    input.lookY += e.movementY;
  }
});
addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    if (G.phase === 'live' || G.phase === 'buy') {
      if (!document.pointerLockElement && !SHOT) {
        lockPointer(); // first click captures the mouse, it does not fire
      } else {
        input.fireHeld = true;
        tryFireOnce();
      }
    }
  }
  if (e.button === 2) {
    player.scoped = player.current === 'LONGSHOT' && (G.phase === 'live');
  }
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) input.fireHeld = false;
  if (e.button === 2) player.scoped = false;
});
addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  hud.hint.classList.toggle('show', !document.pointerLockElement && G.phase === 'live');
});
function lockPointer() {
  try {
    const p = renderer.domElement.requestPointerLock();
    // Newer Chrome returns a promise that rejects when the lock cannot be taken
    // (headless, no user gesture): swallow it and let the click fire instead,
    // so the game stays playable without pointer lock.
    if (p && typeof p.catch === 'function') {
      p.catch(() => { input.fireHeld = true; tryFireOnce(); });
    }
  } catch (e) { /* headless: look stays put */ }
}
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- the shared hitscan resolver: player and bots shoot through this one function ----
const _o = new THREE.Vector3();
const _hit = new THREE.Vector3();
function rayAABB(ox, oy, oz, dx, dy, dz, box) {
  let t0 = 0, t1 = Infinity;
  const axes = [[ox, dx, box.x0, box.x1], [oy, dy, box.y0, box.y1], [oz, dz, box.z0, box.z1]];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return -1;
    } else {
      let ta = (lo - o) / d, tb = (hi - o) / d;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return -1;
    }
  }
  return t0;
}
function hitBoxes(a) {
  const crouch = a === player && player.crouched;
  const headTop = crouch ? 1.32 : 1.8;
  const headBot = crouch ? 1.0 : 1.45;
  return {
    body: { x0: a.pos.x - 0.36, x1: a.pos.x + 0.36, y0: 0.05, y1: headBot, z0: a.pos.z - 0.36, z1: a.pos.z + 0.36 },
    head: { x0: a.pos.x - 0.2, x1: a.pos.x + 0.2, y0: headBot, y1: headTop, z0: a.pos.z - 0.2, z1: a.pos.z + 0.2 },
  };
}

function fireShot(shooter, origin, dir, weaponId) {
  const w = WEAPONS[weaponId];
  const range = w.range;
  const wallT = rayHit(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, range, colliders);
  let bestT = wallT === -1 ? range : wallT;
  let victim = null, head = false;
  for (const a of agents) {
    if (a === shooter || !a.alive) continue;
    const boxes = hitBoxes(a);
    const tb = rayAABB(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, boxes.body);
    const th = rayAABB(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, boxes.head);
    let t = -1, isHead = false;
    if (th !== -1 && (tb === -1 || th <= tb)) { t = th; isHead = true; }
    else if (tb !== -1) { t = tb; }
    if (t !== -1 && t < bestT) { bestT = t; victim = a; head = isHead; }
  }
  _hit.copy(origin).addScaledVector(dir, bestT);
  spawnTracer(origin, _hit);
  if (victim) {
    const dist = bestT;
    const falloff = dist > 40 ? 0.65 : dist > 25 ? 0.8 : 1;
    const dmg = w.damage * falloff * (head ? w.headMult : 1);
    const dealt = victim.takeDamage(dmg, head);
    if (shooter === player) {
      hitmarker(false);
      sfx.hit();
    }
    if (victim === player) sfx.hurt();
    if (!victim.alive) {
      shooter.kills = (shooter.kills || 0) + 1;
      killfeed(
        { name: shooter === player ? 'YOU' : shooter.name, team: shooter.team },
        { name: victim === player ? 'YOU' : victim.name, team: victim.team },
        w.name, head,
      );
      if (shooter === player) { player.money = Math.min(MAX_MONEY, player.money + KILL_REWARD); hitmarker(true); sfx.kill(); }
      if (shooter !== player) botMoney.set(shooter, Math.min(MAX_MONEY, (botMoney.get(shooter) || 0) + KILL_REWARD));
      if (victim === player) onPlayerDeath();
      else victim.die();
      if (bomb.carrier === victim) dropCharge(victim.pos);
      checkRoundEnd();
    }
    return { hit: true, victim, head, dealt };
  }
  return { hit: false };
}

function tryFireOnce() {
  if (G.phase !== 'live' || !player.alive) return;
  if (player.tryFire(G.now)) {
    const origin = player.eyePos();
    const dir = player.shotDirection();
    fireShot(player, origin, dir, player.current);
    sfx.shot(player.current, null);
  } else if (player.ammo().mag === 0 && player.cooldown <= 0) {
    sfx.dry();
    tryReload();
  }
}
function tryReload() {
  if (G.phase === 'live' || G.phase === 'buy') {
    if (player.startReload()) sfx.reload();
  }
}
function switchWeapon(slot) {
  if (slot === 0 && player.slots[0]) {
    player.current = player.slots[0];
    player.scoped = false;
  } else if (slot === 1) {
    player.current = 'P9';
    player.scoped = false;
  }
}

// ---- buy menu ----
function toggleBuy() {
  if (G.phase !== 'buy' || !player.alive) return;
  const m = $('buy-menu');
  m.classList.toggle('open');
  refreshBuy();
}
function refreshBuy() {
  $('buy-money').textContent = `$${player.money}`;
  for (const btn of document.querySelectorAll('[data-buy]')) {
    const id = btn.dataset.buy;
    const price = id === 'KEVLAR' ? KEVLAR_PRICE : id === 'FLASH' ? FLASH_PRICE : WEAPONS[id].price;
    btn.classList.toggle('cant', player.money < price || (id === 'KEVLAR' && player.armor));
  }
}
function buy(item) {
  if (G.phase !== 'buy' || !player.alive) return;
  let price = 0;
  if (item === 'KEVLAR') {
    if (player.armor || player.money < KEVLAR_PRICE) return;
    price = KEVLAR_PRICE;
    player.money -= price;
    player.armor = true;
  } else if (item === 'FLASH') {
    if (player.money < FLASH_PRICE) return;
    price = FLASH_PRICE;
    player.money -= price;
    player.grenades += 1;
  } else {
    const w = WEAPONS[item];
    if (player.money < w.price) return;
    price = w.price;
    player.money -= price;
    if (player.owned[item]) {
      player.owned[item].mag = w.mag;
      player.owned[item].reserve = w.reserve;
    } else {
      player.owned[item] = { mag: w.mag, reserve: w.reserve };
      player.slots[0] = item;
      player.current = item;
    }
    player.scoped = false;
  }
  sfx.buy();
  refreshBuy();
}
for (const btn of document.querySelectorAll('[data-buy]')) {
  btn.addEventListener('click', () => buy(btn.dataset.buy));
}
$('buy-close').addEventListener('click', () => $('buy-menu').classList.remove('open'));

// ---- grenade ----
function throwFlash() {
  if (G.phase !== 'live' || !player.alive || player.grenades <= 0) return;
  player.grenades -= 1;
  const origin = player.eyePos();
  const dir = new THREE.Vector3(-Math.sin(player.yaw), 0.16, -Math.cos(player.yaw)).normalize();
  const mesh = new THREE.Mesh(grenadeGeo, grenadeMat);
  mesh.position.copy(origin);
  scene.add(mesh);
  grenades.push({
    pos: origin.clone(), vel: dir.multiplyScalar(15).add(new THREE.Vector3(0, 3.5, 0)),
    timer: 1.4, mesh,
  });
  tone(600, 0.05, 'square', 0.1);
}
function explodeFlash(g) {
  scene.remove(g.mesh);
  noise(0.25, 0.7, 5000);
  tone(2400, 0.3, 'sine', 0.25, 800);
  const p = g.pos;
  for (const b of bots) {
    if (!b.alive) continue;
    const dx = p.x - b.pos.x, dy = p.y - b.eyePos().y, dz = p.z - b.pos.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 18) continue;
    if (!hasLOS(p.x, p.y, p.z, b.pos.x, b.eyePos().y, b.pos.z, colliders)) continue;
    const fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
    if ((dx * fx + dz * fz) / (d || 1) < -0.2) continue; // looking away
    b.blindUntil = G.now + 2.5;
  }
  if (player.alive) {
    const dx = p.x - player.pos.x, dy = p.y - player.eyePos().y, dz = p.z - player.pos.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 30 && hasLOS(p.x, p.y, p.z, player.pos.x, player.eyePos().y, player.pos.z, colliders)) {
      const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
      if ((dx * fx + dz * fz) / (d || 1) > 0.05) {
        hud.flash.style.opacity = '0.95';
        setTimeout(() => { hud.flash.style.opacity = '0'; }, 350);
      }
    }
  }
}

// ---- charge ----
function dropCharge(pos) {
  bomb.state = 'dropped';
  bomb.carrier = null;
  bomb.pos.set(pos.x, 0.12, pos.z);
  bombMesh.visible = true;
  bombMesh.position.copy(bomb.pos);
}
function plantCharge(byBot) {
  bomb.state = 'planted';
  bomb.fuse = 40;
  bomb.pos.set(byBot ? byBot.pos.x : player.pos.x, 0.12, byBot ? byBot.pos.z : player.pos.z);
  bomb.site = inSite(SITES.A, bomb.pos.x, bomb.pos.z) ? 'A' : 'B';
  bombMesh.visible = true;
  bombMesh.position.copy(bomb.pos);
  banner('CHARGE PLANTED', `Site ${bomb.site} — 40 seconds on the fuse`, 3000);
  sfx.plant();
  for (const b of bots) { b.path = null; b.repathAt = 0; }
}
function detonate() {
  sfx.explosion();
  bombMesh.visible = false;
  bomb.state = 'none';
  endRound('strike', 'Detonation — site destroyed');
}

// ---- round / match flow ----
function botBuy(b) {
  let money = botMoney.get(b);
  let pick = 'P9';
  if (money >= 4300 && rng() < 0.22) pick = 'LONGSHOT';
  else if (money >= 2700) pick = 'AR7';
  else if (money >= 1400) pick = 'VK9';
  const price = WEAPONS[pick].price;
  money -= price;
  let armor = false;
  if (money >= KEVLAR_PRICE + 400 && rng() < 0.55) { armor = true; money -= KEVLAR_PRICE; }
  botMoney.set(b, money);
  b.money = money;
  return { weaponId: pick, armor };
}

function startMatch() {
  G.scoreS = 0; G.scoreA = 0; G.round = 1; G.winner = null;
  player.resetMatch();
  for (const b of bots) { botMoney.set(b, START_MONEY); b.kills = 0; b.deaths = 0; }
  $('end-screen').classList.add('hidden');
  $('menu').classList.add('hidden');
  startRound();
}

function startRound() {
  G.sitePick = rng() < 0.5 ? 'A' : 'B';
  const otherSite = G.sitePick === 'A' ? 'B' : 'A';
  // STRIKE: player + 3 bots west; AEGIS: 4 bots east.
  player.resetRound(SPAWNS.strike[0], -Math.PI / 2);
  player.owned.P9 = { mag: WEAPONS.P9.mag, reserve: WEAPONS.P9.reserve };
  bots.forEach((b, i) => {
    const spawn = b.team === 'strike' ? SPAWNS.strike[i + 1] : SPAWNS.aegis[i - 3];
    const buyInfo = botBuy(b);
    b.resetRound(spawn[0], spawn[1], b.team === 'strike' ? -Math.PI / 2 : Math.PI / 2,
      buyInfo.weaponId, buyInfo.armor);
    if (b.team === 'strike') {
      b.siteKey = i === 2 ? otherSite : G.sitePick; // one flanker takes the other site
    } else {
      // AEGIS posts: two on A, one on B, one roaming mid.
      const posts = {
        a0: [19, -13], a1: [26, -18], a2: [19, 13], a3: [4, 0],
      };
      b.post = { x: posts[b.id][0], z: posts[b.id][1] };
    }
  });
  bomb.state = 'carried';
  bomb.carrier = player;
  bomb.plantProgress = 0;
  bomb.fuse = 0;
  bombMesh.visible = false;
  G.phase = 'buy';
  G.roundTime = 12;
  $('buy-menu').classList.remove('open');
  banner(`ROUND ${G.round}`, 'Buy phase — B for the buy menu', 2200);
}

function awardMoney(winner) {
  for (const a of agents) {
    if (a === player) {
      player.money = Math.min(MAX_MONEY, player.money + (a.team === winner ? (bomb.state === 'none' && G.endReason.startsWith('Detonation') ? DETONATION_WIN : ROUND_WIN) : ROUND_LOSS));
    }
  }
  for (const b of bots) {
    const m = botMoney.get(b);
    const gain = b.team === winner
      ? (G.endReason.startsWith('Detonation') ? DETONATION_WIN : ROUND_WIN)
      : ROUND_LOSS;
    botMoney.set(b, Math.min(MAX_MONEY, m + gain));
  }
}

function endRound(winner, reason) {
  if (G.phase !== 'live' && G.phase !== 'buy') return;
  G.phase = 'roundEnd';
  G.endReason = reason;
  if (winner === 'strike') G.scoreS += 1; else G.scoreA += 1;
  awardMoney(winner);
  G.endTimer = 4.5;
  $('buy-menu').classList.remove('open');
  const won = winner === 'strike';
  banner(won ? 'STRIKE TAKES THE ROUND' : 'AEGIS TAKES THE ROUND', reason, 3200);
  if (won) sfx.win(); else sfx.lose();
}

function endMatch() {
  G.phase = 'matchEnd';
  G.winner = G.scoreS > G.scoreA ? 'strike' : 'aegis';
  if (document.pointerLockElement) document.exitPointerLock();
  $('end-title').textContent = G.winner === 'strike' ? 'STRIKE WINS THE MATCH' : 'AEGIS WINS THE MATCH';
  $('end-score').textContent = `${G.scoreS} — ${G.scoreA}`;
  const rows = [...agents]
    .sort((a, b) => (b.kills - b.deaths) - (a.kills - a.deaths))
    .map((a) => `<tr><td class="${a.team}">${a === player ? 'YOU' : a.name}</td><td>${a.team.toUpperCase()}</td><td>${a.kills}</td><td>${a.deaths}</td></tr>`)
    .join('');
  $('kd-body').innerHTML = rows;
  $('end-screen').classList.remove('hidden');
  if (G.winner === 'strike') sfx.win(); else sfx.lose();
}

function checkRoundEnd() {
  if (G.phase !== 'live') return;
  const sAlive = agents.filter((a) => a.team === 'strike' && a.alive).length;
  const aAlive = agents.filter((a) => a.team === 'aegis' && a.alive).length;
  if (bomb.state === 'planted') {
    if (aAlive === 0) return; // fuse still decides it
    return;
  }
  if (sAlive === 0) endRound('aegis', 'STRIKE eliminated');
  else if (aAlive === 0) endRound('strike', 'AEGIS eliminated');
}

function onPlayerDeath() {
  player.scoped = false;
  if (document.pointerLockElement) document.exitPointerLock();
  banner('YOU ARE DOWN', 'Spectating your team', 2400);
}

// ---- bot context: everything a bot needs from the match ----
function botContext() {
  return {
    now: G.now,
    rng,
    graph,
    colliders,
    agents,
    bomb,
    shoot: (bot, origin, dir, weaponId) => {
      fireShot(bot, origin, dir, weaponId);
      const d = origin.distanceTo(player.eyePos());
      sfx.shot(weaponId, d);
    },
    carrierAgent: () => (bomb.carrier && bomb.carrier.alive ? bomb.carrier : null),
    onPlant: (bot) => { bomb.carrier = bot; plantCharge(bot); },
    onDefuse: () => endRound('aegis', 'Charge defused'),
    onPickup: (bot) => {
      bomb.state = 'carried';
      bomb.carrier = bot;
      bombMesh.visible = false;
    },
  };
}

// ---- simulation step (fixed 1/60) ----
function sim(dt) {
  G.now += dt;
  if (G.phase === 'menu') {
    const t = G.now;
    camera.position.set(-28, 2.4, Math.sin(t * 0.12) * 2);
    camera.rotation.set(0, -Math.PI / 2 + Math.sin(t * 0.1) * 0.18, 0);
    return;
  }
  if (G.phase === 'buy') {
    G.roundTime -= dt;
    player.update(dt, input, colliders);
    if (G.roundTime <= 0) {
      G.phase = 'live';
      G.roundTime = 100;
      banner('GO', 'Plant the charge or eliminate AEGIS', 1800);
      tone(660, 0.1, 'sine', 0.2);
    }
  } else if (G.phase === 'live') {
    G.roundTime -= dt;
    // Player plant channel: hold E, still, inside a site, carrying the charge.
    if (bomb.state === 'carried' && bomb.carrier === player && player.alive) {
      const site = inSite(SITES.A, player.pos.x, player.pos.z) ? SITES.A
        : inSite(SITES.B, player.pos.x, player.pos.z) ? SITES.B : null;
      if (site && input.interact && player.speed2d < 0.6) {
        bomb.plantProgress += dt;
        if (bomb.plantProgress >= 3) plantCharge(null);
      } else {
        bomb.plantProgress = Math.max(0, bomb.plantProgress - dt * 2);
      }
    }
    // Fuse.
    if (bomb.state === 'planted') {
      bomb.fuse -= dt;
      const interval = bomb.fuse > 20 ? 1.0 : bomb.fuse > 10 ? 0.5 : 0.25;
      if (G.now >= bomb.beepAt) {
        sfx.beep();
        bomb.beepAt = G.now + interval;
        bombMesh.userData.light.material.emissiveIntensity =
          bombMesh.userData.light.material.emissiveIntensity > 1 ? 0.2 : 2;
      }
      if (bomb.fuse <= 0) { detonate(); return; }
    }
    // Timeout with no plant: defenders win.
    if (G.roundTime <= 0 && bomb.state !== 'planted') {
      endRound('aegis', 'Time — the charge never went down');
      return;
    }
    player.update(dt, input, colliders);
    // Hold-to-fire for automatics.
    if (input.fireHeld && player.weapon().auto && player.cooldown <= 0) tryFireOnce();
    // Bots.
    const ctx = botContext();
    for (const b of bots) b.update(dt, ctx);
    // Spectate when dead: camera rides the first living teammate.
    if (!player.alive) {
      const mate = bots.find((b) => b.team === 'strike' && b.alive);
      if (mate) {
        const bx = mate.pos.x + Math.sin(mate.yaw) * 2.4;
        const bz = mate.pos.z + Math.cos(mate.yaw) * 2.4;
        camera.position.set(bx, 2.1, bz);
        camera.rotation.set(0, mate.yaw, 0);
        camera.rotateX(-0.12);
      }
    }
  } else if (G.phase === 'roundEnd') {
    G.endTimer -= dt;
    for (const b of bots) if (b.alive) b.syncMesh();
    if (G.endTimer <= 0) {
      if (G.scoreS >= 9 || G.scoreA >= 9) endMatch();
      else { G.round += 1; startRound(); }
    }
  }
  // Grenades fly in buy/live.
  if (G.phase === 'live' || G.phase === 'buy') {
    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      g.timer -= dt;
      g.vel.y -= 12 * dt;
      const nx = g.pos.x + g.vel.x * dt;
      const nz = g.pos.z + g.vel.z * dt;
      // Wall bounce: axis-separated, like movement.
      let px = g.pos.x, pz = g.pos.z;
      if (!circleHits(nx, pz, 0.15, colliders)) px = nx; else g.vel.x *= -0.4;
      if (!circleHits(px, nz, 0.15, colliders)) pz = nz; else g.vel.z *= -0.4;
      g.pos.set(px, g.pos.y + g.vel.y * dt, pz);
      if (g.pos.y < 0.1) { g.pos.y = 0.1; g.vel.y *= -0.35; g.vel.x *= 0.7; g.vel.z *= 0.7; }
      g.mesh.position.copy(g.pos);
      if (g.timer <= 0) {
        explodeFlash(g);
        grenades.splice(i, 1);
      }
    }
  }
  updateHud();
}

function circleHits(x, z, r, cols) {
  for (const c of cols) {
    if (x >= c.x0 - r && x <= c.x1 + r && z >= c.z0 - r && z <= c.z1 + r) return true;
  }
  return false;
}

// ---- HUD refresh ----
function updateHud() {
  const mm = Math.max(0, Math.ceil(bomb.state === 'planted' ? bomb.fuse : G.roundTime));
  const clock = `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, '0')}`;
  setText(hud.score, 'score', `STRIKE ${G.scoreS} — ${G.scoreA} AEGIS · ROUND ${G.round}`);
  setText(hud.clock, 'clock', bomb.state === 'planted' ? `FUSE ${clock}` : clock);
  setText(hud.phase, 'phase',
    G.phase === 'buy' ? 'BUY PHASE — press B' : G.phase === 'live' ? (bomb.state === 'planted' ? 'CHARGE LIVE' : 'LIVE') : G.phase.toUpperCase());
  setText(hud.hp, 'hp', `${Math.ceil(player.hp)}`);
  hud.hpBar.style.width = `${Math.max(0, player.hp)}%`;
  hud.hpBar.classList.toggle('low', player.hp <= 30);
  hud.armor.classList.toggle('on', player.armor);
  setText(hud.money, 'money', `$${player.money}`);
  const w = player.weapon();
  setText(hud.wname, 'wname', w.name + (player.scoped ? ' · SCOPED' : ''));
  const a = player.ammo();
  setText(hud.mag, 'mag', `${a.mag}`);
  setText(hud.res, 'res', `/ ${a.reserve}`);
  setText(hud.nades, 'nades', `FLASH ×${player.grenades}`);
  const gap = 5 + player.currentSpread() * 900;
  hud.cross.style.setProperty('--gap', `${gap.toFixed(1)}px`);
  hud.charge.classList.toggle('show',
    bomb.state === 'carried' && bomb.carrier === player && G.phase === 'live');
  hud.charge.textContent = 'CHARGE — hold E on a site to plant';
  // Plant / defuse progress bar.
  let prog = -1, label = '';
  if (bomb.state === 'carried' && bomb.carrier === player && bomb.plantProgress > 0) {
    prog = bomb.plantProgress / 3; label = 'PLANTING';
  } else {
    const defuser = bots.find((b) => b.team === 'aegis' && b.state === 'defuse' && b.defuseProgress > 0);
    if (defuser) { prog = defuser.defuseProgress / 5; label = 'DEFUSE IN PROGRESS'; }
  }
  if (prog >= 0) {
    hud.channel.classList.add('show');
    hud.channelFill.style.width = `${Math.min(100, prog * 100)}%`;
    hud.channelLabel.textContent = label;
  } else {
    hud.channel.classList.remove('show');
  }
}

// ---- menu / deploy / play again ----
function deploy() {
  if (G.phase !== 'menu') return;
  audio();
  startMatch();
  lockPointer();
}
$('deploy').addEventListener('click', deploy);
$('play-again').addEventListener('click', () => {
  startMatch();
  lockPointer();
});

// ---- deterministic ?shot= render modes for the screenshots ----
function applyShotMode() {
  if (SHOT === 'start') {
    placeAgentsForShot();
    return; // menu stays up over the scene
  }
  if (SHOT === 'play') {
    $('menu').classList.add('hidden');
    startMatch();
    G.phase = 'live';
    G.roundTime = 95;
    player.pos.set(-18, 0, 0);
    player.yaw = -Math.PI / 2;
    const aegis = bots.filter((b) => b.team === 'aegis');
    if (aegis[0]) { aegis[0].pos.set(6, 0, 1.5); aegis[0].yaw = Math.PI / 2; }
    if (aegis[1]) { aegis[1].pos.set(10, 0, -4); aegis[1].yaw = Math.PI / 2; }
    if (aegis[2]) { aegis[2].pos.set(2, 0, -6); aegis[2].yaw = Math.PI / 2; }
    return;
  }
  if (SHOT === 'end') {
    $('menu').classList.add('hidden');
    G.scoreS = 9; G.scoreA = 7; G.round = 16;
    player.kills = 14; player.deaths = 9;
    const kd = [[11, 8], [9, 10], [8, 7], [10, 12], [7, 9], [9, 11], [6, 10]];
    bots.forEach((b, i) => { b.kills = kd[i][0]; b.deaths = kd[i][1]; });
    placeAgentsForShot();
    camera.position.set(-26, 3.2, 6);
    camera.rotation.set(0, -Math.PI / 2 - 0.15, 0);
    endMatch();
  }
}
function placeAgentsForShot() {
  player.resetRound(SPAWNS.strike[0], -Math.PI / 2);
  bots.forEach((b, i) => {
    const spawn = b.team === 'strike' ? SPAWNS.strike[i + 1] : SPAWNS.aegis[i - 3];
    b.resetRound(spawn[0], spawn[1], b.team === 'strike' ? -Math.PI / 2 : Math.PI / 2, 'AR7', true);
    b.mesh.position.set(spawn[0], 0, spawn[1]);
  });
  camera.position.set(-28, EYE(), 0);
  camera.rotation.set(0, -Math.PI / 2, 0);
}
function EYE() { return 1.62; }

applyShotMode();
updateHud();

// ---- main loop: fixed-step sim, render apart ----
let last = performance.now();
let acc = 0;
const STEP = 1 / 60;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  acc += dt;
  let n = 0;
  while (acc >= STEP && n < 5) { sim(STEP); acc -= STEP; n += 1; }
  if (n === 5) acc = 0;
  for (const line of tracers) {
    if (line.userData.life > 0) {
      line.userData.life -= dt;
      line.material.opacity = Math.max(0, line.userData.life / 0.08) * 0.9;
    }
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

window.__game = { G, player, bots, bomb, version: 'sunder-2' };
