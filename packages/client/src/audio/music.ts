/**
 * The score: the Suno tracks on the `score` bus. The bed and the two scene loops are cut files, decoded to
 * `AudioBuffer`s so `AudioBufferSourceNode` can loop them sample-accurately; «Ирий» is a full one-shot.
 * A 60 s stereo buffer is about 23 MB, the 3-minute «Ирий» about 74 MB, so the tracks are decoded on demand
 * and cached: the bed first, the two scene loops after the world starts, «Ирий» when it is actually chosen.
 *
 * The player owns the choice (`selection.ts`); this class only plays, crossfades and reports.
 */
import pogostLoopUrl from '../assets/audio/pogost-loop.ogg?url';
import banyaLoopUrl from '../assets/audio/banya-loop.ogg?url';
import iriyUrl from '../assets/audio/iriy.mp3?url';
import nedobudkaLoopUrl from '../assets/audio/nedobudka-loop.ogg?url';
import nedobudkaWakeUrl from '../assets/audio/nedobudka-wake.ogg?url';
import type { Mixer } from './mixer.ts';
import { MUSIC_TRACKS } from './selection.ts';

interface TrackDef {
  readonly url: string;
  /** Loops are cut files; «Ирий» is a scene cue and must not cycle. */
  readonly loop: boolean;
}

export const MUSIC_CUES = [...MUSIC_TRACKS, 'nedobudka-wake'] as const;

export type MusicCue = (typeof MUSIC_CUES)[number];

const TRACKS: Record<MusicCue, TrackDef> = {
  // The bed is a 59.5 s body loop (68–128 s, 0.5 s equal-power seam); the full `pogost.mp3` stays in the
  // assets as the audition source and is not bundled.
  pogost: { url: pogostLoopUrl, loop: true },
  // 54–134 s, 0.5 s seam: the body of the bathhouse scene, not its fade-in and fade-out.
  banya: { url: banyaLoopUrl, loop: true },
  // 40–100 s: the approach before the guard's build; the wake at 110–130 is not in this loop.
  nedobudka: { url: nedobudkaLoopUrl, loop: true },
  // The whole track, once. The scene is a sleep/death/prayer insert, not a background.
  iriy: { url: iriyUrl, loop: false },
  // The wake build and hit, 94–138 s, one-shot; the scene ends in silence until the player leaves.
  'nedobudka-wake': { url: nedobudkaWakeUrl, loop: false },
};

/** Long enough to hide the seam, short enough not to feel like a scene change. */
const FADE_SECONDS = 3;

/** About −9 dB under a dialogue; the voice on the head bus stays clear. */
const DUCK_GAIN = 0.35;
const DUCK_SECONDS = 0.35;

/**
 * Per-cue output trim. The measured integrated loudness is −14.7…−16.3 LUFS; with the default score 0.7
 * and master 0.8 these trims land near −21 LUFS. «Ирий» is the quietest, so it gets the only >1 gain.
 */
const GAINS: Record<MusicCue, number> = {
  pogost: 0.88,
  banya: 0.99,
  iriy: 1.04,
  nedobudka: 0.86,
  'nedobudka-wake': 0.93,
};

/**
 * A shared mastering chain for the dark Suno mixes. The tracks lose the top above 1–2 kHz; the presence
 * and air shelves put the jaw harp, psaltery and bell back without trying to fix everything in Reaper.
 * `?eq=0` or `__music.eq(false)` bypasses the shelves for an A/B.
 */
const EQ = {
  highpassHz: 30,
  lowShelfHz: 180,
  lowShelfDb: -2,
  presenceHz: 2500,
  presenceQ: 0.8,
  presenceDb: 2.5,
  airHz: 7000,
  airDb: 2,
} as const;

/**
 * A live preview of the Навь variant: a low-pass and a slight slow-down, not the Reaper reverse/stretch
 * of `docs/music.md`. The depth state does not exist in the game yet, so this is a console hook.
 */
const NAVY = { minHz: 1600, maxHz: 20000, rate: 0.06 } as const;

