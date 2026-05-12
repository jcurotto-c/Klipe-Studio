import type { Display, KlipeMouseEvent, MouseTrack, ScreenSource } from '../types';
import { acquireMobileStream } from './mobile-session';

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
  camera: MediaStream | null;
  mobile: MediaStream | null;
}

export interface BuildScreenStreamOptions {
  withMic?: boolean;
  /** Camera device id to record alongside the screen, or null/empty for none. */
  camDeviceId?: string | null;
  /** Mobile (phone-as-video-device) id, or null/empty for none. */
  mobileDeviceId?: string | null;
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

// `cursor` is part of the Screen Capture spec but missing from lib.dom.
interface DisplayMediaVideoConstraints extends MediaTrackConstraints {
  cursor?: 'always' | 'motion' | 'never';
}

async function captureWithDisplayMedia(sourceId: string): Promise<MediaStream> {
  const k = bridge();
  if (typeof k.prepareDisplayMedia !== 'function') {
    throw new Error('prepareDisplayMedia bridge missing — preload likely outdated');
  }
  await k.prepareDisplayMedia(sourceId);
  const videoConstraints: DisplayMediaVideoConstraints = {
    cursor: 'never',
    frameRate: { ideal: 60, min: 30 },
  };
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: videoConstraints as MediaTrackConstraints,
  });
  if (stream.getVideoTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('getDisplayMedia returned no video tracks');
  }
  return stream;
}

async function captureWithLegacyGetUserMedia(sourceId: string): Promise<MediaStream> {
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
  return navigator.mediaDevices.getUserMedia(
    constraints as unknown as MediaStreamConstraints,
  );
}

async function acquireCameraStream(deviceId: string): Promise<MediaStream | null> {
  // Recording resolution is higher than the live preview disc — the user can
  // upscale it freely in the editor without softening. Bitrate is tuned for
  // a face/upper-body shot, not a full screen.
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
  } catch (err) {
    console.warn('[capture] camera unavailable for recording:', err);
    return null;
  }
}

export async function buildScreenStream(
  sourceId: string,
  {
    withMic = false,
    camDeviceId = null,
    mobileDeviceId = null,
  }: BuildScreenStreamOptions = {},
): Promise<ScreenCapture> {
  // Prefer getDisplayMedia + cursor: 'never' so the OS cursor is excluded
  // from captured frames. If anything in that path fails, fall back to the
  // legacy getUserMedia path so recording always works.
  let screenStream: MediaStream;
  try {
    screenStream = await captureWithDisplayMedia(sourceId);
    console.info('[capture] using getDisplayMedia (cursor excluded)');
  } catch (err) {
    console.warn('[capture] getDisplayMedia failed, falling back to legacy capture:', err);
    screenStream = await captureWithLegacyGetUserMedia(sourceId);
  }

  let micStream: MediaStream | null = null;
  if (withMic) {
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
    }
  }

  const cameraStream = camDeviceId ? await acquireCameraStream(camDeviceId) : null;
  const mobileStream = mobileDeviceId ? await acquireMobileStream(mobileDeviceId) : null;

  // The "combined" stream is what the screen+mic recorder consumes. The
  // camera and mobile each go to their own recorder so the editor can
  // move/resize/restyle them freely without reflowing what's baked into
  // the screen capture.
  let combined: MediaStream = screenStream;
  if (micStream) {
    combined = new MediaStream();
    screenStream.getVideoTracks().forEach((t) => combined.addTrack(t));
    micStream.getAudioTracks().forEach((t) => combined.addTrack(t));
  }

  return {
    combined,
    screen: screenStream,
    mic: micStream,
    camera: cameraStream,
    mobile: mobileStream,
  };
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
  /** Recorded camera footage, if a camera was attached at start. */
  cameraBlob: Blob | null;
  cameraMimeType: string | null;
  /** Recorded mobile (phone) footage, if a mobile session was attached. */
  mobileBlob: Blob | null;
  mobileMimeType: string | null;
}

export interface RecorderController {
  mimeType: string;
  start(): Promise<void>;
  stop(): Promise<RecordingResult>;
}

