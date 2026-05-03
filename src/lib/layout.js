/**
 * Shared geometry helpers used by the renderer (canvas drawing) and the
 * crop overlay (DOM positioning) so both stay in lockstep.
 */

export const PREVIEW_PADDING_SCALE = 0.94;
export const FULL_CROP = { x: 0, y: 0, width: 1, height: 1 };
export const MIN_CROP_NORM = 0.05;

export function computeInsetRect(canvasW, canvasH, sourceW, sourceH, paddingScale = PREVIEW_PADDING_SCALE) {
  const fit = Math.min(canvasW / sourceW, canvasH / sourceH) * paddingScale;
  const baseW = sourceW * fit;
  const baseH = sourceH * fit;
  return {
    fit,
    baseW,
    baseH,
    baseX: (canvasW - baseW) / 2,
    baseY: (canvasH - baseH) / 2
  };
}

export function isFullCrop(crop) {
  if (!crop) return true;
  return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
}

export function clampCrop(crop) {
  const x = Math.min(1 - MIN_CROP_NORM, Math.max(0, crop.x));
  const y = Math.min(1 - MIN_CROP_NORM, Math.max(0, crop.y));
  const width = Math.min(1 - x, Math.max(MIN_CROP_NORM, crop.width));
  const height = Math.min(1 - y, Math.max(MIN_CROP_NORM, crop.height));
  return { x, y, width, height };
}
