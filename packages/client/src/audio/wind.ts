/**
 * The wind of the Погост: a recorded loop, not a synth. The source is a 30-second cut of
 * Ivo Vicic's "Wind in pines" (Sonniss GDC 2019), crossfaded at the seam and normalised to
 * −22 dBFS RMS; see `assets/audio/README.md`.
 *
 * It plays on the world bus, so the body's ears will muffle it once hearing exists.
 */

import windUrl from '../assets/audio/wind-pines.mp3?url';
import type { Mixer } from './mixer.ts';

export interface Wind {
  stop(): void;
}

const LEVEL = 0.8;
const FADE_IN_SECONDS = 2.5;

export async function startWind(mixer: Mixer): Promise<Wind | null> {
  const context = mixer.audioContext;
  const bus = mixer.bus('world');
  if (!context || !bus) return null;

  const response = await fetch(windUrl);
  if (!response.ok) {
    mixer.issues.push({ subtype: 'wind', message: `HTTP ${response.status}` });
    return null;
  }
  const data = await response.arrayBuffer();
  const buffer = await context.decodeAudioData(data).catch((error: unknown) => {
    mixer.issues.push({ subtype: 'wind', message: error instanceof Error ? error.message : String(error) });
    throw error;
  });

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  const level = context.createGain();
  level.gain.value = 0;
  source.connect(level).connect(bus);

  // The first frame gets wind, not a pop.
  const startAt = context.currentTime + 0.05;
  level.gain.setValueAtTime(0, startAt);
  level.gain.linearRampToValueAtTime(LEVEL, startAt + FADE_IN_SECONDS);
  source.start(startAt);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      const now = context.currentTime;
      level.gain.cancelScheduledValues(now);
      level.gain.setTargetAtTime(0, now, 0.1);
      try {
        source.stop(now + 0.4);
      } catch {
        // Already stopped.
      }
    },
  };
}
