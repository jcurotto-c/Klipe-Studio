/**
 * Overlay layers — text and image elements drawn on top of the Editor's
 * video composition.
 *
 * All positional values are stored in **fractional canvas units** so overlays
 * survive aspect-ratio changes:
 *   x, y           — 0 = top/left edge, 1 = bottom/right edge of the canvas
 *   sizeRel        — text height as a fraction of canvas height
 *   widthRel/heightRel for images — long-edge as fraction of canvas height
 *
 * Other values stay in their natural units:
 *   scale          — multiplicative, 1.0 = native
 *   rotation       — radians
 *   opacity        — 0..1
 *   blur           — pixel strength
 *
 * Times are in milliseconds, in the editor's **output-time** space (the same
 * clock the timeline uses — not the raw source-video time).
 */

export type Easing =
  | 'linear'
  | 'easeOutQuint'
  | 'easeInOutCubic'
  | 'easeOutExpo'
  | 'easeOutBack'
  | 'spring';

export interface Keyframe<T> {
  t: number;
  value: T;
  easing?: Easing;
}

export interface NumberTrack { keys: Keyframe<number>[]; }

export interface Vec2 { x: number; y: number; }

export interface VecTrack { keys: Keyframe<Vec2>[]; }

export interface OverlayTransform {
  position?: VecTrack;
  scale?: NumberTrack;
  rotation?: NumberTrack;
  opacity?: NumberTrack;
  blur?: NumberTrack;
}

export interface OverlayBase {
  /** Fractional canvas coords, 0..1. */
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  blur: number;
}

export interface IdleFloat {
  /** Wobble amplitudes in fractional canvas units (0..0.2 typical). */
  ampX: number;
  ampY: number;
  periodX: number;
  periodY: number;
  phase: number;
}

export interface Typewriter {
  startMs: number;
  charsPerSecond: number;
}

interface OverlayCommon {
  id: string;
  name?: string;
  z: number;
  /** Visibility window in output-time ms. Undefined = always visible. */
  visibleFrom?: number;
  visibleTo?: number;
  hidden?: boolean;
  idle?: IdleFloat;
  base: OverlayBase;
  transform: OverlayTransform;
}

export interface TextOverlay extends OverlayCommon {
  type: 'text';
  text: string;
  /** Fraction of canvas height. 0.06 ≈ 6% of canvas height. */
  sizeRel: number;
  color: string;
  weight?: number;
  letterSpacing?: number;
  align?: 'left' | 'center' | 'right';
  /** Render the text in UPPERCASE (raw `text` is preserved). */
  uppercase?: boolean;
  /** Force the legibility drop-shadow on/off, overriding the stage default
   * (off for card text, on for body overlays over video). */
  shadow?: boolean;
  /** Font id from the card font registry (src/overlays/fonts.ts). Takes
   * precedence over `mono`; absent → default (Inter), or JetBrains Mono if
   * `mono` is set (legacy, pre-picker). */
  fontFamily?: string;
  mono?: boolean;
  /** Card-editor entrance animation id (fade | rise | zoom | blur | typewriter).
   * Editor metadata — the actual motion lives in `transform`/`typewriter`. */
  anim?: string;
  typewriter?: Typewriter;
  /** Wrap text to multiple lines once it exceeds this fraction of canvas WIDTH.
   * Absent → no wrapping (single overflowing line, the historical behaviour).
   * Used by captions for the 1–2-line classic-subtitle look. */
  wordWrapRel?: number;
  /** Outline stroke for legibility over busy video. Absent → none. */
  stroke?: { color: string; width: number };
  /** Rounded-rect background pill drawn behind the text. Absent → none.
   * `padRel` is padding as a fraction of the font size. */
  box?: { color: string; opacity: number; padRel: number };
}

export interface ImageOverlay extends OverlayCommon {
  type: 'image';
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  /** Long-edge as fraction of canvas height. */
  sizeRel: number;
}

export type Overlay = TextOverlay | ImageOverlay;
