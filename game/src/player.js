// SUNDER — player.js
// The human player: pointer-lock look, acceleration movement, weapons, spread and
// recoil, and the first-person viewmodel. One job: the body the player drives.
import * as THREE from 'three';
import { moveCircle } from './world.js';

export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.12;
export const PLAYER_RADIUS = 0.4;

// damage, head multiplier, fire rate, magazine, spread (radians), bloom per shot,
// kick (radians of pitch), reload seconds, price, zoom FOV (0 = none).
export const WEAPONS = {
  P9: {
    name: 'P9', price: 0, damage: 26, headMult: 2, rpm: 380, mag: 12, reserve: 48,
    spread: 0.011, bloom: 0.006, kick: 0.006, reload: 1.1, range: 60, auto: false, zoom: 0,
  },
  VK9: {
    name: 'VK-9 SMG', price: 1400, damage: 24, headMult: 2, rpm: 750, mag: 28, reserve: 84,
    spread: 0.017, bloom: 0.004, kick: 0.004, reload: 1.6, range: 55, auto: true, zoom: 0,
  },
  AR7: {
    name: 'AR-7', price: 2700, damage: 33, headMult: 2, rpm: 600, mag: 25, reserve: 75,
    spread: 0.009, bloom: 0.005, kick: 0.008, reload: 2.0, range: 70, auto: true, zoom: 0,
  },
  LONGSHOT: {
    name: 'LONGSHOT', price: 4300, damage: 88, headMult: 2, rpm: 55, mag: 5, reserve: 15,
    spread: 0.05, scopedSpread: 0.0016, bloom: 0.02, kick: 0.03, reload: 2.8, range: 90,
    auto: false, zoom: 30,
  },
};

export const KEVLAR_PRICE = 650;
export const FLASH_PRICE = 200;
export const START_MONEY = 800;
export const MAX_MONEY = 16000;
export const KILL_REWARD = 300;
export const ROUND_WIN = 3250;
export const DETONATION_WIN = 3500;
export const ROUND_LOSS = 1400;

const WALK_SPEED = 5.0;
const CROUCH_SPEED = 2.2;
const SLOW_SPEED = 2.4; // Shift: walk quietly, steadier aim
const ACCEL = 42;
const FRICTION = 11;
const JUMP_VEL = 5.4;
const GRAVITY = 14.5;

