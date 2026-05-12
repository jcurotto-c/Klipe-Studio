/**
 * Frame renderer: draws a video frame onto a canvas applying zoom transform,
 * a soft gradient background, an enhanced cursor, and a click ripple.
 */

import { sampleZoom } from './zoom-engine';
import { computeInsetRect } from './layout';
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
  FrameOptions,
  MobileOptions,
  MouseTrack,
  ZoomSegment,
} from '../types';
import boneSvgUrl from '../assets/cartoon-bone.svg';
import handSvgUrl from '../assets/pointinghand.svg';
import type { CursorShape } from './cursor-sprites';
import {
  MOBILE_ASPECT,
  drawDynamicIsland,
  drawIPhoneBody,
  drawNotch,
  drawScreen,
  drawScreenHighlight,
  drawSideButtons,
  drawTopSpecular,
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

const CURSOR_BASE_RADIUS = 10;
const CURSOR_REFERENCE_WIDTH = 1920;
const CORNER_RADIUS_RATIO = 0.025;

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

interface ImageCacheEntry {
  img: HTMLImageElement;
  ready: boolean;
}

const imageCache = new Map<string, ImageCacheEntry>();
function getCachedImage(src: string | null | undefined): ImageCacheEntry | null {
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
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bg: Background,
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
  } else {
    const preset = WALLPAPER_PRESETS[bg.value] ?? WALLPAPER_PRESETS['default']!;
    fillLinearGradient(ctx, w, h, preset.from, preset.to, 135);
  }

  if (blurPx > 0) ctx.restore();
}

export interface RenderFrameOptions {
  tMs: number;
  segments?: ZoomSegment[];
  mouse?: MouseTrack | null;
  displayWidth?: number;
  displayHeight?: number;
  background?: BackgroundLike;
  paddingScale?: number;
  showCursor?: boolean;
  crop?: Crop | null;
  cameraSource?: HTMLVideoElement | null;
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
const cursorSvgCache = new Map<'bone' | 'hand', CursorSvgImage>();

function loadCursorSvg(key: 'bone' | 'hand'): CursorSvgImage {
  const existing = cursorSvgCache.get(key);
  if (existing) return existing;
  const img = new Image();
  const entry: CursorSvgImage = { img, ready: false };
  img.onload = () => { entry.ready = true; };
  img.onerror = () => { entry.ready = false; };
  img.src = key === 'bone' ? boneSvgUrl : handSvgUrl;
  cursorSvgCache.set(key, entry);
  return entry;
}
// Eager preload — typical case is the user opens the editor, then plays
// the recording; both SVGs decode well before any text/pointer event fires.
loadCursorSvg('bone');
loadCursorSvg('hand');

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
 *   - `text`    → `svg-bone` (typing in a field)
 *   - `pointer` → `svg-hand` (hovering a clickable)
 *   - otherwise → user-selected style as-is
 */
function resolveCursorShape(style: CursorOptions['style'], type: CursorType): CursorShape {
  if (type === 'text') return 'svg-bone';
  if (type === 'pointer') return 'svg-hand';
  return style;
}

/**
 * Per-style visual scale. Arrow/outline/dot/figma render at the full
 * baseline height; arrow-mini intentionally shrinks. The bone/hand SVG
 * overrides inherit whichever scale the user-selected style uses, so the
 * cursor does not change size when typing or hovering buttons.
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
    paddingScale,
    showCursor = true,
    crop = null,
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

  if (!fOpts.removeBackground) {
    drawBackground(ctx, cw, ch, normalizeBackground(background));
  } else {
    ctx.clearRect(0, 0, cw, ch);
  }

  // Phone-primary mode: the phone is the recording's main subject. Render
  // the phone frame centered, large, on the background; skip the screen
  // source, cursor, camera, zoom, and blur entirely (none of those apply
  // when there's no screen behind the phone).
  if (mobilePrimary) {
    drawMobilePrimary(ctx, mobileSource, mobileOptions, cw, ch);
    return;
  }

  const sw = source.videoWidth || source.displayWidth || displayWidth;
  const sh = source.videoHeight || source.displayHeight || displayHeight;
  if (!sw || !sh) return;

  const sx0 = crop ? crop.x * sw : 0;
  const sy0 = crop ? crop.y * sh : 0;
  const swEff = crop ? crop.width * sw : sw;
  const shEff = crop ? crop.height * sh : sh;

  // When the canvas aspect doesn't match the source aspect, the user has
  // explicitly asked for an output shape different from what was recorded
  // (e.g. a 16:9 PC capture rendered into a 9:16 reels frame). Letterboxing
  // would shrink the source into a tiny strip; instead, switch to cover-fit
  // so the source fills the frame and the long axis is center-cropped.
  //
  // We compare against the RAW source aspect (sw/sh), not the cropped aspect
  // (swEff/shEff). Cropping is a "zoom into a sub-region" operation, not an
  // output-shape change — so a 4:3 crop of a 16:9 recording into a 16:9
  // canvas should still render the cropped region inset within the frame
  // with the background visible, not balloon it to fill the canvas.
  const canvasAspect = cw / ch;
  const sourceAspect = sw / sh;
  const fillFrame = Math.abs(canvasAspect - sourceAspect) > 0.005;

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
    ({ baseX, baseY, baseW, baseH } = computeInsetRect(cw, ch, swEff, shEff, effectivePadding));
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

  const fcx = cx == null ? null : cx - sx0;
  const fcy = cy == null ? null : cy - sy0;
  const focusInCrop = fcx != null && fcy != null
    && fcx >= 0 && fcx <= swEff && fcy >= 0 && fcy <= shEff;

  const drawW = baseW * scale;
  const drawH = baseH * scale;
  let drawX: number;
  let drawY: number;
  if (!focusInCrop) {
    drawX = (cw - drawW) / 2;
    drawY = (ch - drawH) / 2;
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
    drawX = (cw - drawW) / 2;
    drawY = (ch - drawH) / 2;
  } else {
    const focusBaseX = baseX + (fcx / swEff) * baseW;
    const focusBaseY = baseY + (fcy / shEff) * baseH;
    drawX = focusBaseX - (fcx / swEff) * drawW;
    drawY = focusBaseY - (fcy / shEff) * drawH;
    drawX = Math.min(baseX, Math.max(baseX + baseW - drawW, drawX));
    drawY = Math.min(baseY, Math.max(baseY + baseH - drawH, drawY));
  }

  const radiusScale = (fOpts.radius / 24);
  // Fill-frame mode bleeds the source past the canvas edges, so rounded
  // corners and shadow would render outside the visible area. Skip the
  // chrome and let the canvas itself provide the edge.
  const radius = fillFrame ? 0 : Math.min(drawW, drawH) * CORNER_RADIUS_RATIO * radiusScale;

  if (fOpts.shadow > 0 && !fillFrame) {
    const shadowAlpha = Math.min(0.85, 0.18 + (fOpts.shadow / 100) * 0.7);
    const shadowBlur = 8 + (fOpts.shadow / 100) * 70;
    const shadowOffset = 4 + (fOpts.shadow / 100) * 28;
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${shadowAlpha})`;
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetY = shadowOffset;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.roundRect(drawX, drawY, drawW, drawH, radius);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  if (radius > 0) {
    ctx.beginPath();
    ctx.roundRect(drawX, drawY, drawW, drawH, radius);
    ctx.clip();
  }
  ctx.drawImage(source, sx0, sy0, swEff, shEff, drawX, drawY, drawW, drawH);
  ctx.restore();

  if (blurRegions && blurRegions.length > 0) {
    applyBlurRegions(ctx, source, blurRegions, tMs, {
      sw, sh, sx0, sy0, swEff, shEff, drawX, drawY, drawW, drawH, radius,
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
  /** Rounded-corner radius of the video frame, for clipping the blur. */
  radius: number;
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
    if (radius > 0) {
      ctx.beginPath();
      ctx.roundRect(drawX, drawY, drawW, drawH, radius);
      ctx.clip();
    }
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
    case 'dot':
    default:              drawDot(ctx, targetH); return;
  }
}

