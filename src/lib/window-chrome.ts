/**
 * Canvas 2D primitives that draw a fake OS window title bar above the
 * recording. No SVG, no images — every glyph is paths and gradients, so the
 * chrome stays sharp at any resolution, needs nothing from the CSP, and bakes
 * into export for free (preview and export share renderFrame).
 *
 * Everything derives from the bar height `h`, which the renderer computes as a
 * fixed fraction of the card's CURRENT width — so the chrome scales with the
 * zoom and looks identical at 1080p and 4K. Strokes are always
 * `Math.max(1, h * k)`: a hard-coded 1px line is a hairline at 4K.
 */

import type { WindowChromeOptions, WindowChromeStyle, WindowChromeTheme } from '../types';

export const DEFAULT_WINDOW_CHROME: WindowChromeOptions = {
  style: 'none',
  theme: 'dark',
  title: '',
  url: '',
};

/**
 * Bar height ÷ card WIDTH — the single tuning table; every other dimension in
 * this module derives from the resulting bar height.
 *
 * Deliberately ~2× the real OS ratios (a macOS title bar is ~1.5% of a
 * 1920-wide window, Chrome's tab+toolbar ~4.4%): these frames usually wrap a
 * full-screen capture, where a true-to-life bar reads as a rendering artifact
 * rather than as a window.
 */
/**
 * All three styles share one height so switching between them doesn't resize
 * the frame. A real toolbar is ~52px REGARDLESS of window width, so deriving
 * the ratio from a narrow reference window overshoots badly on a full-screen
 * capture: 52/1920 ≈ 0.027 is the honest number, and this sits just above it
 * so the glyphs keep some room. Every other dimension in this module derives
 * from the resulting bar height, so this is the only value to tune.
 */
const BAR_RATIO = 0.031;

export const CHROME_BAR_RATIO: Record<WindowChromeStyle, number> = {
  none: 0,
  macos: BAR_RATIO,
  browser: BAR_RATIO,
  windows: BAR_RATIO,
};

/**
 * Normalize a partial / hand-edited / future-version chrome object.
 * An unknown or missing style resolves to "off", so a project.json edited by
 * hand can never put the renderer into an undefined state.
 */
export function resolveWindowChrome(
  w: Partial<WindowChromeOptions> | null | undefined,
): WindowChromeOptions {
  const style = w?.style;
  if (!style || style === 'none' || !(style in CHROME_BAR_RATIO)) return DEFAULT_WINDOW_CHROME;
  return {
    style,
    theme: w?.theme === 'light' ? 'light' : 'dark',
    title: typeof w?.title === 'string' ? w.title : '',
    url: typeof w?.url === 'string' ? w.url : '',
  };
}

export function windowChromeBarRatio(
  w: Partial<WindowChromeOptions> | null | undefined,
): number {
  return CHROME_BAR_RATIO[resolveWindowChrome(w).style];
}

// ─── Palettes ────────────────────────────────────────────────────────────
//
// Every fill here is FULLY OPAQUE. With `removeBackground` on, the frame's
// shadow-caster (a black roundRect) sits under the card — a translucent bar
// would bleed that black into the exported alpha channel.

interface ChromePalette {
  /** Title bar / Safari toolbar fill. Flat: macOS toolbars carry no gradient. */
  bar: string;
  /** Separator along the bar's bottom edge. */
  hairline: string;
  /** Centred window title (macOS / Windows styles). */
  title: string;
  /** Icon strokes and fills. */
  glyph: string;
  /**
   * Recessed fill behind the toolbar buttons and the address field. Drawn ON
   * TOP of the opaque bar, so translucency here can't leak into the alpha
   * channel when `removeBackground` is on.
   */
  controlBg: string;
  fieldText: string;
}

