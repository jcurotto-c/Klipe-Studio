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
  /** Dedicated loopback stream for system audio (video stripped). Stopped on stop. */
  systemAudioStream?: MediaStream | null;
}

export interface BuildScreenStreamOptions {
  withMic?: boolean;
  /** Camera device id to record alongside the screen, or null/empty for none. */
  camDeviceId?: string | null;
  /** Mobile (phone-as-video-device) id, or null/empty for none. */
  mobileDeviceId?: string | null;
  /** Capture the PC's system/desktop audio (Windows WASAPI loopback). */
  systemAudio?: boolean;
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

// Video-only screen capture with the OS cursor excluded (cursor: 'never').
// System audio is captured SEPARATELY via captureLoopbackAudio — bundling
// loopback into this same getDisplayMedia call does not attach the audio track
// in Electron, so the two must be requested independently.
async function captureWithDisplayMedia(sourceId: string): Promise<MediaStream> {
  const k = bridge();
  if (typeof k.prepareDisplayMedia !== 'function') {
    throw new Error('prepareDisplayMedia bridge missing — preload likely outdated');
  }
  await k.prepareDisplayMedia(sourceId, false);
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

// System (desktop) audio via a DEDICATED getDisplayMedia request. The main
// process answers with `audio: 'loopback'` (Windows WASAPI). getDisplayMedia
// requires video:true for loopback to attach, so we request video too and
// immediately discard it — only the loopback audio track is kept. This is the
// reliable Electron pattern; a combined clean-video + loopback request yields
// silence or no audio track at all.
async function captureLoopbackAudio(sourceId: string): Promise<MediaStream | null> {
  const k = bridge();
  if (typeof k.prepareDisplayMedia !== 'function') return null;
  try {
    await k.prepareDisplayMedia(sourceId, true);
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
    if (stream.getAudioTracks().length === 0) {
      console.warn('[capture] loopback returned no audio track');
      return null;
    }
    return stream;
  } catch (err) {
    console.warn('[capture] system-audio loopback failed:', err);
    return null;
  }
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
    systemAudio = false,
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

  // System/desktop audio via a separate, dedicated loopback capture.
  const systemAudioStream = systemAudio ? await captureLoopbackAudio(sourceId) : null;

  const cameraStream = camDeviceId ? await acquireCameraStream(camDeviceId) : null;
  const mobileStream = mobileDeviceId ? await acquireMobileStream(mobileDeviceId) : null;

  // The "combined" stream the main recorder consumes is VIDEO ONLY. Microphone
  // and system audio are recorded as separate parallel tracks (like camera and
  // mobile) so the editor can balance their volumes independently and the export
  // can mix them with per-track gains. We no longer bake a single mixed audio
  // track into the screen blob.
  const combined: MediaStream = screenStream;

  return {
    combined,
    screen: screenStream,
    mic: micStream,
    camera: cameraStream,
    mobile: mobileStream,
    systemAudioStream,
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
  /** Microphone audio recorded as its own track, if a mic was attached. */
  micAudioBlob: Blob | null;
  micAudioMimeType: string | null;
  /** System/desktop audio recorded as its own track, if enabled. */
  systemAudioBlob: Blob | null;
  systemAudioMimeType: string | null;
  /** Whether any audio (mic and/or system) was captured. */
  hasAudio: boolean;
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

function pickAudioMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'audio/webm';
}

export function createRecorder(
  capture: ScreenCapture,
  { onMouseEvent }: RecorderOptions = {},
): RecorderController {
  const mimeType = pickBestMimeType();
  const hasAudio =
    (capture.mic?.getAudioTracks().length ?? 0) > 0 ||
    (capture.systemAudioStream?.getAudioTracks().length ?? 0) > 0;
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

  // Microphone and system audio each get their own audio-only recorder so the
  // editor can balance them independently. Same parallel-recorder pattern as
  // camera/mobile.
  const makeAudioRecorder = (
    stream: MediaStream | null | undefined,
  ): { rec: MediaRecorder; chunks: Blob[]; mimeType: string } | null => {
    if (!stream || stream.getAudioTracks().length === 0) return null;
    const m = pickAudioMimeType();
    const rec = new MediaRecorder(stream, { mimeType: m, audioBitsPerSecond: 128_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    return { rec, chunks, mimeType: m };
  };
  const micAudio = makeAudioRecorder(capture.mic);
  const systemAudio = makeAudioRecorder(capture.systemAudioStream);

  let mouseStartTime = 0;
  const events: KlipeMouseEvent[] = [];
  let removeListener: (() => void) | null = null;

  // Stop a recorder and resolve with its blob. A safety timeout guarantees the
  // promise settles even if `onstop` never fires (track already ended, driver
  // hiccup) — otherwise a single stuck recorder would hang Promise.all forever,
  // freezing the "finishing" state and (worse) leaving the system cursor blanked.
  const stopRecorder = (
    rec: MediaRecorder | null,
    getBlob: () => Blob,
    timeoutMs = 4000,
  ): Promise<Blob | null> =>
    new Promise((resolve) => {
      if (!rec) { resolve(null); return; }
      let settled = false;
      const finish = (): void => { if (settled) return; settled = true; resolve(getBlob()); };
      rec.onstop = finish;
      setTimeout(finish, timeoutMs);
      try {
        if (rec.state !== 'inactive') rec.stop();
        else finish();
      } catch { finish(); }
    });

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
      micAudio?.rec.start(250);
      systemAudio?.rec.start(250);
    },
    stop() {
      // Restore the system cursor and tear down the OS tracker IMMEDIATELY,
      // independent of blob collection. Blob finalization can be slow; the user
      // must never be left with a blanked cursor while it finishes.
      const trackingStopped = bridge().stopMouseTracking().catch(() => undefined);
      if (removeListener) { removeListener(); removeListener = null; }

      const screenStop = stopRecorder(recorder, () => new Blob(chunks, { type: mimeType }), 6000);
      const cameraStop = stopRecorder(
        cameraRecorder,
        () => new Blob(cameraChunks, { type: cameraMimeType ?? 'video/webm' }),
      );
      const mobileStop = stopRecorder(
        mobileRecorder,
        () => new Blob(mobileChunks, { type: mobileMimeType ?? 'video/webm' }),
      );
      const micStop = stopRecorder(
        micAudio?.rec ?? null,
        () => new Blob(micAudio!.chunks, { type: micAudio!.mimeType }),
      );
      const systemStop = stopRecorder(
        systemAudio?.rec ?? null,
        () => new Blob(systemAudio!.chunks, { type: systemAudio!.mimeType }),
      );

      return Promise.all([screenStop, cameraStop, mobileStop, micStop, systemStop, trackingStopped]).then(
        ([screenBlob, cameraBlob, mobileBlob, micBlob, systemBlob]) => {
          capture.combined.getTracks().forEach((t) => t.stop());
          capture.screen.getTracks().forEach((t) => t.stop());
          capture.mic?.getTracks().forEach((t) => t.stop());
          capture.camera?.getTracks().forEach((t) => t.stop());
          capture.mobile?.getTracks().forEach((t) => t.stop());
          capture.systemAudioStream?.getTracks().forEach((t) => t.stop());
          const micOk = micBlob && micBlob.size > 0;
          const systemOk = systemBlob && systemBlob.size > 0;
          return {
            blob: screenBlob ?? new Blob([], { type: mimeType }),
            mimeType,
            hasAudio,
            mouse: { startTime: mouseStartTime, events },
            cameraBlob,
            cameraMimeType: cameraBlob ? cameraMimeType : null,
            mobileBlob: mobileBlob && mobileBlob.size > 0 ? mobileBlob : null,
            mobileMimeType: mobileBlob && mobileBlob.size > 0 ? mobileMimeType : null,
            micAudioBlob: micOk ? micBlob : null,
            micAudioMimeType: micOk ? (micAudio?.mimeType ?? null) : null,
            systemAudioBlob: systemOk ? systemBlob : null,
            systemAudioMimeType: systemOk ? (systemAudio?.mimeType ?? null) : null,
          };
        },
      );
    },
  };
}