export interface MusicDebug {
  readonly track: MusicCue | null;
  readonly playing: boolean;
  readonly audible: boolean;
  readonly context: AudioContextState | 'off';
  readonly volume: number;
  readonly ducked: boolean;
  readonly duck: number;
  readonly eq: boolean;
  readonly navь: number;
}

export class Music {
  private readonly mixer: Mixer;
  private readonly gains = new Map<MusicCue, GainNode>();
  private readonly buffers = new Map<MusicCue, AudioBuffer>();
  private readonly loading = new Map<MusicCue, Promise<AudioBuffer>>();
  private readonly failed = new Set<MusicCue>();
  private readonly sources = new Map<MusicCue, AudioBufferSourceNode>();
  private readonly stopTimers = new Map<MusicCue, ReturnType<typeof setTimeout>>();
  private readonly finished = new Set<MusicCue>();
  private duckGain: GainNode | null = null;
  private eqHighpass: BiquadFilterNode | null = null;
  private eqLowShelf: BiquadFilterNode | null = null;
  private eqPresence: BiquadFilterNode | null = null;
  private eqAir: BiquadFilterNode | null = null;
  private eqOn = true;
  private navьLowpass: BiquadFilterNode | null = null;
  private navь = 0;
  private ducked = false;
  private current: MusicCue | null = null;
  /** A track whose buffer is still decoding; the loop asks for it every frame. */
  private pending: MusicCue | null = null;
  /** The one-shot cue the score is waiting on; its callback runs when the source ends on its own. */
  private cueTrack: MusicCue | null = null;
  private cueEnded: (() => void) | null = null;
  private unlocked = false;
  /** Cancels a crossfade whose decode is still running. */
  private request = 0;

  constructor(mixer: Mixer) {
    this.mixer = mixer;
  }

  /** Call inside the Play click, after `Mixer.unlock()`: the context and the score bus exist by then. */
  unlock(): void {
    if (this.unlocked) return;
    const context = this.mixer.audioContext;
    const bus = this.mixer.bus('score');
    if (!context || !bus) return;

    const duck = context.createGain();
    duck.gain.value = this.ducked ? DUCK_GAIN : 1;
    duck.connect(bus);
    this.duckGain = duck;

    const highpass = context.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = this.eqOn ? EQ.highpassHz : 10;
    highpass.Q.value = 0.7;
    const lowShelf = context.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = EQ.lowShelfHz;
    lowShelf.gain.value = this.eqOn ? EQ.lowShelfDb : 0;
    const presence = context.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = EQ.presenceHz;
    presence.Q.value = EQ.presenceQ;
    presence.gain.value = this.eqOn ? EQ.presenceDb : 0;
    const air = context.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = EQ.airHz;
    air.gain.value = this.eqOn ? EQ.airDb : 0;
    const navьLowpass = context.createBiquadFilter();
    navьLowpass.type = 'lowpass';
    navьLowpass.Q.value = 0.7;
    navьLowpass.frequency.value = this.navьHz();
    highpass.connect(lowShelf).connect(presence).connect(air).connect(navьLowpass).connect(duck);
    this.navьLowpass = navьLowpass;
    this.eqHighpass = highpass;
    this.eqLowShelf = lowShelf;
    this.eqPresence = presence;
    this.eqAir = air;

    for (const track of MUSIC_CUES) {
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(highpass);
      this.gains.set(track, gain);
    }
    this.unlocked = true;

    // Decode the bed while the world loads; the first fade starts as soon as the buffer is ready.
    void this.load('pogost').catch((error: unknown) => {
      this.fail('decode', 'pogost', error);
      console.warn('music: "pogost" failed to decode', error);
    });
  }

  /** The track the score should use now; `null` fades the score out. Safe to call every frame. */
  setTrack(track: MusicCue | null, force = false): void {
    if (!this.unlocked) return;
    if (track === null) {
      this.fadeOut();
      return;
    }
    if (force) this.finished.delete(track);
    if (track === this.current || track === this.pending || this.failed.has(track) || this.finished.has(track)) return;
    void this.crossfade(track);
  }

