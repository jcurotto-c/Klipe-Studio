import type { Display, KlipeMouseEvent, MouseTrack, ScreenSource } from '../types';

function bridge(): KlipeBridge {
  const k = window.klipe;
  if (!k) throw new Error('Electron bridge `window.klipe` is not available');
  return k;
}

export async function listScreenSources(): Promise<ScreenSource[]> {
  return bridge().getScreenSources();
}

export async function getPrimaryDisplaySize(): Promise<Display> {
  return bridge().getPrimaryDisplaySize();
}

export interface ScreenCapture {
  combined: MediaStream;
  screen: MediaStream;
  mic: MediaStream | null;
}

interface DesktopMediaTrackConstraints extends MediaTrackConstraints {
  mandatory?: {
    chromeMediaSource: 'desktop';
    chromeMediaSourceId: string;
    minFrameRate?: number;
    maxFrameRate?: number;
  };
}

interface DesktopMediaStreamConstraints {
  audio: false;
  video: DesktopMediaTrackConstraints;
}

export async function buildScreenStream(
  sourceId: string,
  { withMic = false }: { withMic?: boolean } = {},
): Promise<ScreenCapture> {
  const constraints: DesktopMediaStreamConstraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        minFrameRate: 30,
        maxFrameRate: 60,
      },
    },
  };
  const screenStream = await navigator.mediaDevices.getUserMedia(
    constraints as unknown as MediaStreamConstraints,
  );

  if (!withMic) {
    return { combined: screenStream, screen: screenStream, mic: null };
  }

  let micStream: MediaStream | null = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
      },
      video: false,
    });
  } catch (err) {
    console.warn('Microphone unavailable:', err);
    return { combined: screenStream, screen: screenStream, mic: null };
  }

  const combined = new MediaStream();
  screenStream.getVideoTracks().forEach((t) => combined.addTrack(t));
  micStream.getAudioTracks().forEach((t) => combined.addTrack(t));

  return { combined, screen: screenStream, mic: micStream };
}

export function pickBestMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'video/webm';
}

export interface RecorderOptions {
  onMouseEvent?: (evt: KlipeMouseEvent) => void;
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  mouse: MouseTrack;
}

export interface RecorderController {
  mimeType: string;
  start(): Promise<void>;
  stop(): Promise<RecordingResult>;
}

export function createRecorder(
  capture: ScreenCapture,
  { onMouseEvent }: RecorderOptions = {},
): RecorderController {
  const mimeType = pickBestMimeType();
  const recorder = new MediaRecorder(capture.combined, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 128_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  let mouseStartTime = 0;
  const events: KlipeMouseEvent[] = [];
  let removeListener: (() => void) | null = null;

  return {
    mimeType,
    async start() {
      const k = bridge();
      const result = await k.startMouseTracking();
      mouseStartTime = result.startTime || Date.now();
      removeListener = k.onMouseEvent((evt) => {
        events.push(evt);
        onMouseEvent?.(evt);
      });
      recorder.start(250);
    },
    stop() {
      return new Promise<RecordingResult>((resolve) => {
        recorder.onstop = async () => {
          await bridge().stopMouseTracking();
          if (removeListener) removeListener();
          capture.combined.getTracks().forEach((t) => t.stop());
          capture.screen.getTracks().forEach((t) => t.stop());
          capture.mic?.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: mimeType });
          resolve({
            blob,
            mimeType,
            mouse: { startTime: mouseStartTime, events },
          });
        };
        recorder.stop();
      });
    },
  };
}
