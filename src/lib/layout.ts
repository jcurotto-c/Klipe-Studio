import type { Crop } from '../types';

export const PREVIEW_PADDING_SCALE = 0.94;
export const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1 };
export const MIN_CROP_NORM = 0.05;

/**
 * Aspect-difference tolerance above which an output aspect is treated as
 * "cross-aspect" (the source is letterboxed/cropped rather than rendered
 * 1:1). Shared by the renderer (fit/fill decision), the BlurOverlay (handle
 * geometry), and the editor (Fit/Fill toggle visibility) so all three agree
 * on exactly when the output crosses the source aspect.
 */
export const CROSS_ASPECT_EPSILON = 0.005;

export interface InsetRect {
  fit: number;
  baseW: number;
  baseH: number;
  baseX: number;
  baseY: number;
}

export function computeInsetRect(
  canvasW: number,
  canvasH: number,
  sourceW: number,
  sourceH: number,
  paddingScale: number = PREVIEW_PADDING_SCALE,
): InsetRect {
  const fit = Math.min(canvasW / sourceW, canvasH / sourceH) * paddingScale;
  const baseW = sourceW * fit;
  const baseH = sourceH * fit;
  return {
    fit,
    baseW,
    baseH,
    baseX: (canvasW - baseW) / 2,
    baseY: (canvasH - baseH) / 2,
  };
}

export function isFullCrop(crop: Crop | null | undefined): boolean {
  if (!crop) return true;
  return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
}

export function clampCrop(crop: Crop): Crop {
  const x = Math.min(1 - MIN_CROP_NORM, Math.max(0, crop.x));
  const y = Math.min(1 - MIN_CROP_NORM, Math.max(0, crop.y));
  const width = Math.min(1 - x, Math.max(MIN_CROP_NORM, crop.width));
  const height = Math.min(1 - y, Math.max(MIN_CROP_NORM, crop.height));
  return { x, y, width, height };
}
