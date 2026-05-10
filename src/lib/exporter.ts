/**
 * Real-time export pipeline (no WASM, no native deps):
 *
 *   1. Off-screen <video> plays the trimmed source from start..end
 *   2. A hidden canvas re-renders each frame (zoom, cursor, ripples)
 *   3. canvas.captureStream(fps) gives us a MediaStream
 *   4. WebAudio MediaElementSource → MediaStreamDestination feeds the
 *      original audio track into the same stream
 *   5. MediaRecorder writes a webm/mp4 blob (whichever the platform
 *      supports best)
 */

import { renderFrame } from './renderer';
import { createCursorState } from './cursor-engine';
import { createCursorFollowState } from './cursor-follow-camera';
import { fragmentDuration, totalOutputDuration } from './fragments';
import {
  createSoundFxBus,
  detectAudioFxNeed,
  loadSoundFxSamples,
  playClickSound,
  playKeystrokeSound,
  type SoundFxBus,
} from './sound-fx';
import { createMp4Encoder, isMp4ExportSupported } from './mp4-encoder';
import { SourceDecoder } from './source-decoder';
import type {
  AudioFxOptions,
  Background,
  BackgroundMusic,
  BlurRegion,
  Crop,
  CursorOptions,
  Display,
  FrameOptions,
  Fragment,
  MouseTrack,
  ZoomSegment,
} from '../types';

export interface Resolution {
  w: number;
  h: number;
}

export type ResolutionName = '720p' | '1080p' | '4K';

const RESOLUTIONS: Record<ResolutionName, Resolution> = {
  '720p':  { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
  '4K':    { w: 3840, h: 2160 },
};

export type QualityName = 'studio' | 'social' | 'web' | 'webLow';

export interface QualityPreset {
  label: string;
  description: string;
  multiplier: number;
}

export const QUALITY_PRESETS: Record<QualityName, QualityPreset> = {
  studio: {
    label: 'Studio',
    description: 'Highest quality, best for further editing. Compression is almost impossible to notice.',
    multiplier: 1.5,
  },
  social: {
    label: 'Social Media',
    description: 'Balanced quality, ideal for posting to social platforms.',
    multiplier: 1.0,
  },
  web: {
    label: 'Web',
    description: 'Smaller files for embedding on websites and faster sharing.',
    multiplier: 0.65,
  },
  webLow: {
    label: 'Web (Low)',
    description: 'Smallest file size for slow connections; visible compression.',
    multiplier: 0.35,
  },
};

export function getResolution(name: string | null | undefined): Resolution {
  if (name && name in RESOLUTIONS) return RESOLUTIONS[name as ResolutionName];
  return RESOLUTIONS['1080p'];
}

export type ExportFormat = 'webm' | 'mp4';

function pickRecorderMime(format: ExportFormat): string {
  const mp4Candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
  ];
  const webmCandidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const ordered = format === 'mp4'
    ? [...mp4Candidates, ...webmCandidates]
    : webmCandidates;
  for (const m of ordered) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'video/webm';
}

export type ExportProgressStage = 'encoding' | 'done' | 'starting';
export type ExportProgressCallback = (stage: ExportProgressStage, progress: number) => void;
export type ExportLogCallback = (msg: string) => void;

export interface ExportVideoOptions {
  sourceBlob: Blob;
  mouse: MouseTrack;
  segments: ZoomSegment[];
  display: Display;
  background?: Background;
  crop?: Crop | null;
  fragments: Fragment[];
  resolution?: ResolutionName;
  fps?: number;
  format?: ExportFormat;
  quality?: QualityName;
  cursorOptions?: Partial<CursorOptions> | null;
  frame?: Partial<FrameOptions> | null;
  audioFx?: AudioFxOptions | null;
  backgroundMusic?: BackgroundMusic | null;
  blurRegions?: BlurRegion[] | null;
  signal?: AbortSignal;
  onProgress?: ExportProgressCallback;
  onLog?: ExportLogCallback;
}

