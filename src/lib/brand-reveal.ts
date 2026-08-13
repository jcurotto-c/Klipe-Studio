/**
 * Paints the "Brand Card" family of outros: a patterned field over the card's
 * background, with a logo and a line or two of copy scaling up in the centre.
 *
 * Two orthogonal knobs cover every preset — `pattern` (dots / grid / rings /
 * none) and `cardStyle` (solid plate / glass / bare). The templates in
 * cards/brand-card.ts are nothing but presets of those, so a new look is a
 * colour set rather than new drawing code.
 *
 * This is a card PAINTER, not a compositor — it never touches the recording.
 * It slots into the three places an ordinary card background is drawn (the
 * preview's card layer, the exporter's synthetic frames, and the frozen frame
 * baked for crossfades), so the card behaves like every other one: the global
 * clock, the crossfade and the export length all work unchanged.
 *
 * Everything is a fraction of the canvas height, so a 1080p preview and a 4K
 * export produce the same layout.
 */

import type { BrandCardConfig } from '../cards/types';
import { drawCardBackground } from './renderer';
import { applyEasing } from '../overlays/engine/easings';
import { fontStackById } from '../overlays/fonts';

/** Reusable canvases. Held by the caller so a 60 fps encode doesn't reallocate. */
export interface BrandScratch {
  /** One halftone dot, tiled by createPattern. */
  dotTile: HTMLCanvasElement;
  /** The pattern field, masked to a soft radial falloff. */
  dots: HTMLCanvasElement;
}

export function createBrandScratch(): BrandScratch {
  return {
    dotTile: document.createElement('canvas'),
    dots: document.createElement('canvas'),
  };
}

export function disposeBrandScratch(s: BrandScratch): void {
  for (const c of [s.dotTile, s.dots]) {
    c.width = 0;
    c.height = 0;
  }
}

function sized(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const iw = Math.max(2, Math.round(w));
  const ih = Math.max(2, Math.round(h));
  if (c.width !== iw || c.height !== ih) {
    c.width = iw;
    c.height = ih;
  }
  return c.getContext('2d');
}

function span(a: number, b: number, t: number): number {
  if (b <= a) return t >= b ? 1 : 0;
  return Math.max(0, Math.min(1, (t - a) / (b - a)));
}

/**
 * Draw the whole card at `localMs` (card-local time).
 *
 * The background and pattern sit at full strength for the card's whole length —
 * the entry from the recording is the card's own crossfade, so fading them in
 * again on top would read as a double dissolve. Only the brand card animates.
 */
export function drawBrandReveal(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cfg: BrandCardConfig,
  localMs: number,
  durationMs: number,
  scratch: BrandScratch,
  /**
   * Decoded frame when the backdrop is a video, supplied by the export. Passed
   * straight through to drawCardBackground — without it the export would fall
   * back to the renderer's live <video>, which is not deterministic.
   */
  backdropFrame?: CanvasImageSource | null,
): void {
  if (w < 2 || h < 2) return;
  drawCardBackground(ctx, w, h, cfg.background, backdropFrame);
  drawPatternField(ctx, w, h, cfg, scratch);
  const p = durationMs > 0 ? Math.max(0, Math.min(1, localMs / durationMs)) : 1;
  drawBrandCard(ctx, w, h, cfg, p);
}

/**
 * The background texture, masked to a soft centre-weighted falloff.
 *
 * Every pattern goes through the same mask so the styles read as one family
 * rather than as unrelated backdrops. The mask is a spatially varying alpha,
 * which `globalAlpha` can't express — hence the scratch canvas and the
 * `destination-in` punch.
 */
