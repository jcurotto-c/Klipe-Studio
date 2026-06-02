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

import { renderFrame, drawCardBackground, ensureBackgroundReady } from './renderer';
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
import { SourceDecoder, CameraFrameProvider } from './source-decoder';
import { OverlayStage } from '../overlays/engine/OverlayStage';
import type {
  AudioFxOptions,
  Background,
  BackgroundMusic,
  BlurRegion,
  CameraFollowStyle,
  CameraOptions,
  Crop,
  CursorOptions,
  Display,
  FitMode,
  FrameOptions,
  Fragment,
  MobileOptions,
  MouseTrack,
  ZoomSegment,
} from '../types';
import type { Overlay } from '../overlays/types';
import type { Card, CardSet } from '../cards/types';
import type { CardSegment, CardTimeline } from '../cards/timeline';
import { buildCardTimeline, resolveTransition, bodyToGlobalMs } from '../cards/timeline';
import { ensureFontsReady } from '../overlays/fonts';

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

/**
 * Output canvas dimensions for a given resolution tier and target aspect.
 *
 * The resolution presets are all 16:9, so the named tier is treated as a
 * "short side" budget (720 / 1080 / 2160) and the requested aspect picks how
 * that budget maps to width × height:
 *   16:9 @ 1080p → 1920×1080   9:16 @ 1080p → 1080×1920   1:1 @ 1080p → 1080×1080
 *
 * Dimensions are rounded to even numbers (H.264 requires it). When no aspect
 * is supplied we keep the legacy behaviour: native 16:9, swapped to portrait
 * for phone-primary recordings so the iPhone frame fills the canvas.
 */
