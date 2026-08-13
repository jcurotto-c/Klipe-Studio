/**
 * Frame renderer: draws a video frame onto a canvas applying zoom transform,
 * a soft gradient background, an enhanced cursor, and a click ripple.
 */

import { sampleZoom } from './zoom-engine';
import { computeHeaderInsetRect, CROSS_ASPECT_EPSILON } from './layout';
import {
  CHROME_BAR_RATIO,
  WINDOW_RIM,
  drawWindowChrome,
  resolveWindowChrome,
  windowChromeBarRatio,
} from './window-chrome';
import {
  brandHeaderBleed,
  brandHeaderRatio,
  drawBrandHeader,
  resolveBrandHeader,
} from './brand-header';
import { cameraShapeAspect } from './camera-shape';
import { sampleCursor, DEFAULT_CURSOR_OPTIONS } from './cursor-engine';
import {
  applyCursorFollow,
  DEFAULT_CURSOR_FOLLOW,
  type CursorFollowConfig,
  type CursorFollowState,
} from './cursor-follow-camera';
import {
  sampleBlurRegion,
  strengthToBlockPx,
  strengthToBlurPx,
} from './blur-engine';
import type {
  Background,
  BlurRegion,
  CameraOptions,
  CameraPosition,
  Crop,
  CursorOptions,
  CursorSample,
  CursorState,
  CursorType,
  FitMode,
  FrameOptions,
  MobileOptions,
  MobilePosition,
  MouseTrack,
  ZoomSample,
  ZoomSegment,
} from '../types';
import boneSvgUrl from '../assets/cartoon-bone.svg';
import handSvgUrl from '../assets/pointinghand_2.svg';
import resizeEwSvgUrl from '../assets/resizeeastwest.svg';
import resizeNsSvgUrl from '../assets/resizenorthsouth.svg';
import moveSvgUrl from '../assets/resizeleftright.svg';
import zoomInSvgUrl from '../assets/zoomin.svg';
import zoomOutSvgUrl from '../assets/zoomout.svg';
import type { CursorShape } from './cursor-sprites';
import {
  drawDynamicIsland,
  drawDeviceBody,
  drawNotch,
  drawPunchHole,
  drawScreen,
  drawScreenHighlight,
  drawSideButtons,
  drawTopSpecular,
  getMobileDevice,
  type MobileDeviceSpec,
} from './mobile-frame';

export const DEFAULT_FRAME_OPTIONS: FrameOptions = {
  shadow: 50,
  radius: 24,
  padding: 6,
  removeBackground: false,
};

/**
 * Padding scale the renderer uses when drawing the source into the canvas.
 * Overlays (CropOverlay, BlurOverlay) call this so their handles land exactly
 * where the source pixels do — otherwise a region drawn on the overlay would
 * be applied to the canvas at a slightly different y/x than the user expected.
 */
export function computeFramePaddingScale(
  frame: Partial<FrameOptions> | null | undefined,
): number {
  const fOpts: FrameOptions = { ...DEFAULT_FRAME_OPTIONS, ...(frame ?? {}) };
  return Math.max(0.4, Math.min(1, 1 - (fOpts.padding / 100) * 1.6));
}

/**
 * Window-chrome bar height as a fraction of the card WIDTH, for the current
 * frame options. Overlays (CropOverlay, BlurOverlay) call this alongside
 * computeFramePaddingScale so their handles land on the VIDEO, not on the bar.
 */
export function computeFrameBarRatio(
  frame: Partial<FrameOptions> | null | undefined,
): number {
  return windowChromeBarRatio(frame?.window);
}

/**
 * Brand-header band height as a fraction of the canvas HEIGHT, and the card's
 * downward bleed in card heights. Overlays call these alongside
 * computeFramePaddingScale / computeFrameBarRatio for the same reason: the
 * header pushes the video down, so handles computed without it land high.
 */
export function computeFrameHeaderRatio(
  frame: Partial<FrameOptions> | null | undefined,
): number {
  return brandHeaderRatio(frame?.header);
}

export function computeFrameBleed(
  frame: Partial<FrameOptions> | null | undefined,
): number {
  return brandHeaderBleed(frame?.header);
}

const CURSOR_BASE_RADIUS = 10;
const CURSOR_REFERENCE_WIDTH = 1920;
const CORNER_RADIUS_RATIO = 0.025;

/** Uniform radius, or per-corner `[tl, tr, br, bl]` — what ctx.roundRect takes. */
type CornerRadii = number | [number, number, number, number];

function hasRadius(r: CornerRadii): boolean {
  return typeof r === 'number' ? r > 0 : r.some((v) => v > 0);
}

/** Clip to a rounded rect. No-op when every corner is 0, so an unrounded frame
 * skips the clip entirely (and keeps the caller's save/restore balanced). */
function clipRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: CornerRadii,
): void {
  if (!hasRadius(r)) return;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();
}

export interface WallpaperPreset {
  from: string;
  to: string;
}

export const WALLPAPER_PRESETS: Record<string, WallpaperPreset> = {
  default: { from: '#1a1f2b', to: '#0b0d12' },
  sunset:  { from: '#ff7e5f', to: '#feb47b' },
  ocean:   { from: '#2b5876', to: '#4e4376' },
  mint:    { from: '#0f9b0f', to: '#000000' },
  violet:  { from: '#7c5cff', to: '#5cc4ff' },
  ember:   { from: '#ff5c7a', to: '#ffb454' },
};

export interface ImagePreset {
  src: string;
  label?: string;
  thumbnail?: string;
}

/**
 * Image presets are auto-discovered from `public/wallpapers/`.
 * Drop a JPG/PNG/WEBP/GIF/AVIF into that folder — Vite picks it up via the
 * `virtual:wallpapers` plugin (see vite.config.ts) and it appears in the panel.
 */
import wallpaperManifest, { type WallpaperManifestEntry } from 'virtual:wallpapers';

export const IMAGE_PRESETS: Record<string, ImagePreset> = Object.fromEntries(
  wallpaperManifest.map((w: WallpaperManifestEntry) => [w.key, { src: w.src, label: w.label }]),
);

export interface ImageCacheEntry {
  img: HTMLImageElement;
  ready: boolean;
}

const imageCache = new Map<string, ImageCacheEntry>();
/**
 * Decode-once cache of `<img>` elements keyed by src. Exported so the camera
 * compositor can share the same decoded image a wallpaper background already
 * uses — one decode whether a preset is the video background or the camera one.
 */
export function getCachedImage(src: string | null | undefined): ImageCacheEntry | null {
  if (!src) return null;
  const existing = imageCache.get(src);
  if (existing) return existing;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const entry: ImageCacheEntry = { img, ready: false };
  img.onload = () => { entry.ready = true; };
  img.onerror = () => { entry.ready = false; };
  img.src = src;
  imageCache.set(src, entry);
  return entry;
}

/**
 * Single-slot cache for the live-preview video background. Unlike images we keep
 * just ONE element: a playing <video> keeps a decoder alive, so switching the
 * background must tear the previous one down rather than leak decoders. The
 * element autoplays muted + looped; the preview's rAF loop draws its current
 * frame each tick. The EXPORT pipeline never touches this — it samples frames
 * deterministically via Mediabunny (see BackgroundVideoProvider) instead.
 */
interface BgVideoSlot {
  src: string;
  el: HTMLVideoElement;
  /** Wall-clock of the last request, for LRU eviction. */
  usedAt: number;
  /** Last time asked for by syncPreviewVideoTime, to detect playhead jumps. */
  lastWant?: number;
}

/**
 * Clips that must stay decoded even while nothing is drawing them.
 *
 * A card's video sits at the far end of the timeline: created lazily it would
 * be cold when the card arrives, and the first frames would show the fallback
 * fill instead of the clip. Pinning keeps it warm and parked on frame 0.
 */
const pinnedVideoSrcs = new Set<string>();

/**
 * Declare the clips belonging to cards that currently exist. Creates and parks
 * each one, and exempts it from the idle sweep. Call with the full set — srcs
 * that drop out are unpinned and reaped normally.
 */
export function setPinnedPreviewVideos(srcs: ReadonlyArray<string>): void {
  pinnedVideoSrcs.clear();
  for (const src of srcs) {
    if (!src) continue;
    pinnedVideoSrcs.add(src);
    const existed = bgVideoSlots.some((s) => s.src === src);
    const el = getCachedBgVideo(src);
    // Park a freshly created element on its first frame rather than letting it
    // loop unseen in the background. An element already in the pool is left
    // alone — it may be the body background, which is supposed to be playing.
    if (el && !existed) {
      el.loop = false;
      const park = (): void => { try { el.pause(); el.currentTime = 0; } catch { /* ignore */ } };
      if (el.readyState >= 1) park();
      else el.addEventListener('loadedmetadata', park, { once: true });
    }
  }
}
/**
 * A SMALL pool, not one slot: a video card in the intro/outro and a video
 * BODY background are two different clips that both want a live element, and
 * with a single slot the two tore each other down on every card boundary —
 * one recreate per frame. Still bounded, because every live element keeps a
 * decoder alive.
 */
const MAX_BG_VIDEO_SLOTS = 3;
const bgVideoSlots: BgVideoSlot[] = [];

function disposeSlot(slot: BgVideoSlot): void {
  try {
    slot.el.pause();
    slot.el.removeAttribute('src');
    slot.el.load();
    slot.el.remove();
  } catch { /* ignore */ }
}

/** How long a slot may go unrequested before its decoder is torn down. */
const BG_VIDEO_IDLE_MS = 2000;

/**
 * Drop the elements nothing has drawn recently, so their decoders stop.
 *
 * Idle-based rather than "release everything the body isn't using": a video
 * CARD and a video BODY background are drawn from different branches, and only
 * one of them runs on any given frame. A blanket release from the body's
 * branch would tear the card's element down once per frame — recreating a
 * decoder every tick — and vice versa. Going by last-use lets both survive
 * while either is on screen, and still reaps them when the composition stops
 * using video at all.
 */
function sweepBgVideos(): void {
  const now = performance.now();
  for (let i = bgVideoSlots.length - 1; i >= 0; i--) {
    const slot = bgVideoSlots[i]!;
    if (pinnedVideoSrcs.has(slot.src)) continue;
    if (now - slot.usedAt < BG_VIDEO_IDLE_MS) continue;
    disposeSlot(slot);
    bgVideoSlots.splice(i, 1);
  }
}

/**
 * Park a preview clip at a specific time instead of letting it free-run.
 *
 * A looping BODY background is ambient — nobody cares which frame it's on. A
 * card whose background IS an animation has a beginning and an end, so the
 * preview has to follow the playhead or the card can't be scrubbed.
 *
 * Only corrects when it has drifted past `tolSec`: assigning `currentTime`
 * every frame re-seeks the decoder and stutters playback. Within tolerance the
 * element is left to play on its own, which is what keeps it smooth.
 */