/**
 * macOS system colours, not hand-picked grays.
 *   - `bar`   = NSColor.windowBackgroundColor  (dark #323232, light #ececec)
 *   - text    = NSColor.labelColor             (white 85% / black 85%)
 * Caveat worth knowing: a real macOS toolbar is an NSVisualEffectView, so it's
 * translucent and samples the desktop behind the window — the same Safari looks
 * different over a dark wallpaper than over a light one. There is no single
 * "true" flat value; these are the system colours the material is built on,
 * which is the closest a flat fill can get. `fieldBg` and `hairline` have no
 * documented counterpart and stay estimates.
 */
const PALETTES: Record<WindowChromeTheme, ChromePalette> = {
  dark: {
    // Sonoma's toolbar runs much darker than the classic windowBackgroundColor
    // (#323232) because Safari tints it toward the page. This is systemGray6.
    bar: '#1e1e20',
    hairline: 'rgba(0, 0, 0, 0.5)',
    title: 'rgba(255, 255, 255, 0.85)',
    // Toolbar glyphs and the URL sit at secondaryLabelColor, not labelColor:
    // in the reference they read as a muted gray. Full-strength white makes the
    // chrome shout over the recording.
    glyph: 'rgba(255, 255, 255, 0.62)',
    controlBg: 'rgba(255, 255, 255, 0.09)',
    fieldText: 'rgba(255, 255, 255, 0.78)',
  },
  light: {
    // Pure white, not the system's off-white window gray: on a coloured
    // background the frame should read as a clean white card.
    bar: '#ffffff',
    hairline: 'rgba(0, 0, 0, 0.12)',
    title: 'rgba(0, 0, 0, 0.85)',
    glyph: 'rgba(0, 0, 0, 0.62)',
    // Slightly stronger than it would need to be on the old grey bar, so the
    // recessed controls stay visible against white.
    controlBg: 'rgba(0, 0, 0, 0.075)',
    fieldText: 'rgba(0, 0, 0, 0.72)',
  },
};

/** Hairline rim macOS draws around a window, over the card's rounded edge. */
export const WINDOW_RIM: Record<WindowChromeTheme, string> = {
  dark: 'rgba(255, 255, 255, 0.11)',
  light: 'rgba(0, 0, 0, 0.13)',
};

/** The actual traffic-light fills and their darker rims, per light. */
const TRAFFIC = ['#ff5f57', '#febc2e', '#28c840'] as const;
const TRAFFIC_RIM = ['#e0443e', '#dea123', '#1aab29'] as const;

/**
 * Traffic-light geometry as fractions of the bar height, shared by the macOS
 * and Safari painters so the two can't drift apart — they're the same buttons
 * on the same window.
 */
const LIGHT_D = 0.25; // dot diameter
const LIGHT_X = 0.46; // first dot's left edge, from the frame's left edge

/**
 * Inter is self-hosted and warmed by ensureFontsReady() before both the first
 * preview paint and the export loop, so measureText agrees in both paths.
 */
const TITLE_FONT = "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// ─── Shared helpers ──────────────────────────────────────────────────────

function palette(theme: WindowChromeTheme): ChromePalette {
  return PALETTES[theme] ?? PALETTES.dark;
}

/** Bar background + the hairline that separates it from the video below. */
function fillBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  p: ChromePalette,
): void {
  // Flat, no gradient: a vertical ramp reads as Big-Sur-era or as generic
  // window chrome. Modern macOS toolbars are a single tone in both appearances.
  ctx.fillStyle = p.bar;
  // +1px of overdraw at the bottom: the video's square top edge lands on the
  // same fractional y, and two anti-aliased edges there leave a 1px seam of
  // background showing through.
  ctx.fillRect(x, y, w, h + 1);
  const lw = Math.max(1, h * 0.035);
  ctx.fillStyle = p.hairline;
  ctx.fillRect(x, y + h - lw, w, lw);
}

/** Three dots starting at `x`, centred on `cy`. Returns their right edge. */
function trafficLights(
  ctx: CanvasRenderingContext2D,
  x: number, cy: number, d: number,
): number {
  const r = d / 2;
  const gap = d * 1.4;
  ctx.lineWidth = Math.max(1, d * 0.05);
  for (let i = 0; i < 3; i++) {
    const cx = x + r + gap * i;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = TRAFFIC[i]!;
    ctx.fill();
    // Each light carries its own darker rim, not a generic black ring.
    ctx.strokeStyle = TRAFFIC_RIM[i]!;
    ctx.stroke();
  }
  return x + d + gap * 2;
}

