/**
 * Canvas 2D primitives that compose a premium iPhone-style frame around the
 * phone screen content. No SVG, no images — every layer is paths and
 * gradients so the frame stays sharp at any resolution and bakes into export
 * for free when the renderer reads cameraSource/mobileSource the same way.
 *
 * Geometry constants chosen to match the modern iPhone (14/15/16 Pro family):
 * 19.5:9 body aspect, ~16% radius corners, dynamic-island ellipse.
 */

import type { MobileFinish, MobileDeviceId } from '../types';

// ─── Device specs ────────────────────────────────────────────────────────
//
// Each phone model is described purely as geometry ratios so the same drawing
// primitives render any chassis. Ratios are expressed against the BODY WIDTH
// (the binding dimension for a portrait phone) so they scale at any size.

/** Camera cutout style drawn over the top of the screen. */
export type MobileCutout = 'island' | 'notch' | 'punch-hole';
/** Side-button rail layout. */
export type MobileButtons = 'iphone' | 'samsung';

export interface MobileDeviceSpec {
  id: MobileDeviceId;
  /** Short name shown in the picker. */
  label: string;
  /** Body height / body width (portrait orientation). */
  aspect: number;
  /** Corner radius as a fraction of body width. */
  radiusRatio: number;
  /** Bezel thickness as a fraction of body width. */
  bezelRatio: number;
  cutout: MobileCutout;
  buttons: MobileButtons;
}

export const DEFAULT_MOBILE_DEVICE: MobileDeviceId = 'iphone-island';

export const MOBILE_DEVICES: Record<MobileDeviceId, MobileDeviceSpec> = {
  'iphone-island': {
    id: 'iphone-island',
    label: 'iPhone',
    aspect: 19.5 / 9,
    radiusRatio: 0.16,
    bezelRatio: 0.038,
    cutout: 'island',
    buttons: 'iphone',
  },
  'iphone-notch': {
    id: 'iphone-notch',
    label: 'iPhone (notch)',
    aspect: 19.5 / 9,
    radiusRatio: 0.15,
    bezelRatio: 0.045, // notch-era iPhones carry slightly chunkier bezels
    cutout: 'notch',
    buttons: 'iphone',
  },
  'samsung-galaxy': {
    id: 'samsung-galaxy',
    label: 'Galaxy',
    aspect: 20 / 9, // Galaxy panels read taller/narrower than an iPhone
    radiusRatio: 0.115, // flatter, less-rounded corners
    bezelRatio: 0.03, // very thin uniform bezel
    cutout: 'punch-hole',
    buttons: 'samsung',
  },
};

export function getMobileDevice(id: MobileDeviceId | null | undefined): MobileDeviceSpec {
  return MOBILE_DEVICES[id ?? DEFAULT_MOBILE_DEVICE] ?? MOBILE_DEVICES[DEFAULT_MOBILE_DEVICE];
}

/** Default body aspect (iPhone). Kept for callers that predate per-device specs. */
export const MOBILE_ASPECT = MOBILE_DEVICES['iphone-island'].aspect; // height / width

interface FinishStops {
  /** Body chassis vertical gradient stops. */
  body: ReadonlyArray<readonly [number, string]>;
  /** Side-button fill color. */
  button: string;
  /** Outer rim 1px highlight color. */
  rim: string;
}

const FINISHES: Record<MobileFinish, FinishStops> = {
  graphite: {
    body: [
      [0, '#1d1f24'],
      [0.42, '#2a2d34'],
      [0.55, '#15171b'],
      [1, '#0c0d11'],
    ],
    button: '#15171b',
    rim: 'rgba(255, 255, 255, 0.07)',
  },
  silver: {
    body: [
      [0, '#e9ecef'],
      [0.42, '#cfd4dc'],
      [0.55, '#9aa1ab'],
      [1, '#5f656e'],
    ],
    button: '#a8aeb8',
    rim: 'rgba(255, 255, 255, 0.35)',
  },
  gold: {
    body: [
      [0, '#f5e0bf'],
      [0.42, '#dcbf8c'],
      [0.55, '#9b7e4f'],
      [1, '#5d4a2e'],
    ],
    button: '#b29568',
    rim: 'rgba(255, 235, 200, 0.28)',
  },
  black: {
    body: [
      [0, '#111114'],
      [0.42, '#1a1a1f'],
      [0.55, '#08080a'],
      [1, '#020203'],
    ],
    button: '#08080a',
    rim: 'rgba(255, 255, 255, 0.05)',
  },
};

