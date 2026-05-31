import type { CameraShape } from '../types';

/**
 * Footprint aspect ratio (width ÷ height) for each camera shape. The renderer
 * draws the camera `size`% of the canvas WIDTH, then derives the height from
 * this ratio — so `circle` is square, `card` a landscape rectangle, and `pill`
 * a wide capsule. Shared by the renderer (actual draw) and CameraPanel (the
 * miniature stage preview) so the two always agree.
 */
export const CAMERA_SHAPE_ASPECT: Record<CameraShape, number> = {
  circle: 1,    // 1:1
  card: 1.5,    // 3:2
  pill: 2.5,    // 5:2
};

/**
 * Corner-roundness preset applied when a shape is picked. `circle`/`pill` go
 * fully round (perfect circle / capsule ends); `card` keeps soft corners. The
 * Roundness slider still fine-tunes from here, so this is only a sensible start.
 */
export const CAMERA_SHAPE_ROUNDNESS: Record<CameraShape, number> = {
  circle: 100,
  card: 24,
  pill: 100,
};

/**
 * Aspect for a possibly-absent/unknown shape. Legacy camera options (and old
 * projects) have no `shape` — those keep the original square footprint so their
 * recordings render exactly as before.
 */
export function cameraShapeAspect(shape: CameraShape | undefined | null): number {
  return (shape != null && CAMERA_SHAPE_ASPECT[shape]) || 1;
}
