/**
 * Canvas 2D primitives that draw a brand header — logo + name, a headline and
 * an optional subtitle — in a band reserved along the TOP of the canvas, with
 * the video card below it. The "Showcase" format in the Frame panel.
 *
 * Same discipline as `window-chrome`: no SVG, nothing from the CSP, every
 * dimension derived from the band height so it looks identical at 1080p and 4K,
 * and it bakes into the export for free (preview and export share renderFrame).
 *
 * The band height is DECLARED by the user (`sizeRel`), never measured from the
 * text. The overlays read it through a pure function to place their handles, so
 * a height that depended on `measureText` would make the renderer and the
 * overlays disagree — see the contract in `lib/layout`. The content shrinks to
 * fit the band instead.
 */

import type { BrandHeaderOptions } from '../types';
import { fontStackById, fontTitleWeight, fontTracking, snapWeight } from '../overlays/fonts';
import { getCachedImage } from './renderer';

export const DEFAULT_BRAND_HEADER: BrandHeaderOptions = {
  enabled: false,
  brand: '',
  headline: '',
  subtitle: '',
  color: '#101114',
  fontFamily: 'inter',
  align: 'left',
  sizeRel: 0.3,
  bleed: 0,
};

/** Background the Showcase format switches to when it's turned on. */
export const SHOWCASE_BACKGROUND_COLOR = '#f4f4f0';

export const HEADER_SIZE_MIN = 0.1;
export const HEADER_SIZE_MAX = 0.5;
export const HEADER_BLEED_MAX = 0.5;

const clamp = (v: number, lo: number, hi: number): number =>
  (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/**
 * Normalize a partial / hand-edited / future-version header object. Every field
 * is coerced into range, so a project.json edited by hand can never put the
 * renderer into an undefined state.
 *
 * A DISABLED header still keeps its content: the panel edits the resolved
 * object, and wiping the copy whenever the user flips the format off would lose
 * their headline. `enabled` alone decides whether anything is drawn.
 */
export function resolveBrandHeader(
  h: Partial<BrandHeaderOptions> | null | undefined,
): BrandHeaderOptions {
  if (!h) return DEFAULT_BRAND_HEADER;
  const logo = h.logo;
  return {
    enabled: !!h.enabled,
    logo: logo && typeof logo.src === 'string' && logo.src
      ? {
          src: logo.src,
          naturalWidth: logo.naturalWidth > 0 ? logo.naturalWidth : 512,
          naturalHeight: logo.naturalHeight > 0 ? logo.naturalHeight : 512,
        }
      : undefined,
    brand: typeof h.brand === 'string' ? h.brand : '',
    headline: typeof h.headline === 'string' ? h.headline : '',
    subtitle: typeof h.subtitle === 'string' ? h.subtitle : '',
    color: typeof h.color === 'string' && h.color ? h.color : DEFAULT_BRAND_HEADER.color,
    fontFamily: typeof h.fontFamily === 'string' && h.fontFamily
      ? h.fontFamily
      : DEFAULT_BRAND_HEADER.fontFamily,
    align: h.align === 'center' ? 'center' : 'left',
    sizeRel: clamp(h.sizeRel ?? DEFAULT_BRAND_HEADER.sizeRel, HEADER_SIZE_MIN, HEADER_SIZE_MAX),
    bleed: clamp(h.bleed ?? 0, 0, HEADER_BLEED_MAX),
  };
}

/** Band height ÷ canvas HEIGHT. 0 when the header is off. */
export function brandHeaderRatio(
  h: Partial<BrandHeaderOptions> | null | undefined,
): number {
  const r = resolveBrandHeader(h);
  return r.enabled ? r.sizeRel : 0;
}

/** Downward shift of the card, in card heights. 0 when the header is off. */
export function brandHeaderBleed(
  h: Partial<BrandHeaderOptions> | null | undefined,
): number {
  const r = resolveBrandHeader(h);
  return r.enabled ? r.bleed : 0;
}

/**
 * Resolve once the logo bitmap has decoded. The header is painted synchronously
 * per frame, so a cold cache would bake the opening frames of an export without
 * the logo. `decode()` rather than an onload listener: `getCachedImage` owns the
 * element's handlers and overwriting them would break its `ready` flag.
 */
export async function ensureBrandHeaderAssets(
  h: Partial<BrandHeaderOptions> | null | undefined,
): Promise<void> {
  const header = resolveBrandHeader(h);
  const src = header.logo?.src;
  if (!header.enabled || !src) return;
  const entry = getCachedImage(src);
  if (!entry || entry.ready) return;
  try {
    await entry.img.decode();
  } catch { /* a broken logo just doesn't draw */ }
}

// ─── Layout constants ────────────────────────────────────────────────────
//
// All fractions of the BAND height, so the whole block scales with the slider
// and stays proportional at every resolution.

const PAD_TOP = 0.1;
const PAD_BOTTOM = 0.1;
/** Logo/brand-name row. */
const BRAND_ROW = 0.16;
/** Space between the brand row and the headline. */
const ROW_GAP = 0.14;
const SUBTITLE_SIZE = 0.075;
const SUBTITLE_GAP = 0.05;
/** Headline line box ÷ font size. Tight, the way display type is set. */
const LINE_HEIGHT = 1.12;
const HEADLINE_MAX_LINES = 3;
const SUBTITLE_ALPHA = 0.62;

/**
 * Text drawn at a fractional baseline is resampled across two pixel rows and
 * reads soft. Round origins and font sizes so glyphs hit a whole-pixel raster.
 */
const snap = (v: number): number => Math.round(v);

/**
 * Greedy word wrap honouring explicit newlines — the headline comes from a
 * textarea, so a hard break the user typed is intentional.
 * Assumes `ctx.font` is already set.
 */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let line = words[0]!;
    for (let i = 1; i < words.length; i++) {
      const cand = `${line} ${words[i]}`;
      if (ctx.measureText(cand).width <= maxW) line = cand;
      else { out.push(line); line = words[i]!; }
    }
    out.push(line);
  }
  return out;
}

