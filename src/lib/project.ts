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
 * Two save paths exist:
 *   - `saveProject`    — full save (prompts for a location, writes every media
 *                        file). Used for the first save / "Save As".
 *   - `saveProjectDoc` — fast re-save to a known folder: rewrites project.json
 *                        only (plus background-music bytes, which can change).
 *                        The large video blobs are immutable in the editor, so
 *                        they are never rewritten. Used by the Save button once
 *                        a path is known, and by autosave.
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
  /** Master volume (0..1) for the recording's own audio. */
  audioVolume?: number;
  /** Per-track volumes (0..1) for the separate mic / system audio tracks. */
  micVolume?: number;
  systemVolume?: number;
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
    micAudio?: MediaRef | null;
    systemAudio?: MediaRef | null;
  };
}

export interface SaveProjectResult {
  canceled: boolean;
  projectPath?: string;
  error?: string;
}

export interface SaveDocResult {
  ok: boolean;
  error?: string;
}

export interface OpenedProject {
  recording: Recording;
  doc: EditDocument;
  projectPath: string;
}

interface ReadResult {
  canceled: boolean;
  manifestJson?: string;
  media?: Record<string, Uint8Array>;
  projectPath?: string;
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
 * Deterministic media filenames for a recording's blobs. The same names are
 * used by the full save (which writes the bytes) and by re-save (which assumes
 * they already exist on disk), so re-save never has to touch the video files.
 */
function mediaRefsFor(recording: Recording): {
  screen: MediaRef;
  camera: MediaRef | null;
  mobile: MediaRef | null;
  micAudio: MediaRef | null;
  systemAudio: MediaRef | null;
} {
  return {
    screen: { file: `screen.${extFor(recording.mimeType, 'webm')}`, mimeType: recording.mimeType },
    camera: recording.camera
      ? { file: `camera.${extFor(recording.camera.mimeType, 'webm')}`, mimeType: recording.camera.mimeType }
      : null,
    mobile: recording.mobile
      ? { file: `mobile.${extFor(recording.mobile.mimeType, 'mp4')}`, mimeType: recording.mobile.mimeType }
      : null,
    micAudio: recording.micAudio
      ? { file: `mic.${extFor(recording.micAudio.mimeType, 'webm')}`, mimeType: recording.micAudio.mimeType }
      : null,
    systemAudio: recording.systemAudio
      ? { file: `system.${extFor(recording.systemAudio.mimeType, 'webm')}`, mimeType: recording.systemAudio.mimeType }
      : null,
  };
}

/** Read the background-music bytes from its volatile object URL, if present. */
async function readMusicMedia(
  doc: EditDocument,
): Promise<{ ref: MediaRef; bytes: Uint8Array } | null> {
  if (!doc.backgroundMusic?.src) return null;
  try {
    const res = await fetch(doc.backgroundMusic.src);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type') || 'audio/mpeg';
    return { ref: { file: `music.${extFor(mimeType, 'mp3')}`, mimeType }, bytes };
  } catch {
    return null;
  }
}

function buildManifest(
  recording: Recording,
  doc: EditDocument,
  musicRef: MediaRef | null,
): ProjectManifest {
  const refs = mediaRefsFor(recording);
  // Strip the volatile background-music object URL from the persisted doc;
  // open() rebuilds it from the stored music file.
  const docToStore = doc.backgroundMusic
    ? { ...doc, backgroundMusic: { ...doc.backgroundMusic, src: '' } }
    : doc;
  return {
    klipeProject: true,
    version: PROJECT_VERSION,
    name: recording.name || 'Untitled',
    createdAt: Date.now(),
    display: recording.display,
    autoZoom: recording.autoZoom !== false,
    mouse: recording.mouse,
    doc: docToStore,
    media: {
      screen: refs.screen,
      camera: refs.camera,
      mobile: refs.mobile,
      music: musicRef,
      micAudio: refs.micAudio,
      systemAudio: refs.systemAudio,
    },
  };
}

/**
 * Full save: prompt for a location and write the manifest plus every media
 * file. Returns `{ canceled: true }` if the dialog was dismissed.
 */
export async function saveProject(
  recording: Recording,
  doc: EditDocument,
): Promise<SaveProjectResult> {
  const bridge = window.klipe?.project;
  if (!bridge?.save) {
    return { canceled: true, error: 'Project saving is unavailable in this build.' };
  }

  const refs = mediaRefsFor(recording);
  const media: Array<{ name: string; bytes: Uint8Array }> = [];
  media.push({ name: refs.screen.file, bytes: await blobBytes(recording.blob) });
  if (recording.camera && refs.camera) {
    media.push({ name: refs.camera.file, bytes: await blobBytes(recording.camera.blob) });
  }
  if (recording.mobile && refs.mobile) {
    media.push({ name: refs.mobile.file, bytes: await blobBytes(recording.mobile.blob) });
  }
  if (recording.micAudio && refs.micAudio) {
    media.push({ name: refs.micAudio.file, bytes: await blobBytes(recording.micAudio.blob) });
  }
  if (recording.systemAudio && refs.systemAudio) {
    media.push({ name: refs.systemAudio.file, bytes: await blobBytes(recording.systemAudio.blob) });
  }
  const music = await readMusicMedia(doc);
  if (music) media.push({ name: music.ref.file, bytes: music.bytes });

  const manifest = buildManifest(recording, doc, music?.ref ?? null);
  return bridge.save({
    manifestJson: JSON.stringify(manifest),
    media,
    suggestedName: manifest.name,
  });
}

/**
 * Fast re-save to an already-known project folder: rewrites project.json (and
 * background-music bytes, which can change), never the immutable video blobs.
 * Used by the Save button once a path is known and by autosave.
 */
export async function saveProjectDoc(
  projectPath: string,
  recording: Recording,
  doc: EditDocument,
): Promise<SaveDocResult> {
  const bridge = window.klipe?.project;
  if (!bridge?.saveDoc) return { ok: false, error: 'Project saving is unavailable in this build.' };
  const music = await readMusicMedia(doc);
  const manifest = buildManifest(recording, doc, music?.ref ?? null);
  return bridge.saveDoc({
    projectPath,
    manifestJson: JSON.stringify(manifest),
    media: music ? [{ name: music.ref.file, bytes: music.bytes }] : [],
  });
}

/** Reconstruct a Recording + edit document from a project read result. */
function reconstructProject(result: ReadResult | null): OpenedProject | null {
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
  const micAudio = blobFor(manifest.media.micAudio ?? null);
  const systemAudio = blobFor(manifest.media.systemAudio ?? null);

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
    micAudio: micAudio ? { blob: micAudio.blob, url: micAudio.url, mimeType: micAudio.mimeType } : null,
    systemAudio: systemAudio ? { blob: systemAudio.blob, url: systemAudio.url, mimeType: systemAudio.mimeType } : null,
  };

  return { recording, doc, projectPath: result.projectPath || '' };
}

/** Prompt the user to pick a `.klipestudio` folder and open it. */
export async function openProject(): Promise<OpenedProject | null> {
  const bridge = window.klipe?.project;
  if (!bridge?.open) return null;
  return reconstructProject(await bridge.open());
}

/** Open a project by a known folder path (no dialog) — used by the recents list. */
export async function openProjectPath(projectPath: string): Promise<OpenedProject | null> {
  const bridge = window.klipe?.project;
  if (!bridge?.openPath) return null;
  return reconstructProject(await bridge.openPath(projectPath));
}
