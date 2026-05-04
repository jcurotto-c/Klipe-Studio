/**
 * Frame renderer: draws a video frame onto a canvas applying zoom transform,
 * a soft gradient background, an enhanced cursor, and a click ripple.
 */

import { sampleZoom } from './zoom-engine';
import { computeInsetRect, PREVIEW_PADDING_SCALE } from './layout';
import { sampleCursor, DEFAULT_CURSOR_OPTIONS } from './cursor-engine';
import type {
  Background,
  CameraOptions,
  CameraPosition,
  Crop,
  CursorOptions,
  CursorSample,
  CursorState,
  MouseTrack,
  ZoomSegment,
} from '../types';

const RIPPLE_DURATION = 600;
const CURSOR_BASE_RADIUS = 10;
const CURSOR_REFERENCE_WIDTH = 1920;
const CORNER_RADIUS_RATIO = 0.025;

interface Ripple {
  x: number;
  y: number;
  p: number;
}

function activeRipples(mouse: MouseTrack | null | undefined, t: number): Ripple[] {
  if (!mouse) return [];
  const out: Ripple[] = [];
  for (const e of mouse.events) {
    if (e.type !== 'click') continue;
    const dt = t - e.t;
    if (dt >= 0 && dt < RIPPLE_DURATION) {
      out.push({ x: e.x, y: e.y, p: dt / RIPPLE_DURATION });
    }
  }
  return out;
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
  cursorState?: CursorState | null;
  cursorOptions?: Partial<CursorOptions> | null;
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
    paddingScale = PREVIEW_PADDING_SCALE,
    showCursor = true,
    crop = null,
    cameraSource = null,
    cameraOptions = null,
    cursorState = null,
    cursorOptions = null,
  } = opts;
  const cOpts: CursorOptions = { ...DEFAULT_CURSOR_OPTIONS, ...(cursorOptions ?? {}) };

  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  drawBackground(ctx, cw, ch, normalizeBackground(background));

  const sw = source.videoWidth || source.displayWidth || displayWidth;
  const sh = source.videoHeight || source.displayHeight || displayHeight;
  if (!sw || !sh) return;

  const sx0 = crop ? crop.x * sw : 0;
  const sy0 = crop ? crop.y * sh : 0;
  const swEff = crop ? crop.width * sw : sw;
  const shEff = crop ? crop.height * sh : sh;

  const { baseX, baseY, baseW, baseH } = computeInsetRect(cw, ch, swEff, shEff, paddingScale);

  const { scale, cx, cy, p: zoomP } = sampleZoom(segments, tMs);

  const fcx = cx == null ? null : cx - sx0;
  const fcy = cy == null ? null : cy - sy0;
  const focusInCrop = fcx != null && fcy != null
    && fcx >= 0 && fcx <= swEff && fcy >= 0 && fcy <= shEff;

  const drawW = baseW * scale;
  const drawH = baseH * scale;
  let drawX: number;
  let drawY: number;
  if (!focusInCrop || scale === 1) {
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

  const radius = Math.min(drawW, drawH) * CORNER_RADIUS_RATIO;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.roundRect(drawX, drawY, drawW, drawH, radius);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(drawX, drawY, drawW, drawH, radius);
  ctx.clip();
  ctx.drawImage(source, sx0, sy0, swEff, shEff, drawX, drawY, drawW, drawH);
  ctx.restore();

  if (!showCursor || !cOpts.show || !mouse) {
    drawCameraOverlay(ctx, cameraSource, cameraOptions, cw, ch, zoomP || 0);
    return;
  }

  const cursor: CursorSample = cursorState
    ? sampleCursor(cursorState, mouse, tMs, cOpts)
    : staticCursorSample(mouse, tMs, cOpts);

  if (cursor.visible) {
    const lx = cursor.x - sx0;
    const ly = cursor.y - sy0;
    if (lx >= 0 && lx <= swEff && ly >= 0 && ly <= shEff) {
      const px = drawX + (lx / swEff) * drawW;
      const py = drawY + (ly / shEff) * drawH;

      const refDim = Math.max(cw, ch);
      const baseR = CURSOR_BASE_RADIUS * (refDim / CURSOR_REFERENCE_WIDTH);
      const r = baseR * cOpts.size * (cursor.scaleMul || 1);

      const ripples = activeRipples(mouse, tMs);
      for (const rp of ripples) {
        const rlx = rp.x - sx0;
        const rly = rp.y - sy0;
        if (rlx < 0 || rlx > swEff || rly < 0 || rly > shEff) continue;
        const rpx = drawX + (rlx / swEff) * drawW;
        const rpy = drawY + (rly / shEff) * drawH;
        const rippleR = r * 0.8 + rp.p * r * 4.5;
        ctx.save();
        ctx.beginPath();
        ctx.arc(rpx, rpy, rippleR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(124, 92, 255, ${1 - rp.p})`;
        ctx.lineWidth = Math.max(1.5, r * 0.18);
        ctx.stroke();
        ctx.restore();
      }

      drawCursor(ctx, px, py, r, cursor.rotation || 0, {
        style: cOpts.style,
        motionAngle: cursor.motionAngle,
        motionStrength: cursor.motionStrength,
      });
    }
  }

  drawCameraOverlay(ctx, cameraSource, cameraOptions, cw, ch, zoomP || 0);
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
  const s = evs[lo]!;

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
  style: CursorStyleish;
  motionAngle?: number;
  motionStrength?: number;
}

type CursorStyleish = CursorOptions['style'];

function drawCursor(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  r: number,
  rotation: number,
  opts: DrawCursorOptions,
): void {
  const { style, motionAngle = 0, motionStrength = 0 } = opts;

  const drawSprite = (alpha = 1): void => {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rotation);
    ctx.globalAlpha *= alpha;
    drawCursorShape(ctx, r, style);
    ctx.restore();
  };

  if (motionStrength > 0.05) {
    const ghosts = 4;
    const smear = r * 1.6 * Math.min(1.5, motionStrength);
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
  r: number,
  style: CursorStyleish,
): void {
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = Math.max(2, r * 0.5);
  ctx.shadowOffsetY = Math.max(1, r * 0.15);

  switch (style) {
    case 'arrow':         drawArrow(ctx, r, true); return;
    case 'arrow-outline': drawArrow(ctx, r, false); return;
    case 'arrow-mini':    drawArrow(ctx, r * 0.85, true); return;
    case 'figma':         drawFigmaArrow(ctx, r); return;
    case 'dot':
    default:              drawDot(ctx, r); return;
  }
}

function drawDot(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

function drawArrow(ctx: CanvasRenderingContext2D, r: number, filled: boolean): void {
  const k = r / 6;
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

function drawFigmaArrow(ctx: CanvasRenderingContext2D, r: number): void {
  const k = r / 5;
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
