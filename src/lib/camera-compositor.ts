/**
 * Composites a webcam frame with a replaced background (blur or image), for the
 * editor's camera disc. Returns a canvas the caller draws in place of the raw
 * camera source; `drawCameraOverlay` treats it identically (it already accepts
 * a canvas), so the disc shape, mirror, cover-fit and border are unchanged.
 *
 * One implementation covers both paths of the renderer's dual contract:
 *   - preview passes an HTMLVideoElement
 *   - export passes a decoded VideoFrame
 * The source is only ever touched via drawImage, and the segmenter only ever
 * sees the internal work canvas — never the raw source — so neither path needs
 * special handling.
 *
 * All canvases are module-level and reused; nothing is allocated per frame.
 */

import type { CameraBackground } from '../types';
import { getCachedImage } from './renderer';
import { segmentMask } from './camera-segmenter';

/**
 * The disc is at most ~34% of a 1920-wide canvas (~650px), so compositing at
 * 640px wide is plenty and roughly halves the per-frame fill cost versus the
 * camera's native 1280px.
 */
const MAX_WORK_W = 640;

/** Blur is done at 1/4 scale (radius/4) then upscaled — Canvas2D blur is
 *  CPU-bound at full resolution, and the downscale IS part of the blur. */
const BLUR_SCALE = 4;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const workCanvas = makeCanvas(2, 2);   // camera frame, masked to the person
const maskCanvas = makeCanvas(2, 2);   // upload target for the mask alpha
const blurCanvas = makeCanvas(2, 2);   // 1/4-scale scratch for the blur
const outCanvas = makeCanvas(2, 2);    // final: background + masked person

const workCtx = workCanvas.getContext('2d')!;
const maskCtx = maskCanvas.getContext('2d')!;
const blurCtx = blurCanvas.getContext('2d')!;
const outCtx = outCanvas.getContext('2d', { alpha: false })!;

function sizeTo(canvas: HTMLCanvasElement, w: number, h: number): void {
  // Assigning width/height clears the canvas, so only do it on a real change.
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function sourceDims(source: HTMLVideoElement | VideoFrame): { w: number; h: number } | null {
  if (source instanceof HTMLVideoElement) {
    return source.videoWidth > 0 && source.videoHeight > 0
      ? { w: source.videoWidth, h: source.videoHeight }
      : null;
  }
  return source.displayWidth > 0 && source.displayHeight > 0
    ? { w: source.displayWidth, h: source.displayHeight }
    : null;
}

/**
 * Returns a canvas with the background replaced, at camera dims (capped to
 * MAX_WORK_W). Returns null — meaning "draw the raw source" — when there's
 * nothing to do or nothing is ready: background none/absent, segmenter not
 * ready, source has no dimensions yet, or an image background hasn't decoded.
 *
 * The canvas is owned by this module and reused across frames: draw it
 * synchronously, don't retain it.
 */
export function composeCameraFrame(
  source: HTMLVideoElement | VideoFrame,
  bg: CameraBackground | undefined,
): HTMLCanvasElement | null {
  if (!bg || bg.type === 'none') return null;

  const dims = sourceDims(source);
  if (!dims) return null;

  const scale = Math.min(1, MAX_WORK_W / dims.w);
  const workW = Math.max(2, Math.round(dims.w * scale));
  const workH = Math.max(2, Math.round(dims.h * scale));

  // For an image background, bail early (raw camera) if it hasn't decoded yet.
  let bgImage: CanvasImageSource | null = null;
  if (bg.type === 'image') {
    const entry = getCachedImage(bg.src);
    if (!entry || !entry.ready) return null;
    bgImage = entry.img;
  }

  sizeTo(workCanvas, workW, workH);
  workCtx.globalCompositeOperation = 'source-over';
  workCtx.clearRect(0, 0, workW, workH);
  workCtx.drawImage(source, 0, 0, workW, workH);

  // Segment the work canvas (an HTMLCanvasElement is always a valid ImageSource).
  const mask = segmentMask(workCanvas);
  if (!mask) return null;

  // Paint the mask's person-alpha into maskCanvas, then keep only the person
  // pixels of the work canvas via destination-in. The browser's bilinear
  // upscale of the small mask softens the cutout edge for free.
  sizeTo(maskCanvas, mask.width, mask.height);
  const imageData = maskCtx.createImageData(mask.width, mask.height);
  const px = imageData.data;
  const m = mask.data;
  for (let i = 0, j = 3; i < m.length; i++, j += 4) {
    px[j] = m[i]!; // 255 = person → opaque; 0 = background → transparent
  }
  maskCtx.putImageData(imageData, 0, 0);

  workCtx.globalCompositeOperation = 'destination-in';
  workCtx.drawImage(maskCanvas, 0, 0, workW, workH);
  workCtx.globalCompositeOperation = 'source-over';

  // Compose: background first, masked person on top.
  sizeTo(outCanvas, workW, workH);
  outCtx.globalCompositeOperation = 'source-over';
  outCtx.filter = 'none';

  if (bg.type === 'blur') {
    const bw = Math.max(1, Math.round(workW / BLUR_SCALE));
    const bh = Math.max(1, Math.round(workH / BLUR_SCALE));
    sizeTo(blurCanvas, bw, bh);
    blurCtx.clearRect(0, 0, bw, bh);
    blurCtx.drawImage(source, 0, 0, bw, bh);
    const radius = (Math.max(0, Math.min(100, bg.amount)) / 100) * workW * 0.06;
    outCtx.filter = radius > 0 ? `blur(${radius / BLUR_SCALE}px)` : 'none';
    outCtx.drawImage(blurCanvas, 0, 0, workW, workH);
    outCtx.filter = 'none';
  } else if (bgImage) {
    drawCover(outCtx, bgImage, workW, workH);
  }

  outCtx.drawImage(workCanvas, 0, 0, workW, workH);
  return outCanvas;
}

/** Cover-fit an image source over the whole output canvas (center-cropped). */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  w: number,
  h: number,
): void {
  const iw = (img as HTMLImageElement).naturalWidth || (img as HTMLImageElement).width || w;
  const ih = (img as HTMLImageElement).naturalHeight || (img as HTMLImageElement).height || h;
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * Waits for an image background to decode. Await before baking an export (the
 * mirror of renderer.ts's ensureBackgroundReady) so the first exported frames
 * aren't drawn with the raw camera while the image is still loading.
 */
export function ensureCameraBackgroundReady(bg: CameraBackground | undefined): Promise<void> {
  if (!bg || bg.type !== 'image' || !bg.src) return Promise.resolve();
  const entry = getCachedImage(bg.src);
  if (!entry || entry.ready) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const img = entry.img;
    if (img.complete && img.naturalWidth > 0) { resolve(); return; }
    const done = (): void => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  });
}
