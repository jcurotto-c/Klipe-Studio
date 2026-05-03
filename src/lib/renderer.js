/**
 * Frame renderer: draws a video frame onto a canvas applying zoom transform,
 * a soft gradient background, an enhanced cursor, and a click ripple.
 *
 * Optional crop: a {x, y, width, height} rect normalized to source pixels
 * (0..1). When provided, only that source slice is drawn and zoom/cursor
 * coordinates are mapped into the cropped frame.
 */

import { sampleZoom } from './zoom-engine.js';
import { computeInsetRect, PREVIEW_PADDING_SCALE } from './layout.js';

const RIPPLE_DURATION = 600; // ms
const CURSOR_RADIUS = 12;
const CORNER_RADIUS_RATIO = 0.025; // of min(drawW, drawH)

function getNearestCursor(mouse, t) {
  if (!mouse || !mouse.events.length) return null;
  const evs = mouse.events;
  let lo = 0, hi = evs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (evs[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return evs[lo];
}

function activeRipples(mouse, t) {
  if (!mouse) return [];
  const out = [];
  for (const e of mouse.events) {
    if (e.type !== 'click') continue;
    const dt = t - e.t;
    if (dt >= 0 && dt < RIPPLE_DURATION) {
      out.push({ x: e.x, y: e.y, p: dt / RIPPLE_DURATION });
    }
  }
  return out;
}

export const WALLPAPER_PRESETS = {
  default: { from: '#1a1f2b', to: '#0b0d12' },
  sunset:  { from: '#ff7e5f', to: '#feb47b' },
  ocean:   { from: '#2b5876', to: '#4e4376' },
  mint:    { from: '#0f9b0f', to: '#000000' },
  violet:  { from: '#7c5cff', to: '#5cc4ff' },
  ember:   { from: '#ff5c7a', to: '#ffb454' }
};

// Image cache so we don't re-decode the source on every frame.
const imageCache = new Map();
function getCachedImage(src) {
  if (!src) return null;
  let entry = imageCache.get(src);
  if (entry) return entry;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  entry = { img, ready: false };
  img.onload = () => { entry.ready = true; };
  img.onerror = () => { entry.ready = false; };
  img.src = src;
  imageCache.set(src, entry);
  return entry;
}

function normalizeBackground(bg) {
  if (!bg) return { type: 'wallpaper', value: 'default', blur: 0 };
  if (typeof bg === 'string') return { type: 'wallpaper', value: bg, blur: 0 };
  return { blur: 0, ...bg };
}

function fillLinearGradient(ctx, w, h, from, to, angleDeg = 135) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  const cx = w / 2, cy = h / 2;
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

function drawCoverImage(ctx, w, h, img) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale, dh = ih * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawBackground(ctx, w, h, bg) {
  const { type, blur = 0 } = bg;
  const blurPx = Math.max(0, Number(blur) || 0);

  if (blurPx > 0) {
    ctx.save();
    ctx.filter = `blur(${blurPx}px)`;
  }

  if (type === 'color') {
    ctx.fillStyle = bg.value || '#0b0d12';
    ctx.fillRect(0, 0, w, h);
  } else if (type === 'gradient') {
    const from = bg.from || '#1a1f2b';
    const to = bg.to || '#0b0d12';
    const angle = bg.angle == null ? 135 : bg.angle;
    fillLinearGradient(ctx, w, h, from, to, angle);
  } else if (type === 'image') {
    // Solid fallback while the image decodes; never leave the canvas blank.
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);
    const entry = getCachedImage(bg.src);
    if (entry && entry.ready) drawCoverImage(ctx, w, h, entry.img);
  } else {
    const preset = WALLPAPER_PRESETS[bg.value] || WALLPAPER_PRESETS.default;
    fillLinearGradient(ctx, w, h, preset.from, preset.to, 135);
  }

  if (blurPx > 0) ctx.restore();
}

export function renderFrame(ctx, source, opts) {
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
    cameraOptions = null
  } = opts;

  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;

  // High-quality bicubic so zoom upscales pull from the source's native pixels
  // instead of a low-quality bilinear default.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  drawBackground(ctx, cw, ch, normalizeBackground(background));

  const sw = source.videoWidth || source.displayWidth || displayWidth;
  const sh = source.videoHeight || source.displayHeight || displayHeight;
  if (!sw || !sh) return;

  // Effective slice of the source we draw — full frame, or the crop rect.
  const sx0 = crop ? crop.x * sw : 0;
  const sy0 = crop ? crop.y * sh : 0;
  const swEff = crop ? crop.width * sw : sw;
  const shEff = crop ? crop.height * sh : sh;

  const { baseX, baseY, baseW, baseH } = computeInsetRect(cw, ch, swEff, shEff, paddingScale);

  const { scale, cx, cy, p: zoomP } = sampleZoom(segments, tMs);

  // Map zoom focus into cropped-source coords; ignore if outside the crop.
  const fcx = cx == null ? null : cx - sx0;
  const fcy = cy == null ? null : cy - sy0;
  const focusInCrop = fcx != null && fcy != null
    && fcx >= 0 && fcx <= swEff && fcy >= 0 && fcy <= shEff;

  let drawW = baseW * scale;
  let drawH = baseH * scale;
  let drawX, drawY;
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

  if (!showCursor || !mouse) {
    drawCameraOverlay(ctx, cameraSource, cameraOptions, cw, ch, zoomP || 0);
    return;
  }

  const cursor = getNearestCursor(mouse, tMs);
  if (cursor) {
    const lx = cursor.x - sx0;
    const ly = cursor.y - sy0;
    if (lx >= 0 && lx <= swEff && ly >= 0 && ly <= shEff) {
      const px = drawX + (lx / swEff) * drawW;
      const py = drawY + (ly / shEff) * drawH;
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, CURSOR_RADIUS * 1.6, 0, Math.PI * 2);
      const halo = ctx.createRadialGradient(px, py, 0, px, py, CURSOR_RADIUS * 1.6);
      halo.addColorStop(0, 'rgba(255,255,255,0.55)');
      halo.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = halo;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, CURSOR_RADIUS * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 6;
      ctx.fill();
      ctx.restore();
    }
  }

  const ripples = activeRipples(mouse, tMs);
  for (const r of ripples) {
    const lx = r.x - sx0;
    const ly = r.y - sy0;
    if (lx < 0 || lx > swEff || ly < 0 || ly > shEff) continue;
    const px = drawX + (lx / swEff) * drawW;
    const py = drawY + (ly / shEff) * drawH;
    const radius = 8 + r.p * 60;
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(124, 92, 255, ${1 - r.p})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  drawCameraOverlay(ctx, cameraSource, cameraOptions, cw, ch, zoomP || 0);
}

const CAMERA_PADDING_RATIO = 0.025;

function cameraSlot(position, cw, ch, dim, pad) {
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

function drawCameraOverlay(ctx, cameraSource, cameraOptions, cw, ch, zoomP) {
  if (!cameraOptions || cameraOptions.hide) return;

  // Smooth-blend size with the zoom progress; sampleZoom's smoothstep `p`
  // gives us free easing — when p=0 we use base size, p=1 we use zoom size.
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

  const ready = cameraSource
    && cameraSource.readyState >= 2
    && cameraSource.videoWidth > 0
    && cameraSource.videoHeight > 0;

  if (ready) {
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
