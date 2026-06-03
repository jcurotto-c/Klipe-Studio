/**
 * Caption auto-transcription — fully LOCAL, on-device speech-to-text.
 *
 * The heavy Whisper inference runs in a Web Worker (transcribe.worker.ts) via
 * transformers.js (ONNX/WASM). This module is the main-thread side: it picks the
 * recording's speech audio, decodes it to the 16 kHz mono PCM Whisper expects
 * (the Web Audio API can only be reached from the main thread), drives the
 * worker, and maps the returned timestamps onto the editor's output-time clock.
 *
 * Whisper timestamps are in the uploaded audio's (= the recording's SOURCE)
 * time. Captions use OUTPUT time (post trim/reorder), so every chunk is remapped
 * through `sourceToOutput`; chunks that land inside a trimmed-out span map to
 * null and are dropped, so transcription respects cuts for free.
 */

import type { Fragment, Recording } from '../types';
import { sourceToOutput } from './fragments';
import { makeCaptionId, type Caption } from '../overlays/captions';

export interface CaptionProgress {
  /** 'download' while the model is fetched the first time, then 'transcribe'. */
  stage: 'download' | 'transcribe';
  /** 0..1 during download (undefined when indeterminate). */
  progress?: number;
}

export class TranscriptionError extends Error {}

interface RawChunk { start: number; end: number | null; text: string }
interface Line { start: number; end: number; text: string }

/** ~one comfortable subtitle line. */
const CAPTION_MAX_CHARS = 42;
/** A silence at least this long starts a new caption. */
const CAPTION_MAX_GAP_S = 0.9;

/**
 * The best audio track to transcribe: the mic carries narration; system audio
 * is the next-best; legacy recordings bake audio into the screen blob.
 */
export function pickCaptionAudio(recording: Recording): { blob: Blob; mime: string } | null {
  const mic = recording.micAudio;
  if (mic?.blob && mic.blob.size > 0) return { blob: mic.blob, mime: mic.mimeType || mic.blob.type };
  const sys = recording.systemAudio;
  if (sys?.blob && sys.blob.size > 0) return { blob: sys.blob, mime: sys.mimeType || sys.blob.type };
  if (recording.blob && recording.blob.size > 0 && recording.hasAudio !== false) {
    return { blob: recording.blob, mime: recording.mimeType || recording.blob.type };
  }
  return null;
}

/** Decode any supported audio/video container to 16 kHz mono PCM (Whisper input). */
async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new TranscriptionError('Audio decoding is not available.');
  const tmp = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await tmp.decodeAudioData(buf);
  } catch {
    throw new TranscriptionError('Could not decode the recording audio.');
  } finally {
    void tmp.close();
  }
  // Resample + downmix to mono 16 kHz by rendering through an offline graph.
  const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
  const offline = new OfflineAudioContext(1, frames, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

let worker: Worker | null = null;
let seq = 0;
function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

function runWorker(
  audio: Float32Array,
  language: string | undefined,
  onProgress?: (p: CaptionProgress) => void,
): Promise<RawChunk[]> {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const id = ++seq;
    const handler = (e: MessageEvent): void => {
      const m = e.data as
        | { type: 'progress'; id: number; stage: 'download' | 'transcribe'; progress?: number }
        | { type: 'result'; id: number; chunks: RawChunk[] }
        | { type: 'error'; id: number; message: string };
      if (m.id !== id) return;
      if (m.type === 'progress') {
        onProgress?.({ stage: m.stage, progress: m.progress });
      } else if (m.type === 'result') {
        w.removeEventListener('message', handler);
        resolve(m.chunks);
      } else {
        w.removeEventListener('message', handler);
        reject(new TranscriptionError(m.message));
      }
    };
    w.addEventListener('message', handler);
    // Transfer the PCM buffer (no copy); the main thread no longer needs it.
    w.postMessage({ type: 'transcribe', id, audio, language }, [audio.buffer]);
  });
}

/**
 * Group word-level chunks into subtitle lines, then map each line's start/end
 * from source time to output time. Each line's start is its FIRST word's real
 * onset (so a line lands when it's actually spoken). A new line begins on a
 * sentence end, a long pause, or once the line would get too wide. Lines whose
 * start falls inside a trimmed-out span are dropped.
 */
function chunksToCaptions(words: RawChunk[], fragments: Fragment[]): Caption[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const w of words) {
    const t = (w.text ?? '').trim();
    if (!t) continue;
    const wEnd = w.end ?? w.start;
    if (!cur) { cur = { start: w.start, end: wEnd, text: t }; continue; }
    const gap = w.start - cur.end;
    const endsSentence = /[.!?]$/.test(cur.text);
    const nextLen = cur.text.length + 1 + t.length;
    if (endsSentence || gap > CAPTION_MAX_GAP_S || nextLen > CAPTION_MAX_CHARS) {
      lines.push(cur);
      cur = { start: w.start, end: wEnd, text: t };
    } else {
      cur.text += ` ${t}`;
      cur.end = wEnd;
    }
  }
  if (cur) lines.push(cur);

  const out: Caption[] = [];
  for (const line of lines) {
    if (!line.text) continue;
    const start = sourceToOutput(fragments, line.start);
    if (!start) continue; // line starts inside a cut → drop it
    const end = sourceToOutput(fragments, line.end);
    const startMs = Math.round(start.outputTime * 1000);
    const endMs = end
      ? Math.max(startMs + 200, Math.round(end.outputTime * 1000))
      : startMs + 1200;
    out.push({ id: makeCaptionId(), text: line.text, startMs, endMs });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Transcribe the recording's speech locally and return output-time captions.
 * Throws `TranscriptionError` with a user-facing message on failure.
 */
export async function generateCaptions(
  recording: Recording,
  fragments: Fragment[],
  opts: { language?: string; onProgress?: (p: CaptionProgress) => void } = {},
): Promise<Caption[]> {
  const audio = pickCaptionAudio(recording);
  if (!audio) throw new TranscriptionError('This recording has no audio to transcribe.');
  const pcm = await decodeToMono16k(audio.blob);
  const chunks = await runWorker(pcm, opts.language, opts.onProgress);
  return chunksToCaptions(chunks, fragments);
}