export interface ExportVideoResult {
  bytes: Uint8Array;
  mimeType: string;
  ext: 'mp4' | 'webm';
}

interface AudioContextCtor {
  new (contextOptions?: AudioContextOptions): AudioContext;
}

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  if (window.AudioContext) return window.AudioContext;
  if (window.webkitAudioContext) return window.webkitAudioContext;
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function exportVideo(opts: ExportVideoOptions): Promise<ExportVideoResult> {
  if (opts.format === 'mp4') {
    if (!isMp4ExportSupported()) {
      throw new Error(
        'MP4 export requires WebCodecs (VideoEncoder), which is unavailable in this build.',
      );
    }
    return exportVideoMp4(opts);
  }
  return exportVideoWebM(opts);
}

async function exportVideoWebM({
  sourceBlob,
  mouse,
  segments,
  display,
  background,
  crop = null,
  fragments,
  resolution = '1080p',
  fps = 60,
  format = 'webm',
  quality = 'social',
  cursorOptions = null,
  frame = null,
  audioFx = null,
  backgroundMusic = null,
  blurRegions = null,
  signal,
  onProgress,
  onLog,
}: ExportVideoOptions): Promise<ExportVideoResult> {
  const cursorState = createCursorState();
  // Same cursor-follow state shape the live preview uses — without this the
  // exporter would produce videos that ignore the safe-zone follow camera
  // (cursor stays off-frame during zooms because we'd render at the static
  // segment focus instead of tracking the cursor).
  const cursorFollowState = createCursorFollowState();
  const { w, h } = getResolution(resolution);
  const qMult = QUALITY_PRESETS[quality]?.multiplier ?? 1.0;
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError');
  };
  throwIfAborted();

  if (!fragments.length) throw new Error('No fragments to export');

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to acquire 2D canvas context');

  const url = URL.createObjectURL(sourceBlob);
  const video = document.createElement('video');
  video.src = url;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.playsInline = true;

  await new Promise<void>((res, rej) => {
    video.addEventListener('loadedmetadata', () => res(), { once: true });
    video.addEventListener('error', () => rej(new Error('Failed to load source')), { once: true });
  });

  const total = Math.max(0.05, totalOutputDuration(fragments));

  const canvasStream = canvas.captureStream(fps);

  let audioCtx: AudioContext | null = null;
  let fxBus: SoundFxBus | null = null;
  let fxNeed: { clicks: boolean; keys: boolean } = { clicks: false, keys: false };
  let bgMusicEl: HTMLAudioElement | null = null;
  let bgMusicGain: GainNode | null = null;
  let bgMusicTimers: number[] = [];
  try {
    const Ctor = getAudioContextCtor();
    if (Ctor) {
      audioCtx = new Ctor();
      const srcNode = audioCtx.createMediaElementSource(video);
      const dest = audioCtx.createMediaStreamDestination();
      srcNode.connect(dest);
      dest.stream.getAudioTracks().forEach((t) => canvasStream.addTrack(t));

      if (audioFx) {
        fxNeed = detectAudioFxNeed(mouse.events, audioFx);
        if (fxNeed.clicks || fxNeed.keys) {
          fxBus = createSoundFxBus(dest);
          if (fxBus) await loadSoundFxSamples(fxBus);
        }
      }

      if (backgroundMusic && backgroundMusic.src) {
        try {
          const el = new Audio(backgroundMusic.src);
          el.loop = true;
          el.crossOrigin = 'anonymous';
          el.preload = 'auto';
          await new Promise<void>((res, rej) => {
            el.addEventListener('canplaythrough', () => res(), { once: true });
            el.addEventListener('error', () => rej(new Error('Failed to load background music')), { once: true });
          });
          const musicSrc = audioCtx.createMediaElementSource(el);
          const gain = audioCtx.createGain();
          gain.gain.value = 0; // start silent; ramp in when recording starts
          musicSrc.connect(gain).connect(dest);
          bgMusicEl = el;
          bgMusicGain = gain;
        } catch (e) {
          onLog?.(`Background music skipped: ${errorMessage(e)}`);
        }
      }
    }
  } catch (e) {
    onLog?.(`Audio capture skipped: ${errorMessage(e)}`);
  }

  const mimeType = pickRecorderMime(format);
  onLog?.(`Recorder mime: ${mimeType}`);

  const baseBitrate = resolution === '4K' ? 24_000_000 : resolution === '1080p' ? 12_000_000 : 6_000_000;
  const recorder = new MediaRecorder(canvasStream, {
    mimeType,
    videoBitsPerSecond: Math.round(baseBitrate * qMult),
    audioBitsPerSecond: 192_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  let stopRender = false;
  let elapsedOutput = 0;
  let activeFragmentEnd = fragments[0]!.srcEnd;
  let activeFragmentStart = fragments[0]!.srcStart;

  const tick = (): void => {
    if (stopRender) return;
    const src = video.currentTime;
    const tMs = src * 1000;
    renderFrame(ctx, video, {
      tMs,
      segments,
      mouse,
      displayWidth: display?.width,
      displayHeight: display?.height,
      background,
      crop,
      cursorState,
      cursorOptions,
      frame,
      cursorFollowState,
      cursorFollowEnabled: true,
      blurRegions,
    });
    if (onProgress) {
      const localOffset = Math.max(0, Math.min(activeFragmentEnd - activeFragmentStart, src - activeFragmentStart));
      onProgress('encoding', Math.min(1, (elapsedOutput + localOffset) / total));
    }
    requestAnimationFrame(tick);
  };

  const seekTo = (t: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const onSeeked = (): void => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = t;
    });

  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    try { video.pause(); } catch { /* ignore */ }
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  const cleanup = async (): Promise<void> => {
    stopRender = true;
    try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
    try { await stopped; } catch { /* ignore */ }
    canvasStream.getTracks().forEach((t) => t.stop());
    for (const t of bgMusicTimers) {
      clearTimeout(t);
    }
    bgMusicTimers = [];
    if (bgMusicEl) {
      try { bgMusicEl.pause(); } catch { /* ignore */ }
      bgMusicEl = null;
    }
    if (bgMusicGain) {
      try { bgMusicGain.disconnect(); } catch { /* ignore */ }
      bgMusicGain = null;
    }
    if (fxBus) {
      try { fxBus.master.disconnect(); } catch { /* ignore */ }
      fxBus = null;
    }
    if (audioCtx) {
      try { await audioCtx.close(); } catch { /* ignore */ }
    }
    URL.revokeObjectURL(url);
    if (signal) signal.removeEventListener('abort', onAbort);
  };

  try {
    await seekTo(fragments[0]!.srcStart);
    activeFragmentStart = fragments[0]!.srcStart;
    activeFragmentEnd = fragments[0]!.srcEnd;

    renderFrame(ctx, video, {
      tMs: video.currentTime * 1000,
      segments,
      mouse,
      displayWidth: display?.width,
      displayHeight: display?.height,
      background,
      crop,
      frame,
      blurRegions,
    });

    if (audioCtx && audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch { /* ignore */ }
    }

    if (bgMusicEl && bgMusicGain && audioCtx && backgroundMusic) {
      // Only play music inside the user's [startMs, endMs] window.
      const targetVol = Math.max(0, Math.min(1, backgroundMusic.volume));
      const fadeSec = Math.max(0, (backgroundMusic.fadeMs || 0) / 1000);
      const startSec = Math.max(0, Math.min(total, backgroundMusic.startMs / 1000));
      const endSec = Math.max(startSec, Math.min(total, backgroundMusic.endMs / 1000));
      const windowSec = endSec - startSec;
      const now = audioCtx.currentTime;
      const winStart = now + startSec;
      const winEnd = now + endSec;
      const halfWindow = windowSec / 2;
      const inDur = Math.min(fadeSec, halfWindow);
      const outDur = Math.min(fadeSec, halfWindow);

      bgMusicGain.gain.cancelScheduledValues(now);
      bgMusicGain.gain.setValueAtTime(0, now);
      bgMusicGain.gain.setValueAtTime(0, winStart);
      bgMusicGain.gain.linearRampToValueAtTime(targetVol, winStart + inDur);
      bgMusicGain.gain.setValueAtTime(targetVol, winEnd - outDur);
      bgMusicGain.gain.linearRampToValueAtTime(0, winEnd);

      const sourceStartSec = Math.max(
        0,
        Math.min(
          (backgroundMusic.durationMs || 0) / 1000 || 0,
          (backgroundMusic.sourceStartMs || 0) / 1000,
        ),
      );
      bgMusicEl.currentTime = sourceStartSec;
      const startTimer = window.setTimeout(() => {
        if (!bgMusicEl) return;
        // Re-seek right before play in case any other code touched currentTime
        // between the schedule and the fire (defensive).
        try { bgMusicEl.currentTime = sourceStartSec; } catch { /* ignore */ }
        void bgMusicEl.play().catch(() => { /* ignore */ });
      }, Math.max(0, startSec * 1000));
      const stopTimer = window.setTimeout(() => {
        try { bgMusicEl?.pause(); } catch { /* ignore */ }
      }, Math.max(0, endSec * 1000));
      bgMusicTimers = [startTimer, stopTimer];
    }

    recorder.start(250);
    requestAnimationFrame(tick);

    for (let i = 0; i < fragments.length; i++) {
      if (aborted) break;
      const f = fragments[i]!;
      activeFragmentStart = f.srcStart;
      activeFragmentEnd = f.srcEnd;
      if (i > 0) {
        try { video.pause(); } catch { /* ignore */ }
        await seekTo(f.srcStart);
      }
      await video.play();

      if (fxBus && (fxNeed.clicks || fxNeed.keys) && audioFx) {
        const startMs = f.srcStart * 1000;
        const endMs = f.srcEnd * 1000;
        const playStartCtxTime = fxBus.ctx.currentTime;
        for (const evt of mouse.events) {
          if (evt.t < startMs || evt.t > endMs) continue;
          const offsetSec = (evt.t - startMs) / 1000;
          const when = playStartCtxTime + offsetSec;
          if (evt.type === 'click' && fxNeed.clicks) {
            playClickSound(fxBus, when, audioFx.clickVolume, evt.button);
          } else if (evt.type === 'key' && fxNeed.keys) {
            playKeystrokeSound(fxBus, when, audioFx.keyVolume, evt.code | 0);
          }
        }
      }

      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (aborted || video.currentTime >= f.srcEnd - 0.02 || video.ended) {
            try { video.pause(); } catch { /* ignore */ }
            resolve();
          } else {
            requestAnimationFrame(check);
          }
        };
        requestAnimationFrame(check);
      });
      elapsedOutput += fragmentDuration(f);
    }

    if (aborted) {
      await cleanup();
      throw new DOMException('Export aborted', 'AbortError');
    }

    await new Promise((r) => setTimeout(r, 120));
    await cleanup();
  } catch (err) {
    await cleanup();
    throw err;
  }

  const blob = new Blob(chunks, { type: mimeType });
  const isMp4 = mimeType.startsWith('video/mp4');
  const bytes = new Uint8Array(await blob.arrayBuffer());

  onProgress?.('done', 1);

  return { bytes, mimeType, ext: isMp4 ? 'mp4' : 'webm' };
}

