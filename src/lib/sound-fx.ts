import type { AudioFxOptions } from '../types';

export const DEFAULT_AUDIO_FX: AudioFxOptions = {
  clickEnabled: true,
  clickVolume: 0.5,
  keyEnabled: true,
  keyVolume: 0.45,
  mode: 'auto',
};

const CLICK_SAMPLE_URL = './sounds/mouse-click.mp3';
const KEY_SAMPLE_URL = './sounds/keyboard-office.mp3';

// Each event plays a short slice of the sample so the rendered audio length
// stays proportional to the click/keystroke count, not the source file's
// duration — sources contain many sounds back-to-back as a sample library.
const CLICK_SLICE_SEC = 0.10;
const KEY_SLICE_SEC = 0.12;
const FADE_SEC = 0.005;

// Onset detection thresholds — a slice is anchored to a detected peak so we
// never sample from silent gaps in the source file.
const ONSET_THRESHOLD_RATIO = 0.35;
const ONSET_MIN_GAP_SEC = 0.05;
const ONSET_LOOKBACK_SEC = 0.005;

export interface SoundFxBus {
  ctx: AudioContext;
  master: GainNode;
  destination: AudioNode;
  clickBuffer: AudioBuffer | null;
  clickOnsets: ReadonlyArray<number> | null;
  keyBuffer: AudioBuffer | null;
  keyOnsets: ReadonlyArray<number> | null;
  loadPromise: Promise<void> | null;
}

interface ContextCtor {
  new (options?: AudioContextOptions): AudioContext;
}

function getCtor(): ContextCtor | null {
  if (typeof window === 'undefined') return null;
  if (window.AudioContext) return window.AudioContext;
  if (window.webkitAudioContext) return window.webkitAudioContext;
  return null;
}

export function createSoundFxBus(target?: AudioNode): SoundFxBus | null {
  const Ctor = getCtor();
  if (!Ctor) return null;
  let ctx: AudioContext;
  if (target) {
    ctx = target.context as AudioContext;
  } else {
    ctx = new Ctor();
  }
  const master = ctx.createGain();
  master.gain.value = 1.0;
  const destination = target ?? ctx.destination;
  master.connect(destination);
  return {
    ctx,
    master,
    destination,
    clickBuffer: null,
    clickOnsets: null,
    keyBuffer: null,
    keyOnsets: null,
    loadPromise: null,
  };
}

export async function resumeBus(bus: SoundFxBus | null): Promise<void> {
  if (!bus) return;
  if (bus.ctx.state === 'suspended') {
    try { await bus.ctx.resume(); } catch { /* ignore */ }
  }
}