export function syncPreviewVideoTime(
  src: string | null | undefined,
  timeSec: number,
  playing: boolean,
): void {
  if (!src) return;
  const el = getCachedBgVideo(src);
  const slot = bgVideoSlots.find((s) => s.src === src);
  if (!el || !slot) return;

  // A card clip is not wallpaper: it holds its last frame instead of wrapping.
  // Looping made the tail of the card snap back to frame 0 whenever the card
  // ran a hair longer than the clip.
  el.loop = false;
  const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : Infinity;
  // Never ask for a time at or past the end — there is no frame there, and the
  // element reports "not ready", which paints the fallback fill.
  const want = Math.min(Math.max(0, timeSec), dur - 1 / 60);
  const prev = slot.lastWant;
  slot.lastWant = timeSec;

  if (!playing) {
    if (!el.paused) el.pause();
    if (el.readyState >= 1 && Math.abs(el.currentTime - want) > 0.02) el.currentTime = want;
    return;
  }

  // While playing, re-seek ONLY when the playhead jumped — entering the card,
  // scrubbing, or restarting. Correcting continuous drift was the stutter: the
  // element and the global clock advance independently, so a tolerance check
  // fires every couple of seconds and every seek is a visible hitch.
  const jumped = prev == null || timeSec < prev - 0.05 || timeSec > prev + 0.4;
  if (jumped && el.readyState >= 1) el.currentTime = want;
  // Past the clip's end there is nothing to play; leaving it paused holds the
  // final frame rather than blanking.
  if (el.paused && want < dur - 1 / 30) void el.play().catch(() => { /* retried next tick */ });
}

/**
 * Tear down every live-preview bg-video element at once. Exported for editor
 * teardown; the per-frame path uses {@link sweepBgVideos} instead.
 */
export function releaseAllBgVideos(): void {
  for (const slot of bgVideoSlots) disposeSlot(slot);
  bgVideoSlots.length = 0;
}

function getCachedBgVideo(src: string | null | undefined): HTMLVideoElement | null {
  if (!src) return null;
  const hit = bgVideoSlots.find((s) => s.src === src);
  if (hit) {
    hit.usedAt = performance.now();
    return hit.el;
  }
  // Pool full: evict the element nobody has asked for in the longest.
  if (bgVideoSlots.length >= MAX_BG_VIDEO_SLOTS) {
    let oldest = 0;
    for (let i = 1; i < bgVideoSlots.length; i++) {
      if (bgVideoSlots[i]!.usedAt < bgVideoSlots[oldest]!.usedAt) oldest = i;
    }
    disposeSlot(bgVideoSlots[oldest]!);
    bgVideoSlots.splice(oldest, 1);
  }
  const el = document.createElement('video');
  el.crossOrigin = 'anonymous';
  el.muted = true;
  el.loop = true;
  el.autoplay = true;
  el.playsInline = true;
  el.preload = 'auto';
  el.src = src;
  // IN the document, not detached. A <video> that isn't in the DOM decodes,
  // and drawImage reads from it, but the browser doesn't drive its frame
  // production on a steady cadence — sampled onto a canvas that shows up as
  // stutter. The recording's own element is in the DOM, which is exactly why
  // the body plays smoothly and a detached card clip did not. Off-screen and
  // 1px rather than display:none, which would suspend rendering again.
  bgVideoHost().appendChild(el);
  // Autoplay should fire on its own (muted), but call play() too in case a
  // gesture-policy quirk holds it back; ignore the promise rejection.
  void el.play().catch(() => { /* will retry as the loop ticks */ });
  bgVideoSlots.push({ src, el, usedAt: performance.now() });
  return el;
}

let bgVideoHostEl: HTMLDivElement | null = null;

/** Off-screen container keeping pooled clips attached to the document. */
function bgVideoHost(): HTMLDivElement {
  if (bgVideoHostEl && bgVideoHostEl.isConnected) return bgVideoHostEl;
  const host = document.createElement('div');
  host.setAttribute('data-klipe-video-pool', '');
  host.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;'
    + 'opacity:0;pointer-events:none;z-index:-1;';
  document.body.appendChild(host);
  bgVideoHostEl = host;
  return host;
}

function drawCoverSource(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  src: CanvasImageSource,
  iw: number,
  ih: number,
): void {
  if (!iw || !ih) return;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

type BackgroundLike = Background | string | null | undefined;

function normalizeBackground(bg: BackgroundLike): Background {
  if (!bg) return { type: 'wallpaper', value: 'default', blur: 0 };
  if (typeof bg === 'string') return { type: 'wallpaper', value: bg, blur: 0 };
  if (bg.blur == null) return { ...bg, blur: 0 };
  return bg;
}

function fillLinearGradient(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  from: string,
  to: string,
  angleDeg = 135,
): void {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.hypot(w, h) / 2;
  const x0 = cx - Math.cos(a) * r;
  const y0 = cy - Math.sin(a) * r;
  const x1 = cx + Math.cos(a) * r;
  const y1 = cy + Math.sin(a) * r;
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  grad.addColorStop(0, from);
  grad.addColorStop(1, to);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  img: HTMLImageElement,
): void {
  drawCoverSource(ctx, w, h, img, img.naturalWidth || img.width, img.naturalHeight || img.height);
}

/** Width/height of any drawable source (image, <video>, or WebCodecs frame). */
function sourceDims(src: CanvasImageSource): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) {
    return { w: src.displayWidth, h: src.displayHeight };
  }
  const anySrc = src as unknown as { width?: number; height?: number };
  return { w: anySrc.width ?? 0, h: anySrc.height ?? 0 };
}

/**
 * Paint the chosen background to fill `w×h`.
 *
 * `videoFrame` only matters for `type: 'video'`:
 *   - `undefined` → preview path: draw the renderer-owned looping <video>'s
 *                   current frame (or a dark base while it's still loading).
 *   - a value     → export path: draw this exact decoded frame.
 *   - `null`      → export path with no frame ready yet: dark base only (never
 *                   falls back to the live element, which would be off-clock).
 */
function drawBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bg: Background,
  videoFrame?: CanvasImageSource | null,
): void {
  const blurPx = Math.max(0, Number(bg.blur ?? 0) || 0);

  if (blurPx > 0) {
    ctx.save();
    ctx.filter = `blur(${blurPx}px)`;
  }

  if (bg.type === 'color') {
    ctx.fillStyle = bg.value || '#0b0d12';
    ctx.fillRect(0, 0, w, h);
  } else if (bg.type === 'gradient') {
    const from = bg.from || '#1a1f2b';
    const to = bg.to || '#0b0d12';
    const angle = bg.angle == null ? 135 : bg.angle;
    fillLinearGradient(ctx, w, h, from, to, angle);
  } else if (bg.type === 'image') {
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);
    const entry = getCachedImage(bg.src);
    if (entry && entry.ready) drawCoverImage(ctx, w, h, entry.img);
  } else if (bg.type === 'video') {
    // Dark base first so the frame is never transparent (blur/letterbox edges).
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);
    let frame: CanvasImageSource | null = null;
    if (videoFrame !== undefined) {
      // Export path: use exactly what was supplied (frame or, if null, nothing).
      frame = videoFrame;
    } else {
      // Preview path: pull the renderer-owned looping element if it has data.
      const el = getCachedBgVideo(bg.src);
      if (el && el.readyState >= 2 && el.videoWidth > 0) frame = el;
    }
    if (frame) {
      const { w: iw, h: ih } = sourceDims(frame);
      drawCoverSource(ctx, w, h, frame, iw, ih);
    }
  } else {
    const preset = WALLPAPER_PRESETS[bg.value] ?? WALLPAPER_PRESETS['default']!;
    fillLinearGradient(ctx, w, h, preset.from, preset.to, 135);
  }

  if (blurPx > 0) ctx.restore();
}

/**
 * Fill a canvas with an intro/outro card background. Reuses the exact same
 * `drawBackground` routine the main composition uses, so a card's solid
 * color / gradient / image matches the body pixel-for-pixel in both the live
 * preview and the export.
 */
export function drawCardBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bg: Background | string | null | undefined,
  /**
   * Decoded frame for a `type: 'video'` card background, supplied by the
   * export pipeline (one VideoFrame per card-local time). Omit in the live
   * preview — the renderer then drives its own looping <video> element. Same
   * contract as `RenderFrameOptions.backgroundFrame`: `null` means "video, but
   * no frame ready" and draws the dark base rather than reaching for the live
   * element, which would make the export non-deterministic.
   */
  frame?: CanvasImageSource | null,
): void {
  drawBackground(ctx, w, h, normalizeBackground(bg), frame);
}

/**
 * Resolve once a background's image (if any) has finished decoding. No-op for
 * color/gradient/wallpaper backgrounds. The export bakes card frames in one
 * synchronous pass, so without this an image background can be drawn blank on a
 * cold cache; await this first. Resolves even on error so callers never hang.
 */
export async function ensureBackgroundReady(bg: Background | string | null | undefined): Promise<void> {
  const norm = normalizeBackground(bg);
  if (norm.type !== 'image' || !norm.src) return;
  const entry = getCachedImage(norm.src);
  if (!entry) return;
  if (entry.ready || entry.img.complete) return;
  await new Promise<void>((resolve) => {
    const { img } = entry;
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => resolve(), { once: true });
  });
}

