/**
 * Frame renderer: draws a video frame onto a canvas applying zoom transform,
 * a soft gradient background, an enhanced cursor, and a click ripple.
 */

import { sampleZoom } from './zoom-engine.js';

const RIPPLE_DURATION = 600; // ms
const CURSOR_RADIUS = 12;

function getNearestCursor(mouse, t) {
  if (!mouse || !mouse.events.length) return null;
  // Binary search by t
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
    } else if (dt >= RIPPLE_DURATION) {
      // ripples are sorted by t implicitly only if events are sorted; keep scanning
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

/**
 * Draw a single frame.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLVideoElement|VideoFrame} source
 * @param {object} opts
 *   - tMs: current time in milliseconds (relative to recording start)
 *   - segments: zoom segments
 *   - mouse: { startTime, events }
 *   - displayWidth/displayHeight: original screen capture pixel size (for mouse coord mapping)
 *   - background: palette name
 *   - paddingScale: how much smaller the inset video is vs canvas (e.g. 0.92)
 *   - showCursor: bool
 */
export function renderFrame(ctx, source, opts) {
  const {
    tMs,
    segments = [],
    mouse,
    displayWidth,
    displayHeight,
    background = 'default',
    paddingScale = 0.94,
    showCursor = true
  } = opts;

  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;

  // Background
  drawBackground(ctx, cw, ch, background);

  // Source size — for HTMLVideoElement
  const sw = source.videoWidth || source.displayWidth || displayWidth;
  const sh = source.videoHeight || source.displayHeight || displayHeight;
  if (!sw || !sh) return;

  // Inset video area inside canvas (with padding for the background frame)
  const fit = Math.min(cw / sw, ch / sh) * paddingScale;
  const baseW = sw * fit;
  const baseH = sh * fit;
  const baseX = (cw - baseW) / 2;
  const baseY = (ch - baseH) / 2;

  const { scale, cx, cy } = sampleZoom(segments, tMs);

  // Convert focus point (screen px) -> position inside the inset video rect.
  // Translate so focus stays anchored while scaling up.
  let drawW = baseW * scale;
  let drawH = baseH * scale;
  let drawX, drawY;
  if (cx == null || cy == null || scale === 1) {
    drawX = (cw - drawW) / 2;
    drawY = (ch - drawH) / 2;
  } else {
    // Where the focus point lives in canvas pixels at base scale:
    const focusBaseX = baseX + (cx / sw) * baseW;
    const focusBaseY = baseY + (cy / sh) * baseH;
    // After scaling, we want that screen-point to remain at focusBaseX/Y.
    drawX = focusBaseX - (cx / sw) * drawW;
    drawY = focusBaseY - (cy / sh) * drawH;
    // Clamp so we never reveal "outside" the captured frame.
    drawX = Math.min(baseX, Math.max(baseX + baseW - drawW, drawX));
    drawY = Math.min(baseY, Math.max(baseY + baseH - drawH, drawY));
  }

  // Soft drop shadow under the video plate
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.fillStyle = '#000';
  ctx.fillRect(drawX, drawY, drawW, drawH);
  ctx.restore();

  // Draw video frame
  ctx.drawImage(source, drawX, drawY, drawW, drawH);

  if (!showCursor || !mouse) return;

  const cursor = getNearestCursor(mouse, tMs);
  if (cursor) {
    const px = drawX + (cursor.x / sw) * drawW;
    const py = drawY + (cursor.y / sh) * drawH;
    // Highlight halo
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, CURSOR_RADIUS * 1.6, 0, Math.PI * 2);
    const halo = ctx.createRadialGradient(px, py, 0, px, py, CURSOR_RADIUS * 1.6);
    halo.addColorStop(0, 'rgba(255,255,255,0.55)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = halo;
    ctx.fill();
    // Core dot
    ctx.beginPath();
    ctx.arc(px, py, CURSOR_RADIUS * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.restore();
  }

  const ripples = activeRipples(mouse, tMs);
  for (const r of ripples) {
    const px = drawX + (r.x / sw) * drawW;
    const py = drawY + (r.y / sh) * drawH;
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
