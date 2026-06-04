/**
 * Poster-frame capture for the library gallery.
 *
 * Grabs a single representative frame from a recording and encodes it as a
 * small JPEG. Used when a recording auto-saves into the library so each gallery
 * card has a thumbnail. Frames are pulled from a detached <video> element (never
 * the editor's preview <video>) so this never disturbs playback.
 *
 * Mirrors the duration/seek quirk-handling in {@link lib/filmstrip}: MediaRecorder
 * WebM clips often report `Infinity` for duration until forced to seek past the
 * end, so we apply the same trick before sampling.
 */

/** Backing-store thumbnail width in px — generous enough for HiDPI gallery cards. */
const THUMB_W = 480;
const SEEK_TIMEOUT_MS = 4000;
const JPEG_QUALITY = 0.72;

export interface PosterResult {
  /** JPEG bytes, or null if a frame could not be captured. */
  bytes: Uint8Array | null;
  /** Source duration in ms (best effort; 0 if unknown). */
  durationMs: number;
}

function once(el: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: number | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener('error', onErr);
    };
    const onOk = (): void => { cleanup(); resolve(); };
    const onErr = (): void => { cleanup(); reject(new Error(`video ${event} error`)); };
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener('error', onErr, { once: true });
    timer = window.setTimeout(onOk, timeoutMs); // resolve anyway — draw whatever is current
  });
}

/**
 * Seek to `t` and resolve true if it TIMED OUT (never landed). Tolerates a stale
 * 'seeked' left over from the duration probe (currentTime still far from target)
 * by continuing to wait rather than resolving on the wrong frame.
 */
function seekTo(video: HTMLVideoElement, t: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: number | undefined;
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onErr);
      resolve(timedOut);
    };
    const onSeeked = (): void => {
      if (Math.abs(video.currentTime - t) < 0.25) finish(false);
      else video.addEventListener('seeked', onSeeked, { once: true }); // stale seek — keep waiting
    };
    const onErr = (): void => finish(true);
    timer = window.setTimeout(() => finish(true), timeoutMs);
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onErr, { once: true });
    video.currentTime = t;
  });
}

async function resolveDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  try {
    await new Promise<void>((resolve) => {
      const onDur = (): void => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          video.removeEventListener('durationchange', onDur);
          resolve();
        }
      };
      video.addEventListener('durationchange', onDur);
      window.setTimeout(resolve, SEEK_TIMEOUT_MS);
      video.currentTime = 1e7;
    });
  } catch {
    /* fall through */
  }
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

function blobToBytes(blob: Blob | null): Promise<Uint8Array | null> {
  if (!blob) return Promise.resolve(null);
  return blob.arrayBuffer().then((buf) => new Uint8Array(buf));
}

/**
 * Capture a poster frame from a recording's object URL. Seeks to ~10% in (a
 * frame past any black lead-in) and encodes a JPEG. Always resolves — on any
 * failure it returns `{ bytes: null }` and the gallery falls back to a
 * placeholder, so a flaky decode never blocks the auto-save.
 */
export async function capturePoster(url: string): Promise<PosterResult> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
  video.src = url;

  try {
    await once(video, 'loadedmetadata', SEEK_TIMEOUT_MS);
    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    const duration = await resolveDuration(video);
    const durationMs = Math.round(duration * 1000);

    // resolveDuration seeks to 1e7 to force a finite duration on Infinity-duration
    // WebMs; that seek may still be in flight. Drain it before the target seek so
    // its trailing 'seeked' can't be mistaken for the target landing.
    if (video.seeking) await once(video, 'seeked', SEEK_TIMEOUT_MS);

    const target = duration > 0 ? Math.min(duration * 0.1, duration) : 0;
    let seekTimedOut = false;
    if (Math.abs(video.currentTime - target) > 1e-3) {
      seekTimedOut = await seekTo(video, target, SEEK_TIMEOUT_MS);
    }

    // If the seek never landed (timed out / still seeking / no decoded frame),
    // bail with a null poster so the gallery shows its placeholder instead of a
    // baked black/partial frame — the same guard the editor's export thumbnail uses.
    if (seekTimedOut || video.seeking || video.readyState < 2) {
      return { bytes: null, durationMs };
    }

    const w = THUMB_W;
    const h = Math.max(1, Math.round((THUMB_W * vh) / vw));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { bytes: null, durationMs };
    ctx.drawImage(video, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY),
    );
    return { bytes: await blobToBytes(blob), durationMs };
  } catch {
    return { bytes: null, durationMs: 0 };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
