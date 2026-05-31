import { Texture } from 'pixi.js';
import pointerSvgUrl from '../assets/pointer-cursor.svg';
import boneSvgUrl from '../assets/cartoon-bone.svg';
import handSvgUrl from '../assets/pointinghand_2.svg';
import resizeEwSvgUrl from '../assets/resizeeastwest.svg';
import resizeNsSvgUrl from '../assets/resizenorthsouth.svg';
import moveSvgUrl from '../assets/resizeleftright.svg';
import zoomInSvgUrl from '../assets/zoomin.svg';
import zoomOutSvgUrl from '../assets/zoomout.svg';

/**
 * Cursor shapes recognised by the render pipeline.
 *
 *   - 'arrow' / 'arrow-outline' / 'arrow-mini' / 'dot' / 'figma'
 *       User-selectable styles from the Cursor panel. These are painted
 *       procedurally to canvas so the editor preview and the exported video
 *       use byte-identical paths (renderer.ts:drawCursorShape uses the same
 *       coordinates).
 *
 *   - 'svg-*'
 *       OS-cursor-type overrides, rasterized from the SVG assets in
 *       src/assets. The captured `cursorType` (electron/main.ts) is mapped to
 *       one of these by renderer.ts:resolveCursorShape:
 *         text      → svg-bone       (typing in a field)
 *         pointer   → svg-hand       (hovering a clickable)
 *         resize-ew → svg-resize-ew  (↔ horizontal resize)
 *         resize-ns → svg-resize-ns  (↕ vertical resize)
 *         move      → svg-move       (4-way move / size-all)
 *       These trump the user-selected style for the duration of the type.
 *       'svg-zoom-in' / 'svg-zoom-out' (magnifier glyphs) are registered and
 *       can be rendered, but nothing resolves to them — Windows has no standard
 *       zoom cursor to detect, so they are intentionally never triggered.
 */
export type ProceduralShape =
  | 'arrow'
  | 'arrow-outline'
  | 'arrow-mini'
  | 'dot'
  | 'figma';

export type CursorShape =
  | ProceduralShape
  | 'svg-bone'
  | 'svg-hand'
  | 'svg-resize-ew'
  | 'svg-resize-ns'
  | 'svg-move'
  | 'svg-zoom-in'
  | 'svg-zoom-out';

export interface CursorSprite {
  texture: Texture;
  width: number;
  height: number;
  /**
   * Visible content height (in texture pixels). The Pixi overlay scales by
   * `contentTargetHeight / contentHeight` so every cursor shape — procedural
   * or SVG — renders at exactly the same on-screen height for the same
   * `contentTargetHeight`. This is the cure for shape-A-and-shape-B looking
   * different sizes when fed the same `r`.
   */
  contentHeight: number;
  /** Hotspot expressed as a fraction of width / height (0..1). */
  hotspotX: number;
  hotspotY: number;
}

const PROCEDURAL_RESOLUTION = 256;

/** Asset keys for the rasterizable SVG cursors. A `CursorShape` of the form
 *  `svg-<key>` maps to the entry of the same `<key>` here (see svgKeyForShape). */
type SvgCursorKey =
  | 'pointer'
  | 'bone'
  | 'hand'
  | 'resize-ew'
  | 'resize-ns'
  | 'move'
  | 'zoom-in'
  | 'zoom-out';

// SVG hotspots are tuned for the source viewBox of each asset. Adjust the
// constants below if the artwork is replaced. Hotspots are in viewBox units
// and stored as fractions (x / viewBox.width, y / viewBox.height).
//
//   pointer:     618 × 958,     arrow tip at (53, 37)
//   bone:        618 × 1350,    vertical I-beam → centred hotspot
//   hand:        618 × 767,     index finger pointing up → fingertip (264, 24)
//   resize-ew:   400 × 400,     ↔ double arrow → glyph centre
//   resize-ns:   400 × 400,     ↕ double arrow → glyph centre
//   move:        618 × 618,     4-way arrow → glyph centre
//   zoom-in/out: 618 × 618,     magnifier → lens centre (261, 232)
const SVG_META: Record<SvgCursorKey, {
  url: string;
  viewBox: { width: number; height: number };
  hotspot: { x: number; y: number };
}> = {
  pointer:     { url: pointerSvgUrl,  viewBox: { width: 618,        height: 958  }, hotspot: { x: 53,  y: 37  } },
  bone:        { url: boneSvgUrl,     viewBox: { width: 618,        height: 1350 }, hotspot: { x: 309, y: 675 } },
  hand:        { url: handSvgUrl,     viewBox: { width: 618,        height: 767  }, hotspot: { x: 264, y: 24  } },
  'resize-ew': { url: resizeEwSvgUrl, viewBox: { width: 400,        height: 400  }, hotspot: { x: 200, y: 200 } },
  'resize-ns': { url: resizeNsSvgUrl, viewBox: { width: 400,        height: 400  }, hotspot: { x: 200, y: 200 } },
  move:        { url: moveSvgUrl,     viewBox: { width: 618,        height: 618  }, hotspot: { x: 309, y: 309 } },
  'zoom-in':   { url: zoomInSvgUrl,   viewBox: { width: 618,        height: 618  }, hotspot: { x: 261, y: 232 } },
  'zoom-out':  { url: zoomOutSvgUrl,  viewBox: { width: 618,        height: 618  }, hotspot: { x: 261, y: 232 } },
};