async function fetchAndDecode(ctx: AudioContext, url: string): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[sound-fx] ${url} → ${res.status}`);
      return null;
    }
    const data = await res.arrayBuffer();
    return await ctx.decodeAudioData(data);
  } catch (err) {
    console.warn(`[sound-fx] Failed to load ${url}:`, err);
    return null;
  }
}

function detectOnsets(buffer: AudioBuffer): number[] {
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const ch = buffer.getChannelData(0);

  let peak = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(ch[i]!);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return [];

  const threshold = peak * ONSET_THRESHOLD_RATIO;
  const minGapSamples = Math.floor(sr * ONSET_MIN_GAP_SEC);
  const lookbackSamples = Math.floor(sr * ONSET_LOOKBACK_SEC);
  const onsets: number[] = [];
  let lastOnset = -minGapSamples;

  for (let i = 0; i < len; i++) {
    if (Math.abs(ch[i]!) >= threshold && i - lastOnset >= minGapSamples) {
      const start = Math.max(0, i - lookbackSamples);
      onsets.push(start / sr);
      lastOnset = i;
    }
  }
  return onsets;
}

export function loadSoundFxSamples(bus: SoundFxBus): Promise<void> {
  if (bus.loadPromise) return bus.loadPromise;
  const p = (async () => {
    const [click, key] = await Promise.all([
      fetchAndDecode(bus.ctx, CLICK_SAMPLE_URL),
      fetchAndDecode(bus.ctx, KEY_SAMPLE_URL),
    ]);
    bus.clickBuffer = click;
    bus.clickOnsets = click ? detectOnsets(click) : null;
    bus.keyBuffer = key;
    bus.keyOnsets = key ? detectOnsets(key) : null;
    if (click) {
      console.info(`[sound-fx] click: ${click.duration.toFixed(2)}s, ${bus.clickOnsets?.length ?? 0} onsets`);
    }
    if (key) {
      console.info(`[sound-fx] keyboard: ${key.duration.toFixed(2)}s, ${bus.keyOnsets?.length ?? 0} onsets`);
    }
  })();
  bus.loadPromise = p;
  return p;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function hashSeed(seed: number): number {
  let x = (seed | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 0xffffffff;
}

function pickOffset(
  buffer: AudioBuffer,
  sliceDur: number,
  onsets: ReadonlyArray<number> | null,
  rand: number,
): number {
  const maxOffset = Math.max(0, buffer.duration - sliceDur);
  if (onsets && onsets.length > 0) {
    const idx = Math.min(onsets.length - 1, Math.floor(rand * onsets.length));
    return Math.min(onsets[idx]!, maxOffset);
  }
  return maxOffset > 0 ? rand * maxOffset : 0;
}

function playSlice(
  bus: SoundFxBus,
  buffer: AudioBuffer,
  whenSec: number,
  volume: number,
  sliceDur: number,
  offset: number,
): void {
  const ctx = bus.ctx;
  const t = Math.max(whenSec, ctx.currentTime + 0.001);

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const gain = ctx.createGain();
  const fade = Math.min(FADE_SEC, sliceDur / 4);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + fade);
  gain.gain.setValueAtTime(volume, t + Math.max(fade, sliceDur - fade));
  gain.gain.linearRampToValueAtTime(0, t + sliceDur);

  src.connect(gain);
  gain.connect(bus.master);
  src.start(t, offset, sliceDur);
  src.stop(t + sliceDur + 0.02);
}

export function playClickSound(
  bus: SoundFxBus,
  whenSec: number,
  volume: number,
  variant: 'left' | 'right' | 'middle' = 'left',
): void {
  const v = clamp(volume, 0, 1);
  if (v <= 0) return;
  const buf = bus.clickBuffer;
  if (!buf) return;
  const variantSeed = variant === 'right' ? 17 : variant === 'middle' ? 31 : 0;
  const rand = hashSeed(variantSeed ^ Math.floor(bus.ctx.currentTime * 1000));
  const offset = pickOffset(buf, CLICK_SLICE_SEC, bus.clickOnsets, rand);
  playSlice(bus, buf, whenSec, v, CLICK_SLICE_SEC, offset);
}

export function playKeystrokeSound(
  bus: SoundFxBus,
  whenSec: number,
  volume: number,
  seed = 0,
): void {
  const v = clamp(volume, 0, 1);
  if (v <= 0) return;
  const buf = bus.keyBuffer;
  if (!buf) return;
  const rand = hashSeed((seed | 0) ^ Math.floor(bus.ctx.currentTime * 1000));
  const offset = pickOffset(buf, KEY_SLICE_SEC, bus.keyOnsets, rand);
  playSlice(bus, buf, whenSec, v, KEY_SLICE_SEC, offset);
}

export function detectAudioFxNeed(
  events: ReadonlyArray<{ type: string }>,
  options: AudioFxOptions,
): { clicks: boolean; keys: boolean } {
  if (options.mode === 'off') return { clicks: false, keys: false };
  if (options.mode === 'on') {
    return { clicks: options.clickEnabled, keys: options.keyEnabled };
  }
  let hasClick = false;
  let hasKey = false;
  for (const e of events) {
    if (e.type === 'click') hasClick = true;
    else if (e.type === 'key') hasKey = true;
    if (hasClick && hasKey) break;
  }
  return {
    clicks: options.clickEnabled && hasClick,
    keys: options.keyEnabled && hasKey,
  };
}
