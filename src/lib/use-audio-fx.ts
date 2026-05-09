import { useCallback, useEffect, useRef } from 'react';
import {
  createSoundFxBus,
  detectAudioFxNeed,
  loadSoundFxSamples,
  playClickSound,
  playKeystrokeSound,
  resumeBus,
  type SoundFxBus,
} from './sound-fx';
import { outputToSource } from './fragments';
import type { AudioFxOptions, Fragment, MouseTrack } from '../types';

interface AudioFxRuntime {
  bus: SoundFxBus | null;
}

interface UseAudioFxArgs {
  mouse: MouseTrack;
  fragments: Fragment[];
  options: AudioFxOptions;
  playing: boolean;
  currentTime: number;
}

export function useAudioFx({
  mouse,
  fragments,
  options,
  playing,
  currentTime,
}: UseAudioFxArgs): void {
  const runtime = useRef<AudioFxRuntime>({ bus: null });
  const lastSrcMsRef = useRef<number | null>(null);
  const lastFragIndexRef = useRef<number>(-1);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mouseRef = useRef(mouse);
  mouseRef.current = mouse;
  const fragmentsRef = useRef(fragments);
  fragmentsRef.current = fragments;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    if (!playing) {
      lastSrcMsRef.current = null;
      lastFragIndexRef.current = -1;
      return;
    }
    if (!runtime.current.bus) {
      runtime.current.bus = createSoundFxBus();
      if (runtime.current.bus) void loadSoundFxSamples(runtime.current.bus);
    }
    void resumeBus(runtime.current.bus);
  }, [playing]);

  useEffect(() => {
    return () => {
      const b = runtime.current.bus;
      if (b) {
        try { b.master.disconnect(); } catch { /* ignore */ }
        try { void b.ctx.close(); } catch { /* ignore */ }
      }
      runtime.current.bus = null;
    };
  }, []);

  const triggerForRange = useCallback(
    (fragIdx: number, fromMs: number, toMs: number): void => {
      const bus = runtime.current.bus;
      if (!bus) return;
      const opts = optionsRef.current;
      const need = detectAudioFxNeed(mouseRef.current.events, opts);
      if (!need.clicks && !need.keys) return;
      const events = mouseRef.current.events;
      const lo = Math.min(fromMs, toMs);
      const hi = Math.max(fromMs, toMs);
      const now = bus.ctx.currentTime;
      for (const e of events) {
        if (e.t < lo || e.t > hi) continue;
        if (e.type === 'click' && need.clicks) {
          playClickSound(bus, now, opts.clickVolume, e.button);
        } else if (e.type === 'key' && need.keys) {
          playKeystrokeSound(bus, now, opts.keyVolume, e.code | 0);
        }
      }
      void fragIdx; // index reserved for future per-fragment grouping
    },
    [],
  );

  useEffect(() => {
    if (!playing) {
      lastSrcMsRef.current = null;
      lastFragIndexRef.current = -1;
      return;
    }
    const m = outputToSource(fragmentsRef.current, currentTime);
    if (!m) {
      lastSrcMsRef.current = null;
      lastFragIndexRef.current = -1;
      return;
    }
    const srcMs = m.srcTime * 1000;
    const fragIdx = m.index;
    const lastMs = lastSrcMsRef.current;
    const lastFrag = lastFragIndexRef.current;
    if (lastMs !== null && fragIdx === lastFrag) {
      const dt = srcMs - lastMs;
      if (dt > 0 && dt < 500) {
        triggerForRange(fragIdx, lastMs, srcMs);
      }
    }
    lastSrcMsRef.current = srcMs;
    lastFragIndexRef.current = fragIdx;
  }, [currentTime, playing, triggerForRange]);
}
