/**
 * Klipe project (.klipestudio) save / open.
 *
 * A project is a folder named `<Name>.klipestudio/` containing:
 *   - `project.json`  — manifest: version, recording metadata (mouse track,
 *                       display, name) and the full edit document.
 *   - `screen.<ext>`  — the source screen recording.
 *   - `camera.<ext>`  — recorded webcam footage, if any.
 *   - `mobile.<ext>`  — recorded phone footage, if any.
 *   - `music.<ext>`   — background-music audio, if any (its in-memory object
 *                       URL is volatile, so we persist the bytes and rebuild a
 *                       fresh URL on open).
 *
 * Custom background images and image overlays are stored inline as data URLs
 * in the edit document, so they survive serialization without extra files.
 *
 * The renderer gathers the blobs and hands them, plus the JSON, to the main
 * process over IPC (`window.klipe.project`) which performs the actual file I/O.
 */

import type {
  AudioFxOptions,
  Background,
  BackgroundMusic,
  BlurRegion,
  CameraOptions,
  Crop,
  CursorOptions,
  FrameOptions,
  Fragment,
  MobileOptions,
  MouseTrack,
  Recording,
  Display,
  ZoomDefaults,
  ZoomSegment,
} from '../types';
import type { Overlay } from '../overlays/types';

export const PROJECT_VERSION = 1;

/** Everything the editor lets the user change about a recording. */
export interface EditDocument {
  fragments: Fragment[];
  segments: ZoomSegment[];
  background: Background;
  crop: Crop | null;
  zoomDefaults: ZoomDefaults;
  cameraOptions: CameraOptions;
  cursorOptions: CursorOptions;
  frameOptions: FrameOptions;
  audioFxOptions: AudioFxOptions;
  /** `src` is rewritten to a fresh object URL on open (or '' if absent). */
  backgroundMusic: BackgroundMusic | null;
  aspectRatioId: string;
  mobileOptions: MobileOptions;
  blurRegions: BlurRegion[];
  overlays: Overlay[];
}

interface MediaRef {
  file: string;
  mimeType: string;
}

export interface ProjectManifest {
  klipeProject: true;
  version: number;
  name: string;
  createdAt: number;
  display: Display;
  autoZoom: boolean;
  mouse: MouseTrack;
  doc: EditDocument;
  media: {
    screen: MediaRef;
    camera: MediaRef | null;
    mobile: MediaRef | null;
    music: MediaRef | null;
  };
}

export interface SaveProjectResult {
  canceled: boolean;
  projectPath?: string;
  error?: string;
}

export interface OpenedProject {
  recording: Recording;
  doc: EditDocument;
  projectPath: string;
}

function extFor(mimeType: string, fallback: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return fallback;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Serialize the current recording + edit document and prompt the user for a
 * location. Returns `{ canceled: true }` if the dialog was dismissed.
 */
export async function saveProject(
  recording: Recording,
  doc: EditDocument,
): Promise<SaveProjectResult> {
  const bridge = window.klipe?.project;
  if (!bridge?.save) {
    return { canceled: true, error: 'Project saving is unavailable in this build.' };
  }

  const media: Array<{ name: string; bytes: Uint8Array }> = [];

  const screenFile = `screen.${extFor(recording.mimeType, 'webm')}`;
  media.push({ name: screenFile, bytes: await blobBytes(recording.blob) });

  let cameraRef: MediaRef | null = null;
  if (recording.camera) {
    const file = `camera.${extFor(recording.camera.mimeType, 'webm')}`;
    media.push({ name: file, bytes: await blobBytes(recording.camera.blob) });
    cameraRef = { file, mimeType: recording.camera.mimeType };
  }

  let mobileRef: MediaRef | null = null;
  if (recording.mobile) {
    const file = `mobile.${extFor(recording.mobile.mimeType, 'mp4')}`;
    media.push({ name: file, bytes: await blobBytes(recording.mobile.blob) });
    mobileRef = { file, mimeType: recording.mobile.mimeType };
  }

  // Background music lives behind a volatile object URL. Persist its bytes and
  // strip the URL from the stored doc; open() rebuilds a fresh URL.
  let musicRef: MediaRef | null = null;
  let docToStore = doc;
  if (doc.backgroundMusic?.src) {
    try {
      const res = await fetch(doc.backgroundMusic.src);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mimeType = res.headers.get('content-type') || 'audio/mpeg';
      const file = `music.${extFor(mimeType, 'mp3')}`;
      media.push({ name: file, bytes });
      musicRef = { file, mimeType };
    } catch {
      /* couldn't read the music bytes — store the doc without a working src */
    }
    docToStore = { ...doc, backgroundMusic: { ...doc.backgroundMusic, src: '' } };
  }

  const manifest: ProjectManifest = {
    klipeProject: true,
    version: PROJECT_VERSION,
    name: recording.name || 'Untitled',
    createdAt: Date.now(),
    display: recording.display,
    autoZoom: recording.autoZoom !== false,
    mouse: recording.mouse,
    doc: docToStore,
    media: {
      screen: { file: screenFile, mimeType: recording.mimeType },
      camera: cameraRef,
      mobile: mobileRef,
      music: musicRef,
    },
  };

  return bridge.save({
    manifestJson: JSON.stringify(manifest),
    media,
    suggestedName: manifest.name,
  });
}

/**
 * Prompt the user to open a `.klipestudio` project, reconstruct the source
 * blobs and the edit document. Returns `null` if the dialog was dismissed.
 */
export async function openProject(): Promise<OpenedProject | null> {
  const bridge = window.klipe?.project;
  if (!bridge?.open) return null;

  const result = await bridge.open();
  if (!result || result.canceled || !result.manifestJson) return null;

  const manifest = JSON.parse(result.manifestJson) as ProjectManifest;
  if (!manifest || manifest.klipeProject !== true) {
    throw new Error('That folder is not a valid Klipe project.');
  }
  const mediaBytes = result.media || {};

  const blobFor = (ref: MediaRef | null): { blob: Blob; url: string; mimeType: string } | null => {
    if (!ref) return null;
    const bytes = mediaBytes[ref.file];
    if (!bytes) return null;
    // Copy into an ArrayBuffer-backed view so the Blob constructor accepts it
    // (the lib types a bare Uint8Array as possibly SharedArrayBuffer-backed).
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy], { type: ref.mimeType });
    return { blob, url: URL.createObjectURL(blob), mimeType: ref.mimeType };
  };

  const screen = blobFor(manifest.media.screen);
  if (!screen) throw new Error('Project is missing its screen recording.');
  const camera = blobFor(manifest.media.camera);
  const mobile = blobFor(manifest.media.mobile);
  const music = blobFor(manifest.media.music);

  const doc: EditDocument = { ...manifest.doc };
  if (doc.backgroundMusic) {
    doc.backgroundMusic = { ...doc.backgroundMusic, src: music?.url ?? '' };
  }

  const recording: Recording = {
    blob: screen.blob,
    url: screen.url,
    mimeType: screen.mimeType,
    mouse: manifest.mouse,
    display: manifest.display,
    autoZoom: manifest.autoZoom,
    name: manifest.name,
    camera: camera ? { blob: camera.blob, url: camera.url, mimeType: camera.mimeType } : null,
    mobile: mobile ? { blob: mobile.blob, url: mobile.url, mimeType: mobile.mimeType } : null,
  };

  return { recording, doc, projectPath: result.projectPath || '' };
}