export function drawPatternField(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  cfg: BrandCardConfig,
  scratch: BrandScratch,
): void {
  const alpha = Math.max(0, Math.min(1, cfg.patternOpacity));
  if (cfg.pattern === 'none' || alpha <= 0.002) return;

  const dctx = sized(scratch.dots, W, H);
  if (!dctx) return;
  dctx.clearRect(0, 0, W, H);

  // One pitch for all three, so switching pattern keeps the same visual density.
  const pitch = Math.max(6, Math.round(W * 0.0125));
  if (cfg.pattern === 'dots') paintDots(dctx, W, H, cfg.patternColor, pitch, scratch);
  else if (cfg.pattern === 'grid') paintGrid(dctx, W, H, cfg.patternColor, pitch);
  else paintRings(dctx, W, H, cfg.patternColor, pitch);

  dctx.globalCompositeOperation = 'destination-in';
  const g = dctx.createRadialGradient(W / 2, H * 0.48, 0, W / 2, H * 0.48, Math.max(W, H) * 0.55);
  g.addColorStop(0, 'rgba(0,0,0,0.92)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.62)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  dctx.fillStyle = g;
  dctx.fillRect(0, 0, W, H);
  dctx.globalCompositeOperation = 'source-over';

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(scratch.dots, 0, 0);
  ctx.restore();
}

/** Halftone dots, tiled from a one-dot pattern. */
function paintDots(
  dctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  color: string,
  pitch: number,
  scratch: BrandScratch,
): void {
  const tctx = sized(scratch.dotTile, pitch, pitch);
  if (!tctx) return;
  tctx.clearRect(0, 0, pitch, pitch);
  tctx.fillStyle = color;
  tctx.beginPath();
  tctx.arc(pitch / 2, pitch / 2, Math.max(1, pitch * 0.26), 0, Math.PI * 2);
  tctx.fill();
  const pattern = dctx.createPattern(scratch.dotTile, 'repeat');
  if (!pattern) return;
  dctx.fillStyle = pattern;
  dctx.fillRect(0, 0, W, H);
}

/** Hairline graph-paper grid. */
function paintGrid(
  dctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  color: string,
  pitch: number,
): void {
  // Two pitches out: at the dot spacing a grid turns into a solid wash.
  const step = pitch * 2;
  const lw = Math.max(1, W * 0.0009);
  dctx.fillStyle = color;
  for (let x = (W / 2) % step; x < W; x += step) dctx.fillRect(Math.round(x), 0, lw, H);
  for (let y = (H / 2) % step; y < H; y += step) dctx.fillRect(0, Math.round(y), W, lw);
}

/** Concentric rings radiating from the centre. */
function paintRings(
  dctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  color: string,
  pitch: number,
): void {
  const step = pitch * 2.4;
  const cx = W / 2;
  const cy = H * 0.48;
  const max = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
  dctx.strokeStyle = color;
  dctx.lineWidth = Math.max(1, W * 0.0011);
  for (let r = step; r < max; r += step) {
    dctx.beginPath();
    dctx.arc(cx, cy, r, 0, Math.PI * 2);
    dctx.stroke();
  }
}

/** The plate (if any) plus the logo and copy, fading and scaling up. */
function drawBrandCard(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  cfg: BrandCardConfig,
  p01: number,
): void {
  // Held back briefly so the dot field establishes itself first, and settled
  // well before the end so the card has a moment to just sit there.
  const p = span(0.08, 0.45, p01);
  if (p <= 0) return;
  const fade = applyEasing('easeOutQuint', p);
  const scale = 0.86 + 0.14 * applyEasing('easeOutBack', p);

  const font = fontStackById(cfg.fontFamily);
  const title = cfg.cardText.trim();
  const sub = cfg.cardSubtext.trim();
  const iconSrc = cfg.icon?.src;

  const padX = H * Math.max(0, cfg.padX);
  const padY = H * Math.max(0, cfg.padY);
  const iconH = iconSrc ? H * 0.135 : 0;
  const titleSize = H * 0.062;
  const subSize = H * 0.032;
  const gap = H * 0.026;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let contentW = 0;
  if (title) {
    ctx.font = `600 ${titleSize}px ${font}`;
    contentW = Math.max(contentW, ctx.measureText(title).width);
  }
  if (sub) {
    ctx.font = `400 ${subSize}px ${font}`;
    contentW = Math.max(contentW, ctx.measureText(sub).width);
  }
  if (iconSrc) contentW = Math.max(contentW, iconH);

  let contentH = 0;
  if (iconH) contentH += iconH;
  if (title) contentH += (contentH ? gap : 0) + titleSize;
  if (sub) contentH += (contentH ? gap * 0.5 : 0) + subSize;
  // An icon on its own gets a square-ish card, the way an app tile reads.
  if (contentH === 0) contentH = H * 0.12;

  // Content plus the configured thickness on each axis, capped so a long name
  // or a wide setting can't run off the frame. No implicit "at least square"
  // rule: with padX and padY exposed, squaring the box is the user's call.
  const cardW = Math.min(W * 0.92, contentW + padX * 2);
  const cardH = Math.min(H * 0.9, contentH + padY * 2);
  const cx = W / 2;
  const cy = H * 0.5;

  ctx.globalAlpha = fade;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);

  // Clamped to half the short side so a thin box turns into a pill rather than
  // letting the corner arcs overlap and pinch.
  const radius = Math.min(H * 0.034, cardW / 2, cardH / 2);
  const plate = (): void => {
    ctx.beginPath();
    ctx.roundRect(cx - cardW / 2, cy - cardH / 2, cardW, cardH, radius);
  };

  if (cfg.cardStyle === 'solid') {
    ctx.shadowColor = 'rgba(0,0,0,0.20)';
    ctx.shadowBlur = H * 0.05;
    ctx.shadowOffsetY = H * 0.014;
    ctx.fillStyle = '#ffffff';
    plate();
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  } else if (cfg.cardStyle === 'glass') {
    // Frosted panel: a light wash plus a hairline rim. No blur — sampling the
    // backdrop per frame would cost more than the effect is worth, and over a
    // soft gradient the wash alone reads as glass.
    // Opaque enough that the pattern behind doesn't read through the copy —
    // at a lighter wash the subtitle picks up the dots and turns muddy.
    const g = ctx.createLinearGradient(0, cy - cardH / 2, 0, cy + cardH / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.30)');
    g.addColorStop(1, 'rgba(255,255,255,0.17)');
    ctx.fillStyle = g;
    plate();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = Math.max(1, H * 0.0022);
    plate();
    ctx.stroke();
  }
  // 'none' plates nothing — the logo and copy sit straight on the backdrop.

  let y = cy - contentH / 2;
  if (iconSrc) {
    const img = loadIcon(iconSrc);
    if (img && img.complete && img.naturalWidth > 0) {
      const ratio = img.naturalWidth / img.naturalHeight;
      const iw = iconH * ratio;
      ctx.drawImage(img, cx - iw / 2, y, iw, iconH);
    }
    y += iconH;
  }
  // Un-plated copy needs a shadow to stay legible over a busy pattern.
  if (cfg.cardStyle === 'none') {
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = H * 0.03;
    ctx.shadowOffsetY = H * 0.006;
  }
  if (title) {
    y += (y > cy - contentH / 2 ? gap : 0) + titleSize / 2;
    ctx.fillStyle = cfg.textColor;
    ctx.font = `600 ${titleSize}px ${font}`;
    ctx.fillText(title, cx, y);
    y += titleSize / 2;
  }
  if (sub) {
    y += gap * 0.5 + subSize / 2;
    // Dim the subtitle ONLY over an opaque plate. Lowering alpha makes the
    // glyphs themselves translucent, so over glass or bare backdrop the
    // pattern shows through the letters and the text turns muddy — there the
    // size difference alone carries the hierarchy.
    if (cfg.cardStyle === 'solid') ctx.globalAlpha = fade * 0.62;
    ctx.fillStyle = cfg.textColor;
    ctx.font = `400 ${subSize}px ${font}`;
    ctx.fillText(sub, cx, y);
  }

  ctx.restore();
}

/**
 * Icon images, cached by data URL. The export bakes card frames synchronously,
 * so a cold cache would draw the first frames without the logo — callers must
 * await `ensureBrandAssets` before the encode loop.
 */
const iconCache = new Map<string, HTMLImageElement>();

function loadIcon(src: string): HTMLImageElement | null {
  const hit = iconCache.get(src);
  if (hit) return hit;
  const img = new Image();
  img.src = src;
  iconCache.set(src, img);
  return img;
}

/** Resolve once the config's icon has decoded. Resolves on error too. */
export async function ensureBrandAssets(cfg: BrandCardConfig | null | undefined): Promise<void> {
  const src = cfg?.icon?.src;
  if (!src) return;
  const img = loadIcon(src);
  if (!img || img.complete) return;
  await new Promise<void>((resolve) => {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => resolve(), { once: true });
  });
}
