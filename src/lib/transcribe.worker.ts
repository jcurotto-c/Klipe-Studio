/**
 * Local speech-to-text worker — runs Whisper entirely on-device via
 * transformers.js (ONNX/WASM). No network at transcribe time except the ONE
 * first-run model download, which transformers.js then caches in the renderer's
 * persistent storage (works fully offline afterwards). No API key.
 *
 * Heavy work (model load + inference) lives here so the editor UI never blocks.
 * The main thread decodes audio to 16 kHz mono PCM and transfers the Float32
 * buffer in; we post back download progress, then the timestamped chunks.
 */
import { pipeline, env } from '@huggingface/transformers';
// ORT's WASM runtime as real emitted files. `?url` makes Vite copy them into
// dist and hand us their hashed paths — see the wasmPaths note below for why
// that matters. onnxruntime-web is a transitive dep of transformers.js; the
// specifiers are its documented subpath exports and resolve because pnpm runs
// with node-linker=hoisted (see pnpm-workspace.yaml).
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';

// Models come from the Hub (and are cached); never probe the local filesystem.
env.allowLocalModels = false;
// Use multiple WASM threads when the context is cross-origin isolated (so
// SharedArrayBuffer exists) — that's the case in dev and is what makes Whisper
// usably fast on CPU. Falls back to a single thread otherwise.
const wasm = env.backends?.onnx?.wasm;
if (wasm) {
  wasm.numThreads = self.crossOriginIsolated
    ? Math.min(8, Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1))
    : 1;
  // Left to itself, ORT loads its WASM glue by building a Blob and import()ing
  // it. That works over http:// (dev) and dies in a packaged build, which runs
  // from file:// where Chromium refuses to import a blob: URL:
  //   "no available backend found. ERR: [wasm] TypeError: Failed to fetch
  //    dynamically imported module: blob:file:///<uuid>"
  // Pointing at the emitted files skips the blob path entirely. Absolute URLs
  // are required, hence resolving against the worker's own location.
  wasm.proxy = false;
  wasm.wasmPaths = {
    wasm: new URL(ortWasmUrl, self.location.href).href,
    mjs: new URL(ortMjsUrl, self.location.href).href,
  };
}

const MODEL_ID = 'Xenova/whisper-base';

// `self` is the worker global. Typed via a minimal local interface so this file
// compiles under the app's DOM lib without a webworker-lib clash.
const ctx = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((e: MessageEvent) => void) | null;
};

interface TranscribeRequest {
  type: 'transcribe';
  id: number;
  audio: Float32Array;
  language?: string;
}

type Transcriber = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{
  text?: string;
  chunks?: Array<{ timestamp: [number, number | null]; text: string }>;
}>;

let asrPromise: Promise<Transcriber> | null = null;

function getASR(onProgress: (p: { file?: string; progress?: number }) => void): Promise<Transcriber> {
  if (!asrPromise) {
    asrPromise = pipeline('automatic-speech-recognition', MODEL_ID, {
      // Full precision on the WASM/CPU backend. The quantized (q8/q4) Whisper
      // exports use MatMulNBits ops the on-device runtime can't build a session
      // for ("TransposeDQWeightsForMatMulNBits Missing required scale"), so fp32
      // is the reliable choice; it's larger to download but runs correctly.
      dtype: 'fp32',
      device: 'wasm',
      progress_callback: (p: { status?: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
        if (p.status === 'progress') {
          const frac = typeof p.progress === 'number'
            ? p.progress / 100
            : (p.total ? (p.loaded ?? 0) / p.total : undefined);
          onProgress({ file: p.file, progress: frac });
        }
      },
    }) as unknown as Promise<Transcriber>;
  }
  return asrPromise;
}

ctx.onmessage = async (e: MessageEvent): Promise<void> => {
  const msg = e.data as TranscribeRequest;
  if (msg?.type !== 'transcribe') return;
  const { id, audio, language } = msg;
  try {
    const asr = await getASR(({ file, progress }) => {
      ctx.postMessage({ type: 'progress', id, stage: 'download', file, progress });
    });
    ctx.postMessage({ type: 'progress', id, stage: 'transcribe' });

    const baseOpts = {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: language || undefined,
      task: 'transcribe',
    };
    // Word-level timestamps so captions land when each word is actually said
    // (segment-level anchors the first line at 0 even with leading music). Not
    // every model export supports word-level — fall back to segment-level so a
    // missing alignment head never fails the whole transcription.
    let out: Awaited<ReturnType<Transcriber>>;
    try {
      out = await asr(audio, { ...baseOpts, return_timestamps: 'word' });
    } catch {
      out = await asr(audio, { ...baseOpts, return_timestamps: true });
    }

    const chunks = (out?.chunks ?? []).map((c) => ({
      start: c.timestamp[0],
      end: c.timestamp[1],
      text: c.text,
    }));
    ctx.postMessage({ type: 'result', id, chunks });
  } catch (err) {
    ctx.postMessage({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