interface FittedText {
  size: number;
  lines: string[];
}

/**
 * Single-slot memo. The fit only depends on its inputs, and they change when
 * the user types — not every frame — so one slot spares ~8 wrap passes per
 * rendered frame in both the preview loop and the export loop.
 */
let fitCacheKey = '';
let fitCacheValue: FittedText = { size: 0, lines: [] };

/**
 * Largest font size at which `text` wraps into at most `maxLines` that fit both
 * `maxW` and `maxH`. Binary search on integer pixel sizes.
 *
 * The width test uses the widest RESULTING line, not just the line count: a
 * single word longer than `maxW` can't be broken, so without this it would
 * overflow the band silently instead of shrinking.
 */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string, maxW: number, maxH: number,
  maxLines: number, font: string, weight: number,
  /** em fraction; the caller must have set ctx.letterSpacing to match. */
  tracking: number,
): FittedText {
  // `tracking` is in the key because letterSpacing changes measureText: a fit
  // computed at one spacing and drawn at another overflows the band.
  const key = `${text}|${Math.round(maxW)}|${Math.round(maxH)}|${maxLines}|${font}|${weight}|${tracking}`;
  if (key === fitCacheKey) return fitCacheValue;

  const empty: FittedText = { size: 0, lines: [] };
  if (!text.trim() || maxW <= 0 || maxH <= 0) {
    fitCacheKey = key; fitCacheValue = empty;
    return empty;
  }

  let lo = 1;
  let hi = Math.max(1, Math.floor(maxH));
  let best: FittedText = { size: 1, lines: [text] };
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    ctx.font = `${weight} ${mid}px ${font}`;
    // Tracking scales with the size, so it has to be re-set on every probe or
    // the search measures a spacing the draw won't use.
    ctx.letterSpacing = `${(tracking * mid).toFixed(3)}px`;
    const lines = wrapLines(ctx, text, maxW);
    const widest = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
    const fits = lines.length > 0
      && lines.length <= maxLines
      && widest <= maxW
      && lines.length * mid * LINE_HEIGHT <= maxH;
    if (fits) { best = { size: mid, lines }; lo = mid + 1; }
    else hi = mid - 1;
  }

  fitCacheKey = key;
  fitCacheValue = best;
  return best;
}

/** Logo draw size for a given row height, capped so a wide mark can't take over. */
function logoBox(
  logo: NonNullable<BrandHeaderOptions['logo']>,
  rowH: number, maxW: number,
): { w: number; h: number } {
  const aspect = logo.naturalWidth / logo.naturalHeight;
  let h = rowH;
  let w = h * aspect;
  if (w > maxW) { w = maxW; h = w / aspect; }
  return { w, h };
}

/**
 * Paint the header into the band.
 *
 * `(x, y, w, h)` is the CONTENT box, not the canvas: the renderer passes the
 * card's BASE rect for x/w so the headline's left edge lines up with the
 * window's, and the base rect is pre-zoom so the header doesn't drift when a
 * zoom comes in.
 */
