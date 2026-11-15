// player.js — first-person controller, weapon definitions and the viewmodel.
// The accuracy model is the game's thesis: a shot's spread cone grows with
// movement, jumping and sustained fire, and shrinks to near-nothing when you
// stand still — and tighter still crouched. Rifles reward the patient shot.

import * as THREE from 'three';
import { collide } from './world.js';

export const WEAPONS = {
  p9: {
    id: 'p9', name: 'P9 SIDEARM', slot: 2, price: 0,
    damage: 26, headMult: 3.0, rofMs: 270, auto: false,
    mag: 12, reserveStart: 48, reloadMs: 1150, range: 70,
    spreadStill: 0.007, spreadMove: 0.030, bloomPerShot: 0.006, kick: 0.5,
    tracer: 0xffd9a0,
  },
  vk9: {
    id: 'vk9', name: 'VK-9 SMG', slot: 1, price: 1400,
    damage: 22, headMult: 2.6, rofMs: 88, auto: true,
    mag: 30, reserveStart: 90, reloadMs: 1750, range: 60,
    spreadStill: 0.013, spreadMove: 0.042, bloomPerShot: 0.004, kick: 0.35,
    tracer: 0xffc98a,
  },
  ar7: {
    id: 'ar7', name: 'AR-7 RIFLE', slot: 1, price: 2700,
    damage: 34, headMult: 3.0, rofMs: 112, auto: true,
    mag: 30, reserveStart: 90, reloadMs: 1950, range: 110,
    spreadStill: 0.0035, spreadMove: 0.052, bloomPerShot: 0.005, kick: 0.6,
    tracer: 0xffe2b0,
  },
  longshot: {
    id: 'longshot', name: 'LONGSHOT DMR', slot: 1, price: 4300,
    damage: 98, headMult: 2.0, rofMs: 1350, auto: false,
    mag: 5, reserveStart: 25, reloadMs: 2600, range: 160,
    spreadStill: 0.0012, spreadMove: 0.075, bloomPerShot: 0.01, kick: 1.6,
    zoomFov: 24, tracer: 0xfff3d0,
  },
};

export class Input {
  constructor(dom) {
    this.keys = new Set();
    this.mouseDX = 0; this.mouseDY = 0;
    this.firing = false; this.firePressed = false;
    this.scoping = false;
    this.locked = false;
    this.enabled = false;
    const el = dom;
    document.addEventListener('keydown', (e) => {
      if (['Space', 'ControlLeft', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault();
      if (!e.repeat) this.keys.add(e.code);
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked || !this.enabled) return;
      if (e.button === 0) { this.firing = true; this.firePressed = true; }
      if (e.button === 2) this.scoping = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firing = false;
      if (e.button === 2) this.scoping = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      if (!this.locked) { this.firing = false; this.scoping = false; }
    });
    this.dom = el;
  }
  lock() {
    // Returns a promise in newer Chrome; a refusal (no gesture yet) just
    // means the next canvas click will lock instead.
    try { this.dom.requestPointerLock?.()?.catch?.(() => {}); } catch { /* not fatal */ }
  }
  consumeMouse() {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0; this.mouseDY = 0;
    return d;
  }
  down(...codes) { return codes.some((c) => this.keys.has(c)); }
}

const GRAVITY = -19;
const EYE_STAND = 1.62, EYE_CROUCH = 1.06;

export class Player {
  constructor(scene, camera, world, input) {
    this.camera = camera;
    this.world = world;
    this.input = input;
    this.pos = new THREE.Vector3(-28, 0, 0);
    this.vel = new THREE.Vector3();
    this.yaw = Math.PI / 2; this.pitch = 0;
    this.hp = 100; this.armor = false; this.alive = true;
    this.onGround = true; this.crouching = false;
    this.eye = EYE_STAND;
    this.bloom = 0; this.kickPitch = 0; this.lastShotAt = -1e9;
    this.reloadingUntil = 0; this.reloadWeapon = null;
    this.loadout = { primary: null, pistol: freshWeapon(WEAPONS.p9), current: 'pistol' };
    this.events = { shoot() {}, dryFire() {}, reloadStart() {}, reloadEnd() {}, scoped() {} };
    this.buildViewmodel(scene);
  }

