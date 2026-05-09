import type { AudioFxOptions } from '../types';

export const DEFAULT_AUDIO_FX: AudioFxOptions = {
  clickEnabled: true,
  clickVolume: 0.5,
  keyEnabled: true,
  keyVolume: 0.45,
  mode: 'auto',
};

export interface SoundFxBus {
  ctx: AudioContext;
  master: GainNode;
  destination: AudioNode;
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
  return { ctx, master, destination };
}

export async function resumeBus(bus: SoundFxBus | null): Promise<void> {
  if (!bus) return;
  if (bus.ctx.state === 'suspended') {
    try { await bus.ctx.resume(); } catch { /* ignore */ }
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function noiseBuffer(ctx: AudioContext, durationSec: number, decay = 0.15): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(8, Math.floor(durationSec * sr));
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  const tau = len * decay;
  for (let i = 0; i < len; i++) {
    const env = Math.exp(-i / tau);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  return buf;
}

export function playClickSound(
  bus: SoundFxBus,
  whenSec: number,
  volume: number,
  variant: 'left' | 'right' | 'middle' = 'left',
): void {
  const v = clamp(volume, 0, 1);
  if (v <= 0) return;
  const ctx = bus.ctx;
  const t = Math.max(whenSec, ctx.currentTime + 0.001);

  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.55 * v;

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx, 0.045, 0.14);

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = variant === 'right' ? 1100 : 1500;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 7000;

  noise.connect(hp);
  hp.connect(lp);
  lp.connect(noiseGain);
  noiseGain.connect(bus.master);
  noise.start(t);
  noise.stop(t + 0.06);

  const osc = ctx.createOscillator();
  osc.type = 'square';
  const startFreq = variant === 'right' ? 1700 : variant === 'middle' ? 2600 : 2200;
  osc.frequency.setValueAtTime(startFreq, t);
  osc.frequency.exponentialRampToValueAtTime(700, t + 0.012);
  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.0, t);
  oscGain.gain.linearRampToValueAtTime(0.18 * v, t + 0.0015);
  oscGain.gain.exponentialRampToValueAtTime(0.0008, t + 0.03);
  osc.connect(oscGain);
  oscGain.connect(bus.master);
  osc.start(t);
  osc.stop(t + 0.045);
}

function hashSeed(seed: number): number {
  let x = (seed | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 0xffffffff;
}

export function playKeystrokeSound(
  bus: SoundFxBus,
  whenSec: number,
  volume: number,
  seed = 0,
): void {
  const v = clamp(volume, 0, 1);
  if (v <= 0) return;
  const ctx = bus.ctx;
  const t = Math.max(whenSec, ctx.currentTime + 0.001);

  const r = hashSeed(seed);
  const r2 = hashSeed(seed * 7919 + 13);

  const bodyFreq = 220 + r * 90;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(bodyFreq * 1.7, t);
  osc.frequency.exponentialRampToValueAtTime(bodyFreq * 0.85, t + 0.04);

  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.0, t);
  oscGain.gain.linearRampToValueAtTime(0.13 * v, t + 0.002);
  oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  osc.connect(oscGain);
  oscGain.connect(bus.master);
  osc.start(t);
  osc.stop(t + 0.09);

  const tickDur = 0.03;
  const tick = ctx.createBufferSource();
  tick.buffer = noiseBuffer(ctx, tickDur, 0.1);

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2600 + r2 * 1800;
  bp.Q.value = 1.6;

  const tickGain = ctx.createGain();
  tickGain.gain.value = 0.22 * v;

  tick.connect(bp);
  bp.connect(tickGain);
  tickGain.connect(bus.master);
  tick.start(t);
  tick.stop(t + tickDur + 0.01);

  if (r2 > 0.6) {
    const releaseDur = 0.022;
    const release = ctx.createBufferSource();
    release.buffer = noiseBuffer(ctx, releaseDur, 0.08);
    const rbp = ctx.createBiquadFilter();
    rbp.type = 'bandpass';
    rbp.frequency.value = 1800 + r * 1200;
    rbp.Q.value = 1.4;
    const rGain = ctx.createGain();
    rGain.gain.value = 0.1 * v;
    release.connect(rbp);
    rbp.connect(rGain);
    rGain.connect(bus.master);
    const rDelay = 0.045 + r * 0.02;
    release.start(t + rDelay);
    release.stop(t + rDelay + releaseDur + 0.01);
  }
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