export interface RenderFrameOptions {
  tMs: number;
  segments?: ZoomSegment[];
  mouse?: MouseTrack | null;
  displayWidth?: number;
  displayHeight?: number;
  background?: BackgroundLike;
  /**
   * Decoded frame for a `type: 'video'` background, supplied by the export
   * pipeline (one VideoFrame per output time). Omit in the live preview — the
   * renderer then drives its own looping <video> element. A value of `null`
   * means "video background, but no frame is ready yet" → a dark base is drawn
   * (and the live element is NOT used, so the export stays deterministic).
   */
  backgroundFrame?: CanvasImageSource | null;
  paddingScale?: number;
  showCursor?: boolean;
  crop?: Crop | null;
  /**
   * How to reconcile a chosen output aspect that differs from the source
   * aspect. 'fit' (default) shows the whole frame inset on the chosen
   * background; 'fill' cover-crops the source to fill the frame. No effect
   * when the output aspect matches the source.
   */
  fitMode?: FitMode;
  /**
   * Webcam image source. `HTMLVideoElement` in the live editor; `VideoFrame`
   * in the export pipeline (which decodes the recorded camera track via
   * WebCodecs and feeds the frame matching each output timestamp). May also be
   * an `HTMLCanvasElement` when `cameraOptions.background` replaces the disc's
   * background — the caller composites it via camera-compositor.ts and passes
   * the result here; drawCameraOverlay draws it identically.
   */
  cameraSource?: HTMLVideoElement | VideoFrame | HTMLCanvasElement | null;
  cameraOptions?: CameraOptions | null;
  /**
   * Phone-screen image source. `HTMLVideoElement` in the live editor;
   * `VideoFrame` in the export pipeline (which decodes the recorded MP4
   * directly via WebCodecs).
   */
  mobileSource?: HTMLVideoElement | VideoFrame | null;
  mobileOptions?: MobileOptions | null;
  /**
   * When true, the phone is the recording's primary subject. The renderer
   * ignores the screen source entirely and draws the phone frame centered
   * and large, with no camera/cursor/zoom overlays. Set this from the
   * editor when `recording.mobile` exists.
   */
  mobilePrimary?: boolean;
  cursorState?: CursorState | null;
  cursorOptions?: Partial<CursorOptions> | null;
  frame?: Partial<FrameOptions> | null;
  /** When true, renderer skips drawing the cursor — caller draws it (e.g., via PixiJS). */
  skipCursorDraw?: boolean;
  /** Mutated by renderer with the cursor's per-frame placement when provided. */
  cursorOutput?: CursorPlacement;
  /** Stateful cursor-follow camera (call createCursorFollowState() once per timeline). */
  cursorFollowState?: CursorFollowState | null;
  /** Master switch for cursor-follow (defaults to off). */
  cursorFollowEnabled?: boolean;
  /** Cursor-follow tuning. */
  cursorFollowConfig?: Partial<CursorFollowConfig>;
  /**
   * Zoom-transition motion blur intensity 0..1. The actual smear is scaled
   * by how fast the zoom is changing at `tMs` (derived deterministically
   * from `sampleZoom` at `tMs ± dt`), so it only appears during ease-in/out.
   */
  zoomBlur?: number;
  /** Blur/redaction regions to bake into the frame. */
  blurRegions?: BlurRegion[] | null;
}

export interface CursorPlacement {
  visible: boolean;
  px: number;
  py: number;
  r: number;
  rotation: number;
  motionAngle: number;
  motionStrength: number;
  /**
   * Effective cursor shape for this frame: the user-selected style, unless
   * the OS cursor type (text → svg-bone, pointer → svg-hand) overrides it.
   */
  shape: CursorShape;
  /**
   * Visible cursor height in canvas pixels for this frame. Both render
   * paths (2D canvas + Pixi overlay) honor this exactly so all shapes —
   * arrow, bone, hand, etc. — end up at the same on-screen size for the
   * same `r`. The value is `r * 2` for normal styles and `r * 2 * 0.85`
   * for `arrow-mini`, with the cursor type override (bone/hand) inheriting
   * the user-style scale so type changes don't resize the cursor.
   */
  contentTargetHeight: number;
}

// Pre-warm the bone/hand image elements so the first text/pointer frame on
// the 2D canvas (used by the exporter) draws immediately rather than missing.
interface CursorSvgImage {
  img: HTMLImageElement;
  ready: boolean;
}
// Keys for the SVG cursor overrides drawn on the 2D canvas (export path).
// Mirrors the `svg-*` CursorShape variants, minus `pointer` (which is only
// reached as the `svg-hand` override, never drawn directly here).
type CursorSvgKey =
  | 'bone'
  | 'hand'
  | 'resize-ew'
  | 'resize-ns'
  | 'move'
  | 'zoom-in'
  | 'zoom-out';

const CURSOR_SVG_URLS: Record<CursorSvgKey, string> = {
  bone: boneSvgUrl,
  hand: handSvgUrl,
  'resize-ew': resizeEwSvgUrl,
  'resize-ns': resizeNsSvgUrl,
  move: moveSvgUrl,
  'zoom-in': zoomInSvgUrl,
  'zoom-out': zoomOutSvgUrl,
};

const cursorSvgCache = new Map<CursorSvgKey, CursorSvgImage>();

function loadCursorSvg(key: CursorSvgKey): CursorSvgImage {
  const existing = cursorSvgCache.get(key);
  if (existing) return existing;
  const img = new Image();
  const entry: CursorSvgImage = { img, ready: false };
  img.onload = () => { entry.ready = true; };
  img.onerror = () => { entry.ready = false; };
  img.src = CURSOR_SVG_URLS[key];
  cursorSvgCache.set(key, entry);
  return entry;
}
// Eager preload — typical case is the user opens the editor, then plays
// the recording; these decode well before any cursor-type event fires.
loadCursorSvg('bone');
loadCursorSvg('hand');
loadCursorSvg('resize-ew');
loadCursorSvg('resize-ns');
loadCursorSvg('move');

/**
 * Walk back through the mouse-event timeline from `tMs` and return the most
 * recent `cursorType` event. Returns `'arrow'` when nothing has been
 * reported yet — keeps the rest of the pipeline branch-free.
 */
function findLatestCursorType(mouse: MouseTrack | null | undefined, tMs: number): CursorType {
  if (!mouse || !mouse.events) return 'arrow';
  const events = mouse.events;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.t > tMs) continue;
    if (e.type === 'cursorType') return e.cursorType;
  }
  return 'arrow';
}

/**
 * Resolve `(style, cursorType)` to a single CursorShape.
 *   - `text`      → `svg-bone`      (typing in a field)
 *   - `pointer`   → `svg-hand`      (hovering a clickable)
 *   - `resize-ew` → `svg-resize-ew` (↔ horizontal resize)
 *   - `resize-ns` → `svg-resize-ns` (↕ vertical resize)
 *   - `move`      → `svg-move`      (4-way move / size-all)
 *   - otherwise   → user-selected style as-is
 *
 * The cursor-type override wins over the user-selected style so the
 * typing/hover/resize affordance stays consistent across all styles.
 * `crosshair` and `not-allowed` are reported by the OS but have no dedicated
 * glyph yet, so they fall through to the user's style. There is no zoom
 * cursor type — Windows has no standard zoom cursor, so the registered
 * `svg-zoom-in`/`svg-zoom-out` shapes are intentionally never resolved here.
 */
function resolveCursorShape(
  style: CursorOptions['style'],
  type: CursorType,
): CursorShape {
  if (type === 'text') return 'svg-bone';
  if (type === 'pointer') return 'svg-hand';
  if (type === 'resize-ew') return 'svg-resize-ew';
  if (type === 'resize-ns') return 'svg-resize-ns';
  if (type === 'move') return 'svg-move';
  return style;
}

/**
 * Per-style visual scale. Arrow/outline/dot/figma render at the full
 * baseline height; arrow-mini intentionally shrinks. The bone/hand SVG
 * overrides inherit whichever scale the user-selected style uses, so the
 * cursor does not change size when typing or hovering buttons. Custom
 * imports keep the baseline 1.0 — the user's source PNG/CUR/ANI controls
 * the visual weight.
 */
function styleHeightFactor(style: CursorOptions['style']): number {
  return style === 'arrow-mini' ? 0.85 : 1.0;
}