/** Path helper: rounded rect path on the current context. */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function drawDeviceBody(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, bodyRadius: number,
  finish: MobileFinish,
): void {
  const stops = FINISHES[finish] ?? FINISHES.graphite;
  const grad = ctx.createLinearGradient(x, y, x, y + h);
  for (const [offset, color] of stops.body) grad.addColorStop(offset, color);
  ctx.save();
  roundRectPath(ctx, x, y, w, h, bodyRadius);
  ctx.fillStyle = grad;
  ctx.fill();
  // Outer rim highlight — the polished chamfer catch.
  ctx.strokeStyle = stops.rim;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

export function drawSideButtons(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  finish: MobileFinish,
  layout: MobileButtons = 'iphone',
): void {
  const stops = FINISHES[finish] ?? FINISHES.graphite;
  const btnW = w * 0.018;
  const btnH = w * 0.085;
  const btnR = btnW * 0.6;
  ctx.save();
  ctx.fillStyle = stops.button;

  if (layout === 'samsung') {
    // Galaxy keeps every control on the RIGHT rail: a long volume rocker above
    // the power key. The left rail is clean.
    const rightX = x + w - btnW * 0.45;
    const volY = y + h * 0.17;
    const volH = btnH * 2.1;
    roundRectPath(ctx, rightX, volY, btnW, volH, btnR);
    ctx.fill();
    const powerY = volY + volH + btnH * 0.55;
    roundRectPath(ctx, rightX, powerY, btnW, btnH * 1.1, btnR);
    ctx.fill();
    ctx.restore();
    return;
  }

  // iPhone: left side (silent toggle, vol-up, vol-down).
  const silentY = y + h * 0.08;
  const volUpY = y + h * 0.155;
  const volDownY = volUpY + btnH * 1.55;
  const leftX = x - btnW * 0.55;
  roundRectPath(ctx, leftX, silentY, btnW, btnH * 0.55, btnR);
  ctx.fill();
  roundRectPath(ctx, leftX, volUpY, btnW, btnH, btnR);
  ctx.fill();
  roundRectPath(ctx, leftX, volDownY, btnW, btnH, btnR);
  ctx.fill();
  // Right side (power / action button).
  const powerY = y + h * 0.155;
  const rightX = x + w - btnW * 0.45;
  roundRectPath(ctx, rightX, powerY, btnW, btnH * 1.6, btnR);
  ctx.fill();
  ctx.restore();
}

/**
 * Draw the screen content with a soft inset shadow ring suggesting the
 * recessed bezel, then clip and draw whatever the caller supplies into the
 * passed-in callback.
 */
export function drawScreen(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  bodyRadius: number, bezelThickness: number,
  drawInside: (screenX: number, screenY: number, screenW: number, screenH: number) => void,
): void {
  const screenX = x + bezelThickness;
  const screenY = y + bezelThickness;
  const screenW = w - bezelThickness * 2;
  const screenH = h - bezelThickness * 2;
  const screenRadius = Math.max(0, bodyRadius - bezelThickness * 0.85);

  // Inner bezel ring — recessed feel.
  ctx.save();
  roundRectPath(
    ctx,
    x + bezelThickness * 0.5,
    y + bezelThickness * 0.5,
    w - bezelThickness,
    h - bezelThickness,
    Math.max(0, bodyRadius - bezelThickness * 0.4),
  );
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.lineWidth = bezelThickness * 0.5;
  ctx.stroke();
  ctx.restore();

  // Screen content (clipped).
  ctx.save();
  roundRectPath(ctx, screenX, screenY, screenW, screenH, screenRadius);
  ctx.clip();
  ctx.fillStyle = '#000';
  ctx.fillRect(screenX, screenY, screenW, screenH);
  drawInside(screenX, screenY, screenW, screenH);
  ctx.restore();
}

export function drawScreenHighlight(
  ctx: CanvasRenderingContext2D,
  screenX: number, screenY: number, screenW: number, screenH: number,
  bodyRadius: number, bezelThickness: number,
): void {
  const screenRadius = Math.max(0, bodyRadius - bezelThickness * 0.85);
  ctx.save();
  roundRectPath(ctx, screenX, screenY, screenW, screenH, screenRadius);
  ctx.clip();
  const grad = ctx.createLinearGradient(screenX, screenY, screenX, screenY + screenH * 0.32);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.085)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = grad;
  ctx.fillRect(screenX, screenY, screenW, screenH * 0.32);
  ctx.restore();
}

