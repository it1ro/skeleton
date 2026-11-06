import { describe, expect, it } from 'vitest';
import type { Biome } from '@skeleton/shared';
import {
  BANYA_ENTER,
  BANYA_EXIT,
  CYCLE_SECONDS,
  GUARD_ENTER,
  GUARD_EXIT,
  GuardScene,
  MusicZones,
  WAKE_RADIUS,
  ZONE_ENTER_DWELL,
  ZONE_EXIT_DWELL,
  cycleTrackAt,
  isMusicTrack,
  parseMusicMode,
  pickTrack,
  type MusicPlace,
} from '../src/audio/selection.ts';

function place(biome: Biome, nearGuard = false, nearBanya = false): MusicPlace {
  return { biome, nearGuard, nearBanya };
}

function advance(
  zones: MusicZones,
  seconds: number,
  guardDistance: number,
  banyaDistance: number,
  dialogueOpen = false,
): void {
  for (let t = 0; t < seconds; t += 0.1) {
    zones.update(0.1, guardDistance, banyaDistance, dialogueOpen);
  }
}

describe('parseMusicMode', () => {
  it('defaults to auto without a value', () => {
    expect(parseMusicMode(null)).toBe('auto');
    expect(parseMusicMode(undefined)).toBe('auto');
    expect(parseMusicMode('')).toBe('auto');
    expect(parseMusicMode('auto')).toBe('auto');
  });

  it('keeps the four tracks and the two special modes', () => {
    expect(parseMusicMode('pogost')).toBe('pogost');
    expect(parseMusicMode('banya')).toBe('banya');
    expect(parseMusicMode('iriy')).toBe('iriy');
    expect(parseMusicMode('nedobudka')).toBe('nedobudka');
    expect(parseMusicMode('cycle')).toBe('cycle');
    expect(parseMusicMode('off')).toBe('off');
  });

  it('falls back to auto for an unknown value', () => {
    expect(parseMusicMode('strazh')).toBe('auto');
    expect(parseMusicMode('Pogost')).toBe('auto');
  });
});

describe('pickTrack', () => {
  it('plays the Погост bed in the meadows', () => {
    expect(pickTrack('auto', place('meadows'))).toBe('pogost');
  });

  it('lets the guard take the score over the bathhouse and the bed', () => {
    expect(pickTrack('auto', place('meadows', true, true))).toBe('nedobudka');
    expect(pickTrack('auto', place('forest', true))).toBe('nedobudka');
  });

  it('lets the bathhouse take the score in the meadows', () => {
    expect(pickTrack('auto', place('meadows', false, true))).toBe('banya');
  });

  it('is silent outside the meadows while the other rings have no music', () => {
    expect(pickTrack('auto', place('forest'))).toBeNull();
    expect(pickTrack('auto', place('beach'))).toBeNull();
    expect(pickTrack('auto', place('ocean'))).toBeNull();
    expect(pickTrack('auto', place('mountain'))).toBeNull();
  });

  it('pins a manual track anywhere', () => {
    expect(pickTrack('iriy', place('forest'))).toBe('iriy');
    expect(pickTrack('pogost', place('mountain'))).toBe('pogost');
  });

  it('returns null in off mode even next to the guard', () => {
    expect(pickTrack('off', place('meadows', true, true))).toBeNull();
  });

  it('returns the cycle track in cycle mode', () => {
    expect(pickTrack('cycle', place('forest'), 'iriy')).toBe('iriy');
    expect(pickTrack('cycle', place('forest'))).toBe('pogost');
  });
});

describe('cycleTrackAt', () => {
  it('walks the four tracks and wraps', () => {
    expect(cycleTrackAt(0)).toBe('pogost');
    expect(cycleTrackAt(CYCLE_SECONDS - 0.1)).toBe('pogost');
    expect(cycleTrackAt(CYCLE_SECONDS)).toBe('banya');
    expect(cycleTrackAt(CYCLE_SECONDS * 2)).toBe('iriy');
    expect(cycleTrackAt(CYCLE_SECONDS * 3)).toBe('nedobudka');
    expect(cycleTrackAt(CYCLE_SECONDS * 4)).toBe('pogost');
  });

  it('holds the first track for negative time instead of throwing', () => {
    expect(cycleTrackAt(-10)).toBe('pogost');
  });
});

describe('isMusicTrack', () => {
  it('accepts only the four track names', () => {
    expect(isMusicTrack('pogost')).toBe(true);
    expect(isMusicTrack('nedobudka')).toBe(true);
    expect(isMusicTrack('cycle')).toBe(false);
    expect(isMusicTrack('off')).toBe(false);
    expect(isMusicTrack('')).toBe(false);
    expect(isMusicTrack(null)).toBe(false);
  });
});