type RenderableSource = CanvasImageSource & {
  videoWidth?: number;
  videoHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
};

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  source: RenderableSource,
  opts: RenderFrameOptions,
): void {
  const {
    tMs,
    segments = [],
    mouse,
    displayWidth,
    displayHeight,
    background = 'default',
    backgroundFrame,
    paddingScale,
    showCursor = true,
    crop = null,
    fitMode = 'fit',
    cameraSource = null,
    cameraOptions = null,
    mobileSource = null,
    mobileOptions = null,
    mobilePrimary = false,
    cursorState = null,
    cursorOptions = null,
    frame = null,
    skipCursorDraw = false,
    cursorOutput,
    cursorFollowState = null,
    cursorFollowEnabled = false,
    cursorFollowConfig,
    zoomBlur = 0,
    blurRegions = null,
  } = opts;
  if (cursorOutput) {
    cursorOutput.visible = false;
    // Default the shape so the overlay never reads `undefined` between frames
    // where the cursor is hidden. Real value below when the cursor is visible.
    cursorOutput.shape = 'arrow';
    cursorOutput.contentTargetHeight = 0;
  }
  const cOpts: CursorOptions = { ...DEFAULT_CURSOR_OPTIONS, ...(cursorOptions ?? {}) };
  const effectiveCursorType = findLatestCursorType(mouse, opts.tMs);
  const effectiveCursorShape = resolveCursorShape(cOpts.style, effectiveCursorType);
  // The user-selected style controls the cursor's visual size — arrow-mini
  // is intentionally smaller. The OS-cursor-type overrides (svg-bone, svg-hand)
  // inherit this factor so the cursor doesn't grow/shrink as the OS cursor
  // type changes during recording.
  const styleScale = styleHeightFactor(cOpts.style);
  const fOpts: FrameOptions = { ...DEFAULT_FRAME_OPTIONS, ...(frame ?? {}) };

  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const normBg = normalizeBackground(background);
  if (!fOpts.removeBackground) {
    drawBackground(ctx, cw, ch, normBg, backgroundFrame);
  } else {
    ctx.clearRect(0, 0, cw, ch);
  }
  // Reap preview video elements nothing has drawn for a while. A sweep, NOT a
  // blanket release: card backgrounds can be videos too, and they're drawn from
  // a different branch than this one, so releasing "everything the body isn't
  // using" would recreate the card's decoder on every body frame.
  sweepBgVideos();

  // Phone-primary mode: the phone is the recording's main subject. Render
  // the phone frame on the background; skip the screen source, cursor, camera,
  // and blur (none apply when there's no screen behind the phone). Zoom DOES
  // apply here — segments push the camera into the phone screen.
  if (mobilePrimary) {
    const phoneZoom = sampleZoom(segments, tMs);
    drawMobilePrimary(ctx, mobileSource, mobileOptions, cw, ch, phoneZoom, displayWidth, displayHeight);
    return;
  }

  const sw = source.videoWidth || source.displayWidth || displayWidth;
  const sh = source.videoHeight || source.displayHeight || displayHeight;
  if (!sw || !sh) return;

  // Not const: the brand-header "viewport" zoom below narrows this rect in place
  // so every downstream source→canvas mapping follows it. The base card rect is
  // computed from the UNNARROWED values, above that point.
  let sx0 = crop ? crop.x * sw : 0;
  let sy0 = crop ? crop.y * sh : 0;
  let swEff = crop ? crop.width * sw : sw;
  let shEff = crop ? crop.height * sh : sh;

  // The chosen output shape differs from what was recorded (e.g. a 16:9 PC
  // capture rendered into a 9:16 reels frame). Two ways to reconcile it:
  //   - 'fill' → cover-fit the source so it fills the frame, center-cropping
  //              the long axis (the classic reels crop).
  //   - 'fit'  → show the WHOLE source (contain, inset like the matched-aspect
  //              case); the user's chosen background fills the surrounding space
  //              (already painted by drawBackground above).
  //
  // We compare against the RAW source aspect (sw/sh), not the cropped aspect
  // (swEff/shEff). Cropping is a "zoom into a sub-region" operation, not an
  // output-shape change — so a 4:3 crop of a 16:9 recording into a 16:9
  // canvas should still render the cropped region inset within the frame
  // with the background visible, not balloon it to fill the canvas.
  const canvasAspect = cw / ch;
  const sourceAspect = sw / sh;
  const crossAspect = Math.abs(canvasAspect - sourceAspect) > CROSS_ASPECT_EPSILON;
  const fillFrame = crossAspect && fitMode === 'fill';

  // Named `winChrome`, not `chrome`: the latter shadows the browser global.
  const winChrome = resolveWindowChrome(fOpts.window);
  // Fill mode bleeds past the canvas edges, so the window chrome is skipped
  // there — the same rule the `chromeFade === 0` branch applies to the card's
  // shadow and corner radius below.
  const barRatio = fillFrame ? 0 : CHROME_BAR_RATIO[winChrome.style];

  // The brand header reserves a band off the top of the canvas. Skipped in fill
  // mode for the same reason as the chrome: the video bleeds past every edge
  // there, so there is no band left to sit in.
  const header = resolveBrandHeader(fOpts.header);
  const headerRatio = fillFrame ? 0 : brandHeaderRatio(header);
  const headerBleed = fillFrame ? 0 : brandHeaderBleed(header);

  let baseX: number;
  let baseY: number;
  let baseW: number;
  let baseH: number;
  if (fillFrame) {
    const fit = Math.max(cw / swEff, ch / shEff);
    baseW = swEff * fit;
    baseH = shEff * fit;
    baseX = (cw - baseW) / 2;
    baseY = (ch - baseH) / 2;
  } else {
    const effectivePadding = paddingScale != null
      ? paddingScale
      : Math.max(0.4, Math.min(1, 1 - (fOpts.padding / 100) * 1.6));
    // The chrome bar eats into the vertical margin rather than shrinking the
    // video. baseX/Y/W/H stays the VIDEO rect, so every zoom branch below is
    // unchanged in meaning.
    ({ baseX, baseY, baseW, baseH } = computeHeaderInsetRect(
      cw, ch, swEff, shEff, effectivePadding, barRatio, headerRatio, headerBleed,
    ));
  }

  // Brand header: over the background, under the card. Aligned to the BASE rect
  // so the headline's left edge lines up with the window's — and because the
  // base rect is pre-zoom, the header stays put when a zoom comes in. The card
  // is the thing that moves; page furniture isn't.
  if (headerRatio > 0) {
    drawBrandHeader(ctx, baseX, 0, baseW, ch * headerRatio, header);
  }

  const { scale: baseScale, cx: baseCx, cy: baseCy, p: zoomP } = sampleZoom(segments, tMs);

  // Sample the cursor early so cursor-follow can override the zoom focus
  // before we compute the draw rect. We reuse the same sample for drawing
  // later — calling sampleCursor twice would advance its spring twice.
  const cursorEnabled = !!(showCursor && cOpts.show && mouse);
  const cursor: CursorSample = cursorEnabled
    ? cursorState
      ? sampleCursor(cursorState, mouse!, tMs, cOpts)
      : staticCursorSample(mouse!, tMs, cOpts)
    : { visible: false };

  let cx = baseCx;
  let cy = baseCy;
  let scale = baseScale;
  if (
    cursorFollowEnabled &&
    cursorFollowState &&
    cursor.visible &&
    baseCx != null &&
    baseCy != null
  ) {
    const followCfg = { ...DEFAULT_CURSOR_FOLLOW, ...(cursorFollowConfig ?? {}) };
    const follow = applyCursorFollow({
      state: cursorFollowState,
      baseFocusX: baseCx,
      baseFocusY: baseCy,
      cursorX: cursor.x,
      cursorY: cursor.y,
      scale: baseScale,
      zoomP,
      sourceWidth: sw,
      sourceHeight: sh,
      tMs,
      config: followCfg,
    });
    cx = follow.cx;
    cy = follow.cy;
    // Adaptive zoom: scale eases off as cursor speed increases. Multiplier
    // only kicks in while we're meaningfully zoomed (zoomP > 0); blends back
    // to 1 during the easing tail so the framing snaps back to its full zoom.
    const adaptiveBlend = Math.max(0, Math.min(1, (zoomP - 0.2) / 0.6));
    const factor = 1 - (1 - follow.scaleFactor) * adaptiveBlend;
    scale = 1 + (baseScale - 1) * factor;
  }

  // A brand header turns the card into a VIEWPORT. The band above it is page
  // furniture — a card that grew under zoom would slide up and cover the logo
  // and the headline — so the card keeps its base rect and the zoom instead
  // narrows the region of the source it samples. Same picture, but the window
  // outline stays put and the magnification happens inside it.
  //
  // Narrowing the SOURCE rect rather than clipping the drawn one is what keeps
  // this cheap: the cursor hit-test, the blur regions and the zoom blur all map
  // through sx0/swEff + drawX/drawW, so they follow with no changes — and a
  // cursor outside the zoomed viewport correctly stops being drawn instead of
  // floating over the header.
  //
  // Runs BEFORE fcx/fcy so those derive from the FINAL source rect — and stay
  // `const`, which is what lets the draw branches below narrow them.
  const innerZoom = headerRatio > 0;
  if (innerZoom && scale > 1.0001) {
    const zw = swEff / scale;
    const zh = shEff / scale;
    // Same focus choice the breakout branch makes below: the CURSOR when it's
    // visible, else the zoom centre. The auto-zoom centre is a click-cluster
    // average and can sit well away from where the pointer ended up — and it
    // goes null between segments while the ease-out still has scale > 1, which
    // is precisely when a centre fallback would show.
    const focusSrcX = cursor.visible ? cursor.x : cx;
    const focusSrcY = cursor.visible ? cursor.y : cy;
    // CLAMPED into the crop, never SWAPPED for the centre. A focus that lands
    // outside — cursor-follow is crop-unaware and its spring overshoots, and the
    // zoom centre can be null mid-ease — has to slide the viewport to the
    // nearest edge. Swapping in the centre made the framing jump to the middle
    // and back on the next frame, which is the tic this replaced.
    const focusX = focusSrcX == null
      ? swEff / 2
      : Math.min(swEff, Math.max(0, focusSrcX - sx0));
    const focusY = focusSrcY == null
      ? shEff / 2
      : Math.min(shEff, Math.max(0, focusSrcY - sy0));
    // Clamped again on the way out so the viewport never samples past the crop
    // and lets a black band in.
    sx0 += Math.min(swEff - zw, Math.max(0, focusX - zw / 2));
    sy0 += Math.min(shEff - zh, Math.max(0, focusY - zh / 2));
    swEff = zw;
    shEff = zh;
  }

  const fcx = cx == null ? null : cx - sx0;
  const fcy = cy == null ? null : cy - sy0;
  const focusInCrop = fcx != null && fcy != null
    && fcx >= 0 && fcx <= swEff && fcy >= 0 && fcy <= shEff;

  // The viewport zoom already lives in the source rect, so the card itself is
  // drawn at 1:1 — scaling it here is what used to push it over the header.
  let drawW = innerZoom ? baseW : baseW * scale;
  let drawH = innerZoom ? baseH : baseH * scale;
  let drawX: number;
  let drawY: number;
  // Cross-aspect 'fit' + an active zoom: let the zoom break OUT of the
  // letterbox band. As the zoom eases in (zoomP 0→1) the framing blends from
  // the contained whole video toward a focus-centered, canvas-covering close-up
  // — i.e. it behaves like 'fill' at the peak of the zoom, then settles back to
  // the full frame as the zoom eases out. Without this, zooming inside a
  // vertical frame magnifies only within the short band, so the subject stays
  // tiny and can be clipped off to one side.
  // Gated on a focus EXISTING, not on it lying inside the crop: a focus that
  // falls in a cropped-out border (cursor-follow is crop-unaware, or a zoom
  // centre placed outside the crop) is clamped to the nearest in-crop edge
  // below, so breakout stays continuous instead of snapping to the plain inset.
  // Centre the close-up on the CURSOR itself when it's visible, so the cursor
  // is the subject and stays dead-centre. The auto-zoom focus (the click-cluster
  // centre) can sit well away from where the cursor actually ended up — that's
  // why a bottom-corner cursor was landing cropped at the edge. Fall back to the
  // zoom focus when the cursor is hidden.
  // A brand header rules breakout out: breakout is the opposite of the viewport
  // zoom above (it deliberately grows the card past the canvas edges), and it
  // would land the video on top of the reserved band. Still gated here rather
  // than left to the `innerZoom` branch below, because `breakoutZoom` also
  // decides the chrome fade.
  const breakoutFocusX = cursor.visible ? cursor.x : cx;
  const breakoutFocusY = cursor.visible ? cursor.y : cy;
  const breakoutZoom = crossAspect && !fillFrame && headerRatio <= 0 && scale > 1.0001
    && breakoutFocusX != null && breakoutFocusY != null;
  if (innerZoom) {
    // The card never moves: it is exactly where computeHeaderInsetRect put it.
    drawX = baseX;
    drawY = baseY;
  } else if (breakoutZoom) {
    const t = Math.max(0, Math.min(1, zoomP));
    // Focus as a fraction of the visible source, clamped in case it lies in a
    // cropped-out border (the cursor / zoom centre can fall outside the crop) so
    // the framing stays continuous instead of snapping.
    const u = Math.max(0, Math.min(1, (breakoutFocusX! - sx0) / swEff));
    const v = Math.max(0, Math.min(1, (breakoutFocusY! - sy0) / shEff));
    const coverFit = Math.max(cw / swEff, ch / shEff);
    const coverW = swEff * coverFit;
    const coverH = shEff * coverFit;
    // Size blends contain→cover by zoomP (grows smoothly out of the band) then
    // takes the zoom magnification, so the close-up fills the frame.
    drawW = (baseW + (coverW - baseW) * t) * scale;
    drawH = (baseH + (coverH - baseH) * t) * scale;
    // Drive the focus point (the click / cursor location) from where it sits in
    // the contained whole-video toward the canvas CENTRE as the zoom eases in,
    // and place the source so the focus lands exactly there. No cover-clamp: the
    // focus — and the cursor on it — ends up dead-centre and visible at full
    // zoom; the chosen background simply shows through wherever a near-edge
    // focus can't cover (e.g. wallpaper above a top-of-screen focus), matching
    // the reference vertical zoom. Interpolating the focus's canvas POSITION
    // against the FIXED contain size keeps it monotonic and on-screen — deriving
    // it from the growing draw size would swing an edge focus off-frame mid-zoom.
    // Derived from baseX/baseY rather than assuming a canvas-centred rect: a
    // window-chrome bar pushes the video rect down, so the two are no longer
    // the same thing (they are identical when there's no bar).
    const restFocusFracX = (baseX + u * baseW) / cw;
    const restFocusFracY = (baseY + v * baseH) / ch;
    const focusFracX = restFocusFracX + (0.5 - restFocusFracX) * t;
    const focusFracY = restFocusFracY + (0.5 - restFocusFracY) * t;
    drawX = focusFracX * cw - u * drawW;
    drawY = focusFracY * ch - v * drawH;
  } else if (!focusInCrop) {
    // Centred on the BASE rect, not on the canvas — a chrome bar shifts the
    // video rect down. Equivalent to (cw - drawW) / 2 when there's no bar.
    drawX = baseX + (baseW - drawW) / 2;
    drawY = baseY + (baseH - drawH) / 2;
  } else if (fillFrame) {
    // Fill mode: place the source's focus point at the canvas center, then
    // clamp so the source still covers the canvas. This makes Focus X/Y act
    // as "which strip of the wider source is visible" even at scale=1, which
    // is the natural control surface for recomposing into vertical reels.
    drawX = cw / 2 - (fcx / swEff) * drawW;
    drawY = ch / 2 - (fcy / shEff) * drawH;
    drawX = Math.min(0, Math.max(cw - drawW, drawX));
    drawY = Math.min(0, Math.max(ch - drawH, drawY));
  } else if (scale === 1) {
    // Contain mode at scale=1: source fits exactly, nothing to pan.
    drawX = baseX + (baseW - drawW) / 2;
    drawY = baseY + (baseH - drawH) / 2;
  } else {
    const focusBaseX = baseX + (fcx / swEff) * baseW;
    const focusBaseY = baseY + (fcy / shEff) * baseH;
    drawX = focusBaseX - (fcx / swEff) * drawW;
    drawY = focusBaseY - (fcy / shEff) * drawH;
    drawX = Math.min(baseX, Math.max(baseX + baseW - drawW, drawX));
    drawY = Math.min(baseY, Math.max(baseY + baseH - drawH, drawY));
  }

  const radiusScale = (fOpts.radius / 24);
  // The framed-card chrome (rounded corners + drop shadow) only reads correctly
  // while the video sits INSIDE the canvas. Fill mode bleeds past the edges so
  // it's skipped entirely. Breakout grows past the edges as the zoom peaks too —
  // keeping the chrome there would paint a floating-card shadow over the
  // background mid-zoom — so fade it out as the nearest edge crosses the bound.
  //
  // A WINDOW is exempt from the breakout fade. The fade exists so a bare card's
  // shadow doesn't float over the background mid-zoom, but a window is meant to
  // read as a window: dissolving it is what made the browser bar vanish the
  // moment a zoom started. Killing breakout instead was the wrong fix — it left
  // the zoom pinned near the frame centre (a top focus landed at 31% of the
  // height instead of 11%), which reads as "it zooms to the middle".
  let chromeFade: number;
  if (fillFrame) {
    chromeFade = 0;
  } else if (breakoutZoom && barRatio <= 0) {
    const minInset = Math.min(drawX, cw - (drawX + drawW), drawY, ch - (drawY + drawH));
    chromeFade = Math.max(0, Math.min(1, minInset / Math.max(1, 0.04 * Math.min(cw, ch))));
  } else {
    chromeFade = 1;
  }
  // The window is PART OF THE IMAGE, so the zoom scales it exactly like the
  // video: the bar's height is a fixed fraction of the card's CURRENT width,
  // which is the same uniform transform the video gets. Zoom into a corner and
  // you see that corner of the window, magnified — including the bar scrolling
  // off the top when you zoom into the video's upper edge.
  //
  // `barRatio > 0` already rules out fill mode and breakout, so chromeFade is 1
  // whenever there's a bar and the chrome never half-dissolves.
  const barH = barRatio > 0 ? drawW * barRatio : 0;
  const winX = drawX;
  const winY = drawY - barH;
  const winW = drawW;
  const winH = drawH + barH;

  const radius = chromeFade <= 0
    ? 0
    : Math.min(winW, winH) * CORNER_RADIUS_RATIO * radiusScale * chromeFade;

  // Cast by the WHOLE card, so there's no shadow seam between bar and video.
  if (fOpts.shadow > 0 && chromeFade > 0) {
    const shadowAlpha = Math.min(0.85, 0.18 + (fOpts.shadow / 100) * 0.7) * chromeFade;
    const shadowBlur = 8 + (fOpts.shadow / 100) * 70;
    const shadowOffset = 4 + (fOpts.shadow / 100) * 28;
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${shadowAlpha})`;
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetY = shadowOffset;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.roundRect(winX, winY, winW, winH, radius);
    ctx.fill();
    ctx.restore();
  }

  // Title bar, clipped to the card so it inherits the rounded TOP corners.
  if (barH > 0) {
    ctx.save();
    ctx.globalAlpha = chromeFade;
    ctx.beginPath();
    ctx.roundRect(winX, winY, winW, winH, radius);
    ctx.clip();
    drawWindowChrome(ctx, winX, winY, winW, barH, winChrome);
    ctx.restore();
  }

  // The video's TOP corners go square once a bar sits above it: the rounding
  // belongs to the card, and the bar already owns those two corners.
  const videoRadii: CornerRadii = barH > 0 ? [0, 0, radius, radius] : radius;

  ctx.save();
  clipRoundRect(ctx, drawX, drawY, drawW, drawH, videoRadii);
  ctx.drawImage(source, sx0, sy0, swEff, shEff, drawX, drawY, drawW, drawH);
  ctx.restore();

  // Hairline rim macOS draws around a window. Stroked on the half-pixel so the
  // 1px line lands on one row instead of straddling two, and scaled with the
  // card so it stays a hairline at 4K. Drawn over the video's top edge, which
  // is why it comes after the image rather than with the bar.
  if (barH > 0) {
    const rim = Math.max(1, winW * 0.0007);
    ctx.save();
    ctx.globalAlpha = chromeFade;
    ctx.strokeStyle = WINDOW_RIM[winChrome.theme];
    ctx.lineWidth = rim;
    ctx.beginPath();
    ctx.roundRect(
      winX + rim / 2, winY + rim / 2,
      winW - rim, winH - rim,
      Math.max(0, radius - rim / 2),
    );
    ctx.stroke();
    ctx.restore();
  }

  // Zoom motion blur — only during transitions, derived deterministically
  // from how fast the zoom scale is changing at this frame. Drawn over the
  // sharp frame but BEFORE the cursor/blur regions so those stay crisp.
  if (zoomBlur > 0 && scale > 1.001) {
    const dt = 1000 / 60;
    const sBefore = sampleZoom(segments, tMs - dt).scale;
    const sAfter = sampleZoom(segments, tMs + dt).scale;
    const vel = Math.abs(sAfter - sBefore);
    const amount = Math.min(1, vel * 10) * Math.max(0, Math.min(1, zoomBlur));
    if (amount > 0.001) {
      const fx = focusInCrop ? drawX + (fcx! / swEff) * drawW : drawX + drawW / 2;
      const fy = focusInCrop ? drawY + (fcy! / shEff) * drawH : drawY + drawH / 2;
      applyZoomBlur(ctx, source, {
        sx0, sy0, swEff, shEff, drawX, drawY, drawW, drawH, radius: videoRadii,
      }, fx, fy, amount);
    }
  }

  if (blurRegions && blurRegions.length > 0) {
    applyBlurRegions(ctx, source, blurRegions, tMs, {
      sw, sh, sx0, sy0, swEff, shEff, drawX, drawY, drawW, drawH, radius: videoRadii,
    });
  }

  if (!cursorEnabled) {
    drawCameraOverlay(ctx, cameraSource, cameraOptions, cw, ch, zoomP || 0);
    // Mobile draws AFTER camera so that when both share a slot the phone
    // stacks on top — an arbitrary but consistent choice.
    drawMobileOverlay(ctx, mobileSource, mobileOptions, cw, ch, zoomP || 0);
    return;
  }

  if (cursor.visible) {
    const lx = cursor.x - sx0;
    const ly = cursor.y - sy0;
    if (lx >= 0 && lx <= swEff && ly >= 0 && ly <= shEff) {
      const px = drawX + (lx / swEff) * drawW;
      const py = drawY + (ly / shEff) * drawH;

      const refDim = Math.max(cw, ch);
      const baseR = CURSOR_BASE_RADIUS * (refDim / CURSOR_REFERENCE_WIDTH);
      const r = baseR * cOpts.size * (cursor.scaleMul || 1);

      const contentTargetHeight = r * 2 * styleScale;
      if (cursorOutput) {
        cursorOutput.visible = true;
        cursorOutput.px = px;
        cursorOutput.py = py;
        cursorOutput.r = r;
        cursorOutput.rotation = cursor.rotation || 0;
        cursorOutput.motionAngle = cursor.motionAngle;
        cursorOutput.motionStrength = cursor.motionStrength;
        cursorOutput.shape = effectiveCursorShape;
        cursorOutput.contentTargetHeight = contentTargetHeight;
      }

      if (!skipCursorDraw) {
        drawCursor(ctx, px, py, contentTargetHeight, cursor.rotation || 0, {
          shape: effectiveCursorShape,
          motionAngle: cursor.motionAngle,
          motionStrength: cursor.motionStrength,
        });
      }
    }
  }

  drawCameraOverlay(ctx, cameraSource, cameraOptions, cw, ch, zoomP || 0);
  drawMobileOverlay(ctx, mobileSource, mobileOptions, cw, ch, zoomP || 0);
}


interface BlurDrawGeometry {
  /** Full source dimensions in pixels. */
  sw: number;
  sh: number;
  /** Crop offset in source pixels (zero when no crop). */
  sx0: number;
  sy0: number;
  /** Visible (post-crop) source size in pixels. */
  swEff: number;
  shEff: number;
  /** Where the source is drawn on the canvas (already zoomed/positioned). */
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
  /**
   * Corner radii of the video rect. Per-corner `[tl, tr, br, bl]` with the top
   * squared off when window chrome sits above.
   */
  radius: CornerRadii;
}

let _blurTmpCanvas: HTMLCanvasElement | null = null;
function getBlurTmpCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  if (!_blurTmpCanvas) _blurTmpCanvas = document.createElement('canvas');
  if (_blurTmpCanvas.width !== w) _blurTmpCanvas.width = w;
  if (_blurTmpCanvas.height !== h) _blurTmpCanvas.height = h;
  return _blurTmpCanvas;
}

let _pixelTmpCanvas: HTMLCanvasElement | null = null;
function getPixelTmpCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  if (!_pixelTmpCanvas) _pixelTmpCanvas = document.createElement('canvas');
  if (_pixelTmpCanvas.width !== w) _pixelTmpCanvas.width = w;
  if (_pixelTmpCanvas.height !== h) _pixelTmpCanvas.height = h;
  return _pixelTmpCanvas;
}

/**
 * Multiply the offscreen's alpha by a soft-edged mask so the redaction blends
 * into the surrounding pixels instead of stamping a hard rectangle. For a
 * rect we use two `destination-in` passes with linear gradients (vertical
 * then horizontal) — alpha multiplies under destination-in, so the corners
 * naturally taper to transparent. For an ellipse we use a single radial
 * gradient stretched to the region's aspect.
 */
function applyFeatherMask(
  tctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  shape: BlurRegion['shape'],
): void {
  tctx.globalCompositeOperation = 'destination-in';
  if (shape === 'ellipse') {
    const minDim = Math.min(w, h);
    tctx.save();
    tctx.translate(w / 2, h / 2);
    tctx.scale(w / minDim, h / minDim);
    const grad = tctx.createRadialGradient(0, 0, 0, 0, 0, minDim / 2);
    grad.addColorStop(0,    'rgba(0,0,0,1)');
    grad.addColorStop(0.55, 'rgba(0,0,0,1)');
    grad.addColorStop(1,    'rgba(0,0,0,0)');
    tctx.fillStyle = grad;
    tctx.fillRect(-minDim / 2, -minDim / 2, minDim, minDim);
    tctx.restore();
  } else {
    // Cap the feather so very small regions don't lose their solid center.
    const featherPx = Math.min(28, Math.min(w, h) * 0.22);
    const fW = Math.min(0.45, featherPx / w);
    const fH = Math.min(0.45, featherPx / h);
    const v = tctx.createLinearGradient(0, 0, 0, h);
    v.addColorStop(0,      'rgba(0,0,0,0)');
    v.addColorStop(fH,     'rgba(0,0,0,1)');
    v.addColorStop(1 - fH, 'rgba(0,0,0,1)');
    v.addColorStop(1,      'rgba(0,0,0,0)');
    tctx.fillStyle = v;
    tctx.fillRect(0, 0, w, h);
    const hG = tctx.createLinearGradient(0, 0, w, 0);
    hG.addColorStop(0,      'rgba(0,0,0,0)');
    hG.addColorStop(fW,     'rgba(0,0,0,1)');
    hG.addColorStop(1 - fW, 'rgba(0,0,0,1)');
    hG.addColorStop(1,      'rgba(0,0,0,0)');
    tctx.fillStyle = hG;
    tctx.fillRect(0, 0, w, h);
  }
  tctx.globalCompositeOperation = 'source-over';
}

/**
 * Fake radial/zoom motion blur. Draws a few copies of the just-rendered
 * video region scaled about the zoom focus point (both slightly larger and
 * smaller) at low alpha — the overlap reads as a radial smear. Uses no
 * filters and no per-frame state, so it's identical between preview and
 * export for the same `tMs`. Clipped to the rounded video frame.
 */
type ZoomBlurGeometry = Omit<BlurDrawGeometry, 'sw' | 'sh'>;

function applyZoomBlur(
  ctx: CanvasRenderingContext2D,
  source: RenderableSource,
  geom: ZoomBlurGeometry,
  focusX: number,
  focusY: number,
  amount: number,
): void {
  const { sx0, sy0, swEff, shEff, drawX, drawY, drawW, drawH, radius } = geom;
  if (swEff <= 0 || shEff <= 0 || drawW <= 0 || drawH <= 0) return;

  const ghosts = 4;
  // Max radial smear as a fraction of the frame (5% at full strength).
  const maxOffset = 0.05 * amount;

  const drawScaled = (f: number, alpha: number): void => {
    const newW = drawW * f;
    const newH = drawH * f;
    const nx = focusX - (focusX - drawX) * f;
    const ny = focusY - (focusY - drawY) * f;
    ctx.globalAlpha = alpha;
    ctx.drawImage(source, sx0, sy0, swEff, shEff, nx, ny, newW, newH);
  };

  ctx.save();
  clipRoundRect(ctx, drawX, drawY, drawW, drawH, radius);
  for (let i = 1; i <= ghosts; i += 1) {
    const t = i / ghosts;
    const alpha = (0.5 / ghosts) * (1 - t * 0.4) * amount;
    drawScaled(1 + maxOffset * t, alpha);
    drawScaled(1 - maxOffset * t, alpha);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function applyBlurRegions(
  ctx: CanvasRenderingContext2D,
  source: RenderableSource,
  regions: BlurRegion[],
  tMs: number,
  geom: BlurDrawGeometry,
): void {
  const { sw, sh, sx0, sy0, swEff, shEff, drawX, drawY, drawW, drawH, radius } = geom;
  if (swEff <= 0 || shEff <= 0 || drawW <= 0 || drawH <= 0) return;

  for (const region of regions) {
    const rect = sampleBlurRegion(region, tMs);
    if (!rect) continue;
    if (rect.width <= 0 || rect.height <= 0) continue;

    // Region in absolute source pixels.
    const srcX = rect.x * sw;
    const srcY = rect.y * sh;
    const srcW = rect.width * sw;
    const srcH = rect.height * sh;

    // Clamp the source-side rect to the visible (post-crop) area so we never
    // sample outside the source or outside the crop.
    const clipSrcX = Math.max(sx0, srcX);
    const clipSrcY = Math.max(sy0, srcY);
    const clipSrcEndX = Math.min(sx0 + swEff, srcX + srcW);
    const clipSrcEndY = Math.min(sy0 + shEff, srcY + srcH);
    if (clipSrcEndX <= clipSrcX || clipSrcEndY <= clipSrcY) continue;

    const clipSrcW = clipSrcEndX - clipSrcX;
    const clipSrcH = clipSrcEndY - clipSrcY;

    // Map the (clamped) region rect onto the canvas, following the same
    // transform the main video draw used.
    const localX = clipSrcX - sx0;
    const localY = clipSrcY - sy0;
    const cX = drawX + (localX / swEff) * drawW;
    const cY = drawY + (localY / shEff) * drawH;
    const cW = (clipSrcW / swEff) * drawW;
    const cH = (clipSrcH / shEff) * drawH;
    if (cW <= 0 || cH <= 0) continue;

    // Build the redacted pixels in an offscreen canvas at the region's size,
    // then mask its alpha with a feathered falloff so the redaction fades
    // smoothly into the surrounding video instead of stamping a hard edge.
    const tmpW = Math.max(1, Math.ceil(cW));
    const tmpH = Math.max(1, Math.ceil(cH));
    const tmp = getBlurTmpCanvas(tmpW, tmpH);
    if (!tmp) continue;
    const tctx = tmp.getContext('2d');
    if (!tctx) continue;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, tmpW, tmpH);
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';

    if (region.style === 'pixelate') {
      const blockPx = Math.max(2, strengthToBlockPx(region.strength));
      const pxW = Math.max(1, Math.floor(tmpW / blockPx));
      const pxH = Math.max(1, Math.floor(tmpH / blockPx));
      const tiny = getPixelTmpCanvas(pxW, pxH);
      if (tiny) {
        const ttctx = tiny.getContext('2d');
        if (ttctx) {
          ttctx.imageSmoothingEnabled = false;
          ttctx.clearRect(0, 0, pxW, pxH);
          ttctx.drawImage(source, clipSrcX, clipSrcY, clipSrcW, clipSrcH, 0, 0, pxW, pxH);
          tctx.imageSmoothingEnabled = false;
          tctx.drawImage(tiny, 0, 0, pxW, pxH, 0, 0, tmpW, tmpH);
        }
      }
    } else {
      const blurPx = strengthToBlurPx(region.strength);
      // CSS-filter blur darkens edges of a clipped draw because the kernel
      // reads transparent pixels outside the rect. Sampling a slightly
      // padded source rect covers the kernel's reach so the blurred result
      // stays uniform across the region (no dark vignette around the edge).
      const padPx = Math.max(0, Math.ceil(blurPx * 2));
      const padSrcX = Math.max(sx0, clipSrcX - padPx * (clipSrcW / Math.max(1, cW)));
      const padSrcY = Math.max(sy0, clipSrcY - padPx * (clipSrcH / Math.max(1, cH)));
      const padSrcEndX = Math.min(sx0 + swEff, clipSrcEndX + padPx * (clipSrcW / Math.max(1, cW)));
      const padSrcEndY = Math.min(sy0 + shEff, clipSrcEndY + padPx * (clipSrcH / Math.max(1, cH)));
      const padSrcW = padSrcEndX - padSrcX;
      const padSrcH = padSrcEndY - padSrcY;
      const dstOffsetX = (clipSrcX - padSrcX) / clipSrcW * cW;
      const dstOffsetY = (clipSrcY - padSrcY) / clipSrcH * cH;
      const dstW = padSrcW / clipSrcW * cW;
      const dstH = padSrcH / clipSrcH * cH;
      tctx.filter = blurPx > 0 ? `blur(${blurPx}px)` : 'none';
      tctx.drawImage(source, padSrcX, padSrcY, padSrcW, padSrcH, -dstOffsetX, -dstOffsetY, dstW, dstH);
      tctx.filter = 'none';
    }

    applyFeatherMask(tctx, tmpW, tmpH, region.shape);

    // Compose onto the main canvas, clipped to the rounded video frame so
    // the feathered edge can't bleed onto the background.
    ctx.save();
    clipRoundRect(ctx, drawX, drawY, drawW, drawH, radius);
    ctx.drawImage(tmp, cX, cY, cW, cH);
    ctx.restore();
  }
}

function staticCursorSample(
  mouse: MouseTrack | null | undefined,
  tMs: number,
  opts: CursorOptions,
): CursorSample {
  if (!mouse || !mouse.events.length) return { visible: false };
  const evs = mouse.events;
  let lo = 0;
  let hi = evs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (evs[mid]!.t <= tMs) lo = mid;
    else hi = mid - 1;
  }
  let s: { x: number; y: number } | null = null;
  for (let i = lo; i >= 0; i--) {
    const e = evs[i]!;
    if (e.type === 'move' || e.type === 'click') {
      s = e;
      break;
    }
  }
  if (!s) return { visible: false };

  let scaleMul = 1;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]!;
    if (e.t > tMs) continue;
    if (tMs - e.t > opts.bounceSpeed) break;
    if (e.type === 'click') {
      const p = Math.max(0, Math.min(1, (tMs - e.t) / opts.bounceSpeed));
      scaleMul = 1 - Math.sin(p * Math.PI) * (0.08 * opts.clickBounce);
      break;
    }
  }
  return {
    visible: true,
    x: s.x,
    y: s.y,
    rotation: 0,
    scaleMul,
    motionAngle: 0,
    motionStrength: 0,
  };
}

interface DrawCursorOptions {
  shape: CursorShape;
  motionAngle?: number;
  motionStrength?: number;
}

function drawCursor(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  targetH: number,
  rotation: number,
  opts: DrawCursorOptions,
): void {
  const { shape, motionAngle = 0, motionStrength = 0 } = opts;

  const drawSprite = (alpha = 1): void => {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rotation);
    ctx.globalAlpha *= alpha;
    drawCursorShape(ctx, targetH, shape);
    ctx.restore();
  };

  if (motionStrength > 0.05) {
    const ghosts = 4;
    // Smear scales with the cursor's visible height so motion blur reads
    // proportionally regardless of which shape is active.
    const smear = targetH * 0.8 * Math.min(1.5, motionStrength);
    const ax = Math.cos(motionAngle);
    const ay = Math.sin(motionAngle);
    ctx.save();
    for (let i = ghosts; i >= 1; i--) {
      const t = i / ghosts;
      const ox = -ax * smear * t;
      const oy = -ay * smear * t;
      ctx.save();
      ctx.translate(ox, oy);
      drawSprite(0.18 * (1 - t * 0.6));
      ctx.restore();
    }
    ctx.restore();
  }

  drawSprite(1);
}

function drawCursorShape(
  ctx: CanvasRenderingContext2D,
  targetH: number,
  shape: CursorShape,
): void {
  // Shadow params are tied to the cursor's rendered height so all shapes
  // get a proportional drop shadow.
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = Math.max(2, targetH * 0.25);
  ctx.shadowOffsetY = Math.max(1, targetH * 0.075);

  switch (shape) {
    case 'arrow':         drawArrow(ctx, targetH, true); return;
    case 'arrow-outline': drawArrow(ctx, targetH, false); return;
    // arrow-mini's smaller size is already baked into the targetH passed
    // by the renderer (styleHeightFactor() == 0.85 for arrow-mini).
    case 'arrow-mini':    drawArrow(ctx, targetH, true); return;
    case 'figma':         drawFigmaArrow(ctx, targetH); return;
    case 'svg-bone':      drawCursorSvg(ctx, targetH, 'bone'); return;
    case 'svg-hand':      drawCursorSvg(ctx, targetH, 'hand'); return;
    case 'svg-resize-ew': drawCursorSvg(ctx, targetH, 'resize-ew'); return;
    case 'svg-resize-ns': drawCursorSvg(ctx, targetH, 'resize-ns'); return;
    case 'svg-move':      drawCursorSvg(ctx, targetH, 'move'); return;
    case 'svg-zoom-in':   drawCursorSvg(ctx, targetH, 'zoom-in'); return;
    case 'svg-zoom-out':  drawCursorSvg(ctx, targetH, 'zoom-out'); return;
    case 'dot':
    default:              drawDot(ctx, targetH); return;
  }
}

// Draws bone (text I-beam) or hand (pointer) SVG centred on the hotspot.
// Falls back silently if the image isn't decoded yet — the next frame will
// pick it up. Caller has already translated the canvas to (px, py), so we
// draw relative to (0, 0) using width/height matching the cursor radius.
const SVG_VIEWBOX: Record<CursorSvgKey, { width: number; height: number; hotspotX: number; hotspotY: number }> = {
  // hotspot ratios match cursor-sprites.ts so the editor preview and the
  // exported video land on the same anchor pixel.
  bone:        { width: 618,        height: 1350, hotspotX: 309 / 618,        hotspotY: 675 / 1350 },
  hand:        { width: 618,        height: 767,  hotspotX: 264 / 618,        hotspotY: 24 / 767 },
  'resize-ew': { width: 400,        height: 400,  hotspotX: 0.5,              hotspotY: 0.5 },
  'resize-ns': { width: 400,        height: 400,  hotspotX: 0.5,              hotspotY: 0.5 },
  move:        { width: 618,        height: 618,  hotspotX: 0.5,              hotspotY: 0.5 },
  'zoom-in':   { width: 618,        height: 618,  hotspotX: 261 / 618,        hotspotY: 232 / 618 },
  'zoom-out':  { width: 618,        height: 618,  hotspotX: 261 / 618,        hotspotY: 232 / 618 },
};

function drawCursorSvg(ctx: CanvasRenderingContext2D, targetH: number, key: CursorSvgKey): void {
  const entry = loadCursorSvg(key);
  if (!entry.ready) {
    // Not decoded yet — fall back to the dot so we never render nothing.
    drawDot(ctx, targetH);
    return;
  }
  const meta = SVG_VIEWBOX[key];
  // Width follows the SVG's natural aspect; height matches the unified
  // targetH so bone/hand are the same on-screen height as the user's
  // selected style.
  const aspect = meta.width / meta.height;
  const targetW = targetH * aspect;
  // Translate so the hotspot lands at the current canvas origin.
  const ox = -meta.hotspotX * targetW;
  const oy = -meta.hotspotY * targetH;
  ctx.drawImage(entry.img, ox, oy, targetW, targetH);
}

function drawDot(ctx: CanvasRenderingContext2D, targetH: number): void {
  // Diameter == targetH so the dot has the same on-screen height as every
  // other cursor shape.
  const radius = targetH / 2;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

function drawArrow(ctx: CanvasRenderingContext2D, targetH: number, filled: boolean): void {
  // Path extends 21k vertically from the tip, so k = targetH / 21 makes the
  // visible content height exactly targetH.
  const k = targetH / 21;
  ctx.translate(-1 * k, -1.5 * k);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 19 * k);
  ctx.lineTo(5 * k, 15 * k);
  ctx.lineTo(8 * k, 21 * k);
  ctx.lineTo(11 * k, 20 * k);
  ctx.lineTo(8 * k, 14 * k);
  ctx.lineTo(15 * k, 14 * k);
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, k * 0.6);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.stroke();
  } else {
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.4, k * 0.9);
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
}

function drawFigmaArrow(ctx: CanvasRenderingContext2D, targetH: number): void {
  // Path extends 16k vertically from the tip, so k = targetH / 16 makes the
  // visible content height exactly targetH.
  const k = targetH / 16;
  ctx.translate(-1 * k, -1 * k);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(16 * k, 8 * k);
  ctx.lineTo(9 * k, 10 * k);
  ctx.lineTo(6 * k, 16 * k);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, k * 0.45);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.stroke();
}

const CAMERA_PADDING_RATIO = 0.025;

function cameraSlot(
  position: CameraPosition,
  cw: number,
  ch: number,
  w: number,
  h: number,
  pad: number,
): { x: number; y: number } {
  const left = pad;
  const right = cw - w - pad;
  const cx = (cw - w) / 2;
  const top = pad;
  const bottom = ch - h - pad;
  const cy = (ch - h) / 2;
  switch (position) {
    case 'top-left':      return { x: left,  y: top };
    case 'top-center':    return { x: cx,    y: top };
    case 'top-right':     return { x: right, y: top };
    case 'middle-left':   return { x: left,  y: cy };
    case 'middle-right':  return { x: right, y: cy };
    case 'bottom-left':   return { x: left,  y: bottom };
    case 'bottom-center': return { x: cx,    y: bottom };
    case 'bottom-right':
    default:              return { x: right, y: bottom };
  }
}

function drawCameraOverlay(
  ctx: CanvasRenderingContext2D,
  cameraSource: HTMLVideoElement | VideoFrame | HTMLCanvasElement | null,
  cameraOptions: CameraOptions | null,
  cw: number,
  ch: number,
  zoomP: number,
): void {
  if (!cameraOptions || cameraOptions.hide) return;

  const baseSize = Number(cameraOptions.size) || 20;
  const zoomSize = Number(cameraOptions.sizeDuringZoom) || baseSize;
  const blend = cameraOptions.zoomDifferent ? Math.max(0, Math.min(1, zoomP)) : 0;
  const sizePct = baseSize + (zoomSize - baseSize) * blend;

  const w = Math.max(20, (sizePct / 100) * cw);
  const h = w / cameraShapeAspect(cameraOptions.shape);
  const pad = Math.max(8, cw * CAMERA_PADDING_RATIO);
  const { x, y } = cameraSlot(cameraOptions.position, cw, ch, w, h, pad);

  const rRaw = Number(cameraOptions.roundness);
  const roundness = Math.max(0, Math.min(100, Number.isFinite(rRaw) ? rRaw : 100));
  const radius = (roundness / 100) * (Math.min(w, h) / 2);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = '#0b0d12';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.clip();

  const camDims = videoSourceDims(cameraSource);

  if (camDims && cameraSource) {
    const sw = camDims.w;
    const sh = camDims.h;
    const scale = Math.max(w / sw, h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh) / 2;

    if (cameraOptions.mirror) {
      const mid = x + w / 2;
      ctx.translate(mid, 0);
      ctx.scale(-1, 1);
      ctx.translate(-mid, 0);
    }
    ctx.drawImage(cameraSource, dx, dy, dw, dh);
  } else {
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, '#2a3142');
    grad.addColorStop(1, '#11141b');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `${Math.round(Math.min(w, h) * 0.16)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Camera', x + w / 2, y + h / 2);
  }
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, Math.max(0, radius - 0.5));
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