/**
 * Trim `text` to fit `maxW`, appending an ellipsis. Binary search keeps this to
 * ~6 measureText calls for any realistic title, on every rendered frame.
 */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (!text || maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : '';
}

/**
 * Text drawn at a fractional baseline is resampled across two pixel rows and
 * reads soft — very visible on a title bar, where everything else is flat fill.
 * Round the font size too, so the glyph cache hits a whole-pixel raster.
 */
const snap = (v: number): number => Math.round(v);

/** Left-aligned, ellipsised label. */
function leftText(
  ctx: CanvasRenderingContext2D,
  text: string, x: number, cy: number,
  maxW: number, fontPx: number, weight: number, color: string,
): void {
  if (!text) return;
  ctx.font = `${weight} ${snap(fontPx)}px ${TITLE_FONT}`;
  const t = ellipsize(ctx, text, maxW);
  if (!t) return;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(t, snap(x), snap(cy));
}

/**
 * Centred title with a SYMMETRIC width budget: the allowance is twice the
 * smaller distance to either limit, so a long title shrinks rather than sliding
 * under the button cluster on whichever side is tighter.
 */
function centredTitle(
  ctx: CanvasRenderingContext2D,
  title: string, x: number, w: number, cy: number,
  fontPx: number, weight: number, color: string,
  leftLimit: number, rightLimit: number,
): void {
  if (!title) return;
  ctx.font = `${weight} ${snap(fontPx)}px ${TITLE_FONT}`;
  const cx = x + w / 2;
  const budget = 2 * Math.min(cx - leftLimit, rightLimit - cx);
  const t = ellipsize(ctx, title, Math.max(0, budget));
  if (!t) return;
  ctx.fillStyle = color;
  // Left-align at a rounded origin instead of centring on a fractional one:
  // textAlign 'center' lands the run on a half-pixel whenever its measured
  // width is odd, which is exactly what makes a centred title look smeared.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(t, snap(cx - ctx.measureText(t).width / 2), snap(cy));
}

/**
 * Stroked chevron pointing left (dir -1) or right (dir 1). The apex goes on
 * the side being pointed AT — writing it the other way round silently draws
 * back/forward mirrored.
 */
function chevron(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number, dir: 1 | -1,
): void {
  // Half as wide as tall. Drawing it square (a 45° apex) gives a blunt, fat
  // angle bracket — the single biggest tell that the icons aren't Safari's.
  const half = size * 0.34;
  const apex = cx + half * dir;
  const tail = cx - half * dir;
  ctx.beginPath();
  ctx.moveTo(tail, cy - size / 2);
  ctx.lineTo(apex, cy);
  ctx.lineTo(tail, cy + size / 2);
  ctx.stroke();
}

/** Stroked ✕ inside a `size` box. */
function cross(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const s = size / 2;
  ctx.beginPath();
  ctx.moveTo(cx - s, cy - s);
  ctx.lineTo(cx + s, cy + s);
  ctx.moveTo(cx + s, cy - s);
  ctx.lineTo(cx - s, cy + s);
  ctx.stroke();
}

/** Stroked + inside a `size` box. */
function plus(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const s = size / 2;
  ctx.beginPath();
  ctx.moveTo(cx - s, cy);
  ctx.lineTo(cx + s, cy);
  ctx.moveTo(cx, cy - s);
  ctx.lineTo(cx, cy + s);
  ctx.stroke();
}

/** Small chevron pointing down (the sidebar button's dropdown caret). */
function chevronDown(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number,
): void {
  ctx.beginPath();
  ctx.moveTo(cx - size / 2, cy - size * 0.26);
  ctx.lineTo(cx, cy + size * 0.26);
  ctx.lineTo(cx + size / 2, cy - size * 0.26);
  ctx.stroke();
}