// ----------------------------------------------------------------------------
// MP4 export pipeline (WebCodecs + web-demuxer)
//
// Architecture mirrors a similar tool's exporter (`src/lib/exporter/streamingDecoder.ts`
// in their repo): we demux the source blob ourselves and feed encoded chunks
// directly to a WebCodecs `VideoDecoder`, completely bypassing the
// HTMLVideoElement / compositor pipeline that previously caused exported
// videos to freeze on the first frame.
//
//   1. Audio is mixed offline via OfflineAudioContext (PCM exact, fast).
//   2. Source frames are decoded by `SourceDecoder` (web-demuxer + VideoDecoder)
//      one fragment at a time, range-read by source seconds.
//   3. Each decoded VideoFrame is rendered onto our canvas with all effects
//      (cinematic zoom, cursor, blur, overlays) and immediately encoded by
//      a hardware-accelerated H.264 VideoEncoder.
//   4. mp4-muxer assembles the result with faststart so the file is streamable.
// ----------------------------------------------------------------------------

async function exportVideoMp4({
  sourceBlob,
  mouse,
  segments,
  display,
  background,
  crop = null,
  fragments,
  resolution = '1080p',
  fps = 60,
  quality = 'social',
  cursorOptions = null,
  frame = null,
  audioFx = null,
  backgroundMusic = null,
  blurRegions = null,
  signal,
  onProgress,
  onLog,
}: ExportVideoOptions): Promise<ExportVideoResult> {
  if (!fragments.length) throw new Error('No fragments to export');

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError');
  };
  throwIfAborted();

  const { w, h } = getResolution(resolution);
  const qMult = QUALITY_PRESETS[quality]?.multiplier ?? 1.0;
  const baseBitrate =
    resolution === '4K' ? 24_000_000 : resolution === '1080p' ? 12_000_000 : 6_000_000;
  const videoBitrate = Math.round(baseBitrate * qMult);

  const cursorState = createCursorState();
  const cursorFollowState = createCursorFollowState();

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to acquire 2D canvas context');

  const total = Math.max(0.05, totalOutputDuration(fragments));

  // ---- 1) Render audio offline (fast — runs in OfflineAudioContext) -------
  onProgress?.('starting', 0);
  let audioBuffer: AudioBuffer | null = null;
  try {
    audioBuffer = await renderAudioOffline({
      sourceBlob,
      mouse,
      audioFx,
      backgroundMusic,
      fragments,
      onLog,
    });
  } catch (e) {
    onLog?.(`Audio render skipped: ${errorMessage(e)}`);
  }
  throwIfAborted();

  // ---- 2) Initialize source decoder ---------------------------------------
  const sourceDecoder = new SourceDecoder();
  await sourceDecoder.init({ blob: sourceBlob });
  throwIfAborted();

  // ---- 3) Configure output encoder ----------------------------------------
  const encoder = await createMp4Encoder({
    width: w,
    height: h,
    fps,
    videoBitrate,
    hasAudio: !!audioBuffer,
    audioSampleRate: audioBuffer?.sampleRate ?? 48_000,
    audioChannels: Math.min(2, audioBuffer?.numberOfChannels ?? 2),
    canvas,
  });
  onLog?.(`MP4 encoder ready: H.264 @ ${(videoBitrate / 1_000_000).toFixed(1)} Mbps, ${w}x${h}@${fps}`);

  let aborted = false;
  const onAbort = (): void => { aborted = true; };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const fallbackFrameDur = 1 / fps;
  let elapsedOutput = 0;
  // Mediabunny's CanvasSource enforces strictly increasing timestamps. Across
  // fragments our outSec calculation already increases monotonically (each new
  // fragment starts at fragOutStart = previous elapsedOutput). Within a
  // fragment, VideoSampleSink yields samples in presentation order. The only
  // hazard is two consecutive samples computing to the *same* outSec after
  // float rounding — guard against it by nudging by 1 µs.
  let lastTimestampSec = -1;

  const cleanup = async (): Promise<void> => {
    sourceDecoder.destroy();
    canvas.width = 0;
    canvas.height = 0;
    if (signal) signal.removeEventListener('abort', onAbort);
  };

  // ---- 4) Drive frames through the pipeline, fragment by fragment ---------
  try {
    for (const frag of fragments) {
      if (aborted) break;
      const fragOutStart = elapsedOutput;
      const fragDur = fragmentDuration(frag);

      // SourceDecoder.decodeRange yields decoded VideoFrames serially in
      // source order. Inside the callback we render onto the canvas (effects
      // baked in) and await the encoder's add() which serializes frame
      // submission internally.
      //
      // Output timestamp = where this source frame should appear on the
      // export timeline. By using each sample's REAL mediaTime we preserve
      // the source's variable framerate — screen recordings emit far fewer
      // frames during static content, and indexing by frame counter would
      // compress those gaps and produce a fast-motion file shorter than the
      // audio track.
      await sourceDecoder.decodeRange(frag.srcStart, frag.srcEnd, async (videoFrame, mediaTimeSec, durationSec) => {
        if (aborted) return;

        const tMs = mediaTimeSec * 1000;
        renderFrame(ctx, videoFrame, {
          tMs,
          segments,
          mouse,
          displayWidth: display?.width,
          displayHeight: display?.height,
          background,
          crop,
          cursorState,
          cursorOptions,
          frame,
          cursorFollowState,
          cursorFollowEnabled: true,
          blurRegions,
        });

        let outSec = fragOutStart + Math.max(0, mediaTimeSec - frag.srcStart);
        if (outSec <= lastTimestampSec) outSec = lastTimestampSec + 1e-6;
        lastTimestampSec = outSec;

        const dur = durationSec > 0 ? durationSec : fallbackFrameDur;
        await encoder.addFrame(outSec, dur);

        if (onProgress) {
          onProgress('encoding', Math.min(0.99, outSec / total));
        }
      });

      elapsedOutput += fragDur;
    }

    if (aborted) {
      await encoder.abort();
      await cleanup();
      throw new DOMException('Export aborted', 'AbortError');
    }

    // Audio is added in one shot (Mediabunny's AudioBufferSource handles AAC
    // encoding internally and respects back-pressure on its own).
    if (audioBuffer) {
      try {
        await encoder.addAudio(audioBuffer);
      } catch (e) {
        onLog?.(`Audio encoding error: ${errorMessage(e)}`);
        throw e;
      }
    }

    onProgress?.('encoding', 0.995);
    const bytes = await encoder.finalize();
    await cleanup();
    onProgress?.('done', 1);
    return { bytes, mimeType: 'video/mp4', ext: 'mp4' };
  } catch (err) {
    await encoder.abort();
    await cleanup();
    throw err;
  }
}