/* ── Mobile overlay (premium iPhone-style frame) ─────────────────────── */

const MOBILE_PADDING_RATIO = 0.025;

function mobileSlot(
  position: MobilePosition,
  cw: number,
  ch: number,
  w: number,
  h: number,
  pad: number,
): { x: number; y: number } {
  const left = pad;
  const right = cw - w - pad;
  const cx = (cw - w) / 2;
  const top = pad;
  const bottom = ch - h - pad;
  const cy = (ch - h) / 2;
  switch (position) {
    case 'top-left':      return { x: left,  y: top };
    case 'top-center':    return { x: cx,    y: top };
    case 'top-right':     return { x: right, y: top };
    case 'middle-left':   return { x: left,  y: cy };
    case 'middle-center': return { x: cx,    y: cy };
    case 'middle-right':  return { x: right, y: cy };
    case 'bottom-left':   return { x: left,  y: bottom };
    case 'bottom-center': return { x: cx,    y: bottom };
    case 'bottom-right':
    default:              return { x: right, y: bottom };
  }
}

/**
 * Pure phone-frame drawing primitive — takes explicit geometry so callers
 * decide where and how big. Both the (PiP) overlay and the (centered)
 * primary mode use this; they only differ in geometry.
 */
/**
 * Read the source's dimensions in a way that works for both
 * HTMLVideoElement (live editor) and VideoFrame (export pipeline).
 *
 * For HTMLVideoElement we deliberately do NOT gate on `readyState >= 2`:
 * during a seek (which fires whenever the editor's sync effect snaps the
 * mobile track to the main video's time) readyState briefly drops to 1.
 * If we returned null there, the editor would flash the placeholder
 * every time the user paused. Once `videoWidth > 0` (i.e. metadata
 * loaded) the dimensions are stable, and `drawImage` on a seeking
 * video draws the last decoded frame — better than a blank placeholder.
 */