/** Page-menu glyph: three left-aligned rules of unequal length. */
function pageMenuGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number,
): void {
  const lens = [1, 0.62, 0.84];
  const gap = size * 0.34;
  const left = cx - size / 2;
  for (let i = 0; i < 3; i++) {
    const yy = cy + (i - 1) * gap;
    ctx.beginPath();
    ctx.moveTo(left, yy);
    ctx.lineTo(left + size * lens[i]!, yy);
    ctx.stroke();
  }
}

/** Recessed rounded fill behind a toolbar control. */
function controlPill(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, fill: string,
): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h * 0.3);
  ctx.fill();
}

/**
 * Safari's sidebar toggle: a rounded rectangle with a divider a third of the
 * way in.
 */
function sidebarGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number,
): void {
  const w = size;
  const h = size * 0.78;
  const l = cx - w / 2;
  const t = cy - h / 2;
  ctx.beginPath();
  ctx.roundRect(l, t, w, h, h * 0.24);
  ctx.stroke();
  const div = l + w * 0.36;
  ctx.beginPath();
  ctx.moveTo(div, t);
  ctx.lineTo(div, t + h);
  ctx.stroke();
}

/**
 * Circular arrow (reload): an arc with a wide gap and a FILLED triangular head
 * at the end of travel, aligned to the clockwise tangent.
 *
 * Two things were wrong before and both matter. The head was two stroked barbs,
 * which at the size this renders (single-digit pixels on a 1080p frame) merge
 * into the arc and leave what looks like a plain circle. And the gap was narrow
 * enough that the ring read as closed. A solid head plus a wide gap is what
 * makes it legible as an arrow at any size.
 */
function reloadGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number, color: string,
): void {
  const r = size / 2;
  const start = -0.05 * Math.PI;
  const end = 1.28 * Math.PI; // 1.33π of sweep — a clearly open ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, end);
  ctx.stroke();

  const ex = cx + r * Math.cos(end);
  const ey = cy + r * Math.sin(end);
  const dir = end + Math.PI / 2; // direction of travel at the arc's end
  const len = size * 0.46;
  const half = size * 0.23;
  ctx.beginPath();
  ctx.moveTo(ex + len * Math.cos(dir), ey + len * Math.sin(dir));
  ctx.lineTo(ex + half * Math.cos(dir + Math.PI / 2), ey + half * Math.sin(dir + Math.PI / 2));
  ctx.lineTo(ex + half * Math.cos(dir - Math.PI / 2), ey + half * Math.sin(dir - Math.PI / 2));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** Closed padlock: rounded body with a stroked shackle above it. */
function padlock(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number, color: string,
): void {
  const bw = size * 0.8;
  const bh = size * 0.56;
  const by = cy + size * 0.46 - bh;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(cx - bw / 2, by, bw, bh, size * 0.13);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, size * 0.11);
  ctx.beginPath();
  ctx.arc(cx, by, size * 0.25, Math.PI, 0);
  ctx.stroke();
}

/** Share sheet: a box open at the top with an arrow rising out of it. */
function shareGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number,
): void {
  const w = size * 0.66;
  const bt = cy - size * 0.06;
  const bb = cy + size * 0.5;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, bt);
  ctx.lineTo(cx - w / 2, bb);
  ctx.lineTo(cx + w / 2, bb);
  ctx.lineTo(cx + w / 2, bt);
  ctx.stroke();
  const top = cy - size * 0.5;
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(cx, cy + size * 0.2);
  ctx.moveTo(cx - size * 0.2, top + size * 0.2);
  ctx.lineTo(cx, top);
  ctx.lineTo(cx + size * 0.2, top + size * 0.2);
  ctx.stroke();
}

/** Tab overview: two overlapping rounded squares. */
function tabsGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number,
): void {
  const s = size * 0.7;
  const off = size * 0.16;
  ctx.beginPath();
  ctx.roundRect(cx - s / 2 - off, cy - s / 2 - off, s, s, s * 0.2);
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(cx - s / 2 + off, cy - s / 2 + off, s, s, s * 0.2);
  ctx.stroke();
}