export function drawBrandHeader(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  opts: BrandHeaderOptions,
): void {
  if (h <= 0 || w <= 0) return;
  const font = fontStackById(opts.fontFamily);
  const centred = opts.align === 'center';
  const originX = centred ? x + w / 2 : x;

  const top = y + h * PAD_TOP;
  const bottom = y + h - h * PAD_BOTTOM;
  let cursorY = top;

  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.fillStyle = opts.color;

  // ─ Brand row: logo, then the name beside it ─
  const logo = opts.logo;
  const entry = logo ? getCachedImage(logo.src) : null;
  const logoReady = !!(logo && entry?.ready);
  const hasBrandRow = logoReady || !!opts.brand.trim();
  if (hasBrandRow) {
    const rowH = h * BRAND_ROW;
    const cy = cursorY + rowH / 2;
    const box = logoReady ? logoBox(logo!, rowH, w * 0.4) : { w: 0, h: 0 };
    const gap = box.w > 0 ? rowH * 0.42 : 0;

    const nameSize = snap(rowH * 0.62);
    const nameWeight = snapWeight(opts.fontFamily, false, 800);
    ctx.font = `${nameWeight} ${nameSize}px ${font}`;
    // Wordmarks are set tight; a touch of tracking keeps a short bold name from
    // reading as a clump. Chromium-only property, harmless where unsupported.
    ctx.letterSpacing = `${(nameSize * 0.01).toFixed(2)}px`;
    const nameW = opts.brand ? ctx.measureText(opts.brand).width : 0;

    const rowW = box.w + gap + nameW;
    let cx = centred ? originX - rowW / 2 : originX;
    if (box.w > 0) {
      ctx.drawImage(entry!.img, snap(cx), snap(cy - box.h / 2), snap(box.w), snap(box.h));
      cx += box.w + gap;
    }
    if (opts.brand) {
      ctx.fillStyle = opts.color;
      ctx.textAlign = 'left';
      ctx.fillText(opts.brand, snap(cx), snap(cy));
    }
    ctx.letterSpacing = '0px';
    cursorY += rowH + h * ROW_GAP;
  }

  // ─ Subtitle claims its space first so the headline fits in what's left ─
  const subSize = snap(h * SUBTITLE_SIZE);
  const hasSub = !!opts.subtitle.trim();
  const subBlock = hasSub ? subSize * LINE_HEIGHT + h * SUBTITLE_GAP : 0;

  // ─ Headline ─
  // Weight and tracking both come from the FACE: Geist reads as a title at 600
  // where Inter needs 700, and each is spaced for its own body cut, so display
  // sizes want a different amount pulled back.
  const headWeight = snapWeight(opts.fontFamily, false, fontTitleWeight(opts.fontFamily));
  const tracking = fontTracking(opts.fontFamily);
  const headAvail = bottom - cursorY - subBlock;
  const fitted = fitText(
    ctx, opts.headline, w, headAvail, HEADLINE_MAX_LINES, font, headWeight, tracking,
  );
  if (fitted.size > 0) {
    ctx.font = `${headWeight} ${fitted.size}px ${font}`;
    ctx.letterSpacing = `${(tracking * fitted.size).toFixed(3)}px`;
    ctx.fillStyle = opts.color;
    ctx.textAlign = 'left';
    const lineH = fitted.size * LINE_HEIGHT;
    for (let i = 0; i < fitted.lines.length; i++) {
      const line = fitted.lines[i]!;
      // Left-align at a rounded origin instead of centring on a fractional one:
      // textAlign 'center' lands the run on a half-pixel whenever its measured
      // width is odd, which is what makes centred display type look smeared.
      const lx = centred ? originX - ctx.measureText(line).width / 2 : originX;
      ctx.fillText(line, snap(lx), snap(cursorY + lineH * i + lineH / 2));
    }
    cursorY += lineH * fitted.lines.length;
  }

  // ─ Subtitle ─
  if (hasSub) {
    const subWeight = snapWeight(opts.fontFamily, false, 500);
    ctx.font = `${subWeight} ${subSize}px ${font}`;
    // Reset from the headline's tracking — it is a fixed px value, so leaving it
    // on would apply a display-size spacing to much smaller type. Half of it at
    // this size: the tighter setting is a display correction, not a house style.
    ctx.letterSpacing = `${(tracking * subSize * 0.5).toFixed(3)}px`;
    ctx.globalAlpha = SUBTITLE_ALPHA;
    ctx.fillStyle = opts.color;
    ctx.textAlign = 'left';
    const line = opts.subtitle.split('\n')[0]!.trim();
    const sy = cursorY + h * SUBTITLE_GAP + (subSize * LINE_HEIGHT) / 2;
    const sx = centred ? originX - ctx.measureText(line).width / 2 : originX;
    ctx.fillText(line, snap(sx), snap(sy));
  }

  ctx.restore();
}