interface VideoOnlyMimeChoice {
  mimeType: string;
}
function pickCameraMimeType(): VideoOnlyMimeChoice {
  // Camera has no audio track — pick a video-only WebM codec to avoid the
  // recorder trying to allocate an audio encoder it'll never use.
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
      return { mimeType: m };
    }
  }
  return { mimeType: 'video/webm' };
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

  // Camera is a parallel stream — its own MediaRecorder, started/stopped
  // alongside the screen recorder. Two-recorder sync is good enough at this
  // granularity (sub-frame drift is invisible at typical playback speeds).
  let cameraRecorder: MediaRecorder | null = null;
  const cameraChunks: Blob[] = [];
  let cameraMimeType: string | null = null;
  if (capture.camera) {
    const cam = pickCameraMimeType();
    cameraMimeType = cam.mimeType;
    cameraRecorder = new MediaRecorder(capture.camera, {
      mimeType: cam.mimeType,
      videoBitsPerSecond: 4_000_000,
    });
    cameraRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) cameraChunks.push(e.data);
    };
  }

  // Mobile is a third parallel stream — same pattern as camera, slightly
  // higher bitrate since phones are typically ~1080×1920 vs. the camera's
  // 1280×720. If the device disconnects mid-recording, the track's `ended`
  // event stops the recorder cleanly so we still get a usable shorter blob.
  let mobileRecorder: MediaRecorder | null = null;
  const mobileChunks: Blob[] = [];
  let mobileMimeType: string | null = null;
  if (capture.mobile) {
    const mob = pickCameraMimeType();
    mobileMimeType = mob.mimeType;
    mobileRecorder = new MediaRecorder(capture.mobile, {
      mimeType: mob.mimeType,
      videoBitsPerSecond: 5_000_000,
    });
    mobileRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) mobileChunks.push(e.data);
    };
    const mobileVideoTrack = capture.mobile.getVideoTracks()[0];
    if (mobileVideoTrack) {
      mobileVideoTrack.addEventListener('ended', () => {
        try {
          if (mobileRecorder && mobileRecorder.state !== 'inactive') {
            mobileRecorder.stop();
          }
        } catch { /* ignore */ }
      });
    }
  }

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
      // Kick off all parallel recorders back-to-back so they share a
      // near-identical wall-clock start. A few ms of drift is below human
      // perception once the editor seeks/plays them together (sub-60ms
      // sync threshold handles it).
      recorder.start(250);
      cameraRecorder?.start(250);
      mobileRecorder?.start(250);
    },
    stop() {
      const screenStop = new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
        recorder.stop();
      });
      const cameraStop: Promise<Blob | null> = cameraRecorder
        ? new Promise((resolve) => {
            cameraRecorder!.onstop = () => {
              const type = cameraMimeType ?? 'video/webm';
              resolve(new Blob(cameraChunks, { type }));
            };
            // The mobile track's `ended` handler may have already stopped this
            // recorder; in that case calling stop() again throws — guard it.
            if (cameraRecorder!.state !== 'inactive') cameraRecorder!.stop();
            else cameraRecorder!.onstop?.(new Event('stop'));
          })
        : Promise.resolve(null);
      const mobileStop: Promise<Blob | null> = mobileRecorder
        ? new Promise((resolve) => {
            const finalize = (): void => {
              const type = mobileMimeType ?? 'video/webm';
              resolve(new Blob(mobileChunks, { type }));
            };
            mobileRecorder!.onstop = finalize;
            if (mobileRecorder!.state !== 'inactive') mobileRecorder!.stop();
            else finalize();
          })
        : Promise.resolve(null);

      return Promise.all([screenStop, cameraStop, mobileStop]).then(
        async ([screenBlob, cameraBlob, mobileBlob]) => {
          await bridge().stopMouseTracking();
          if (removeListener) removeListener();
          capture.combined.getTracks().forEach((t) => t.stop());
          capture.screen.getTracks().forEach((t) => t.stop());
          capture.mic?.getTracks().forEach((t) => t.stop());
          capture.camera?.getTracks().forEach((t) => t.stop());
          capture.mobile?.getTracks().forEach((t) => t.stop());
          return {
            blob: screenBlob,
            mimeType,
            mouse: { startTime: mouseStartTime, events },
            cameraBlob,
            cameraMimeType: cameraBlob ? cameraMimeType : null,
            mobileBlob: mobileBlob && mobileBlob.size > 0 ? mobileBlob : null,
            mobileMimeType: mobileBlob && mobileBlob.size > 0 ? mobileMimeType : null,
          };
        },
      );
    },
  };
}
