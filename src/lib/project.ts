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
  FitMode,
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
import type { Caption, CaptionStyle } from '../overlays/captions';
import type { Card, CardSet } from '../cards/types';

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
  /** How a non-matching output aspect is fitted (whole-frame 'fit' vs cropped
   * 'fill'). Optional for back-compat; absent loads as 'fit'. */
  fitMode?: FitMode;
  /** Target social platform export preset id (see lib/platforms). Optional for
   * back-compat with projects saved before the feature existed. */
  platformId?: string;
  mobileOptions: MobileOptions;
  blurRegions: BlurRegion[];
  overlays: Overlay[];
  /**
   * Intro / outro title cards. Absent on projects saved before the feature —
   * `reconstructProject` leaves it undefined and the editor loads it as
   * `{ intro: null, outro: null }`. Card backgrounds + logo images are stored
   * inline as data URLs (same convention as overlays), so no extra media files.
   */
  cards?: CardSet;
  /**
   * Subtitle captions (timed text) + their single shared style. Absent on
   * projects saved before the feature — `reconstructProject` leaves them
   * undefined and the editor loads `[]` + DEFAULT_CAPTION_STYLE. Plain JSON
   * (text only), no extra media files.
   */
  captions?: Caption[];
  captionStyle?: CaptionStyle;
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
  /** Source duration in ms — recorded so the library gallery can show it
   * without decoding the video. Absent on projects saved before the feature. */
  durationMs?: number;
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
    /**
     * Looping video-background clip, if the document uses one. Stored as a
     * separate file (like `music`) rather than inline so a multi-MB clip never
     * bloats project.json or its re-serialization on every autosave. Absent on
     * projects saved before the feature.
     */
    bgVideo?: MediaRef | null;
    /**
     * Video clips used as intro/outro/mid-roll card backgrounds, keyed by slot
     * (see `cardVideoKey`). An array rather than a fixed field because there
     * can be any number of mid-roll cards. Same volatile-URL → stored-file
     * treatment as `bgVideo`. Absent on projects saved before the feature.
     */
    cardVideos?: Array<{ key: string; ref: MediaRef }>;
  };
}

/**
 * Stable identity for a card's stored video, used as both the manifest key and
 * the media filename. Mid-roll cards key off their own id so reordering or
 * adding cards can't make two of them collide.
 */
export function cardVideoKey(slot: 'intro' | 'outro' | 'mid', card: Card): string {
  return slot === 'mid' ? `mid:${card.id}` : slot;
}