export function outputDimensions(
  res: Resolution,
  aspect: number | null | undefined,
  mobilePrimary: boolean,
): Resolution {
  if (aspect && isFinite(aspect) && aspect > 0) {
    const shortSide = res.h;
    let w: number;
    let h: number;
    if (aspect >= 1) {
      h = shortSide;
      w = Math.round(h * aspect);
    } else {
      w = shortSide;
      h = Math.round(w / aspect);
    }
    return { w: w - (w % 2), h: h - (h % 2) };
  }
  return mobilePrimary && res.w > res.h ? { w: res.h, h: res.w } : res;
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
  /**
   * Target output aspect ratio (w/h). When set, the export canvas is sized to
   * this ratio (e.g. 9:16 for TikTok); the renderer cover-fits the source.
   * Null/undefined keeps the legacy behaviour (native 16:9 / phone-portrait).
   */
  outputAspect?: number | null;
  /**
   * How a non-matching `outputAspect` is fitted: 'fit' (default) shows the
   * whole frame on the chosen background; 'fill' cover-crops the source.
   */
  fitMode?: FitMode | null;
  fps?: number;
  format?: ExportFormat;
  quality?: QualityName;
  cursorOptions?: Partial<CursorOptions> | null;
  /** Camera-follow behaviour during zoom. Absent → `follow`. */
  cameraStyle?: CameraFollowStyle | null;
  /** Zoom-transition motion blur intensity 0..1. Absent/0 → off. */
  zoomBlur?: number | null;
  frame?: Partial<FrameOptions> | null;
  /** Recorded webcam track, composited as the camera disc over each frame. */
  cameraBlob?: Blob | null;
  /** Webcam disc styling (size, shape, position, mirror, zoom behaviour). */
  cameraOptions?: CameraOptions | null;
  /** Phone frame styling, only consulted when `mobilePrimary` is true. */
  mobileOptions?: MobileOptions | null;
  /**
   * When true, `sourceBlob` IS the phone capture; the exporter renders it
   * inside an iPhone frame centered on the canvas (no PC screen drawn).
   */
  mobilePrimary?: boolean;
  audioFx?: AudioFxOptions | null;
  backgroundMusic?: BackgroundMusic | null;
  /** Master volume (0..1) for the recording's own audio (mic + system mix). */
  audioVolume?: number;
  /** Separate mic/system audio tracks (per-track volume). Optional. */
  micBlob?: Blob | null;
  systemBlob?: Blob | null;
  micVolume?: number;
  systemVolume?: number;
  blurRegions?: BlurRegion[] | null;
  /** Text/image overlay layers to composite over each frame. */
  overlays?: Overlay[] | null;
  /** Intro/outro title cards prepended/appended to the recording. */
  cards?: CardSet | null;
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
  outputAspect = null,
  fitMode = 'fit',
  fps = 60,
  format = 'mp4',
  quality = 'social',
  cursorOptions = null,
  cameraStyle = null,
  zoomBlur = null,
  frame = null,
  cameraBlob = null,
  cameraOptions = null,
  mobileOptions = null,
  mobilePrimary = false,
  audioFx = null,
  backgroundMusic = null,
  audioVolume = 1,
  micBlob = null,
  systemBlob = null,
  micVolume = 1,
  systemVolume = 1,
  blurRegions = null,
  overlays = null,
  cards = null,
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
  // Size the export canvas to the requested aspect (e.g. 9:16 for TikTok).
  // Phone-primary recordings with no explicit aspect fall back to a portrait
  // swap so the iPhone frame fills the export instead of sitting in a stripe.
  const { w, h } = outputDimensions(baseRes, outputAspect, mobilePrimary);
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

  // Cards splice into and EXTEND the global timeline: intro before the body,
  // outro after it, and mid-roll cards that split the recording. Everything is
  // a list of segments; body content maps to/from the global clock via the
  // timeline helpers (which account for every card before a point).
  const bodyTotal = Math.max(0.05, totalOutputDuration(fragments));
  const tl = buildCardTimeline(cards, bodyTotal);
  const total = tl.totalMs / 1000;
  const introSeg = tl.segments.find((s): s is CardSegment => s.kind === 'card' && s.slot === 'intro') ?? null;
  const outroSeg = tl.segments.find((s): s is CardSegment => s.kind === 'card' && s.slot === 'outro') ?? null;
  const midSegs = tl.segments.filter((s): s is CardSegment => s.kind === 'card' && s.slot === 'mid');

  // ---- 1) Render audio offline (fast — runs in OfflineAudioContext) -------
  onProgress?.('starting', 0);
  let audioBuffer: AudioBuffer | null = null;
  try {
    audioBuffer = await renderAudioOffline({
      sourceBlob,
      mouse,
      audioFx,
      backgroundMusic,
      sourceVolume: audioVolume,
      micBlob,
      systemBlob,
      micVolume,
      systemVolume,
      fragments,
      onLog,
    });
    // Body audio is rendered in body-time; remap it onto the global clock
    // (silent during cards) when any cards are present.
    if (audioBuffer) audioBuffer = remapBodyAudioToGlobal(audioBuffer, tl);
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

  // Self-hosted fonts must be decoded BEFORE any Pixi Text is constructed —
  // Pixi rasterises/measures text on creation, so a font that loads later would
  // leave the body overlays baked with a fallback face.
  await ensureFontsReady();

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

  // Webcam overlay: the camera was recorded as its own track (a separate blob),
  // so the export must decode it in parallel and draw the frame matching each
  // output timestamp — otherwise the disc shows in the editor but not the file.
  // Skipped for phone-primary exports (no camera disc) and when hidden.
  let cameraProvider: CameraFrameProvider | null = null;
  if (!mobilePrimary && cameraBlob && cameraOptions && !cameraOptions.hide) {
    const provider = new CameraFrameProvider();
    try {
      const ok = await provider.init(cameraBlob);
      if (ok) {
        cameraProvider = provider;
        onLog?.('Camera track ready: compositing webcam disc into export');
      } else {
        provider.destroy();
        onLog?.('Camera track had no decodable video — skipping webcam disc');
      }
    } catch (e) {
      provider.destroy();
      onLog?.(`Camera decode init failed, skipping webcam disc: ${errorMessage(e)}`);
    }
  }

  const fallbackFrameDur = 1 / fps;
  // Body output-time consumed so far (0 at the first recorded frame). The global
  // timestamp for each frame is derived from this via bodyToGlobalMs.
  let elapsedBody = 0;
  // Mediabunny's CanvasSource enforces strictly increasing timestamps. Across
  // fragments our outSec calculation already increases monotonically (each new
  // fragment starts at fragOutStart = previous elapsedOutput). Within a
  // fragment, VideoSampleSink yields samples in presentation order. The only
  // hazard is two consecutive samples computing to the *same* outSec after
  // float rounding — guard against it by nudging by 1 µs.
  let lastTimestampSec = -1;

  // Dedicated Pixi stage for card text/logo, lazily created. Separate from the
  // body overlay stage so the two never fight over one canvas.
  let cardStage: OverlayStage | null = null;
  let cardCanvas: HTMLCanvasElement | null = null;
  const ensureCardStage = async (): Promise<OverlayStage> => {
    if (!cardStage) {
      cardCanvas = document.createElement('canvas');
      cardCanvas.width = w;
      cardCanvas.height = h;
      // No text drop-shadow on cards (matches the editor preview).
      cardStage = new OverlayStage({ textShadow: false });
      await cardStage.mount(cardCanvas, w, h);
    }
    return cardStage;
  };

  // Encode a card's frames at a fixed cadence (fps × duration). Each frame
  // redraws the solid/gradient/image background then composites the card's
  // text/logo sampled at card-local time. Timestamps share lastTimestampSec so
  // the intro → body → outro stream stays strictly increasing.
  const encodeCardFrames = async (card: Card, startOutSec: number): Promise<void> => {
    const durSec = card.durationMs / 1000;
    const frameCount = Math.max(1, Math.round(durSec * fps));
    const hasItems = card.items.length > 0;
    if (hasItems) {
      const stage = await ensureCardStage();
      await stage.setOverlays(card.items);
    }
    for (let i = 0; i < frameCount; i++) {
      if (aborted) break;
      const localMs = (i / fps) * 1000;
      drawCardBackground(ctx, w, h, card.background);
      if (hasItems && cardStage && cardCanvas) {
        cardStage.renderAt(localMs);
        ctx.drawImage(cardCanvas, 0, 0);
      }
      let outSec = startOutSec + i / fps;
      if (outSec <= lastTimestampSec) outSec = lastTimestampSec + 1e-6;
      lastTimestampSec = outSec;
      await encoder.addFrame(outSec, 1 / fps);
      onProgress?.('encoding', Math.min(0.99, outSec / total));
    }
  };

  // Bake a single card frame (background + items at `localMs`) into a detached
  // canvas. Used for crossfades: the card layer is frozen at one frame and
  // alpha-blended over the live recording, so we render it just once.
  const bakeCardFrame = async (card: Card, localMs: number): Promise<HTMLCanvasElement> => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cctx = c.getContext('2d');
    if (cctx) {
      drawCardBackground(cctx, w, h, card.background);
      if (card.items.length > 0) {
        const stage = await ensureCardStage();
        await stage.setOverlays(card.items);
        stage.renderAt(localMs);
        if (cardCanvas) cctx.drawImage(cardCanvas, 0, 0);
      }
    }
    return c;
  };

  // Frozen card frames for crossfades, keyed by `${cardId}:${localMs}`. A card
  // is frozen at its FIRST frame while dissolving IN ("enter", local 0) and at
  // its LAST frame while dissolving OUT ("exit", local duration). Matches
  // resolveTransition's localMs so the body loop can look them up by key.
  const bakedFrames = new Map<string, HTMLCanvasElement>();
  const bakedKey = (card: Card, localMs: number): string => `${card.id}:${Math.round(localMs)}`;

  const cleanup = async (): Promise<void> => {
    sourceDecoder.destroy();
    cameraProvider?.destroy();
    overlayStage?.dispose();
    cardStage?.dispose();
    if (overlayCanvas) { overlayCanvas.width = 0; overlayCanvas.height = 0; }
    if (cardCanvas) { cardCanvas.width = 0; cardCanvas.height = 0; }
    for (const c of bakedFrames.values()) { c.width = 0; c.height = 0; }
    bakedFrames.clear();
    canvas.width = 0;
    canvas.height = 0;
    if (signal) signal.removeEventListener('abort', onAbort);
  };

  // Pre-bake the frozen crossfade frames for every card that has a body chunk
  // beside it (enter over the body before, exit over the body after). Card
  // frames are baked synchronously, so also decode any image backgrounds first.
  const prebakeCrossfades = async (): Promise<void> => {
    const segs = tl.segments;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      if (s.kind !== 'card') continue;
      await ensureBackgroundReady(s.card.background);
      if ((s.card.transitionMs ?? 0) <= 0) continue;
      const before = i > 0 && segs[i - 1]!.kind === 'body' && segs[i - 1]!.gEndMs > segs[i - 1]!.gStartMs;
      const after = i < segs.length - 1 && segs[i + 1]!.kind === 'body' && segs[i + 1]!.gEndMs > segs[i + 1]!.gStartMs;
      if (before) bakedFrames.set(bakedKey(s.card, 0), await bakeCardFrame(s.card, 0));
      if (after) bakedFrames.set(bakedKey(s.card, s.card.durationMs), await bakeCardFrame(s.card, s.card.durationMs));
    }
  };

  // ---- 4) Drive frames through the pipeline, fragment by fragment ---------
  let nextMid = 0;
  try {
    await prebakeCrossfades();

    // Intro card (synthetic frames before the recording).
    if (introSeg) await encodeCardFrames(introSeg.card, 0);

    for (const frag of fragments) {
      if (aborted) break;
      const fragOutStartBody = elapsedBody;
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

        // Body-output-time for this frame, and its position on the global clock
        // (which already includes every intro/mid card before it).
        const bodySec = fragOutStartBody + Math.max(0, mediaTimeSec - frag.srcStart);
        const bodyMsNow = bodySec * 1000;

        // Flush any mid-roll cards whose anchor we've now reached, full-screen,
        // BEFORE this body frame — so the intro→...→outro stream stays ordered.
        while (nextMid < midSegs.length && bodyMsNow >= midSegs[nextMid]!.atBodyMs) {
          await encodeCardFrames(midSegs[nextMid]!.card, midSegs[nextMid]!.gStartMs / 1000);
          nextMid++;
        }

        const tMs = mediaTimeSec * 1000;
        // Pull the webcam frame for this output time (null when no provider /
        // before the camera's first frame) and let renderFrame draw the disc.
        const cameraFrame = cameraProvider ? await cameraProvider.frameAt(mediaTimeSec) : null;
        renderFrame(ctx, videoFrame, {
          tMs,
          segments,
          mouse,
          displayWidth: display?.width,
          displayHeight: display?.height,
          background,
          crop,
          fitMode: fitMode ?? 'fit',
          cameraSource: cameraFrame,
          cameraOptions,
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

        let outSec = bodyToGlobalMs(tl, bodyMsNow) / 1000;
        if (outSec <= lastTimestampSec) outSec = lastTimestampSec + 1e-6;
        lastTimestampSec = outSec;

        // Composite text/image overlays on top — sampled at BODY output-time so
        // their keyframes line up with what the user authored in the editor.
        if (overlayStage && overlayCanvas) {
          overlayStage.renderAt(bodySec * 1000);
          ctx.drawImage(overlayCanvas, 0, 0);
        }

        // Crossfade the adjacent card over the live frame (a card dissolving in
        // over the body before it, or out over the body after it). Mirrors the
        // editor preview exactly.
        const trans = resolveTransition(tl, outSec * 1000);
        if (trans) {
          const baked = bakedFrames.get(bakedKey(trans.card, trans.localMs));
          if (baked) {
            ctx.save();
            ctx.globalAlpha = Math.min(1, Math.max(0, trans.alpha));
            ctx.drawImage(baked, 0, 0);
            ctx.restore();
          }
        }

        const dur = durationSec > 0 ? durationSec : fallbackFrameDur;
        await encoder.addFrame(outSec, dur);

        if (onProgress) {
          onProgress('encoding', Math.min(0.99, outSec / total));
        }
      });

      elapsedBody += fragDur;
    }

    // Any mid-roll cards anchored at/after the body end (e.g. clamped to the
    // tail) that the per-frame flush didn't reach.
    while (!aborted && nextMid < midSegs.length) {
      await encodeCardFrames(midSegs[nextMid]!.card, midSegs[nextMid]!.gStartMs / 1000);
      nextMid++;
    }

    // Outro card (synthetic frames after the recording).
    if (!aborted && outroSeg) await encodeCardFrames(outroSeg.card, outroSeg.gStartMs / 1000);

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
  /** Master volume (0..1) applied on top of per-track gains. */
  sourceVolume?: number;
  /** Separate microphone track; when present, used instead of source-blob audio. */
  micBlob?: Blob | null;
  /** Separate system-audio track; when present, used instead of source-blob audio. */
  systemBlob?: Blob | null;
  /** Per-track volumes (0..1), multiplied by the master volume. */
  micVolume?: number;
  systemVolume?: number;
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
  sourceVolume = 1,
  micBlob = null,
  systemBlob = null,
  micVolume = 1,
  systemVolume = 1,
  fragments,
  onLog,
}: OfflineAudioInput): Promise<AudioBuffer | null> {
  // Rendered purely in BODY-output-time; remapBodyAudioToGlobal later splices in
  // the (silent) card gaps so the audio lines up with the segmented timeline.
  const bodyTotal = Math.max(0.05, totalOutputDuration(fragments));
  const total = bodyTotal;
  const length = Math.ceil(total * OFFLINE_SAMPLE_RATE) + OFFLINE_SAMPLE_RATE; // tail headroom
  const offlineCtx = new OfflineAudioContext(OFFLINE_CHANNELS, length, OFFLINE_SAMPLE_RATE);

  const master = Math.max(0, Math.min(1, sourceVolume));
  let scheduled = false;

  const decode = async (blob: Blob): Promise<AudioBuffer | null> => {
    try {
      const ab = await blob.arrayBuffer();
      return await offlineCtx.decodeAudioData(ab.slice(0));
    } catch (e) {
      onLog?.(`Audio not decodable: ${errorMessage(e)}`);
      return null;
    }
  };

  // Schedule an audio buffer across the fragment timeline at a fixed gain.
  // mic/system/source tracks all share the recording's source-time clock.
  const scheduleBuffer = (buf: AudioBuffer, gainValue: number): void => {
    if (gainValue <= 0) return;
    const gain = offlineCtx.createGain();
    gain.gain.value = gainValue;
    gain.connect(offlineCtx.destination);
    let outAt = 0; // body-output-time
    for (const f of fragments) {
      const dur = fragmentDuration(f);
      if (dur <= 0) continue;
      const node = offlineCtx.createBufferSource();
      node.buffer = buf;
      node.connect(gain);
      node.start(outAt, f.srcStart, dur);
      outAt += dur;
      scheduled = true;
    }
  };

  // 1) Recording audio. Prefer the separate mic/system tracks (independent
  //    volumes); fall back to the legacy single mixed track baked into the
  //    source blob for older recordings.
  if (micBlob || systemBlob) {
    if (micBlob) {
      const buf = await decode(micBlob);
      if (buf) scheduleBuffer(buf, master * Math.max(0, Math.min(1, micVolume)));
    }
    if (systemBlob) {
      const buf = await decode(systemBlob);
      if (buf) scheduleBuffer(buf, master * Math.max(0, Math.min(1, systemVolume)));
    }
  } else {
    const sourceBuf = await decode(sourceBlob);
    if (sourceBuf) scheduleBuffer(sourceBuf, master);
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
      // Window is body-output-time, clamped to the body length.
      const startSec = Math.max(0, Math.min(bodyTotal, backgroundMusic.startMs / 1000));
      const endSec = Math.max(startSec, Math.max(0, Math.min(bodyTotal, backgroundMusic.endMs / 1000)));
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
        let outAt = 0; // body-output-time
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

/**
 * Splice a body-time audio buffer onto the global card timeline: each body
 * chunk is copied to its global offset, leaving card segments silent. Returns
 * the input unchanged when there are no cards (single body segment).
 */
function remapBodyAudioToGlobal(body: AudioBuffer, tl: CardTimeline): AudioBuffer {
  if (!tl.segments.some((s) => s.kind === 'card')) return body;
  const sr = body.sampleRate;
  const outLen = Math.ceil((tl.totalMs / 1000) * sr) + sr; // tail headroom
  const out = new AudioBuffer({ length: outLen, numberOfChannels: body.numberOfChannels, sampleRate: sr });
  for (const s of tl.segments) {
    if (s.kind !== 'body') continue;
    const srcStart = Math.floor((s.bodyStartMs / 1000) * sr);
    const dstStart = Math.floor((s.gStartMs / 1000) * sr);
    const n = Math.floor((s.bodyEndMs / 1000) * sr) - srcStart;
    if (n <= 0) continue;
    for (let ch = 0; ch < body.numberOfChannels; ch++) {
      const src = body.getChannelData(ch);
      const dst = out.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const si = srcStart + i;
        const di = dstStart + i;
        if (si >= 0 && si < src.length && di >= 0 && di < dst.length) dst[di] = src[si] ?? 0;
      }
    }
  }
  return out;
}
