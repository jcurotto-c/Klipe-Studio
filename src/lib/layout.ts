import type { Crop, FitMode } from '../types';

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

export interface SourceInset {
  /** Wrapper-normalized [0..1] rect where the visible source content sits. */
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the visible source sits inside the preview wrapper, as wrapper-normalized
 * fractions [0..1]. Mirrors the renderer's transform so overlay handles and click
 * targets land on the same pixels the renderer draws to. Shared by the BlurOverlay
 * (handle geometry) and the zoom-placement overlay so they can't drift apart.
 *   - Aspect-matched: source is letterboxed by `paddingScale` on all sides.
 *   - Cross-aspect 'fill': source is cover-fit, overflowing on the long axis.
 *   - Cross-aspect 'fit': source is contained (computeInsetRect) and centred.
 */
export function computeSourceInset(
  sourceWidth: number,
  sourceHeight: number,
  aspectRatio: number | null | undefined,
  fitMode: FitMode,
  paddingScale: number = PREVIEW_PADDING_SCALE,
): SourceInset {
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect =
    aspectRatio && isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : sourceAspect;
  const crossAspect = Math.abs(targetAspect - sourceAspect) > CROSS_ASPECT_EPSILON;
  if (crossAspect && fitMode === 'fill') {
    if (sourceAspect > targetAspect) {
      const w = sourceAspect / targetAspect;
      return { left: (1 - w) / 2, top: 0, width: w, height: 1 };
    }
    const h = targetAspect / sourceAspect;
    return { left: 0, top: (1 - h) / 2, width: 1, height: h };
  }
  if (crossAspect) {
    if (sourceAspect > targetAspect) {
      const height = paddingScale * (targetAspect / sourceAspect);
      return { left: (1 - paddingScale) / 2, top: (1 - height) / 2, width: paddingScale, height };
    }
    const width = paddingScale * (sourceAspect / targetAspect);
    return { left: (1 - width) / 2, top: (1 - paddingScale) / 2, width, height: paddingScale };
  }
  const m = (1 - paddingScale) / 2;
  return { left: m, top: m, width: paddingScale, height: paddingScale };
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