/** Every card in a document, paired with its slot. */
function cardEntries(doc: EditDocument): Array<{ slot: 'intro' | 'outro' | 'mid'; card: Card }> {
  const out: Array<{ slot: 'intro' | 'outro' | 'mid'; card: Card }> = [];
  if (doc.cards?.intro) out.push({ slot: 'intro', card: doc.cards.intro });
  if (doc.cards?.outro) out.push({ slot: 'outro', card: doc.cards.outro });
  for (const c of doc.cards?.mid ?? []) out.push({ slot: 'mid', card: c });
  return out;
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

/**
 * Read the looping video-background bytes from its volatile object URL, if the
 * document uses a video background. Same volatile-URL → stored-file pattern as
 * {@link readMusicMedia}, so the clip survives reopen without living inline in
 * project.json.
 */
async function readBgVideoMedia(
  doc: EditDocument,
): Promise<{ ref: MediaRef; bytes: Uint8Array } | null> {
  if (doc.background?.type !== 'video' || !doc.background.src) return null;
  try {
    const res = await fetch(doc.background.src);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type') || 'video/mp4';
    return { ref: { file: `bgvideo.${extFor(mimeType, 'mp4')}`, mimeType }, bytes };
  } catch {
    return null;
  }
}

/**
 * Read every card-background video clip from its volatile object URL. Same
 * pattern as {@link readBgVideoMedia}, once per card that uses one.
 */
async function readCardVideoMedia(
  doc: EditDocument,
): Promise<Array<{ key: string; ref: MediaRef; bytes: Uint8Array }>> {
  const out: Array<{ key: string; ref: MediaRef; bytes: Uint8Array }> = [];
  for (const { slot, card } of cardEntries(doc)) {
    if (card.background?.type !== 'video' || !card.background.src) continue;
    try {
      const res = await fetch(card.background.src);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mimeType = res.headers.get('content-type') || 'video/mp4';
      const key = cardVideoKey(slot, card);
      // Colons aren't safe in filenames on Windows; the key keeps them, the
      // stored file doesn't.
      const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
      out.push({ key, ref: { file: `cardvideo-${safe}.${extFor(mimeType, 'mp4')}`, mimeType }, bytes });
    } catch { /* clip unreadable — skip it rather than fail the save */ }
  }
  return out;
}

function buildManifest(
  recording: Recording,
  doc: EditDocument,
  musicRef: MediaRef | null,
  bgVideoRef: MediaRef | null,
  cardVideoRefs: Array<{ key: string; ref: MediaRef }>,
  durationMs?: number,
): ProjectManifest {
  const refs = mediaRefsFor(recording);
  // Strip volatile object URLs (background music + video background) from the
  // persisted doc; open() rebuilds them from their stored media files. Keeping
  // the video clip out of the JSON is what stops a multi-MB clip from being
  // re-serialized on every autosave.
  let docToStore = doc;
  if (docToStore.backgroundMusic) {
    docToStore = { ...docToStore, backgroundMusic: { ...docToStore.backgroundMusic, src: '' } };
  }
  if (docToStore.background?.type === 'video' && docToStore.background.src) {
    docToStore = { ...docToStore, background: { ...docToStore.background, src: null } };
  }
  // Same for card-background clips: open() rebuilds each src from its file.
  if (docToStore.cards && cardEntries(docToStore).some((e) => e.card.background?.type === 'video')) {
    const strip = (card: Card): Card =>
      card.background?.type === 'video' && card.background.src
        ? { ...card, background: { ...card.background, src: null } }
        : card;
    docToStore = {
      ...docToStore,
      cards: {
        ...docToStore.cards,
        intro: docToStore.cards.intro ? strip(docToStore.cards.intro) : null,
        outro: docToStore.cards.outro ? strip(docToStore.cards.outro) : null,
        ...(docToStore.cards.mid ? { mid: docToStore.cards.mid.map(strip) } : {}),
      },
    };
  }
  return {
    klipeProject: true,
    version: PROJECT_VERSION,
    name: recording.name || 'Untitled',
    createdAt: Date.now(),
    ...(typeof durationMs === 'number' && durationMs > 0 ? { durationMs } : {}),
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
      bgVideo: bgVideoRef,
      ...(cardVideoRefs.length > 0 ? { cardVideos: cardVideoRefs } : {}),
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
  const bgVideo = await readBgVideoMedia(doc);
  if (bgVideo) media.push({ name: bgVideo.ref.file, bytes: bgVideo.bytes });
  const cardVideos = await readCardVideoMedia(doc);
  for (const cv of cardVideos) media.push({ name: cv.ref.file, bytes: cv.bytes });

  const manifest = buildManifest(recording, doc, music?.ref ?? null, bgVideo?.ref ?? null, cardVideos.map((c) => ({ key: c.key, ref: c.ref })));
  return bridge.save({
    manifestJson: JSON.stringify(manifest),
    media,
    suggestedName: manifest.name,
  });
}

export interface LibrarySaveResult {
  ok: boolean;
  projectPath?: string;
  error?: string;
}

/**
 * Auto-save a fresh recording into the managed library (<Videos>/KlipeStudio)
 * with NO dialog. Writes every media file exactly like {@link saveProject} plus
 * a small JPEG poster (`thumbnail.jpg`) and the source duration, so the recording
 * shows up in the gallery immediately and nothing is ever lost. Called once,
 * right after a recording opens in the editor.
 */
export async function saveProjectToLibrary(
  recording: Recording,
  doc: EditDocument,
  options?: { thumbnail?: Uint8Array | null; durationMs?: number | null },
): Promise<LibrarySaveResult> {
  const bridge = window.klipe?.library;
  if (!bridge?.save) return { ok: false, error: 'Library is unavailable in this build.' };

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
  const bgVideo = await readBgVideoMedia(doc);
  if (bgVideo) media.push({ name: bgVideo.ref.file, bytes: bgVideo.bytes });
  const cardVideos = await readCardVideoMedia(doc);
  for (const cv of cardVideos) media.push({ name: cv.ref.file, bytes: cv.bytes });
  if (options?.thumbnail && options.thumbnail.byteLength > 0) {
    media.push({ name: 'thumbnail.jpg', bytes: options.thumbnail });
  }

  const manifest = buildManifest(
    recording,
    doc,
    music?.ref ?? null,
    bgVideo?.ref ?? null,
    cardVideos.map((c) => ({ key: c.key, ref: c.ref })),
    options?.durationMs ?? undefined,
  );
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
  const bgVideo = await readBgVideoMedia(doc);
  const cardVideos = await readCardVideoMedia(doc);
  const manifest = buildManifest(recording, doc, music?.ref ?? null, bgVideo?.ref ?? null, cardVideos.map((c) => ({ key: c.key, ref: c.ref })));
  const media: Array<{ name: string; bytes: Uint8Array }> = [];
  if (music) media.push({ name: music.ref.file, bytes: music.bytes });
  if (bgVideo) media.push({ name: bgVideo.ref.file, bytes: bgVideo.bytes });
  for (const cv of cardVideos) media.push({ name: cv.ref.file, bytes: cv.bytes });
  return bridge.saveDoc({
    projectPath,
    manifestJson: JSON.stringify(manifest),
    media,
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
  const bgVideo = blobFor(manifest.media.bgVideo ?? null);

  const doc: EditDocument = { ...manifest.doc };
  if (doc.backgroundMusic) {
    doc.backgroundMusic = { ...doc.backgroundMusic, src: music?.url ?? '' };
  }
  // Rebuild the video background's volatile object URL from its stored clip.
  if (doc.background?.type === 'video') {
    doc.background = { ...doc.background, src: bgVideo?.url ?? null };
  }
  // Same for card-background clips, matched back up by their stored key.
  const storedCardVideos = manifest.media.cardVideos ?? [];
  if (storedCardVideos.length > 0 && doc.cards) {
    const urlFor = (slot: 'intro' | 'outro' | 'mid', card: Card): string | null => {
      const hit = storedCardVideos.find((c) => c.key === cardVideoKey(slot, card));
      return hit ? (blobFor(hit.ref)?.url ?? null) : null;
    };
    const restore = (slot: 'intro' | 'outro' | 'mid') => (card: Card): Card =>
      card.background?.type === 'video'
        ? { ...card, background: { ...card.background, src: urlFor(slot, card) } }
        : card;
    doc.cards = {
      ...doc.cards,
      intro: doc.cards.intro ? restore('intro')(doc.cards.intro) : null,
      outro: doc.cards.outro ? restore('outro')(doc.cards.outro) : null,
      ...(doc.cards.mid ? { mid: doc.cards.mid.map(restore('mid')) } : {}),
    };
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