// ─── Style painters ──────────────────────────────────────────────────────

function drawMacos(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  opts: WindowChromeOptions,
): void {
  const p = palette(opts.theme);
  fillBar(ctx, x, y, w, h, p);

  const cy = y + h * 0.5;
  const btnRight = trafficLights(ctx, x + h * LIGHT_X, cy, h * LIGHT_D);
  const lead = btnRight - x;

  // Right limit mirrors the left cluster so the title reads optically centred
  // in the space actually available to it. `cy + h*0.02` nudges for the em box
  // sitting high against cap height under textBaseline 'middle'.
  // 0.34 h, not 0.42: sized to match the browser style's URL text so switching
  // between the three frames doesn't change how loud the chrome reads.
  centredTitle(
    ctx, opts.title, x, w, cy + h * 0.02,
    h * 0.34, 600, p.title,
    btnRight + h * 0.5, x + w - lead - h * 0.5,
  );
}

function drawWindows(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  opts: WindowChromeOptions,
): void {
  const p = palette(opts.theme);
  fillBar(ctx, x, y, w, h, p);

  const cellW = h * 1.45;
  const g = h * 0.3;
  const lw = Math.max(1, h * 0.05);
  const cy = y + h / 2;

  ctx.strokeStyle = p.glyph;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const minCx = x + w - cellW * 2.5;
  ctx.beginPath();
  ctx.moveTo(minCx - g / 2, cy);
  ctx.lineTo(minCx + g / 2, cy);
  ctx.stroke();

  const maxCx = x + w - cellW * 1.5;
  ctx.beginPath();
  ctx.roundRect(maxCx - g / 2, cy - g / 2, g, g, lw);
  ctx.stroke();

  cross(ctx, x + w - cellW * 0.5, cy, g);
  ctx.lineCap = 'butt';

  centredTitle(
    ctx, opts.title, x, w, cy,
    h * 0.34, 400, p.title,
    x + h * 0.6, x + w - cellW * 3 - h * 0.5,
  );
}

/**
 * Safari on macOS, one toolbar row. Layout and spacing traced off the Mojave
 * Dark reference, in fractions of the toolbar height:
 *
 *   ● ● ●   ‹ ›   ◨          [  dominio.com        ↻ ]          ⬆  ⧉  +
 *
 * Order matters and is easy to get subtly wrong: back/forward come BEFORE the
 * sidebar toggle, and on the right it's share → tabs → new-tab. The address
 * field is centred on the window and holds the URL centred with reload pinned
 * inside its right edge — no padlock and no "aA" button, matching the reference.
 */