function videoSourceDims(
  src: HTMLVideoElement | VideoFrame | HTMLCanvasElement | null,
): { w: number; h: number } | null {
  if (!src) return null;
  if (src instanceof HTMLCanvasElement) {
    return src.width > 0 && src.height > 0 ? { w: src.width, h: src.height } : null;
  }
  if (src instanceof HTMLVideoElement) {
    if (src.videoWidth <= 0 || src.videoHeight <= 0) return null;
    return { w: src.videoWidth, h: src.videoHeight };
  }
  if (src.displayWidth > 0 && src.displayHeight > 0) {
    return { w: src.displayWidth, h: src.displayHeight };
  }
  return null;
}

// ── Cached static phone-chrome layer ───────────────────────────────────
//
// The drop shadow uses a blur radius of w * 0.32 (~250 px at export
// resolutions). Canvas2D shadow blur is CPU-bound in Chromium — redrawing
// the same chrome 60×/sec is what was making mobile-primary exports take
// 20 minutes for 30 seconds of video. We render the shadow + body + rim
// + side buttons ONCE per unique geometry into an offscreen canvas, then
// `drawImage` that bitmap each frame. The per-frame cost drops from
// hundreds of ms to sub-millisecond.

interface PhoneChromeBack {
  /** Offscreen canvas containing shadow + body + rim + side buttons. */
  canvas: HTMLCanvasElement;
  /** Pixels of padding around the phone-body rect inside the cache canvas. */
  pad: number;
}