  /** Play a one-shot cue now; `onEnded` runs only if the source reaches its own end. */
  playCue(cue: MusicCue, onEnded?: () => void): void {
    this.cueTrack = cue;
    this.cueEnded = onEnded ?? null;
    this.finished.delete(cue);
    this.setTrack(cue, true);
  }

  debug(): MusicDebug {
    const context = this.mixer.audioContext;
    const source = this.current ? this.sources.get(this.current) : null;
    const gain = this.current ? this.gains.get(this.current) : null;
    return {
      track: this.current,
      playing: Boolean(this.current && source),
      audible: Boolean(gain && gain.gain.value > 0.001),
      context: context?.state ?? 'off',
      volume: gain?.gain.value ?? 0,
      ducked: this.ducked,
      duck: this.duckGain?.gain.value ?? 1,
      eq: this.eqOn,
      navь: this.navь,
    };
  }

  /** 0 = Явь, 1 = the full live preview; a console hook until the bone depth exists. */
  setNavь(depth: number): void {
    const value = Math.min(1, Math.max(0, depth));
    this.navь = value;
    const context = this.mixer.audioContext;
    if (!context) return;
    const now = context.currentTime;
    this.navьLowpass?.frequency.setTargetAtTime(this.navьHz(), now, 0.15);
    const rate = 1 - NAVY.rate * value;
    for (const source of this.sources.values()) source.playbackRate.setTargetAtTime(rate, now, 0.1);
  }

  private navьHz(): number {
    return NAVY.maxHz * Math.pow(NAVY.minHz / NAVY.maxHz, this.navь);
  }

  /** A/B the mastering shelves; the high-pass stays, but drops to 10 Hz when off. */
  setEq(on: boolean): void {
    if (this.eqOn === on) return;
    this.eqOn = on;
    const context = this.mixer.audioContext;
    if (!context) return;
    const now = context.currentTime;
    this.eqHighpass?.frequency.setTargetAtTime(on ? EQ.highpassHz : 10, now, 0.05);
    this.eqLowShelf?.gain.setTargetAtTime(on ? EQ.lowShelfDb : 0, now, 0.05);
    this.eqPresence?.gain.setTargetAtTime(on ? EQ.presenceDb : 0, now, 0.05);
    this.eqAir?.gain.setTargetAtTime(on ? EQ.airDb : 0, now, 0.05);
  }

  /** Lower the whole score under a dialogue; the crossfades and the score bus level are untouched. */
  setDucked(ducked: boolean): void {
    if (this.ducked === ducked) return;
    this.ducked = ducked;
    const context = this.mixer.audioContext;
    const duck = this.duckGain;
    if (!context || !duck) return;
    const now = context.currentTime;
    duck.gain.cancelScheduledValues(now);
    duck.gain.setValueAtTime(duck.gain.value, now);
    duck.gain.linearRampToValueAtTime(ducked ? DUCK_GAIN : 1, now + DUCK_SECONDS);
  }

  /** Decode the tracks the player is likely to need next; the current one is left alone. */
  prefetch(tracks: readonly MusicCue[] = MUSIC_CUES): void {
    for (const track of tracks) {
      if (this.buffers.has(track) || this.failed.has(track) || this.pending === track) continue;
      void this.load(track).catch((error: unknown) => {
        this.fail('decode', track, error);
        console.warn(`music: "${track}" failed to decode`, error);
      });
    }
  }

