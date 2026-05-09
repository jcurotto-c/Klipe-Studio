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
import { fragmentDuration, totalOutputDuration } from './fragments';
import {
  createSoundFxBus,
  detectAudioFxNeed,
  loadSoundFxSamples,
  playClickSound,
  playKeystrokeSound,
  type SoundFxBus,
} from './sound-fx';
import type {
  AudioFxOptions,
  Background,
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

export async function exportVideo({
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
  signal,
  onProgress,
  onLog,
}: ExportVideoOptions): Promise<ExportVideoResult> {
  const cursorState = createCursorState();
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
    });

    if (audioCtx && audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch { /* ignore */ }
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
