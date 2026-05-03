/**
 * Real-time export pipeline (no WASM, no native deps):
 *
 *   1. Off-screen <video> plays the trimmed source from start..end
 *   2. A hidden canvas re-renders each frame (zoom, cursor, ripples)
 *      via requestAnimationFrame
 *   3. canvas.captureStream(fps) gives us a MediaStream
 *   4. WebAudio MediaElementSource → MediaStreamDestination feeds the
 *      original audio track into the same stream
 *   5. MediaRecorder writes a webm/mp4 blob (whichever the platform
 *      supports best). The save dialog labels the output accordingly.
 *
 * Tradeoff: export takes (end - start) seconds wall-clock. For typical
 * short recordings this is faster than the WASM PNG-sequence path and
 * has zero loading overhead.
 */

import { renderFrame } from './renderer.js';

const RESOLUTIONS = {
  '720p':  { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
  '4K':    { w: 3840, h: 2160 }
};

export const QUALITY_PRESETS = {
  studio:  { label: 'Studio',     description: 'Highest quality, best for further editing. Compression is almost impossible to notice.', multiplier: 1.5 },
  social:  { label: 'Social Media', description: 'Balanced quality, ideal for posting to social platforms.',                            multiplier: 1.0 },
  web:     { label: 'Web',         description: 'Smaller files for embedding on websites and faster sharing.',                          multiplier: 0.65 },
  webLow:  { label: 'Web (Low)',   description: 'Smallest file size for slow connections; visible compression.',                        multiplier: 0.35 }
};

export function getResolution(name) {
  return RESOLUTIONS[name] || RESOLUTIONS['1080p'];
}

function pickRecorderMime(format) {
  // Note: WebM is the safe default — Chromium's MediaRecorder MP4 output is
  // fragmented (fMP4) with no leading `moov` atom, which NLEs (Premiere,
  // Resolve, Shotcut, Kdenlive…) refuse to import. For direct-playback use
  // (sharing the file) fMP4 is fine, so we honor an MP4 request when the
  // platform supports it.
  const mp4Candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4'
  ];
  const webmCandidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  const ordered = format === 'mp4'
    ? [...mp4Candidates, ...webmCandidates]
    : webmCandidates;
  for (const m of ordered) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'video/webm';
}

export async function exportVideo({
  sourceBlob,
  mouse,
  segments,
  display,
  background,
  crop = null,
  trim,
  resolution = '1080p',
  fps = 60,
  format = 'webm',
  quality = 'social',
  signal,
  onProgress,
  onLog
}) {
  const { w, h } = getResolution(resolution);
  const qMult = QUALITY_PRESETS[quality]?.multiplier ?? 1.0;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError');
  };
  throwIfAborted();

  // Off-screen canvas + video
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  const url = URL.createObjectURL(sourceBlob);
  const video = document.createElement('video');
  video.src = url;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  // We need playback to actually advance, but don't want the OS to play
  // audio out loud while exporting. WebAudio capture below means we
  // can't simply mute the element (mute would also mute the captured
  // graph). Instead, route audio only into the MediaStreamDestination,
  // not the speakers, by NOT calling .connect(audioCtx.destination).
  video.playsInline = true;

  await new Promise((res, rej) => {
    video.addEventListener('loadedmetadata', res, { once: true });
    video.addEventListener('error', () => rej(new Error('Failed to load source')), { once: true });
  });

  const start = Math.max(0, trim.start);
  const end = Math.min(trim.end, video.duration || trim.end);
  const total = Math.max(0.05, end - start);

  // Build the captured MediaStream: video from canvas, audio from element
  const canvasStream = canvas.captureStream(fps);

  let audioCtx = null;
  let hasAudio = false;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const srcNode = audioCtx.createMediaElementSource(video);
    const dest = audioCtx.createMediaStreamDestination();
    srcNode.connect(dest);
    // Intentionally do NOT connect to audioCtx.destination — we don't
    // want speakers playing during export.
    dest.stream.getAudioTracks().forEach((t) => canvasStream.addTrack(t));
    hasAudio = dest.stream.getAudioTracks().length > 0;
  } catch (e) {
    if (onLog) onLog(`Audio capture skipped: ${e.message}`);
  }

  const mimeType = pickRecorderMime(format);
  if (onLog) onLog(`Recorder mime: ${mimeType}`);

  const baseBitrate = resolution === '4K' ? 24_000_000 : resolution === '1080p' ? 12_000_000 : 6_000_000;
  const recorder = new MediaRecorder(canvasStream, {
    mimeType,
    videoBitsPerSecond: Math.round(baseBitrate * qMult),
    audioBitsPerSecond: 192_000
  });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  // Render loop: drive canvas every animation frame; the captureStream
  // samples the canvas at its own fps internally.
  let stopRender = false;
  const tick = () => {
    if (stopRender) return;
    const tMs = video.currentTime * 1000;
    renderFrame(ctx, video, {
      tMs,
      segments,
      mouse,
      displayWidth: display?.width,
      displayHeight: display?.height,
      background,
      crop
    });
    if (onProgress) {
      const elapsed = Math.max(0, video.currentTime - start);
      onProgress('encoding', Math.min(1, elapsed / total));
    }
    requestAnimationFrame(tick);
  };

  // Seek to start, begin playback + recording in lockstep
  await new Promise((resolve) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = start;
  });

  // Prime the canvas so the first chunk has a frame
  renderFrame(ctx, video, {
    tMs: video.currentTime * 1000,
    segments,
    mouse,
    displayWidth: display?.width,
    displayHeight: display?.height,
    background,
    crop
  });

  if (audioCtx && audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (_) {}
  }

  const stopped = new Promise((resolve) => {
    recorder.onstop = () => resolve();
  });

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try { video.pause(); } catch (_) {}
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const cleanup = async () => {
    stopRender = true;
    try { if (recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
    try { await stopped; } catch (_) {}
    canvasStream.getTracks().forEach((t) => t.stop());
    if (audioCtx) {
      try { await audioCtx.close(); } catch (_) {}
    }
    URL.revokeObjectURL(url);
    if (signal) signal.removeEventListener('abort', onAbort);
  };

  try {
    recorder.start(250);
    requestAnimationFrame(tick);
    await video.play();

    // Stop when we reach trim end (or natural end), or abort fires
    await new Promise((resolve) => {
      const check = () => {
        if (aborted || video.currentTime >= end - 0.02 || video.ended) {
          try { video.pause(); } catch (_) {}
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });

    if (aborted) {
      await cleanup();
      throw new DOMException('Export aborted', 'AbortError');
    }

    // Flush a tiny tail to ensure the last frames make it in
    await new Promise((r) => setTimeout(r, 120));
    await cleanup();
  } catch (err) {
    await cleanup();
    throw err;
  }

  const blob = new Blob(chunks, { type: mimeType });
  const isMp4 = mimeType.startsWith('video/mp4');
  const bytes = new Uint8Array(await blob.arrayBuffer());

  if (onProgress) onProgress('done', 1);

  return { bytes, mimeType, ext: isMp4 ? 'mp4' : 'webm' };
}