const phoneChromeCache = new Map<string, PhoneChromeBack>();
const PHONE_CHROME_CACHE_MAX = 4;

function getPhoneChromeBack(
  w: number,
  h: number,
  finish: MobileOptions['finish'],
  spec: MobileDeviceSpec,
): PhoneChromeBack {
  const key = `${Math.round(w)}|${Math.round(h)}|${finish}|${spec.id}`;
  const cached = phoneChromeCache.get(key);
  if (cached) return cached;
  if (typeof document === 'undefined') {
    // Should never happen in renderer/exporter, but defensive.
    throw new Error('phone-chrome cache requires document');
  }
  const pad = Math.ceil(w * 0.5);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w) + pad * 2;
  canvas.height = Math.ceil(h) + pad * 2;
  const cctx = canvas.getContext('2d');
  if (!cctx) throw new Error('phone-chrome offscreen 2d context unavailable');
  const bx = pad;
  const by = pad;
  const bodyRadius = w * spec.radiusRatio;

  // Drop shadow.
  cctx.save();
  cctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  cctx.shadowBlur = w * 0.32;
  cctx.shadowOffsetY = w * 0.10;
  cctx.fillStyle = '#000';
  cctx.beginPath();
  cctx.roundRect(bx, by, w, h, bodyRadius);
  cctx.fill();
  cctx.restore();

  // Side buttons + body fill + rim.
  drawSideButtons(cctx, bx, by, w, h, finish, spec.buttons);
  drawDeviceBody(cctx, bx, by, w, h, bodyRadius, finish);

  // LRU-ish eviction: drop the oldest entry when at capacity.
  if (phoneChromeCache.size >= PHONE_CHROME_CACHE_MAX) {
    const firstKey = phoneChromeCache.keys().next().value;
    if (firstKey !== undefined) phoneChromeCache.delete(firstKey);
  }
  const entry: PhoneChromeBack = { canvas, pad };
  phoneChromeCache.set(key, entry);
  return entry;
}

function drawPhoneFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  mobileSource: HTMLVideoElement | VideoFrame | null,
  finish: MobileOptions['finish'],
  spec: MobileDeviceSpec,
  tilt: number,
): void {
  const bodyRadius = w * spec.radiusRatio;
  const bezelThickness = w * spec.bezelRatio;
  const tilted = tilt !== 0;

  ctx.save();
  if (tilted) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.translate(cx, cy);
    ctx.rotate((tilt * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  // 1-5. Drop shadow + side buttons + body + rim. All static — pulled
  // from a per-geometry offscreen cache. The huge perf saving here is on
  // the shadow blur, which would otherwise run on every export frame.
  // (Tilt is uncommon and skips cache — rotating the cached bitmap is
  // possible but not worth it until users actually use the tilt slider.)
  if (tilted) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = w * 0.32;
    ctx.shadowOffsetY = w * 0.10;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, bodyRadius);
    ctx.fill();
    ctx.restore();
    drawSideButtons(ctx, x, y, w, h, finish, spec.buttons);
    drawDeviceBody(ctx, x, y, w, h, bodyRadius, finish);
  } else {
    const back = getPhoneChromeBack(w, h, finish, spec);
    ctx.drawImage(back.canvas, x - back.pad, y - back.pad);
  }

  // 6. Screen content — clipped to rounded screen rect. Cover-fit the source
  // video; otherwise paint a dark placeholder.
  drawScreen(ctx, x, y, w, h, bodyRadius, bezelThickness,
    (screenX, screenY, screenW, screenH) => {
      const dims = videoSourceDims(mobileSource);
      if (dims && mobileSource) {
        const cover = Math.max(screenW / dims.w, screenH / dims.h);
        const dw = dims.w * cover;
        const dh = dims.h * cover;
        const dx = screenX + (screenW - dw) / 2;
        const dy = screenY + (screenH - dh) / 2;
        ctx.drawImage(mobileSource, dx, dy, dw, dh);
      } else {
        const grad = ctx.createLinearGradient(screenX, screenY, screenX, screenY + screenH);
        grad.addColorStop(0, '#1a2030');
        grad.addColorStop(1, '#080a10');
        ctx.fillStyle = grad;
        ctx.fillRect(screenX, screenY, screenW, screenH);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.font = `${Math.round(w * 0.06)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Phone', screenX + screenW / 2, screenY + screenH / 2);
      }
    });

  // 7. Screen highlight (subtle gloss).
  const screenX = x + bezelThickness;
  const screenY = y + bezelThickness;
  const screenW = w - bezelThickness * 2;
  const screenH = h - bezelThickness * 2;
  drawScreenHighlight(ctx, screenX, screenY, screenW, screenH, bodyRadius, bezelThickness);

  // 8. Camera cutout — island / notch / punch-hole, per device. Sits on top
  // of the screen content.
  if (spec.cutout === 'island') {
    drawDynamicIsland(ctx, x, y, w, bezelThickness);
  } else if (spec.cutout === 'notch') {
    drawNotch(ctx, x, y, w, bezelThickness);
  } else {
    drawPunchHole(ctx, x, y, w, bezelThickness);
  }

  // 9. Top specular highlight.
  drawTopSpecular(ctx, x, y, w, h, bodyRadius);

  ctx.restore();
}

function drawMobileOverlay(
  ctx: CanvasRenderingContext2D,
  mobileSource: HTMLVideoElement | VideoFrame | null,
  mobileOptions: MobileOptions | null,
  cw: number,
  ch: number,
  zoomP: number,
): void {
  if (!mobileOptions || mobileOptions.hide) return;

  const spec = getMobileDevice(mobileOptions.device);
  const baseSize = Number(mobileOptions.size) || 18;
  const zoomSize = Number(mobileOptions.sizeDuringZoom) || baseSize;
  const blend = mobileOptions.zoomDifferent ? Math.max(0, Math.min(1, zoomP)) : 0;
  const sizePct = baseSize + (zoomSize - baseSize) * blend;

  // Phone width is the user-facing size; height follows the device's aspect.
  const W = Math.max(40, (sizePct / 100) * cw);
  const H = W * spec.aspect;
  // If the height would exceed the canvas, scale both down proportionally.
  const scale = H > ch * 0.95 ? (ch * 0.95) / H : 1;
  const w = W * scale;
  const h = H * scale;
  const pad = Math.max(8, cw * MOBILE_PADDING_RATIO);
  const { x, y } = mobileSlot(mobileOptions.position, cw, ch, w, h, pad);

  const tilt = Math.max(-10, Math.min(10, Number(mobileOptions.tilt) || 0));
  drawPhoneFrame(ctx, x, y, w, h, mobileSource, mobileOptions.finish, spec, tilt);
}

/**
 * The "phone is the recording subject" layout: the phone frame drawn over the
 * background. `size` sets the phone height (% of canvas height, device aspect),
 * `position` anchors it (default `middle-center`). An active zoom segment
 * scales the whole phone in toward the zoom's focus point, mapped onto the
 * phone's screen — so zoom behaves like a camera push into the screen content.
 */
function drawMobilePrimary(
  ctx: CanvasRenderingContext2D,
  mobileSource: HTMLVideoElement | VideoFrame | null,
  mobileOptions: MobileOptions | null,
  cw: number,
  ch: number,
  zoom: ZoomSample,
  displayW?: number,
  displayH?: number,
): void {
  // Size is the phone's HEIGHT as % of canvas height. Phones are tall (≈19.5–20:9),
  // so height is its binding dimension in BOTH landscape and portrait canvases —
  // driving off height keeps the control meaningful everywhere (a width-based
  // size silently caps to a constant strip on wide canvases).
  const spec = getMobileDevice(mobileOptions?.device);
  const sizePct = Math.max(20, Math.min(100, Number(mobileOptions?.size) || 85));
  let h = (sizePct / 100) * ch;
  let w = h / spec.aspect;
  // Safety for ultra-narrow canvases where the phone would exceed the width.
  if (w > cw * 0.98) {
    w = cw * 0.98;
    h = w * spec.aspect;
  }
  const pad = Math.max(8, cw * MOBILE_PADDING_RATIO);
  const { x, y } = mobileSlot(mobileOptions?.position ?? 'middle-center', cw, ch, w, h, pad);

  const finish: MobileOptions['finish'] = mobileOptions?.finish ?? 'graphite';
  const tilt = Math.max(-10, Math.min(10, Number(mobileOptions?.tilt) || 0));

  const zScale = zoom?.scale ?? 1;
  if (zScale <= 1.001) {
    drawPhoneFrame(ctx, x, y, w, h, mobileSource, finish, spec, tilt);
    return;
  }

  // Zoom: scale the whole phone around a focus point so the focal pixel stays
  // put and the screen content magnifies. The zoom centre (cx,cy) lives in the
  // recording's display space (default = its centre), so normalise by the
  // display dims and map that fraction onto the phone's visible screen rect —
  // a centred zoom lands on the middle of the screen, as expected.
  const bezel = w * spec.bezelRatio;
  const screenX = x + bezel;
  const screenY = y + bezel;
  const screenW = w - bezel * 2;
  const screenH = h - bezel * 2;
  let fxN = 0.5;
  let fyN = 0.5;
  if (zoom.cx != null && zoom.cy != null && displayW && displayH) {
    fxN = Math.max(0, Math.min(1, zoom.cx / displayW));
    fyN = Math.max(0, Math.min(1, zoom.cy / displayH));
  }
  const fx = screenX + fxN * screenW;
  const fy = screenY + fyN * screenH;

  ctx.save();
  ctx.translate(fx, fy);
  ctx.scale(zScale, zScale);
  ctx.translate(-fx, -fy);
  drawPhoneFrame(ctx, x, y, w, h, mobileSource, finish, spec, tilt);
  ctx.restore();
}
