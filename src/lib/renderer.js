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

function drawBackground(ctx, w, h, palette) {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  if (palette === 'sunset') {
    grad.addColorStop(0, '#ff7e5f');
    grad.addColorStop(1, '#feb47b');
  } else if (palette === 'ocean') {
    grad.addColorStop(0, '#2b5876');
    grad.addColorStop(1, '#4e4376');
  } else if (palette === 'mint') {
    grad.addColorStop(0, '#0f9b0f');
    grad.addColorStop(1, '#000000');
  } else {
    grad.addColorStop(0, '#1a1f2b');
    grad.addColorStop(1, '#0b0d12');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
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
    crop = null
  } = opts;

  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;

  drawBackground(ctx, cw, ch, background);

  const sw = source.videoWidth || source.displayWidth || displayWidth;
  const sh = source.videoHeight || source.displayHeight || displayHeight;
  if (!sw || !sh) return;

  // Effective slice of the source we draw — full frame, or the crop rect.
  const sx0 = crop ? crop.x * sw : 0;
  const sy0 = crop ? crop.y * sh : 0;
  const swEff = crop ? crop.width * sw : sw;
  const shEff = crop ? crop.height * sh : sh;

  const { baseX, baseY, baseW, baseH } = computeInsetRect(cw, ch, swEff, shEff, paddingScale);

  const { scale, cx, cy } = sampleZoom(segments, tMs);

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

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.fillStyle = '#000';
  ctx.fillRect(drawX, drawY, drawW, drawH);
  ctx.restore();

  ctx.drawImage(source, sx0, sy0, swEff, shEff, drawX, drawY, drawW, drawH);

  if (!showCursor || !mouse) return;

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
}
