// player.js — first-person controller, weapons, spread and recoil.
// Movement: acceleration + friction, crouch, jump, walk; collision slides
// on the shared world colliders. Spread blooms with speed, air time and
// sustained fire, and tightens when crouched and still — stopping to aim
// pays. The viewmodel is a small low-poly gun built from boxes.
import * as THREE from 'three';
import { moveCircle } from './world.js';

// name, price, damage, head x, rpm, mag, reserve, reload s, spread base,
// auto?, zoom fov, tracer colour
export const WEAPONS = {
  P9: { name: 'P9', price: 0, dmg: 26, head: 2.2, rpm: 320, mag: 15, reserve: 45, reload: 1.3, spread: 0.011, auto: false, zoom: 0, kick: 0.011, range: 60 },
  VK9: { name: 'VK-9 SMG', price: 1400, dmg: 21, head: 2.0, rpm: 720, mag: 30, reserve: 120, reload: 1.9, spread: 0.017, auto: true, zoom: 0, kick: 0.009, range: 55 },
  AR7: { name: 'AR-7 Rifle', price: 2700, dmg: 33, head: 2.4, rpm: 600, mag: 25, reserve: 75, reload: 2.4, spread: 0.008, auto: true, zoom: 0, kick: 0.016, range: 80 },
  LONGSHOT: { name: 'LONGSHOT DMR', price: 4300, dmg: 78, head: 2.5, rpm: 65, mag: 5, reserve: 20, reload: 3.0, spread: 0.002, auto: false, zoom: 2.2, kick: 0.05, range: 120 },
};
export const KEVLAR_PRICE = 650;
export const ARMOR_FACTOR = 0.55; // kevlar multiplies incoming damage

