/**
 * Capture helpers: list sources, build MediaStream from desktopCapturer source,
 * record with MediaRecorder, and collect global mouse events from main process.
 */

export async function listScreenSources() {
  return await window.klipe.getScreenSources();
}

export async function getPrimaryDisplaySize() {
  return await window.klipe.getPrimaryDisplaySize();
}

export async function buildScreenStream(sourceId, { withMic } = {}) {
  // Electron's recommended chromeMediaSource API
  const screenStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        minFrameRate: 30,
        maxFrameRate: 60
      }
    }
  });

  if (!withMic) return screenStream;

  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false
      },
      video: false
    });
  } catch (err) {
    console.warn('Microphone unavailable:', err);
    return screenStream;
  }

  // Combine: video tracks from screenStream, audio tracks from mic.
  const combined = new MediaStream();
  screenStream.getVideoTracks().forEach((t) => combined.addTrack(t));
  micStream.getAudioTracks().forEach((t) => combined.addTrack(t));

  // Keep mic ref so it can be stopped externally
  combined._micStream = micStream;
  combined._screenStream = screenStream;
  return combined;
}

export function pickBestMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'video/webm';
}

/**
 * Wraps MediaRecorder + global mouse capture.
 * Returns a controller with start(), stop() => Promise<{blob, mimeType, mouse}>
 */
export function createRecorder(stream, { onMouseEvent } = {}) {
  const mimeType = pickBestMimeType();
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 128_000
  });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  let mouseStartTime = 0;
  const events = [];
  let removeListener = null;

  return {
    mimeType,
    async start() {
      const result = await window.klipe.startMouseTracking();
      mouseStartTime = result.startTime || Date.now();
      removeListener = window.klipe.onMouseEvent((evt) => {
        events.push(evt);
        if (onMouseEvent) onMouseEvent(evt);
      });
      recorder.start(250);
    },
    stop() {
      return new Promise((resolve) => {
        recorder.onstop = async () => {
          await window.klipe.stopMouseTracking();
          if (removeListener) removeListener();
          // Stop all tracks
          stream.getTracks().forEach((t) => t.stop());
          if (stream._micStream) stream._micStream.getTracks().forEach((t) => t.stop());
          if (stream._screenStream) stream._screenStream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: mimeType });
          resolve({
            blob,
            mimeType,
            mouse: { startTime: mouseStartTime, events }
          });
        };
        recorder.stop();
      });
    }
  };
}
