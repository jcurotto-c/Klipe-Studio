/**
 * Lazy, singleton wrapper around MediaPipe's selfie ImageSegmenter, used to
 * replace the webcam disc's background in the editor (preview + export).
 *
 * Loading under file:// (production): a renderer fetch() to a local path fails,
 * so we never let MediaPipe fetch its own assets. The WASM binary and the model
 * come through the `ml:read-asset` IPC channel as bytes; the binary is wrapped
 * in a blob: URL (allowed by connect-src), and the model goes straight into
 * `modelAssetBuffer` (no request at all). The loader .js is the one thing
 * MediaPipe still loads itself — as a <script src>, covered by script-src 'self'.
 *
 * Everything degrades to "not ready" (segmentMask → null) on any failure, so a
 * missing model or an unsupported machine just falls back to the raw camera.
 */

import type { ImageSegmenter as ImageSegmenterType } from '@mediapipe/tasks-vision';

/**
 * Inference backend. CPU (XNNPACK) on purpose: the compositor is Canvas2D and
 * needs the mask bytes on the CPU, so a GPU delegate would pay the gl.readPixels
 * readback that cancels its speed win — and it would spin up a third WebGL
 * context alongside PixiJS (OverlayStage). Flip to 'GPU' here to measure.
 */
const DELEGATE: 'CPU' | 'GPU' = 'CPU';

const WASM_BINARY = 'vision_wasm_internal.wasm';
const WASM_LOADER = 'vision_wasm_internal.js';
const MODEL = 'selfie_segmenter_landscape.tflite';

let segmenter: ImageSegmenterType | null = null;
let initPromise: Promise<boolean> | null = null;
let failed = false;

/**
 * Strictly increasing timestamp for segmentForVideo. MediaPipe rejects
 * non-monotonic timestamps, and it only uses them for ordering — so we drive it
 * with our own counter rather than the media time, which jumps backwards
 * whenever the user scrubs the timeline.
 */
let tsCounter = 1;

// Reused mask buffer so a 60fps render loop doesn't allocate every frame.
let maskBuf: Uint8Array | null = null;
let maskW = 0;
let maskH = 0;

/**
 * Index of the "person" channel among the confidence masks, resolved once from
 * the model's own labels at init. We use CONFIDENCE masks, not the category
 * mask: the category mask's polarity for selfie models is a known MediaPipe
 * quirk (it ships inverted in several runtime versions, which put the wallpaper
 * over the face), while the labeled confidence channel is unambiguous — and its
 * smooth 0..1 values give feathered hair edges for free instead of a hard
 * binary cutout. -1 → labels didn't identify one; use the last channel
 * (selfie models order channels [background, person]).
 */
let personChannel = -1;

/** Idempotent, lazy init. Resolves false if the model can't load (→ raw camera). */
export function ensureCameraSegmenter(): Promise<boolean> {
  if (segmenter) return Promise.resolve(true);
  if (failed) return Promise.resolve(false);
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let wasmBlobUrl: string | null = null;
    try {
      const klipe = window.klipe;
      if (!klipe) throw new Error('camera-segmenter: klipe bridge unavailable');
      const [{ ImageSegmenter }, wasmBytes, modelBytes] = await Promise.all([
        import('@mediapipe/tasks-vision'),
        klipe.ml.readAsset(WASM_BINARY),
        klipe.ml.readAsset(MODEL),
      ]);
      if (!wasmBytes || !modelBytes) throw new Error('camera-segmenter: missing WASM or model bytes');

      wasmBlobUrl = URL.createObjectURL(new Blob([new Uint8Array(wasmBytes)], { type: 'application/wasm' }));
      const fileset = {
        // Real file on disk (script-src 'self'); MediaPipe injects it as <script src>.
        wasmLoaderPath: new URL(`./mediapipe/${WASM_LOADER}`, document.baseURI).href,
        // blob: (connect-src); Emscripten fetches this via locateFile.
        wasmBinaryPath: wasmBlobUrl,
      };

      segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: new Uint8Array(modelBytes), delegate: DELEGATE },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
      const labels = segmenter.getLabels();
      personChannel = labels.findIndex((l) => /person|selfie|foreground/i.test(l));
      return true;
    } catch (err) {
      console.warn('[camera-segmenter] failed to initialize — camera background disabled:', err);
      failed = true;
      segmenter = null;
      return false;
    } finally {
      // The loader has read the binary by now; the blob can be released.
      if (wasmBlobUrl) URL.revokeObjectURL(wasmBlobUrl);
    }
  })();
  return initPromise;
}

/** True once segmentMask can return a mask. */
export function isSegmenterReady(): boolean {
  return segmenter !== null;
}

/**
 * Person mask for `source`, synchronously (fits the preview rAF and the export
 * loop). Returns null if not ready or on failure. The Uint8Array is owned by
 * this module and reused across calls — read it synchronously, don't retain it.
 *
 * The returned mask is person-alpha: 255 = person, 0 = background, with smooth
 * in-between values along edges (it's the model's confidence, not a binary cut).
 */
export function segmentMask(
  source: HTMLCanvasElement,
): { data: Uint8Array; width: number; height: number } | null {
  if (!segmenter) return null;
  let ok = false;
  try {
    segmenter.segmentForVideo(source, tsCounter++, (result) => {
      const masks = result.confidenceMasks;
      if (masks && masks.length > 0) {
        const idx = personChannel >= 0 && personChannel < masks.length
          ? personChannel
          : masks.length - 1;
        const m = masks[idx]!;
        const conf = m.getAsFloat32Array();
        maskW = m.width;
        maskH = m.height;
        if (!maskBuf || maskBuf.length !== conf.length) maskBuf = new Uint8Array(conf.length);
        for (let i = 0; i < conf.length; i++) {
          const v = conf[i]!;
          maskBuf[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0;
        }
        ok = true;
      }
      result.close();
    });
  } catch (err) {
    console.warn('[camera-segmenter] segmentForVideo failed:', err);
    return null;
  }
  return ok && maskBuf ? { data: maskBuf, width: maskW, height: maskH } : null;
}

/** Releases the ImageSegmenter. Call when the editor unmounts. */
export function destroyCameraSegmenter(): void {
  try { segmenter?.close(); } catch { /* ignore */ }
  segmenter = null;
  initPromise = null;
  // Leave `failed` as-is: if init already failed once, don't thrash retrying.
  maskBuf = null;
  maskW = 0;
  maskH = 0;
  personChannel = -1;
}
