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
import { createCursorFollowState, resolveCameraFollow } from './cursor-follow-camera';
import { fragmentDuration, totalOutputDuration } from './fragments';
import {
  createSoundFxBus,
  detectAudioFxNeed,
  loadSoundFxSamples,
  playClickSound,
  playKeystrokeSound,
} from './sound-fx';
import { createMp4Encoder, isMp4ExportSupported } from './mp4-encoder';
import { SourceDecoder } from './source-decoder';
import { OverlayStage } from '../overlays/engine/OverlayStage';
import type {
  AudioFxOptions,
  Background,
  BackgroundMusic,
  BlurRegion,
  CameraFollowStyle,
  Crop,
  CursorOptions,
  Display,
  FrameOptions,
  Fragment,
  MobileOptions,
  MouseTrack,
  ZoomSegment,
} from '../types';
import type { Overlay } from '../overlays/types';

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
  /** Camera-follow behaviour during zoom. Absent → `follow`. */
  cameraStyle?: CameraFollowStyle | null;
  /** Zoom-transition motion blur intensity 0..1. Absent/0 → off. */
  zoomBlur?: number | null;
  frame?: Partial<FrameOptions> | null;
  /** Phone frame styling, only consulted when `mobilePrimary` is true. */
  mobileOptions?: MobileOptions | null;
  /**
   * When true, `sourceBlob` IS the phone capture; the exporter renders it
   * inside an iPhone frame centered on the canvas (no PC screen drawn).
   */
  mobilePrimary?: boolean;
  audioFx?: AudioFxOptions | null;
  backgroundMusic?: BackgroundMusic | null;
  blurRegions?: BlurRegion[] | null;
  /** Text/image overlay layers to composite over each frame. */
  overlays?: Overlay[] | null;
  signal?: AbortSignal;
  onProgress?: ExportProgressCallback;
  onLog?: ExportLogCallback;
}

export interface ExportVideoResult {
  bytes: Uint8Array;
  mimeType: string;
  ext: 'mp4' | 'webm';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function exportVideo(opts: ExportVideoOptions): Promise<ExportVideoResult> {
  // Both MP4 and WebM use the modern WebCodecs + Mediabunny pipeline. The
  // legacy MediaRecorder path (`exportVideoWebM`) still lives in this file as
  // dead code for reference, but it had the same `drawImage(video)` /
  // compositor-staleness failure mode the MP4 path used to suffer from, so
  // we no longer route either format to it.
  if (!isMp4ExportSupported()) {
    throw new Error(
      'Video export requires WebCodecs (VideoEncoder), which is unavailable in this build.',
    );
  }
  return exportVideoMp4(opts);
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
  format = 'mp4',
  quality = 'social',
  cursorOptions = null,
  cameraStyle = null,
  zoomBlur = null,
  frame = null,
  mobileOptions = null,
  mobilePrimary = false,
  audioFx = null,
  backgroundMusic = null,
  blurRegions = null,
  overlays = null,
  signal,
  onProgress,
  onLog,
}: ExportVideoOptions): Promise<ExportVideoResult> {
  if (!fragments.length) throw new Error('No fragments to export');

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError');
  };
  throwIfAborted();

  const baseRes = getResolution(resolution);
  // Phone-primary recordings are portrait; swap landscape dimensions so
  // the iPhone frame fills the export. Without this, the phone would be
  // a tiny stripe centered in a wide canvas.
  const { w, h } = mobilePrimary && baseRes.w > baseRes.h
    ? { w: baseRes.h, h: baseRes.w }
    : baseRes;
  const qMult = QUALITY_PRESETS[quality]?.multiplier ?? 1.0;
  const baseBitrate =
    resolution === '4K' ? 24_000_000 : resolution === '1080p' ? 12_000_000 : 6_000_000;
  const videoBitrate = Math.round(baseBitrate * qMult);

  const cursorState = createCursorState();
  const cursorFollowState = createCursorFollowState();
  const camera = resolveCameraFollow(cameraStyle ?? undefined);

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
    format,
    width: w,
    height: h,
    fps,
    videoBitrate,
    hasAudio: !!audioBuffer,
    audioSampleRate: audioBuffer?.sampleRate ?? 48_000,
    audioChannels: Math.min(2, audioBuffer?.numberOfChannels ?? 2),
    canvas,
  });
  const codecLabel = format === 'mp4' ? 'H.264' : 'VP9';
  onLog?.(`${format.toUpperCase()} encoder ready: ${codecLabel} @ ${(videoBitrate / 1_000_000).toFixed(1)} Mbps, ${w}x${h}@${fps}`);

  let aborted = false;
  const onAbort = (): void => { aborted = true; };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  // Spin up a dedicated Pixi overlay stage on a separate offscreen canvas
  // so it doesn't collide with the export canvas's 2D context. Composited
  // onto the export canvas via drawImage per frame. Skipped entirely when
  // there are no overlays — avoids paying the Pixi init cost on every export.
  let overlayStage: OverlayStage | null = null;
  let overlayCanvas: HTMLCanvasElement | null = null;
  if (overlays && overlays.length > 0) {
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = w;
    overlayCanvas.height = h;
    overlayStage = new OverlayStage();
    await overlayStage.mount(overlayCanvas, w, h);
    await overlayStage.setOverlays(overlays);
  }

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
    overlayStage?.dispose();
    if (overlayCanvas) { overlayCanvas.width = 0; overlayCanvas.height = 0; }
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
          cursorFollowEnabled: camera.enabled,
          cursorFollowConfig: camera.config,
          zoomBlur: zoomBlur ?? 0,
          blurRegions,
          // Phone-primary export: the source IS the phone capture. Feed
          // the decoded VideoFrame as mobileSource and tell renderFrame
          // to draw the iPhone-centered layout instead of the screen.
          mobilePrimary,
          mobileSource: mobilePrimary ? videoFrame : null,
          mobileOptions,
        });

        let outSec = fragOutStart + Math.max(0, mediaTimeSec - frag.srcStart);
        if (outSec <= lastTimestampSec) outSec = lastTimestampSec + 1e-6;
        lastTimestampSec = outSec;

        // Composite text/image overlays on top — sampled at output-time so
        // their keyframes line up with what the user authored in the editor.
        if (overlayStage && overlayCanvas) {
          overlayStage.renderAt(outSec * 1000);
          ctx.drawImage(overlayCanvas, 0, 0);
        }

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
    const mimeType = format === 'mp4' ? 'video/mp4' : 'video/webm';
    return { bytes, mimeType, ext: format };
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
