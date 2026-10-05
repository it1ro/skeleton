/** Fixed simulation step, shared by client prediction and server. */
export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
/** Server sends a snapshot every N ticks. */
export const SNAPSHOT_EVERY = 2;

export const CHUNK_SIZE = 64; // meters
export const CHUNK_SEGMENTS = 32; // quads per chunk side, 2 m each
export const WATER_LEVEL = 0;

/** Real seconds in one in-game day. */
export const DAY_LENGTH = 20 * 60;

export const SERVER_PORT = 8787;
