import { Texture } from 'pixi.js';
import pointerSvgUrl from '../assets/pointer-cursor.svg';

export type CursorShape = 'arrow' | 'dot' | 'ring';

export interface CursorSprite {
  texture: Texture;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
}

const SPRITE_RESOLUTION = 256;
const SVG_VIEWBOX = { width: 618, height: 958 };
// Tip of the cursor inside the SVG's viewBox coordinates.
const SVG_HOTSPOT = { x: 53, y: 37 };

function dataUrlToTexture(dataUrl: string): Texture {
  const img = new Image();
  img.src = dataUrl;
  return Texture.from(img);
}

let svgPointerPromise: Promise<CursorSprite> | null = null;

/**
 * Load the SVG pointer at src/assets/pointer-cursor.svg, rasterize it to
 * a canvas at SPRITE_RESOLUTION height (preserving aspect), and wrap it as
 * a PixiJS Texture. Cached after first call.
 */
export function loadSvgPointerSprite(): Promise<CursorSprite> {
  if (svgPointerPromise) return svgPointerPromise;
  svgPointerPromise = (async () => {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Failed to load ${pointerSvgUrl}`));
      img.src = pointerSvgUrl;
    });

    const aspect = SVG_VIEWBOX.width / SVG_VIEWBOX.height;
    const h = SPRITE_RESOLUTION;
    const w = Math.max(1, Math.round(h * aspect));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.drawImage(img, 0, 0, w, h);

    return {
      texture: Texture.from(canvas),
      width: w,
      height: h,
      hotspotX: SVG_HOTSPOT.x / SVG_VIEWBOX.width,
      hotspotY: SVG_HOTSPOT.y / SVG_VIEWBOX.height,
    };
  })();
  return svgPointerPromise;
}

function arrowPath(ctx: CanvasRenderingContext2D, size: number): void {
  // Arrow geometry centered with the tip at the upper-left third of the
  // canvas (matches the hotspot below). Coordinates are tuned for a balanced
  // shape rather than copied from any system cursor.
  const tipX = size * 0.225;
  const tipY = size * 0.075;
  const w = size * 0.46;
  const h = size * 0.7;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);                                    // tip
  ctx.lineTo(tipX, tipY + h);                                // left edge
  ctx.lineTo(tipX + w * 0.32, tipY + h * 0.78);              // notch into tail
  ctx.lineTo(tipX + w * 0.50, tipY + h);                     // tail bottom-left
  ctx.lineTo(tipX + w * 0.66, tipY + h * 0.94);              // tail bottom-right
  ctx.lineTo(tipX + w * 0.46, tipY + h * 0.72);              // notch up
  ctx.lineTo(tipX + w * 0.94, tipY + h * 0.72);              // back to right edge
  ctx.closePath();
}

function paintArrow(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Soft ambient drop shadow — gives weight without a hard edge.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = size * 0.10;
  ctx.shadowOffsetY = size * 0.020;
  arrowPath(ctx, size);
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.restore();

  // Dark outline behind the white fill — keeps the cursor legible on any
  // background. Slightly thicker than the visible stroke so anti-aliasing
  // doesn't eat into the white.
  arrowPath(ctx, size);
  ctx.lineWidth = size * 0.06;
  ctx.strokeStyle = 'rgba(20, 22, 32, 0.95)';
  ctx.stroke();

  // White fill with a subtle vertical gradient — top is bright, bottom
  // gently cooler, gives the arrow a touch of dimensionality.
  const fill = ctx.createLinearGradient(0, 0, 0, size);
  fill.addColorStop(0, '#ffffff');
  fill.addColorStop(0.6, '#f7f8fb');
  fill.addColorStop(1, '#e7eaf0');
  arrowPath(ctx, size);
  ctx.fillStyle = fill;
  ctx.fill();

  // Specular highlight along the upper-left edge — clipped to the arrow.
  ctx.save();
  arrowPath(ctx, size);
  ctx.clip();
  const hl = ctx.createLinearGradient(size * 0.2, 0, size * 0.5, size * 0.6);
  hl.addColorStop(0, 'rgba(255,255,255,0.85)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();

  ctx.restore();
}

function paintDot(ctx: CanvasRenderingContext2D, size: number): void {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.22;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = size * 0.08;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = size * 0.05;
  ctx.strokeStyle = 'rgba(15, 18, 30, 0.85)';
  ctx.stroke();
  ctx.restore();
}

function paintRing(ctx: CanvasRenderingContext2D, size: number): void {
  const cx = size / 2;
  const cy = size / 2;
  const ringR = size * 0.34;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = size * 0.06;
  ctx.lineWidth = size * 0.06;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

const PAINTERS: Record<CursorShape, (ctx: CanvasRenderingContext2D, size: number) => void> = {
  arrow: paintArrow,
  dot: paintDot,
  ring: paintRing,
};

const HOTSPOTS: Record<CursorShape, { x: number; y: number }> = {
  arrow: { x: 0.225, y: 0.075 },
  dot: { x: 0.5, y: 0.5 },
  ring: { x: 0.5, y: 0.5 },
};

const cache = new Map<CursorShape, CursorSprite>();

export function getCursorSprite(shape: CursorShape): CursorSprite {
  const cached = cache.get(shape);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_RESOLUTION;
  canvas.height = SPRITE_RESOLUTION;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  PAINTERS[shape](ctx, SPRITE_RESOLUTION);

  const sprite: CursorSprite = {
    texture: dataUrlToTexture(canvas.toDataURL('image/png')),
    width: SPRITE_RESOLUTION,
    height: SPRITE_RESOLUTION,
    hotspotX: HOTSPOTS[shape].x,
    hotspotY: HOTSPOTS[shape].y,
  };
  cache.set(shape, sprite);
  return sprite;
}