export class Player {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.pos = new THREE.Vector3(0, 0, 0); // feet
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.onGround = true;
    this.crouch = false;
    this.hp = 100; this.armor = false;
    this.money = 800;
    this.alive = true;
    this.weapons = ['P9'];
    this.slot = 0;
    this.ammo = {}; // key -> { mag, reserve }
    for (const k of Object.keys(WEAPONS)) this.ammo[k] = { mag: WEAPONS[k].mag, reserve: WEAPONS[k].reserve };
    this.bloom = 0;          // sustained-fire bloom, 0..1
    this.lastShot = -10;
    this.reloading = 0;      // seconds left
    this.reloadKey = null;
    this.recoil = 0;         // pitch kick still to recover
    this.scoped = false;
    this.grenades = 0;
    this.kills = 0; this.deaths = 0;
    this.walkBob = 0;
    this.viewmodel = this.buildViewmodel();
    camera.add(this.viewmodel);
    scene.add(camera);
  }

  get weapon() { return WEAPONS[this.weapons[this.slot]]; }
  get weaponKey() { return this.weapons[this.slot]; }
  get eyeY() { return this.pos.y + (this.crouch ? 1.15 : 1.62); }
  get eye() { return new THREE.Vector3(this.pos.x, this.eyeY, this.pos.z); }

  buildViewmodel() {
    const g = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x3d4250, roughness: 0.45, metalness: 0.5, emissive: 0x11131a });
    const mid = new THREE.MeshStandardMaterial({ color: 0x6a7180, roughness: 0.4, metalness: 0.6, emissive: 0x181a20 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.55), dark);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 8), mid);
    barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.02, -0.4);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.09), dark);
    grip.position.set(0, -0.15, 0.12); grip.rotation.x = 0.25;
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.08), mid);
    sight.position.set(0, 0.09, -0.05);
    g.add(body, barrel, grip, sight);
    g.position.set(0.28, -0.24, -0.5);
    return g;
  }

  spawn(at, yaw) {
    this.pos.copy(at); this.vel.set(0, 0, 0);
    this.yaw = yaw; this.pitch = 0;
    this.hp = 100; this.alive = true; this.crouch = false;
    this.bloom = 0; this.reloading = 0; this.recoil = 0; this.scoped = false;
  }

  // keys: {f,b,l,r,jump,crouch,walk}; dt fixed step; now seconds.
  update(dt, keys, now) {
    if (!this.alive) return;
    const speed = this.crouch ? 2.4 : (keys.walk ? 3.1 : 5.6);
    const f = (keys.f ? 1 : 0) - (keys.b ? 1 : 0);
    const s = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // Forward is -Z rotated by yaw.
    let wx = (-sin) * f + cos * s;
    let wz = (-cos) * f + (-sin) * s;
    const len = Math.hypot(wx, wz);
    if (len > 0) { wx /= len; wz /= len; }
    const accel = this.onGround ? 42 : 12;
    this.vel.x += wx * accel * dt;
    this.vel.z += wz * accel * dt;
    // Friction on ground.
    const fr = this.onGround ? Math.max(0, 1 - 9 * dt) : Math.max(0, 1 - 0.4 * dt);
    if (len === 0) { this.vel.x *= fr; this.vel.z *= fr; }
    const hv = Math.hypot(this.vel.x, this.vel.z);
    if (hv > speed) { this.vel.x *= speed / hv; this.vel.z *= speed / hv; }
    if (keys.jump && this.onGround) { this.vel.y = 6.4; this.onGround = false; }
    this.vel.y -= 17 * dt;
    moveCircle(this.pos, this.vel.x * dt, this.vel.z * dt, 0.4);
    this.pos.y += this.vel.y * dt;
    if (this.pos.y <= 0) { this.pos.y = 0; this.vel.y = 0; this.onGround = true; }
    this.crouch = !!keys.crouch;
    // Bloom decays when not firing.
    this.bloom = Math.max(0, this.bloom - dt * 1.6);
    this.recoil = Math.max(0, this.recoil - dt * 0.09);
    this.pitch += this.recoil * dt * 0; // recoil applied at shot time
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0 && this.reloadKey) {
        const w = WEAPONS[this.reloadKey], a = this.ammo[this.reloadKey];
        const need = w.mag - a.mag, take = Math.min(need, a.reserve);
        a.mag += take; a.reserve -= take;
        this.reloadKey = null;
      }
    }
    const moving = Math.hypot(this.vel.x, this.vel.z);
    this.walkBob += dt * moving * 1.6;
    // Camera + viewmodel.
    this.camera.position.set(this.pos.x, this.eyeY + Math.sin(this.walkBob * 2) * 0.02 * Math.min(1, moving / 5), this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.fov = this.scoped ? 34 : 75;
    this.camera.updateProjectionMatrix();
    const sway = Math.sin(this.walkBob) * 0.006 * Math.min(1, moving / 5);
    this.viewmodel.position.set(0.28 + sway, -0.24 + Math.abs(Math.cos(this.walkBob)) * 0.006 * Math.min(1, moving / 5) - this.recoil * 0.4, -0.5);
    this.viewmodel.visible = this.alive;
  }

  // Current angular spread (radians) from stance + motion + bloom.
  spreadNow() {
    const w = this.weapon;
    const moving = Math.hypot(this.vel.x, this.vel.z);
    let s = w.spread;
    s += moving * 0.0035;
    if (!this.onGround) s += 0.03;
    if (this.crouch) s *= 0.6;
    if (this.scoped) s *= 0.35;
    s += this.bloom * 0.05;
    return s;
  }

  canFire(now) {
    const w = this.weapon, a = this.ammo[this.weaponKey];
    return this.alive && this.reloading <= 0 && a.mag > 0 && now - this.lastShot >= 60 / w.rpm;
  }

  // Returns a shot descriptor for the shared resolver, or null.
  fire(now) {
    if (!this.canFire(now)) return null;
    const w = this.weapon, a = this.ammo[this.weaponKey];
    a.mag--;
    this.lastShot = now;
    this.bloom = Math.min(1, this.bloom + (w.auto ? 0.09 : 0.16));
    this.recoil = Math.min(0.09, this.recoil + w.kick);
    this.pitch += w.kick * 0.55;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const spread = this.spreadNow();
    dir.x += (Math.random() * 2 - 1) * spread;
    dir.y += (Math.random() * 2 - 1) * spread;
    dir.z += (Math.random() * 2 - 1) * spread;
    dir.normalize();
    return { origin: this.eye, dir, weapon: w, key: this.weaponKey, shooter: 'player' };
  }

  reload() {
    const w = this.weapon, a = this.ammo[this.weaponKey];
    if (this.reloading > 0 || a.mag >= w.mag || a.reserve <= 0) return false;
    this.reloading = w.reload; this.reloadKey = this.weaponKey;
    return true;
  }

  switchSlot(i) {
    if (i >= 0 && i < this.weapons.length && i !== this.slot) {
      this.slot = i; this.reloading = 0; this.reloadKey = null; this.scoped = false;
      return true;
    }
    return false;
  }

  buy(key) {
    const w = WEAPONS[key];
    if (!w || w.price === 0 || this.weapons.includes(key)) return false;
    if (this.money < w.price) return false;
    this.money -= w.price;
    this.weapons.push(key);
    this.ammo[key] = { mag: w.mag, reserve: w.reserve };
    return true;
  }

  buyKevlar() {
    if (this.armor || this.money < KEVLAR_PRICE) return false;
    this.money -= KEVLAR_PRICE; this.armor = true;
    return true;
  }

  buyGrenade() {
    if (this.money < 300) return false;
    this.money -= 300; this.grenades++;
    return true;
  }

  takeDamage(dmg) {
    if (!this.alive) return;
    if (this.armor) dmg *= ARMOR_FACTOR;
    this.hp -= dmg;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; this.deaths++; }
  }
}