export class Player {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3(-28, 0, 0); // feet position
    this.vel = new THREE.Vector3();
    this.yaw = -Math.PI / 2; // facing +x (east, toward mid)
    this.pitch = 0;
    this.onGround = true;
    this.crouched = false;
    this.scoped = false;
    this.hp = 100;
    this.armor = false;
    this.money = START_MONEY;
    this.alive = true;
    this.kills = 0;
    this.deaths = 0;
    this.owned = { P9: { mag: 12, reserve: 48 } };
    this.slots = ['P9']; // 1 = primary slot, 2 = pistol
    this.current = 'P9';
    this.grenades = 0;
    this.bloom = 0;
    this.recoil = 0; // extra pitch, decays
    this.cooldown = 0;
    this.reloadTimer = 0;
    this.bobPhase = 0;
    this.speed2d = 0;
    this.viewmodel = this.buildViewmodel();
    camera.add(this.viewmodel);
  }

  get eyeY() { return this.pos.y + (this.crouched ? EYE_CROUCH : EYE_STAND); }

  weapon() { return WEAPONS[this.current]; }

  ammo() { return this.owned[this.current]; }

  buildViewmodel() {
    const g = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.55, metalness: 0.6 });
    const mid = new THREE.MeshStandardMaterial({ color: 0x3c4149, roughness: 0.6, metalness: 0.4 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xf0a830, roughness: 0.5, metalness: 0.3 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.42), dark);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.3), mid);
    barrel.position.set(0, 0.02, -0.32);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.09), dark);
    grip.position.set(0, -0.12, 0.14);
    grip.rotation.x = 0.35;
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.06), accent);
    sight.position.set(0, 0.09, -0.05);
    const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16),
      new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0, depthWrite: false }));
    flash.position.set(0, 0.02, -0.5);
    g.add(body, barrel, grip, sight, flash);
    g.position.set(0.24, -0.22, -0.45);
    g.userData.flash = flash;
    return g;
  }

  resetRound(spawn, yaw) {
    this.pos.set(spawn[0], 0, spawn[1]);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.hp = 100;
    this.alive = true;
    this.bloom = 0;
    this.recoil = 0;
    this.reloadTimer = 0;
    this.cooldown = 0;
    this.scoped = false;
    // Keep owned weapons across rounds; refill reserve on buy in main.
  }

  resetMatch() {
    this.money = START_MONEY;
    this.kills = 0;
    this.deaths = 0;
    this.owned = { P9: { mag: 12, reserve: 48 } };
    this.slots = ['P9'];
    this.current = 'P9';
    this.grenades = 0;
    this.armor = false;
  }

  // Returns true if a shot was fired (caller resolves the hitscan).
  tryFire(now) {
    if (!this.alive || this.cooldown > 0 || this.reloadTimer > 0) return false;
    const w = this.weapon();
    const a = this.ammo();
    if (a.mag <= 0) return false;
    a.mag -= 1;
    this.cooldown = 60 / w.rpm;
    this.bloom = Math.min(0.05, this.bloom + w.bloom);
    this.recoil = Math.min(0.12, this.recoil + w.kick);
    this.viewmodel.userData.flash.material.opacity = 0.9;
    return true;
  }

  startReload() {
    const w = this.weapon();
    const a = this.ammo();
    if (this.reloadTimer > 0 || a.mag >= w.mag || a.reserve <= 0) return false;
    this.reloadTimer = w.reload;
    return true;
  }

  // Spread in radians for the next shot: near-pinpoint standing still, worse moving,
  // in the air, or after sustained fire; tighter crouched. Scope steadies the DMR.
  currentSpread() {
    const w = this.weapon();
    let s = (this.current === 'LONGSHOT' && this.scoped) ? w.scopedSpread : w.spread;
    s *= 1 + this.speed2d * 0.32;
    if (this.crouched) s *= 0.7;
    if (!this.onGround) s *= 2.2;
    return s + this.bloom;
  }

  // Direction of the next shot, with spread applied.
  shotDirection() {
    const s = this.currentSpread();
    const yaw = this.yaw + (Math.random() * 2 - 1) * s;
    const pitch = this.pitch + this.recoil + (Math.random() * 2 - 1) * s;
    return new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    );
  }

  eyePos() {
    return new THREE.Vector3(this.pos.x, this.eyeY, this.pos.z);
  }

  takeDamage(amount, isHead) {
    if (!this.alive) return 0;
    let dmg = amount;
    if (this.armor) dmg *= isHead ? 0.7 : 0.55; // kevlar soaks body shots, less on head
    this.hp -= dmg;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; this.deaths += 1; }
    return dmg;
  }

  update(dt, input, colliders) {
    if (!this.alive) return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.bloom = Math.max(0, this.bloom - dt * 0.045);
    this.recoil = Math.max(0, this.recoil - dt * 0.25);
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        const w = this.weapon();
        const a = this.ammo();
        const need = w.mag - a.mag;
        const take = Math.min(need, a.reserve);
        a.mag += take;
        a.reserve -= take;
      }
    }
    // Look.
    this.yaw -= input.lookX * 0.0023 * (this.scoped ? 0.45 : 1);
    this.pitch -= input.lookY * 0.0023 * (this.scoped ? 0.45 : 1);
    this.pitch = Math.max(-1.52, Math.min(1.52, this.pitch));
    input.lookX = 0; input.lookY = 0;

    this.crouched = input.crouch;
    // Move: acceleration toward wish direction, friction when idle.
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = 0, wz = 0;
    if (input.forward) { wx -= sin; wz -= cos; }
    if (input.back) { wx += sin; wz += cos; }
    if (input.left) { wx -= cos; wz += sin; }
    if (input.right) { wx += cos; wz -= sin; }
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }
    const targetSpeed = this.crouched ? CROUCH_SPEED : (input.walk ? SLOW_SPEED : WALK_SPEED);
    const accelRate = this.onGround ? ACCEL : ACCEL * 0.35;
    this.vel.x += wx * accelRate * dt;
    this.vel.z += wz * accelRate * dt;
    if (wl === 0 && this.onGround) {
      const f = Math.max(0, 1 - FRICTION * dt);
      this.vel.x *= f; this.vel.z *= f;
    }
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp > targetSpeed) {
      const k = targetSpeed / sp;
      this.vel.x *= k; this.vel.z *= k;
    }
    this.speed2d = Math.hypot(this.vel.x, this.vel.z);

    const moved = moveCircle(this.pos.x, this.pos.z,
      this.vel.x * dt, this.vel.z * dt, PLAYER_RADIUS, colliders);
    this.pos.x = moved.x;
    this.pos.z = moved.z;

    if (input.jump && this.onGround) {
      this.vel.y = JUMP_VEL;
      this.onGround = false;
    }
    this.vel.y -= GRAVITY * dt;
    this.pos.y += this.vel.y * dt;
    if (this.pos.y <= 0) { this.pos.y = 0; this.vel.y = 0; this.onGround = true; }

    // Camera + viewmodel.
    this.bobPhase += this.speed2d * dt * 1.6;
    const bob = Math.min(1, this.speed2d / WALK_SPEED) * 0.012;
    this.camera.position.set(this.pos.x, this.eyeY + Math.sin(this.bobPhase * 2) * bob, this.pos.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch + this.recoil);
    const vm = this.viewmodel;
    vm.visible = !this.scoped;
    const kick = this.recoil * 1.6;
    vm.position.set(
      0.24 + Math.sin(this.bobPhase) * bob * 0.4,
      -0.22 + Math.abs(Math.cos(this.bobPhase)) * bob * 0.5,
      -0.45 + kick,
    );
    vm.rotation.x = kick * 0.9;
    vm.userData.flash.material.opacity = Math.max(0, vm.userData.flash.material.opacity - dt * 14);
    const targetFov = this.scoped ? 30 : 90;
    if (Math.abs(this.camera.fov - targetFov) > 0.5) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 14);
      this.camera.updateProjectionMatrix();
    }
  }
}
