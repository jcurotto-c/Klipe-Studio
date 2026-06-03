/**
 * Filmstrip thumbnail engine for the editor timeline.
 *
 * Generates a row of frame thumbnails (CapCut-style) for a recorded video,
 * sampled at evenly spaced timestamps. Thumbnails are captured at the video's
 * NATIVE aspect ratio so they are never stretched when tiled across the clip.
 *
 * One generation per recording URL, cached module-wide and shared by every
 * fragment on the timeline. Consumers subscribe (via useSyncExternalStore in
 * FragmentFilmstrip) and are notified progressively as thumbnails decode.
 *
 * Frames are pulled from a dedicated, detached <video> element — never the
 * preview <video> — so seeking here does not disturb playback.
 */

export interface FilmstripThumb {
  /** Source-time of this frame, in seconds. */
  t: number;
  bitmap: ImageBitmap;
}

export interface FilmstripData {
  status: 'loading' | 'ready' | 'error';
  thumbs: FilmstripThumb[];
  /** width / height of the source video. */
  aspect: number;
  /** Source duration in seconds (best effort). */
  duration: number;
}

type Listener = () => void;

interface Entry {
  status: FilmstripData['status'];
  thumbs: FilmstripThumb[];
  aspect: number;
  duration: number;
  listeners: Set<Listener>;
  /** Immutable view handed to React; rebuilt on every notify(). */
  snapshot: FilmstripData;
  started: boolean;
}

/** Backing-store thumbnail height in px — generous enough for HiDPI rows (~46px CSS). */
const THUMB_H = 96;
const MIN_THUMBS = 12;
const MAX_THUMBS = 60;
const SECONDS_PER_THUMB = 0.5;
const SEEK_TIMEOUT_MS = 4000;

const cache = new Map<string, Entry>();
/** Keep at most this many recordings' thumbnails resident. ImageBitmaps hold
 *  GPU/native memory that the GC does NOT reclaim — they must be close()d. */
const MAX_CACHED = 3;

function destroyEntry(entry: Entry): void {
  for (const th of entry.thumbs) {
    try { th.bitmap.close(); } catch { /* ignore */ }
  }
  entry.thumbs = [];
}

/** Evict least-recently-used entries nobody is subscribed to (on-screen rows
 *  are kept). Map iteration order is insertion/LRU order — see getEntry. */
function evictIfNeeded(): void {
  if (cache.size <= MAX_CACHED) return;
  for (const [url, entry] of cache) {
    if (cache.size <= MAX_CACHED) break;
    if (entry.listeners.size > 0) continue;
    destroyEntry(entry);
    cache.delete(url);
  }
}

function buildSnapshot(entry: Entry): FilmstripData {
  return {
    status: entry.status,
    thumbs: entry.thumbs.slice(),
    aspect: entry.aspect,
    duration: entry.duration,
  };
}

function notify(entry: Entry): void {
  entry.snapshot = buildSnapshot(entry);
  entry.listeners.forEach((l) => l());
}

function getEntry(url: string): Entry {
  const existing = cache.get(url);
  if (existing) {
    // Re-insert to mark most-recently-used (Map preserves insertion order).
    cache.delete(url);
    cache.set(url, existing);
    return existing;
  }
  const entry: Entry = {
    status: 'loading',
    thumbs: [],
    aspect: 16 / 9,
    duration: 0,
    listeners: new Set(),
    snapshot: { status: 'loading', thumbs: [], aspect: 16 / 9, duration: 0 },
    started: false,
  };
  cache.set(url, entry);
  evictIfNeeded();
  return entry;
}

function once(el: HTMLVideoElement, event: string, timeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: number | undefined;
    const onOk = (): void => {
      cleanup();
      resolve();
    };
    const onErr = (): void => {
      cleanup();
      reject(new Error(`video ${event} error`));
    };
    const cleanup = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener('error', onErr);
    };
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener('error', onErr, { once: true });
    if (timeoutMs !== undefined) {
      timer = window.setTimeout(onOk, timeoutMs); // resolve anyway — draw whatever frame is current
    }
  });
}