// Draws bone (text I-beam) or hand (pointer) SVG centred on the hotspot.
// Falls back silently if the image isn't decoded yet — the next frame will
// pick it up. Caller has already translated the canvas to (px, py), so we
// draw relative to (0, 0) using width/height matching the cursor radius.
const SVG_VIEWBOX: Record<'bone' | 'hand', { width: number; height: number; hotspotX: number; hotspotY: number }> = {
  // hotspot ratios match cursor-sprites.ts so the editor preview and the
  // exported video land on the same anchor pixel.
  bone: { width: 618,        height: 1350, hotspotX: 309 / 618,        hotspotY: 675 / 1350 },
  hand: { width: 767.314286, height: 746,  hotspotX: 322 / 767.314286, hotspotY: 37 / 746 },
};

function drawCursorSvg(ctx: CanvasRenderingContext2D, targetH: number, key: 'bone' | 'hand'): void {
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
  dim: number,
  pad: number,
): { x: number; y: number } {
  const left = pad;
  const right = cw - dim - pad;
  const cx = (cw - dim) / 2;
  const top = pad;
  const bottom = ch - dim - pad;
  const cy = (ch - dim) / 2;
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
  cameraSource: HTMLVideoElement | null,
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

  const dim = Math.max(20, (sizePct / 100) * cw);
  const pad = Math.max(8, cw * CAMERA_PADDING_RATIO);
  const { x, y } = cameraSlot(cameraOptions.position, cw, ch, dim, pad);

  const roundness = Math.max(0, Math.min(100, Number(cameraOptions.roundness) ?? 100));
  const radius = (roundness / 100) * (dim / 2);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = '#0b0d12';
  ctx.beginPath();
  ctx.roundRect(x, y, dim, dim, radius);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, dim, dim, radius);
  ctx.clip();

  const ready = !!cameraSource
    && cameraSource.readyState >= 2
    && cameraSource.videoWidth > 0
    && cameraSource.videoHeight > 0;

  if (ready && cameraSource) {
    const sw = cameraSource.videoWidth;
    const sh = cameraSource.videoHeight;
    const scale = Math.max(dim / sw, dim / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = x + (dim - dw) / 2;
    const dy = y + (dim - dh) / 2;

    if (cameraOptions.mirror) {
      const mid = x + dim / 2;
      ctx.translate(mid, 0);
      ctx.scale(-1, 1);
      ctx.translate(-mid, 0);
    }
    ctx.drawImage(cameraSource, dx, dy, dw, dh);
  } else {
    const grad = ctx.createLinearGradient(x, y, x, y + dim);
    grad.addColorStop(0, '#2a3142');
    grad.addColorStop(1, '#11141b');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, dim, dim);

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `${Math.round(dim * 0.16)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Camera', x + dim / 2, y + dim / 2);
  }
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, dim - 1, dim - 1, Math.max(0, radius - 0.5));
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

/* ── Mobile overlay (premium iPhone-style frame) ─────────────────────── */

const MOBILE_PADDING_RATIO = 0.025;

function mobileSlot(
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
function mobileSourceDims(src: HTMLVideoElement | VideoFrame | null): { w: number; h: number } | null {
  if (!src) return null;
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
): PhoneChromeBack {
  const key = `${Math.round(w)}|${Math.round(h)}|${finish}`;
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
  const bodyRadius = w * 0.16;

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
  drawSideButtons(cctx, bx, by, w, h, finish);
  drawIPhoneBody(cctx, bx, by, w, h, bodyRadius, finish);

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
  showIsland: boolean,
  tilt: number,
): void {
  const bodyRadius = w * 0.16;
  const bezelThickness = w * 0.038;
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
    drawSideButtons(ctx, x, y, w, h, finish);
    drawIPhoneBody(ctx, x, y, w, h, bodyRadius, finish);
  } else {
    const back = getPhoneChromeBack(w, h, finish);
    ctx.drawImage(back.canvas, x - back.pad, y - back.pad);
  }

  // 6. Screen content — clipped to rounded screen rect. Cover-fit the source
  // video; otherwise paint a dark placeholder.
  drawScreen(ctx, x, y, w, h, bodyRadius, bezelThickness,
    (screenX, screenY, screenW, screenH) => {
      const dims = mobileSourceDims(mobileSource);
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

  // 8. Dynamic island OR classic notch — sits on top of screen content.
  if (showIsland) {
    drawDynamicIsland(ctx, x, y, w, bezelThickness);
  } else {
    drawNotch(ctx, x, y, w, bezelThickness);
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

  const baseSize = Number(mobileOptions.size) || 18;
  const zoomSize = Number(mobileOptions.sizeDuringZoom) || baseSize;
  const blend = mobileOptions.zoomDifferent ? Math.max(0, Math.min(1, zoomP)) : 0;
  const sizePct = baseSize + (zoomSize - baseSize) * blend;

  // Phone width is the user-facing size; height is locked to the modern
  // iPhone 19.5:9 aspect.
  const W = Math.max(40, (sizePct / 100) * cw);
  const H = W * MOBILE_ASPECT;
  // If the height would exceed the canvas, scale both down proportionally.
  const scale = H > ch * 0.95 ? (ch * 0.95) / H : 1;
  const w = W * scale;
  const h = H * scale;
  const pad = Math.max(8, cw * MOBILE_PADDING_RATIO);
  const { x, y } = mobileSlot(mobileOptions.position, cw, ch, w, h, pad);

  const tilt = Math.max(-10, Math.min(10, Number(mobileOptions.tilt) || 0));
  drawPhoneFrame(ctx, x, y, w, h, mobileSource, mobileOptions.finish, mobileOptions.showIsland, tilt);
}

/**
 * Centered, large phone for "phone is the recording subject" mode. Ignores
 * the position/size options from `MobileOptions` (position is forced to
 * center, size is computed to fit); finish/showIsland/tilt still apply.
 */
function drawMobilePrimary(
  ctx: CanvasRenderingContext2D,
  mobileSource: HTMLVideoElement | VideoFrame | null,
  mobileOptions: MobileOptions | null,
  cw: number,
  ch: number,
): void {
  // Aim for the phone to fill ~92% of the canvas height. In wide canvases
  // (16:9) the phone naturally takes a thin vertical strip in the center —
  // that's the intended cinematic look. In tall canvases (9:16) the phone
  // fills nearly the whole screen, which is what the user wants.
  let h = ch * 0.92;
  let w = h / MOBILE_ASPECT;
  // Don't let the phone exceed 70% of canvas width; in extreme portrait
  // canvases this caps the phone and adds breathing room either side.
  if (w > cw * 0.7) {
    w = cw * 0.7;
    h = w * MOBILE_ASPECT;
  }
  const x = (cw - w) / 2;
  const y = (ch - h) / 2;

  const finish: MobileOptions['finish'] = mobileOptions?.finish ?? 'graphite';
  const showIsland = mobileOptions?.showIsland ?? true;
  const tilt = Math.max(-10, Math.min(10, Number(mobileOptions?.tilt) || 0));

  drawPhoneFrame(ctx, x, y, w, h, mobileSource, finish, showIsland, tilt);
}
