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

export interface ChromedInsetRect extends InsetRect {
  /** Title-bar strip height in canvas px. 0 when `barRatio` is 0. */
  barH: number;
  /** Top of the WHOLE card (bar + video). Equals `baseY` when `barH` is 0. */
  winY: number;
  /** Height of the whole card. Equals `baseH` when `barH` is 0. */
  winH: number;
}

/**
 * Inset rect for a source drawn inside an optional window-chrome card.
 *
 * The bar grows UPWARD into the vertical margin rather than shrinking the
 * video: at ordinary paddings the video keeps the exact size it has with no
 * chrome, so turning the chrome on doesn't suddenly expose a band of
 * background down each side. The whole CARD (bar + video) is scaled down only
 * when it would outgrow the canvas — and at that limit this reduces exactly to
 * `computeInsetRect(canvasW, canvasH, sourceW, sourceH + sourceW * barRatio)`,
 * so the video size is continuous as the padding slider crosses the threshold.
 *
 * The returned baseX/baseY/baseW/baseH is the VIDEO rect only and always keeps
 * the source's exact aspect. `barRatio === 0` is exactly `computeInsetRect`.
 */
export function computeChromedInsetRect(
  canvasW: number,
  canvasH: number,
  sourceW: number,
  sourceH: number,
  paddingScale: number = PREVIEW_PADDING_SCALE,
  barRatio: number = 0,
): ChromedInsetRect {
  const v = computeInsetRect(canvasW, canvasH, sourceW, sourceH, paddingScale);
  if (barRatio <= 0) {
    return { ...v, barH: 0, winY: v.baseY, winH: v.baseH };
  }
  // Shrink only by what's needed to keep the card inside the canvas height.
  // Width can't bind: the card is exactly as wide as the video, which the
  // padded inset already fits.
  const s = Math.min(1, canvasH / (v.baseH + v.baseW * barRatio));
  const baseW = v.baseW * s;
  const baseH = v.baseH * s;
  const barH = baseW * barRatio;
  const winH = baseH + barH;
  const winY = (canvasH - winH) / 2;
  return {
    fit: v.fit * s,
    baseX: (canvasW - baseW) / 2,
    baseY: winY + barH,
    baseW,
    baseH,
    barH,
    winY,
    winH,
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
 * targets land on the same pixels the renderer draws to. Used by the BlurOverlay
 * for its handle geometry.
 *   - Aspect-matched: source is letterboxed by `paddingScale` on all sides.
 *   - Cross-aspect 'fill': source is cover-fit, overflowing on the long axis.
 *   - Cross-aspect 'fit': source is contained (computeInsetRect) and centred.
 * With window chrome the returned rect is the video BELOW the bar, and the bar
 * eats into the vertical margin rather than shrinking the video — see
 * `computeChromedInsetRect`, which this mirrors exactly.
 */
export function computeSourceInset(
  sourceWidth: number,
  sourceHeight: number,
  aspectRatio: number | null | undefined,
  fitMode: FitMode,
  paddingScale: number = PREVIEW_PADDING_SCALE,
  /** Window-chrome bar height ÷ card width. 0 = no chrome (default). */
  barRatio: number = 0,
): SourceInset {
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect =
    aspectRatio && isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : sourceAspect;
  const crossAspect = Math.abs(targetAspect - sourceAspect) > CROSS_ASPECT_EPSILON;
  if (crossAspect && fitMode === 'fill') {
    // The renderer skips chrome in fill mode (it bleeds past the canvas edges),
    // so `barRatio` is ignored here too.
    if (sourceAspect > targetAspect) {
      const w = sourceAspect / targetAspect;
      return { left: (1 - w) / 2, top: 0, width: w, height: 1 };
    }
    const h = targetAspect / sourceAspect;
    return { left: 0, top: (1 - h) / 2, width: 1, height: h };
  }
  // Contain. This is `computeChromedInsetRect` rewritten in wrapper-normalized
  // units (the canvas taken as frameAspect × 1); the two MUST agree exactly or
  // the overlay handles drift off the pixels the renderer draws. At barRatio 0
  // it reduces to the three cases it replaced.
  const frameAspect = crossAspect ? targetAspect : sourceAspect;
  const fit = Math.min(frameAspect / sourceAspect, 1) * paddingScale;
  const s = barRatio > 0
    ? Math.min(1, 1 / (fit * (1 + sourceAspect * barRatio)))
    : 1;
  const width = (sourceAspect * fit * s) / frameAspect;
  const height = fit * s;
  // Bar height as a wrapper-normalized fraction: (width · frameAspect) · barRatio.
  const barNorm = width * barRatio * frameAspect;
  return {
    left: (1 - width) / 2,
    top: (1 - (height + barNorm)) / 2 + barNorm,
    width,
    height,
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