/**
 * Map an `svg-*` CursorShape to its SVG_META key (`svg-resize-ew` →
 * `resize-ew`). Returns null for procedural shapes. Note that no CursorShape
 * resolves to the `pointer` key — it is reached only via loadSvgPointerSprite.
 */
function svgKeyForShape(shape: CursorShape): Exclude<SvgCursorKey, 'pointer'> | null {
  return shape.startsWith('svg-')
    ? (shape.slice(4) as Exclude<SvgCursorKey, 'pointer'>)
    : null;
}

/** Narrow a CursorShape to the procedurally-painted subset. */
function isProceduralShape(shape: CursorShape): shape is ProceduralShape {
  return !shape.startsWith('svg-');
}

const proceduralCache = new Map<CursorShape, CursorSprite>();
const svgCache = new Map<SvgCursorKey, CursorSprite>();
const svgPromises = new Map<SvgCursorKey, Promise<CursorSprite>>();

function rasterizeSvg(key: SvgCursorKey): Promise<CursorSprite> {
  const cached = svgPromises.get(key);
  if (cached) return cached;
  const meta = SVG_META[key];
  const promise = (async (): Promise<CursorSprite> => {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Failed to load ${meta.url}`));
      img.src = meta.url;
    });

    const aspect = meta.viewBox.width / meta.viewBox.height;
    const h = PROCEDURAL_RESOLUTION;
    const w = Math.max(1, Math.round(h * aspect));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.drawImage(img, 0, 0, w, h);

    const sprite: CursorSprite = {
      texture: Texture.from(canvas),
      width: w,
      height: h,
      // SVGs are rasterized to fill the canvas, so visible content equals
      // the texture height.
      contentHeight: h,
      hotspotX: meta.hotspot.x / meta.viewBox.width,
      hotspotY: meta.hotspot.y / meta.viewBox.height,
    };
    svgCache.set(key, sprite);
    return sprite;
  })();
  svgPromises.set(key, promise);
  return promise;
}

/**
 * Backwards-compatible export — older code paths request the SVG pointer
 * directly. Internally this is the same as `loadCursorSprite('svg-pointer')`
 * but kept under the original name to avoid cascading rename churn.
 */
export function loadSvgPointerSprite(): Promise<CursorSprite> {
  return rasterizeSvg('pointer');
}

/**
 * Async sprite loader. Procedural shapes resolve synchronously (the promise
 * is already settled by the time the caller awaits it); SVG shapes take one
 * trip through the image decoder on first request.
 */
export function loadCursorSprite(shape: CursorShape, tMs = 0): Promise<CursorSprite> {
  const key = svgKeyForShape(shape);
  if (key) return rasterizeSvg(key);
  return Promise.resolve(getCursorSprite(shape, tMs));
}

/**
 * Synchronous cache lookup for shapes that are already loaded. Returns null
 * for SVG shapes that haven't finished rasterizing yet — the caller should
 * fall back to a procedural shape until then.
 */
export function getCursorSpriteCached(shape: CursorShape, tMs = 0): CursorSprite | null {
  const key = svgKeyForShape(shape);
  if (key) return svgCache.get(key) ?? null;
  return getCursorSprite(shape, tMs);
}

// Shared painters — these mirror the geometry in renderer.ts:drawCursorShape
// so the procedural sprite (Pixi path) and the canvas blit (export path) draw
// the same shape pixel-for-pixel. The painter signature centres the cursor
// at canvas (hotspotX*size, hotspotY*size); each painter is responsible for
// drawing relative to that point.

function paintProceduralArrow(ctx: CanvasRenderingContext2D, size: number, filled: boolean): void {
  // Coordinates mirror renderer.ts:drawArrow. We pick `k` so the full path
  // (extents go to 15k × 21k from the tip plus a 1.5k vertical inset) fits
  // INSIDE the texture with a small margin — k = size / 24 keeps the tail
  // clear of the bottom edge for both filled and outline variants.
  const k = size / 24;
  ctx.save();
  // Drop shadow so the cursor reads on bright UIs, matching what the canvas
  // path does via shadowColor in drawCursorShape.
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = Math.max(2, k * 1.5);
  ctx.shadowOffsetY = Math.max(1, k * 0.5);
  ctx.translate(k, 1.5 * k); // align tip to (k, 1.5k) inside the texture
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
  ctx.restore();
}

function paintProceduralDot(ctx: CanvasRenderingContext2D, size: number): void {
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

function paintProceduralFigma(ctx: CanvasRenderingContext2D, size: number): void {
  // Mirrors renderer.ts:drawFigmaArrow. Path extends to 16k × 16k from the
  // hotspot at (k, k), so the full sprite needs k = size / 18 (margin for
  // the stroke + shadow).
  const k = size / 18;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = Math.max(2, k * 1.5);
  ctx.shadowOffsetY = Math.max(1, k * 0.5);
  ctx.translate(k, k); // hotspot offset inside texture
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
  ctx.restore();
}

const PROCEDURAL_PAINTERS: Record<
  ProceduralShape,
  (ctx: CanvasRenderingContext2D, size: number) => void
> = {
  'arrow':         (ctx, size) => paintProceduralArrow(ctx, size, true),
  'arrow-outline': (ctx, size) => paintProceduralArrow(ctx, size, false),
  'arrow-mini':    (ctx, size) => paintProceduralArrow(ctx, size * 0.85, true),
  'dot':           (ctx, size) => paintProceduralDot(ctx, size),
  'figma':         (ctx, size) => paintProceduralFigma(ctx, size),
};

// Per-shape texture metadata. `contentHeight` is the visible cursor height
// inside the (PROCEDURAL_RESOLUTION × PROCEDURAL_RESOLUTION) texture, used
// to scale the sprite to a consistent on-screen size. `hotspotX/Y` are
// texture-relative fractions where the cursor tip lands. Arrow-mini uses
// the painter's internal 0.85 down-scale, so its hotspot AND content height
// shrink correspondingly — earlier code reused the full-arrow constants
// here, which left the click point ~2 px off-tip.
const PROCEDURAL_META: Record<
  ProceduralShape,
  { hotspotX: number; hotspotY: number; contentHeight: number }
> = {
  'arrow':         { hotspotX: 1 / 24,        hotspotY: 1.5 / 24,        contentHeight: PROCEDURAL_RESOLUTION * 21 / 24 },
  'arrow-outline': { hotspotX: 1 / 24,        hotspotY: 1.5 / 24,        contentHeight: PROCEDURAL_RESOLUTION * 21 / 24 },
  'arrow-mini':    { hotspotX: 0.85 / 24,     hotspotY: 1.5 * 0.85 / 24, contentHeight: PROCEDURAL_RESOLUTION * 21 * 0.85 / 24 },
  'dot':           { hotspotX: 0.5,           hotspotY: 0.5,             contentHeight: PROCEDURAL_RESOLUTION * 0.44 },
  'figma':         { hotspotX: 1 / 18,        hotspotY: 1 / 18,          contentHeight: PROCEDURAL_RESOLUTION * 16 / 18 },
};

export function getCursorSprite(shape: CursorShape, _tMs = 0): CursorSprite {
  if (!isProceduralShape(shape)) {
    // Synchronous accessor returns the cached SVG if rasterization already
    // finished, otherwise falls back to the procedural arrow so the caller
    // never gets a missing texture.
    const key = svgKeyForShape(shape)!;
    const cached = svgCache.get(key);
    if (cached) return cached;
    // Kick off the load so the next call has it cached.
    void rasterizeSvg(key);
    return getCursorSprite('arrow');
  }

  const cached = proceduralCache.get(shape);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = PROCEDURAL_RESOLUTION;
  canvas.height = PROCEDURAL_RESOLUTION;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  PROCEDURAL_PAINTERS[shape](ctx, PROCEDURAL_RESOLUTION);

  const meta = PROCEDURAL_META[shape];
  // Build the texture directly from the canvas — synchronous, no waiting
  // for an Image element to decode a data URL. This was the bug that left
  // procedural shapes invisible: `Texture.from(<img src=dataUrl>)` did not
  // re-bind once the image decoded.
  const sprite: CursorSprite = {
    texture: Texture.from(canvas),
    width: PROCEDURAL_RESOLUTION,
    height: PROCEDURAL_RESOLUTION,
    contentHeight: meta.contentHeight,
    hotspotX: meta.hotspotX,
    hotspotY: meta.hotspotY,
  };
  proceduralCache.set(shape, sprite);
  return sprite;
}

/** Returns true once the SVG for the given shape has rasterized at least once. */
export function isSvgShapeLoaded(shape: CursorShape): boolean {
  const key = svgKeyForShape(shape);
  if (key) return svgCache.has(key);
  return true;
}

/**
 * Eagerly preload every SVG shape so the first time the cursor type changes
 * to text/pointer we don't show a one-frame flash of the procedural arrow.
 * Safe to call multiple times — subsequent calls return the cached promise.
 */
export function preloadSvgShapes(): Promise<void> {
  // Eagerly decode the OS-triggerable shapes so the first time the cursor type
  // changes we don't flash the procedural fallback. The zoom glyphs are left
  // lazy — nothing resolves to them.
  const keys: SvgCursorKey[] = ['pointer', 'bone', 'hand', 'resize-ew', 'resize-ns', 'move'];
  return Promise.all(keys.map((k) => rasterizeSvg(k)))
    .then(() => undefined)
    .catch((err) => {
      console.warn('[cursor-sprites] preload failed:', err);
    });
}
