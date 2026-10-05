import { WATER_LEVEL } from './constants.ts';
import type { Terrain } from './terrain.ts';

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  vy: number;
  yaw: number;
  grounded: boolean;
}

/** One fixed step of player intent. The client predicts with it, the server replays it. */
export interface PlayerInput {
  seq: number;
  /** -1..1 */
  forward: number;
  /** -1..1 */
  right: number;
  yaw: number;
  jump: boolean;
  sprint: boolean;
}

export const WALK_SPEED = 5;
export const SPRINT_SPEED = 8.5;
export const SWIM_SPEED = 2.5;
export const JUMP_SPEED = 8;
export const GRAVITY = 25;
/** Body floats this far below the water surface. */
export const SWIM_DEPTH = 1.3;
/** Steeper ground than this (rise per meter) blocks walking uphill. */
export const MAX_CLIMB = 1.2;

export function spawnState(terrain: Terrain): PlayerState {
  return { x: 0, y: terrain.heightAt(0, 0), z: 0, vy: 0, yaw: 0, grounded: true };
}

export type MoveMode = 'ground' | 'air' | 'swim';

/** What the body is doing at a position. Works for any player, so remote avatars animate like the local one. */
export function moveMode(x: number, y: number, z: number, terrain: Terrain): MoveMode {
  const ground = terrain.heightAt(x, z);
  const swimFloor = WATER_LEVEL - SWIM_DEPTH;
  if (ground < swimFloor && y <= swimFloor + 0.05) return 'swim';
  return y - Math.max(ground, swimFloor) > 0.25 ? 'air' : 'ground';
}

function clampUnit(v: number): number {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

/**
 * Kinematic movement over the heightmap. Deterministic: same state, input and dt
 * give the same result on client and server. Collision with objects comes later (Rapier).
 */
export function stepPlayer(s: PlayerState, input: PlayerInput, dt: number, terrain: Terrain): void {
  s.yaw = Number.isFinite(input.yaw) ? input.yaw : s.yaw;
  let fwd = clampUnit(input.forward);
  let right = clampUnit(input.right);
  const len = Math.hypot(fwd, right);
  if (len > 1) {
    fwd /= len;
    right /= len;
  }

  const ground = terrain.heightAt(s.x, s.z);
  const swimming = moveMode(s.x, s.y, s.z, terrain) === 'swim';
  const speed = swimming ? SWIM_SPEED : input.sprint ? SPRINT_SPEED : WALK_SPEED;

  // yaw 0 looks at -Z, like a three.js camera.
  const sin = Math.sin(s.yaw);
  const cos = Math.cos(s.yaw);
  const dx = (-sin * fwd + cos * right) * speed * dt;
  const dz = (-cos * fwd - sin * right) * speed * dt;

  const nextGround = terrain.heightAt(s.x + dx, s.z + dz);
  const step = Math.hypot(dx, dz);
  const tooSteep = s.grounded && step > 0 && (nextGround - ground) / step > MAX_CLIMB;
  if (!tooSteep) {
    s.x += dx;
    s.z += dz;
  }

  if (input.jump && (s.grounded || swimming)) {
    s.vy = swimming ? JUMP_SPEED * 0.6 : JUMP_SPEED;
    s.grounded = false;
  }

  s.vy -= GRAVITY * dt;
  s.y += s.vy * dt;

  const floor = Math.max(terrain.heightAt(s.x, s.z), WATER_LEVEL - SWIM_DEPTH);
  if (s.y <= floor) {
    s.y = floor;
    s.vy = 0;
    s.grounded = true;
  } else if (s.grounded && s.vy <= 0 && s.y - floor < 0.6) {
    // Stick to the ground when walking downhill instead of hopping.
    s.y = floor;
    s.vy = 0;
  } else {
    s.grounded = false;
  }
}