/**
 * Resolve a usable duration. MediaRecorder WebM clips often report Infinity
 * until forced to seek to the end (the well-known browser quirk), so fall back
 * to that trick, then to a caller hint.
 */
async function resolveDuration(video: HTMLVideoElement, hint: number): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  try {
    await new Promise<void>((resolve, reject) => {
      const onDur = (): void => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          video.removeEventListener('durationchange', onDur);
          resolve();
        }
      };
      const onErr = (): void => {
        video.removeEventListener('durationchange', onDur);
        reject(new Error('durationchange error'));
      };
      video.addEventListener('durationchange', onDur);
      video.addEventListener('error', onErr, { once: true });
      window.setTimeout(resolve, SEEK_TIMEOUT_MS);
      video.currentTime = 1e7;
    });
  } catch {
    /* fall through to hint */
  }
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  return hint > 0 ? hint : 0;
}

async function seek(video: HTMLVideoElement, t: number): Promise<void> {
  if (Math.abs(video.currentTime - t) < 1e-3) return;
  const done = once(video, 'seeked', SEEK_TIMEOUT_MS);
  video.currentTime = t;
  await done;
}

async function generate(url: string, entry: Entry, hint: number): Promise<void> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
  video.src = url;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  try {
    await once(video, 'loadedmetadata', SEEK_TIMEOUT_MS);
    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    entry.aspect = vw / vh;

    const duration = await resolveDuration(video, hint);
    entry.duration = duration;
    if (!ctx || duration <= 0) {
      entry.status = 'error';
      notify(entry);
      return;
    }

    const thumbW = Math.max(1, Math.round(THUMB_H * entry.aspect));
    canvas.width = thumbW;
    canvas.height = THUMB_H;

    const count = Math.min(
      MAX_THUMBS,
      Math.max(MIN_THUMBS, Math.ceil(duration / SECONDS_PER_THUMB)),
    );

    for (let i = 0; i < count; i++) {
      const t = ((i + 0.5) / count) * duration;
      await seek(video, t);
      ctx.drawImage(video, 0, 0, thumbW, THUMB_H);
      const bitmap = await createImageBitmap(canvas);
      entry.thumbs.push({ t, bitmap });
      notify(entry); // progressive fill-in
    }

    entry.status = 'ready';
    notify(entry);
  } catch {
    entry.status = entry.thumbs.length > 0 ? 'ready' : 'error';
    notify(entry);
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/** Subscribe to a recording's filmstrip; kicks off generation on first use. */
export function subscribeFilmstrip(url: string, hint: number, cb: Listener): () => void {
  const entry = getEntry(url);
  entry.listeners.add(cb);
  if (!entry.started) {
    entry.started = true;
    void generate(url, entry, hint);
  }
  return () => {
    entry.listeners.delete(cb);
  };
}

export function getFilmstripSnapshot(url: string): FilmstripData {
  return getEntry(url).snapshot;
}

/**
 * Release a recording's cached thumbnails and close their ImageBitmaps. Call
 * when the recording's object URL is revoked (the URL is dead, so the cache
 * entry is unusable) to reclaim GPU/native memory that the GC can't.
 */
export function releaseFilmstrip(url: string): void {
  const entry = cache.get(url);
  if (!entry) return;
  destroyEntry(entry);
  cache.delete(url);
}

/** Nearest thumbnail to a given source-time. `thumbs` is assumed sorted by t. */
export function nearestThumb(thumbs: FilmstripThumb[], t: number): FilmstripThumb | null {
  if (thumbs.length === 0) return null;
  let lo = 0;
  let hi = thumbs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (thumbs[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  const cand = thumbs[lo]!;
  const prev = thumbs[lo - 1];
  if (prev && Math.abs(prev.t - t) <= Math.abs(cand.t - t)) return prev;
  return cand;
}
