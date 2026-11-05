import type { PlayerInput } from './movement.ts';

/** Which figure a player wears: the male or the female skeleton. Purely cosmetic — same stats and hitbox. */
export type Skeleton = 'm' | 'f';

/**
 * Wire messages. JSON for now: easy to debug in DevTools.
 * Switch to a binary encoding when snapshots grow (many entities, 10+ players).
 */

export interface PlayerSnapshot {
  id: number;
  name: string;
  color: number;
  /** The figure the player chose at the start; remote avatars wear it too. */
  skeleton: Skeleton;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Horizontal speed, drives the walk animation of remote avatars. */
  speed: number;
}

export type ClientMessage =
  | { t: 'hello'; name: string; skeleton: Skeleton }
  | { t: 'input'; inputs: PlayerInput[] };

export type ServerMessage =
  | { t: 'welcome'; id: number; seed: number; tick: number }
  | {
      t: 'snapshot';
      tick: number;
      /** Last input seq the server applied for the receiving player. */
      ack: number;
      /** Velocity of the receiving player, needed to replay pending inputs exactly. */
      vy: number;
      grounded: boolean;
      players: PlayerSnapshot[];
    }
  | { t: 'leave'; id: number };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decode<T extends ClientMessage | ServerMessage>(data: string): T | null {
  try {
    const msg = JSON.parse(data) as unknown;
    if (typeof msg === 'object' && msg !== null && typeof (msg as { t?: unknown }).t === 'string') return msg as T;
  } catch {
    // Malformed message: ignored by the caller.
  }
  return null;
}