export function drawDynamicIsland(
  ctx: CanvasRenderingContext2D,
  bodyX: number, bodyY: number, bodyW: number,
  bezelThickness: number,
): void {
  const islandW = bodyW * 0.34;
  const islandH = bodyW * 0.094;
  const cx = bodyX + bodyW / 2;
  const cy = bodyY + bezelThickness * 1.4 + islandH / 2;
  const rx = islandW / 2;
  const ry = islandH / 2;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#000';
  ctx.fill();
  // Hint of the bezel between island and screen.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Two faint "sensor" dots sell the camera/proximity pill.
  ctx.fillStyle = 'rgba(20, 30, 40, 0.7)';
  const dotR = ry * 0.32;
  ctx.beginPath();
  ctx.arc(cx - rx * 0.55, cy, dotR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + rx * 0.55, cy, dotR * 0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Older-style notch alternative, drawn for devices whose cutout is 'notch'.
 * Kept simple — a top-anchored rounded pill.
 */
export function drawNotch(
  ctx: CanvasRenderingContext2D,
  bodyX: number, bodyY: number, bodyW: number,
  bezelThickness: number,
): void {
  const notchW = bodyW * 0.42;
  const notchH = bodyW * 0.058;
  const x = bodyX + (bodyW - notchW) / 2;
  const y = bodyY + bezelThickness * 0.4;
  const r = notchH / 2;
  ctx.save();
  ctx.fillStyle = '#000';
  roundRectPath(ctx, x, y, notchW, notchH, r);
  ctx.fill();
  ctx.restore();
}

/**
 * Galaxy-style centered punch-hole — a single small camera dot near the top of
 * the screen. Drawn when MobileDeviceSpec.cutout is 'punch-hole'.
 */
export function drawPunchHole(
  ctx: CanvasRenderingContext2D,
  bodyX: number, bodyY: number, bodyW: number,
  bezelThickness: number,
): void {
  const r = bodyW * 0.021;
  const cx = bodyX + bodyW / 2;
  const cy = bodyY + bezelThickness * 1.7 + r;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#000';
  ctx.fill();
  // Faint rim so the lens reads against dark screen content.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Tiny inner glint sells the lens.
  ctx.fillStyle = 'rgba(40, 60, 90, 0.7)';
  ctx.beginPath();
  ctx.arc(cx - r * 0.25, cy - r * 0.25, r * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Top-half specular sheen suggesting reflected room light. Cheap but reads
 * as "this is glass and metal, not flat color."
 */
export function drawTopSpecular(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, bodyRadius: number,
): void {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, bodyRadius);
  ctx.clip();
  ctx.beginPath();
  ctx.rect(x, y, w, h * 0.35);
  ctx.clip();
  roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, Math.max(0, bodyRadius - 0.5));
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}