function drawBrowser(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  opts: WindowChromeOptions,
): void {
  const p = palette(opts.theme);
  fillBar(ctx, x, y, w, h, p);

  const cy = y + h * 0.5;
  // Safari's toolbar glyphs are light strokes, not UI-kit slabs — but the bar
  // itself has since got thinner, and 0.03 of it left them too faint to read
  // once the preview downscales the canvas. This is the floor for legibility.
  const lw = Math.max(1, h * 0.04);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // ── left cluster: lights, sidebar button, back/forward capsule ──
  // Sonoma groups the toolbar buttons into recessed rounded controls: the
  // sidebar toggle carries its own pill with a caret, and back/forward share a
  // single capsule split by a divider.
  const btnRight = trafficLights(ctx, x + h * LIGHT_X, cy, h * LIGHT_D);

  const ctrlH = h * 0.62;
  const ctrlY = cy - ctrlH / 2;

  const sbW = h * 1.12;
  const sbX = btnRight + h * 0.4;
  controlPill(ctx, sbX, ctrlY, sbW, ctrlH, p.controlBg);
  ctx.strokeStyle = p.glyph;
  ctx.lineWidth = lw;
  sidebarGlyph(ctx, sbX + h * 0.38, cy, h * 0.3);
  chevronDown(ctx, sbX + h * 0.82, cy, h * 0.16);

  const navW = h * 1.5;
  const navX = sbX + sbW + h * 0.3;
  controlPill(ctx, navX, ctrlY, navW, ctrlH, p.controlBg);
  const navBox = h * 0.26;
  chevron(ctx, navX + navW * 0.27, cy, navBox, -1);
  ctx.globalAlpha = 0.38; // forward is greyed out on a fresh page, as in Safari
  chevron(ctx, navX + navW * 0.73, cy, navBox, 1);
  ctx.globalAlpha = 1;
  // divider between the two halves of the capsule
  ctx.fillStyle = p.glyph;
  ctx.globalAlpha = 0.28;
  ctx.fillRect(navX + navW / 2 - lw / 2, ctrlY + ctrlH * 0.22, lw, ctrlH * 0.56);
  ctx.globalAlpha = 1;
  const leftEnd = navX + navW;

  // ── right cluster: share, +, tabs (Sonoma's order) ──
  const rGap = h * 0.8;
  const rGlyph = h * 0.3;
  const tabsCx = x + w - h * 0.5;
  const plusCx = tabsCx - rGap;
  const shareCx = plusCx - rGap;
  tabsGlyph(ctx, tabsCx, cy, rGlyph);
  plus(ctx, plusCx, cy, rGlyph * 0.72);
  shareGlyph(ctx, shareCx, cy, rGlyph);

  // ── address field: centred on the window, clamped between the clusters ──
  const fH = ctrlH;
  const fY = ctrlY;
  const leftLimit = leftEnd + h * 0.3;
  const rightLimit = shareCx - rGap * 0.6;
  const fW = Math.min(w * 0.44, rightLimit - leftLimit);
  if (fW > fH * 2) {
    const fX = Math.min(Math.max(leftLimit, x + (w - fW) / 2), rightLimit - fW);
    controlPill(ctx, fX, fY, fW, fH, p.controlBg);

    // page menu pinned inside the left edge, reload inside the right edge
    ctx.strokeStyle = p.glyph;
    ctx.lineWidth = lw;
    pageMenuGlyph(ctx, fX + fH * 0.62, cy, fH * 0.34);
    ctx.strokeStyle = p.fieldText;
    ctx.lineWidth = Math.max(1, fH * 0.07);
    reloadGlyph(ctx, fX + fW - fH * 0.62, cy, fH * 0.46, p.fieldText);

    // Padlock + URL as one group, centred in the field and kept clear of the
    // reload button, so a long URL truncates instead of colliding with it.
    const url = (opts.url ?? '').trim();
    if (url) {
      const fontPx = snap(fH * 0.46);
      ctx.font = `400 ${fontPx}px ${TITLE_FONT}`;
      const lockW = fH * 0.42;
      const lockGap = fH * 0.2;
      const inset = fH * 1.15;
      const text = ellipsize(ctx, url, Math.max(0, fW - inset * 2 - lockW - lockGap));
      if (text) {
        const total = lockW + lockGap + ctx.measureText(text).width;
        const startX = fX + fW / 2 - total / 2;
        padlock(ctx, startX + lockW / 2, cy, lockW, p.fieldText);
        leftText(
          ctx, text, startX + lockW + lockGap, cy,
          Number.POSITIVE_INFINITY, fontPx, 400, p.fieldText,
        );
      }
    }
  }
  ctx.lineCap = 'butt';
}

/**
 * Paint the window chrome. `(x, y, w, h)` is the BAR STRIP only — the video
 * starts at `y + h`. The caller owns the card's rounded clip and its shadow.
 */
export function drawWindowChrome(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  opts: WindowChromeOptions,
): void {
  if (h <= 0 || w <= 0 || opts.style === 'none') return;
  ctx.save();
  switch (opts.style) {
    case 'macos':
      drawMacos(ctx, x, y, w, h, opts);
      break;
    case 'browser':
      drawBrowser(ctx, x, y, w, h, opts);
      break;
    case 'windows':
      drawWindows(ctx, x, y, w, h, opts);
      break;
  }
  ctx.restore();
}