describe('MusicZones', () => {
  it('enters the guard radius only after the dwell', () => {
    const zones = new MusicZones();
    advance(zones, ZONE_ENTER_DWELL - 0.1, GUARD_ENTER - 1, 100);
    expect(zones.nearGuard).toBe(false);
    advance(zones, 0.2, GUARD_ENTER - 1, 100);
    expect(zones.nearGuard).toBe(true);
  });

  it('keeps the guard zone between the enter and exit radii', () => {
    const zones = new MusicZones();
    advance(zones, ZONE_ENTER_DWELL + 0.1, GUARD_ENTER - 1, 100);
    expect(zones.nearGuard).toBe(true);
    advance(zones, 5, (GUARD_ENTER + GUARD_EXIT) / 2, 100);
    expect(zones.nearGuard).toBe(true);
    advance(zones, ZONE_EXIT_DWELL + 0.1, GUARD_EXIT + 1, 100);
    expect(zones.nearGuard).toBe(false);
  });

  it('does not restart the music while the player stands on the border', () => {
    const zones = new MusicZones();
    advance(zones, ZONE_ENTER_DWELL + 0.1, GUARD_ENTER - 0.1, 100);
    expect(zones.nearGuard).toBe(true);
    for (let i = 0; i < 40; i++) {
      zones.update(0.1, i % 2 === 0 ? GUARD_ENTER - 0.1 : GUARD_ENTER + 0.1, 100, false);
    }
    expect(zones.nearGuard).toBe(true);
  });

  it('lets the dialogue force the bathhouse zone and release it after the exit dwell', () => {
    const zones = new MusicZones();
    advance(zones, ZONE_ENTER_DWELL + 0.1, 100, 100, true);
    expect(zones.nearBanya).toBe(true);
    advance(zones, ZONE_EXIT_DWELL + 0.1, 100, 100, false);
    expect(zones.nearBanya).toBe(false);
  });

  it('uses the wider bathhouse exit radius', () => {
    const zones = new MusicZones();
    advance(zones, ZONE_ENTER_DWELL + 0.1, 100, BANYA_ENTER - 0.5);
    expect(zones.nearBanya).toBe(true);
    advance(zones, 5, 100, (BANYA_ENTER + BANYA_EXIT) / 2);
    expect(zones.nearBanya).toBe(true);
    advance(zones, ZONE_EXIT_DWELL + 0.1, 100, BANYA_EXIT + 1);
    expect(zones.nearBanya).toBe(false);
  });
});

describe('GuardScene', () => {
  it('arms near the guard and wakes only inside the radius', () => {
    const scene = new GuardScene();
    expect(scene.update(false, 100).wake).toBe(false);
    expect(scene.update(true, 9).wake).toBe(false);
    const cue = scene.update(true, WAKE_RADIUS - 0.1);
    expect(cue.wake).toBe(true);
    expect(cue.override).toBe('nedobudka-wake');
    const playing = scene.update(true, WAKE_RADIUS - 1);
    expect(playing.wake).toBe(false);
    expect(playing.override).toBe('nedobudka-wake');
    expect(playing.silence).toBe(false);
  });

  it('goes silent after the wake and arms again after leaving', () => {
    const scene = new GuardScene();
    scene.update(true, 9);
    scene.update(true, WAKE_RADIUS - 1);
    scene.wakeEnded();
    const done = scene.update(true, WAKE_RADIUS - 1);
    expect(done.override).toBeNull();
    expect(done.silence).toBe(true);
    const left = scene.update(false, 100);
    expect(left.silence).toBe(false);
    scene.update(true, 9);
    expect(scene.update(true, WAKE_RADIUS - 1).wake).toBe(true);
  });

  it('does not wake while the player is still outside the radius', () => {
    const scene = new GuardScene();
    scene.update(true, 9);
    for (let i = 0; i < 20; i++) {
      const cue = scene.update(true, 9);
      expect(cue.wake).toBe(false);
      expect(cue.override).toBeNull();
      expect(cue.silence).toBe(false);
    }
  });

  it('ignores an end callback before the wake', () => {
    const scene = new GuardScene();
    scene.wakeEnded();
    expect(scene.current).toBe('idle');
    scene.update(true, 9);
    expect(scene.current).toBe('armed');
  });

  it('resets to idle when the auto scene is left', () => {
    const scene = new GuardScene();
    scene.update(true, 9);
    scene.reset();
    expect(scene.current).toBe('idle');
    expect(scene.update(false, 100).wake).toBe(false);
  });
});
