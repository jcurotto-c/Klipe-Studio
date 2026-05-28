import { useEffect, useRef } from 'react';
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

// How far ahead of the playhead we schedule sounds, in source ms. Scheduling
// on the Web Audio clock this far in advance absorbs output + React/RAF
// latency, so a click plays exactly as the playhead reaches it (rather than a
// frame or two late, which read as "delayed"). Kept short so at most this many
// ms of queued sound can trail a pause/seek.
const LOOKAHEAD_MS = 80;

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
  /** Source ms we've already scheduled sounds up to (stays LOOKAHEAD ahead of the playhead). */
  const scheduledThroughRef = useRef<number | null>(null);
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
      scheduledThroughRef.current = null;
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

  useEffect(() => {
    if (!playing) {
      lastSrcMsRef.current = null;
      lastFragIndexRef.current = -1;
      scheduledThroughRef.current = null;
      return;
    }
    const bus = runtime.current.bus;
    const m = outputToSource(fragmentsRef.current, currentTime);
    if (!bus || !m) {
      lastSrcMsRef.current = null;
      lastFragIndexRef.current = -1;
      scheduledThroughRef.current = null;
      return;
    }
    const srcMs = m.srcTime * 1000;
    const fragIdx = m.index;
    const opts = optionsRef.current;
    const need = detectAudioFxNeed(mouseRef.current.events, opts);

    // A seek / fragment jump / large gap means the playhead is no longer
    // contiguous with what we've scheduled — start fresh from the new
    // position so we neither replay the past nor double-fire.
    const lastSrc = lastSrcMsRef.current;
    const seek =
      lastSrc === null ||
      fragIdx !== lastFragIndexRef.current ||
      srcMs < lastSrc - 50 ||
      srcMs - lastSrc > 500;

    if (need.clicks || need.keys) {
      // Schedule the window (windowStart, windowEnd]. windowStart never goes
      // behind what we've already queued, so each event is scheduled once.
      const windowStart = seek
        ? srcMs
        : Math.max(scheduledThroughRef.current ?? srcMs, srcMs);
      const windowEnd = srcMs + LOOKAHEAD_MS;
      if (windowEnd > windowStart) {
        const nowCtx = bus.ctx.currentTime;
        for (const e of mouseRef.current.events) {
          if (e.t <= windowStart || e.t > windowEnd) continue;
          // Map the event's source time to the audio clock: it should sound
          // exactly when the playhead reaches it (playback runs at 1×).
          const whenSec = nowCtx + Math.max(0, e.t - srcMs) / 1000;
          if (e.type === 'click' && need.clicks) {
            playClickSound(bus, whenSec, opts.clickVolume, e.button);
          } else if (e.type === 'key' && need.keys) {
            playKeystrokeSound(bus, whenSec, opts.keyVolume, e.code | 0);
          }
        }
        scheduledThroughRef.current = windowEnd;
      }
    } else {
      scheduledThroughRef.current = srcMs;
    }

    lastSrcMsRef.current = srcMs;
    lastFragIndexRef.current = fragIdx;
  }, [currentTime, playing]);
}
