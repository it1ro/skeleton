import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/telemetry/fingerprint.ts';

describe('fingerprint', () => {
  it('stays the same for the same error', () => {
    expect(fingerprint('boom', 'game.js', 12)).toBe(fingerprint('boom', 'game.js', 12));
  });

  it('separates different messages, files and lines', () => {
    const base = fingerprint('boom', 'game.js', 12);
    expect(fingerprint('bang', 'game.js', 12)).not.toBe(base);
    expect(fingerprint('boom', 'other.js', 12)).not.toBe(base);
    expect(fingerprint('boom', 'game.js', 13)).not.toBe(base);
  });

  it('handles missing file and line', () => {
    expect(fingerprint('boom', null, null)).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint('boom', null, null)).toBe(fingerprint('boom', null, null));
  });
});