interface OfflineAudioInput {
  sourceBlob: Blob;
  mouse: MouseTrack;
  audioFx: AudioFxOptions | null | undefined;
  backgroundMusic: BackgroundMusic | null | undefined;
  fragments: Fragment[];
  onLog?: ExportLogCallback;
}

const OFFLINE_SAMPLE_RATE = 48_000;
const OFFLINE_CHANNELS = 2;

async function renderAudioOffline({
  sourceBlob,
  mouse,
  audioFx,
  backgroundMusic,
  fragments,
  onLog,
}: OfflineAudioInput): Promise<AudioBuffer | null> {
  const total = Math.max(0.05, totalOutputDuration(fragments));
  const length = Math.ceil(total * OFFLINE_SAMPLE_RATE) + OFFLINE_SAMPLE_RATE; // tail headroom
  const offlineCtx = new OfflineAudioContext(OFFLINE_CHANNELS, length, OFFLINE_SAMPLE_RATE);

  let scheduled = false;

  // 1) Source-track audio.
  let sourceBuf: AudioBuffer | null = null;
  try {
    const ab = await sourceBlob.arrayBuffer();
    sourceBuf = await offlineCtx.decodeAudioData(ab.slice(0));
  } catch (e) {
    onLog?.(`Source audio not decodable: ${errorMessage(e)}`);
  }

  if (sourceBuf) {
    let outAt = 0;
    for (const f of fragments) {
      const dur = fragmentDuration(f);
      if (dur <= 0) continue;
      const node = offlineCtx.createBufferSource();
      node.buffer = sourceBuf;
      node.connect(offlineCtx.destination);
      node.start(outAt, f.srcStart, dur);
      outAt += dur;
      scheduled = true;
    }
  }

  // 2) Background music with fade envelope.
  if (backgroundMusic && backgroundMusic.src) {
    try {
      const res = await fetch(backgroundMusic.src);
      if (!res.ok) throw new Error(`bgmusic fetch ${res.status}`);
      const ab = await res.arrayBuffer();
      const buf = await offlineCtx.decodeAudioData(ab);
      const targetVol = Math.max(0, Math.min(1, backgroundMusic.volume));
      const fadeSec = Math.max(0, (backgroundMusic.fadeMs || 0) / 1000);
      const startSec = Math.max(0, Math.min(total, backgroundMusic.startMs / 1000));
      const endSec = Math.max(startSec, Math.min(total, backgroundMusic.endMs / 1000));
      const windowSec = Math.max(0, endSec - startSec);
      const halfWindow = windowSec / 2;
      const inDur = Math.min(fadeSec, halfWindow);
      const outDur = Math.min(fadeSec, halfWindow);
      const sourceStartSec = Math.max(
        0,
        Math.min(
          (backgroundMusic.durationMs || buf.duration * 1000) / 1000 || buf.duration,
          (backgroundMusic.sourceStartMs || 0) / 1000,
        ),
      );

      if (windowSec > 0 && targetVol > 0) {
        const node = offlineCtx.createBufferSource();
        node.buffer = buf;
        node.loop = true;
        const gain = offlineCtx.createGain();
        gain.gain.setValueAtTime(0, 0);
        gain.gain.setValueAtTime(0, startSec);
        gain.gain.linearRampToValueAtTime(targetVol, startSec + inDur);
        gain.gain.setValueAtTime(targetVol, Math.max(startSec + inDur, endSec - outDur));
        gain.gain.linearRampToValueAtTime(0, endSec);
        node.connect(gain).connect(offlineCtx.destination);
        node.start(startSec, sourceStartSec, windowSec + 0.05);
        node.stop(endSec + 0.1);
        scheduled = true;
      }
    } catch (e) {
      onLog?.(`Background music skipped: ${errorMessage(e)}`);
    }
  }

  // 3) FX (clicks/keystrokes) — reuse the realtime sound-fx machinery against
  //    the offline context so timings stay identical to live preview.
  if (audioFx) {
    const need = detectAudioFxNeed(mouse.events, audioFx);
    if (need.clicks || need.keys) {
      const fxBus = createSoundFxBus(offlineCtx.destination as unknown as AudioNode);
      if (fxBus) {
        await loadSoundFxSamples(fxBus);
        let outAt = 0;
        for (const f of fragments) {
          const startMs = f.srcStart * 1000;
          const endMs = f.srcEnd * 1000;
          const fragOutStart = outAt;
          for (const evt of mouse.events) {
            if (evt.t < startMs || evt.t > endMs) continue;
            const offsetSec = (evt.t - startMs) / 1000;
            const when = fragOutStart + offsetSec;
            if (evt.type === 'click' && need.clicks) {
              playClickSound(fxBus, when, audioFx.clickVolume, evt.button);
              scheduled = true;
            } else if (evt.type === 'key' && need.keys) {
              playKeystrokeSound(fxBus, when, audioFx.keyVolume, evt.code | 0);
              scheduled = true;
            }
          }
          outAt += fragmentDuration(f);
        }
      }
    }
  }

  if (!scheduled) return null;
  return await offlineCtx.startRendering();
}