  /** A missing or broken track is a sound problem the player hears; the telemetry keeps it. */
  private fail(subtype: 'decode' | 'start', track: MusicCue, error: unknown): void {
    this.mixer.issues.push({
      subtype,
      track,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private async load(track: MusicCue): Promise<AudioBuffer> {
    const cached = this.buffers.get(track);
    if (cached) return cached;
    const inflight = this.loading.get(track);
    if (inflight) return inflight;
    const context = this.mixer.audioContext;
    if (!context) throw new Error('no AudioContext');

    const promise = (async () => {
      const response = await fetch(TRACKS[track].url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      const buffer = await context.decodeAudioData(data);
      this.buffers.set(track, buffer);
      return buffer;
    })();
    this.loading.set(track, promise);
    try {
      return await promise;
    } catch (error) {
      this.failed.add(track);
      throw error;
    } finally {
      this.loading.delete(track);
    }
  }

  private async crossfade(track: MusicCue): Promise<void> {
    const context = this.mixer.audioContext;
    const gain = this.gains.get(track);
    if (!context || !gain) return;

    if (this.cueTrack && track !== this.cueTrack) {
      this.cueTrack = null;
      this.cueEnded = null;
    }
    const request = ++this.request;
    this.pending = track;
    let buffer: AudioBuffer;
    try {
      buffer = await this.load(track);
    } catch (error) {
      this.fail('decode', track, error);
      console.warn(`music: "${track}" is not playable`, error);
      if (this.pending === track) this.pending = null;
      return;
    }
    if (this.pending === track) this.pending = null;
    if (request !== this.request) return;

    // A source for this track may still be fading out from an earlier switch; stop it first.
    this.stopTrack(track);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 1 - NAVY.rate * this.navь;
    source.loop = TRACKS[track].loop;
    if (source.loop) {
      source.loopStart = 0;
      source.loopEnd = buffer.duration;
    }
    source.connect(gain);

    const previous = this.current;
    const previousSource = previous ? this.sources.get(previous) : null;
    const now = context.currentTime;

    // Fade in from zero; the source starts at the same moment.
    const nextLevel = gain.gain;
    nextLevel.cancelScheduledValues(now);
    nextLevel.setValueAtTime(0, now);
    nextLevel.linearRampToValueAtTime(GAINS[track], now + FADE_SECONDS);
    try {
      source.start(now);
    } catch (error) {
      this.fail('start', track, error);
      console.warn(`music: "${track}" failed to start`, error);
      return;
    }

    this.sources.set(track, source);
    this.current = track;
    source.onended = () => {
      if (this.sources.get(track) !== source) return;
      this.sources.delete(track);
      if (!TRACKS[track].loop) this.finished.add(track);
      if (this.current !== track) return;
      // «Ирий» and the wake end on their own; a loop only ends when it is stopped.
      this.current = null;
      if (this.cueTrack === track) {
        const ended = this.cueEnded;
        this.cueTrack = null;
        this.cueEnded = null;
        ended?.();
      }
    };

    if (previous && previous !== track && previousSource) {
      const oldLevel = this.gains.get(previous)?.gain;
      if (oldLevel) {
        oldLevel.cancelScheduledValues(now);
        oldLevel.setValueAtTime(oldLevel.value, now);
        oldLevel.linearRampToValueAtTime(0, now + FADE_SECONDS);
      }
      this.scheduleStop(previous, previousSource, FADE_SECONDS * 1000 + 100);
    }
  }

  private fadeOut(): void {
    const track = this.current;
    if (!track) return;
    const context = this.mixer.audioContext;
    const gain = this.gains.get(track);
    const source = this.sources.get(track);
    if (!context || !gain) return;
    this.pending = null;
    this.cueTrack = null;
    this.cueEnded = null;
    ++this.request; // cancel a crossfade that is still decoding
    const now = context.currentTime;
    const level = gain.gain;
    level.cancelScheduledValues(now);
    level.setValueAtTime(level.value, now);
    level.linearRampToValueAtTime(0, now + FADE_SECONDS);
    this.current = null;
    if (source) this.scheduleStop(track, source, FADE_SECONDS * 1000 + 100);
  }

  private scheduleStop(track: MusicCue, source: AudioBufferSourceNode, delay: number): void {
    const timer = this.stopTimers.get(track);
    if (timer !== undefined) clearTimeout(timer);
    const handle = setTimeout(() => {
      this.stopTimers.delete(track);
      if (this.sources.get(track) === source) this.sources.delete(track);
      try {
        source.stop();
      } catch {
        // Already stopped or never started.
      }
    }, delay);
    this.stopTimers.set(track, handle);
  }

  private stopTrack(track: MusicCue): void {
    const timer = this.stopTimers.get(track);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.stopTimers.delete(track);
    }
    const source = this.sources.get(track);
    if (!source) return;
    this.sources.delete(track);
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
  }
}