  buildViewmodel(scene) {
    this.gun = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x22252a, roughness: 0.55, metalness: 0.45 });
    const mid = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.5, metalness: 0.5 });
    const grip = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.8 });
    this.gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.11, 0.46), mid);
    this.gunBody.position.set(0, -0.02, -0.1);
    this.gunBarrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, 0.34), dark);
    this.gunBarrel.position.set(0, 0.015, -0.46);
    this.gunGrip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.08), grip);
    this.gunGrip.position.set(0, -0.13, 0.02);
    this.gunGrip.rotation.x = 0.25;
    this.gunMag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.07), dark);
    this.gunMag.position.set(0, -0.13, -0.16);
    this.gunSight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.02), dark);
    this.gunSight.position.set(0, 0.075, -0.3);
    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.34),
      new THREE.MeshBasicMaterial({ color: 0xffca7a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.flash.position.set(0, 0.015, -0.66);
    this.flashLight = new THREE.PointLight(0xffb45e, 0, 9);
    this.flashLight.position.set(0, 0, -0.6);
    this.gun.add(this.gunBody, this.gunBarrel, this.gunGrip, this.gunMag, this.gunSight, this.flash, this.flashLight);
    this.gun.position.set(0.22, -0.21, -0.45);
    this.gun.scale.setScalar(0.85);
    this.camera.add(this.gun);
    scene.add(this.camera);
  }

  setWeaponVisual(id) {
    // One viewmodel, re-proportioned per weapon class.
    const long = id === 'longshot', rifle = id === 'ar7', smg = id === 'vk9';
    this.gunBarrel.scale.z = long ? 1.7 : rifle ? 1.25 : smg ? 0.9 : 0.55;
    this.gunBody.scale.z = long || rifle ? 1.25 : smg ? 1.05 : 0.62;
    this.gunBody.scale.y = id === 'p9' ? 0.8 : 1;
    this.gunMag.visible = id !== 'p9';
    this.gunSight.visible = id !== 'p9';
  }

  spawn(spawn) {
    this.pos.set(spawn.x, 0, spawn.z);
    this.vel.set(0, 0, 0);
    this.yaw = spawn.yaw; this.pitch = 0;
    this.hp = 100; this.alive = true;
    this.bloom = 0; this.kickPitch = 0;
    this.reloadingUntil = 0;
  }

  get weapon() {
    const slot = this.loadout.current;
    return slot === 'primary' ? this.loadout.primary : this.loadout.pistol;
  }

  givePrimary(id) {
    this.loadout.primary = freshWeapon(WEAPONS[id]);
    this.loadout.current = 'primary';
    this.setWeaponVisual(id);
  }

  switchTo(slot) {
    if (slot === 'primary' && !this.loadout.primary) return;
    if (this.loadout.current === slot) return;
    this.loadout.current = slot;
    this.reloadingUntil = 0;
    this.setWeaponVisual(this.weapon.def.id);
  }

  eyePos() {
    return new THREE.Vector3(this.pos.x, this.pos.y + this.eye, this.pos.z);
  }

  // Current spread (radians of cone half-angle) for the held weapon.
  spread() {
    const w = this.weapon; if (!w) return 0.02;
    const moving = Math.hypot(this.vel.x, this.vel.z) > 0.6;
    let s = moving ? w.def.spreadMove : w.def.spreadStill;
    if (!this.onGround) s = Math.max(s, 0.085);
    if (this.crouching) s *= 0.6;
    if (this.input.down('ShiftLeft', 'ShiftRight') && moving) s *= 0.7;
    if (w.def.zoomFov && this.input.scoping) s = Math.min(s, 0.0012);
    if (w.def.zoomFov && !this.input.scoping) s = Math.max(s, 0.05);
    return s + this.bloom;
  }

  spreadPixels() {
    return 4 + this.spread() * 900;
  }

  update(dt, now) {
    const inp = this.input;
    const m = inp.consumeMouse();
    if (inp.enabled && inp.locked) {
      this.yaw -= m.dx * 0.00205;
      this.pitch -= m.dy * 0.00205;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    }
    this.crouching = inp.down('ControlLeft', 'ControlRight', 'KeyC');
    const targetEye = this.crouching ? EYE_CROUCH : EYE_STAND;
    this.eye += (targetEye - this.eye) * Math.min(1, dt * 11);

    const walking = inp.down('ShiftLeft', 'ShiftRight');
    const speed = this.crouching ? 2.3 : walking ? 2.7 : 5.4;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let fx = 0, fz = 0;
    if (inp.enabled) {
      if (inp.down('KeyW')) { fx -= sin; fz -= cos; }
      if (inp.down('KeyS')) { fx += sin; fz += cos; }
      if (inp.down('KeyA')) { fx -= cos; fz += sin; }
      if (inp.down('KeyD')) { fx += cos; fz -= sin; }
    }
    const len = Math.hypot(fx, fz);
    if (len > 0) { fx /= len; fz /= len; }
    const accel = this.onGround ? 14 : 2.5;
    this.vel.x += (fx * speed - this.vel.x) * Math.min(1, dt * accel);
    this.vel.z += (fz * speed - this.vel.z) * Math.min(1, dt * accel);
    if (inp.enabled && inp.down('Space') && this.onGround) {
      this.vel.y = 6.4; this.onGround = false;
    }
    this.vel.y += GRAVITY * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;
    if (this.pos.y <= 0) { this.pos.y = 0; this.vel.y = 0; this.onGround = true; }
    const [cx, cz] = collide(this.world.colliders, this.pos.x, this.pos.z, 0.45);
    this.pos.x = cx; this.pos.z = cz;

    // Camera + recoil recovery.
    this.kickPitch *= Math.pow(0.0001, dt); // fast decay
    this.camera.position.copy(this.eyePos());
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch + this.kickPitch, this.yaw, 0);
    const targetFov = (this.weapon?.def.zoomFov && inp.scoping) ? this.weapon.def.zoomFov : 75;
    if (Math.abs(this.camera.fov - targetFov) > 0.1) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 12);
      this.camera.updateProjectionMatrix();
    }
    this.gun.visible = !(this.weapon?.def.zoomFov && inp.scoping);

    // Bloom recovery + muzzle flash decay.
    this.bloom = Math.max(0, this.bloom - dt * 0.028);
    if (this.flash.material.opacity > 0) {
      this.flash.material.opacity = Math.max(0, this.flash.material.opacity - dt * 9);
      this.flashLight.intensity = this.flash.material.opacity * 14;
    }
    // Reload completion.
    if (this.reloadingUntil && now >= this.reloadingUntil) {
      const w = this.weapon;
      const need = w.def.mag - w.mag;
      const take = Math.min(need, w.reserve);
      w.mag += take; w.reserve -= take;
      this.reloadingUntil = 0;
      this.events.reloadEnd();
    }
    this.gun.position.y = -0.21 + (this.reloadingUntil ? -0.13 : 0) + Math.sin(now * 0.0022) * 0.0022;
    this.gun.rotation.x = this.reloadingUntil ? 0.5 : this.kickPitch * 0.6;

    // Firing.
    if (inp.enabled && inp.locked && this.alive) {
      const w = this.weapon;
      if (w) {
        const wantFire = w.def.auto ? inp.firing : inp.firePressed;
        if (wantFire && !this.reloadingUntil) this.tryFire(now);
        if (inp.firePressed && w.mag === 0 && !this.reloadingUntil) this.events.dryFire();
      }
    }
    inp.firePressed = false;
  }

  startReload(now) {
    const w = this.weapon;
    if (!w || this.reloadingUntil || w.mag >= w.def.mag || w.reserve <= 0) return;
    this.reloadingUntil = now + w.def.reloadMs;
    this.events.reloadStart();
  }

  tryFire(now) {
    const w = this.weapon;
    if (now - this.lastShotAt < w.def.rofMs) return;
    if (w.mag <= 0) { this.startReload(now); return; }
    this.lastShotAt = now;
    w.mag -= 1;
    const sp = this.spread();
    this.bloom = Math.min(0.05, this.bloom + w.def.bloomPerShot);
    this.kickPitch += 0.0035 * w.def.kick * (this.crouching ? 0.8 : 1);
    // Direction: camera forward with a uniform random cone of half-angle sp.
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * sp;
    const right = new THREE.Vector3(1, 0, 0).applyEuler(this.camera.rotation);
    const up = new THREE.Vector3(0, 1, 0).applyEuler(this.camera.rotation);
    dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    this.flash.material.opacity = 0.85;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.events.shoot(this.eyePos(), dir, w);
    if (w.mag === 0) this.startReload(now);
  }

  takeDamage(amount) {
    if (!this.alive) return false;
    const dmg = this.armor ? amount * 0.55 : amount;
    this.hp -= dmg;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; return true; }
    return false;
  }
}

export function freshWeapon(def) {
  return { def, mag: def.mag, reserve: def.reserveStart };
}
