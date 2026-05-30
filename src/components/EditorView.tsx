import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import VideoCanvas from './VideoCanvas';
import Timeline from './Timeline';
import ExportButton from './ExportButton';
import ExportModal from './ExportModal';
import ZoomInspector from './ZoomInspector';
import BlurInspector from './BlurInspector';
import SidebarPanel from './SidebarPanel';
import {
  generateZoomSegments,
  createManualSegment,
  addSegment,
  updateSegment,
  removeSegment,
  DEFAULT_ZOOM,
} from '../lib/zoom-engine';
import {
  addBlurRegion,
  addKeyframeAt,
  commitKeyframeAtTime,
  createBlurRegion,
  removeBlurRegion,
  removeKeyframe,
  updateBlurRegion,
} from '../lib/blur-engine';
import { isFullCrop } from '../lib/layout';
import {
  createFragment,
  cutFragmentAtSource,
  fragmentDuration,
  outputToSource,
  removeFragmentAt,
  setFragmentEdge,
  totalOutputDuration,
} from '../lib/fragments';
import { DEFAULT_CAMERA_OPTIONS } from './panels/CameraPanel';
import { DEFAULT_MOBILE_OPTIONS } from './panels/MobilePanel';
import { DEFAULT_CURSOR_OPTIONS } from '../lib/cursor-engine';
import { DEFAULT_FRAME_OPTIONS, WALLPAPER_PRESETS } from '../lib/renderer';
import { DEFAULT_AUDIO_FX } from '../lib/sound-fx';
import { useAudioFx } from '../lib/use-audio-fx';
import type {
  AudioFxOptions,
  Background,
  BackgroundMusic,
  BlurRegion,
  BlurSampleRect,
  CameraOptions,
  Crop,
  CursorOptions,
  FrameOptions,
  Fragment,
  KlipeMouseEvent,
  MobileOptions,
  Recording,
  ZoomDefaults,
  ZoomSegment,
} from '../types';
import type { Overlay } from '../overlays/types';
import {
  applyAnimation,
  createImageOverlay,
  createTextOverlay,
  detectAnimation,
  type AnimationKind,
} from '../overlays/factories';
import OverlayInspector from '../overlays/components/OverlayInspector';
import OverlayLayerList from '../overlays/components/OverlayLayerList';
import { saveProject, saveProjectDoc, type EditDocument } from '../lib/project';

const DEFAULTS_KEY = 'klipe.zoomDefaults';
const CAMERA_OPTIONS_KEY = 'klipe.cameraOptions';
const MOBILE_OPTIONS_KEY = 'klipe.mobileOptions';
const CURSOR_OPTIONS_KEY = 'klipe.cursorOptions';
const FRAME_OPTIONS_KEY = 'klipe.frameOptions';
const AUDIO_FX_OPTIONS_KEY = 'klipe.audioFxOptions';

function loadDefaults(): ZoomDefaults {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    if (!raw) return DEFAULT_ZOOM;
    const parsed = JSON.parse(raw) as Partial<ZoomDefaults>;
    return { ...DEFAULT_ZOOM, ...parsed };
  } catch {
    return DEFAULT_ZOOM;
  }
}

function loadCameraOptions(): CameraOptions {
  try {
    const raw = localStorage.getItem(CAMERA_OPTIONS_KEY);
    if (!raw) return DEFAULT_CAMERA_OPTIONS;
    const parsed = JSON.parse(raw) as Partial<CameraOptions>;
    return { ...DEFAULT_CAMERA_OPTIONS, ...parsed };
  } catch {
    return DEFAULT_CAMERA_OPTIONS;
  }
}

function loadMobileOptions(): MobileOptions {
  try {
    const raw = localStorage.getItem(MOBILE_OPTIONS_KEY);
    if (!raw) return DEFAULT_MOBILE_OPTIONS;
    const parsed = JSON.parse(raw) as Partial<MobileOptions>;
    return { ...DEFAULT_MOBILE_OPTIONS, ...parsed };
  } catch {
    return DEFAULT_MOBILE_OPTIONS;
  }
}

function loadCursorOptions(): CursorOptions {
  try {
    const raw = localStorage.getItem(CURSOR_OPTIONS_KEY);
    if (!raw) return DEFAULT_CURSOR_OPTIONS;
    const parsed = JSON.parse(raw) as Partial<CursorOptions>;
    return { ...DEFAULT_CURSOR_OPTIONS, ...parsed };
  } catch {
    return DEFAULT_CURSOR_OPTIONS;
  }
}

function loadFrameOptions(): FrameOptions {
  try {
    const raw = localStorage.getItem(FRAME_OPTIONS_KEY);
    if (!raw) return DEFAULT_FRAME_OPTIONS;
    const parsed = JSON.parse(raw) as Partial<FrameOptions>;
    return { ...DEFAULT_FRAME_OPTIONS, ...parsed };
  } catch {
    return DEFAULT_FRAME_OPTIONS;
  }
}

function loadAudioFxOptions(): AudioFxOptions {
  try {
    const raw = localStorage.getItem(AUDIO_FX_OPTIONS_KEY);
    if (!raw) return DEFAULT_AUDIO_FX;
    const parsed = JSON.parse(raw) as Partial<AudioFxOptions>;
    return { ...DEFAULT_AUDIO_FX, ...parsed };
  } catch {
    return DEFAULT_AUDIO_FX;
  }
}

interface EditorViewProps {
  recording: Recording;
  onNew: () => void;
  navExtraEl: HTMLElement | null;
  /** When opening a saved .klipestudio project, the edit document to hydrate from. */
  initialDoc?: EditDocument | null;
  /** Folder of the currently-open project, if any (enables quick-save + autosave). */
  projectPath?: string | null;
  /** Called after a successful save with the project's folder + name. */
  onProjectSaved?: (path: string, name: string) => void;
}

interface HistorySnapshot {
  fragments: Fragment[];
  segments: ZoomSegment[];
  blurRegions: BlurRegion[];
  overlays: Overlay[];
}

const HISTORY_LIMIT = 100;

interface AspectOption {
  id: string;
  label: string;
  ratio: string;
  /** w/h. null means follow the source recording. */
  value: number | null;
}

const ASPECT_OPTIONS: ReadonlyArray<AspectOption> = [
  { id: 'auto', label: 'Auto',     ratio: '',     value: null },
  { id: '16:9', label: 'Wide',     ratio: '16:9', value: 16 / 9 },
  { id: '9:16', label: 'Vertical', ratio: '9:16', value: 9 / 16 },
  { id: '1:1',  label: 'Square',   ratio: '1:1',  value: 1 },
  { id: '4:3',  label: 'Classic',  ratio: '4:3',  value: 4 / 3 },
  { id: '3:4',  label: 'Tall',     ratio: '3:4',  value: 3 / 4 },
];

export default function EditorView({ recording, onNew, navExtraEl, initialDoc, projectPath, onProjectSaved }: EditorViewProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fragments, setFragments] = useState<Fragment[]>(() => initialDoc?.fragments ?? []);
  const [selectedFragmentId, setSelectedFragmentId] = useState<string | null>(null);
  const [background, setBackground] = useState<Background>(
    () => initialDoc?.background ?? { type: 'wallpaper', value: 'default', blur: 0 },
  );
  const [cropMode, setCropMode] = useState(false);
  const [crop, setCrop] = useState<Crop | null>(() => initialDoc?.crop ?? null);
  const [zoomDefaults, setZoomDefaults] = useState<ZoomDefaults>(() => initialDoc?.zoomDefaults ?? loadDefaults());
  const [segments, setSegments] = useState<ZoomSegment[]>(() =>
    initialDoc
      ? initialDoc.segments
      : recording.autoZoom === false
        ? []
        : generateZoomSegments(recording.mouse),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [cameraOptions, setCameraOptions] = useState<CameraOptions>(() => initialDoc?.cameraOptions ?? loadCameraOptions());
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const [cursorOptions, setCursorOptions] = useState<CursorOptions>(() => initialDoc?.cursorOptions ?? loadCursorOptions());
  const [frameOptions, setFrameOptions] = useState<FrameOptions>(() => initialDoc?.frameOptions ?? loadFrameOptions());
  const [audioFxOptions, setAudioFxOptions] = useState<AudioFxOptions>(() => initialDoc?.audioFxOptions ?? loadAudioFxOptions());
  const [backgroundMusic, setBackgroundMusic] = useState<BackgroundMusic | null>(() => initialDoc?.backgroundMusic ?? null);
  const [audioVolume, setAudioVolume] = useState<number>(() => initialDoc?.audioVolume ?? 1);
  const lastVolumeRef = useRef(1);
  // Per-track recording-audio volumes (mic vs system). Multiplied by the master
  // audioVolume. Only meaningful when the recording has separate audio tracks.
  const [micVolume, setMicVolume] = useState<number>(() => initialDoc?.micVolume ?? 1);
  const [systemVolume, setSystemVolume] = useState<number>(() => initialDoc?.systemVolume ?? 1);
  const micAudioRef = useRef<HTMLAudioElement | null>(null);
  const systemAudioRef = useRef<HTMLAudioElement | null>(null);
  const recordedMicAudio = recording.micAudio ?? null;
  const recordedSystemAudio = recording.systemAudio ?? null;

  // Recorded mic/system audio playback. New recordings store audio as separate
  // tracks (the screen blob is video-only), so two hidden <audio> elements play
  // them in lockstep with the main <video>, like the camera/mobile videos.
  useEffect(() => {
    const main = videoRef.current;
    const mic = micAudioRef.current;
    const sys = systemAudioRef.current;
    const els: HTMLAudioElement[] = [];
    if (mic && recordedMicAudio) {
      mic.src = recordedMicAudio.url; mic.preload = 'auto'; mic.load(); els.push(mic);
    }
    if (sys && recordedSystemAudio) {
      sys.src = recordedSystemAudio.url; sys.preload = 'auto'; sys.load(); els.push(sys);
    }
    if (!main || els.length === 0) return undefined;
    const SYNC = 0.06;
    const syncTime = (): void => {
      for (const a of els) {
        if (Math.abs(a.currentTime - main.currentTime) > SYNC) a.currentTime = main.currentTime;
      }
    };
    const onPlay = (): void => {
      syncTime();
      for (const a of els) { a.playbackRate = main.playbackRate; a.play().catch(() => { /* retry */ }); }
    };
    const onPause = (): void => { for (const a of els) a.pause(); syncTime(); };
    const onSeek = (): void => { for (const a of els) a.currentTime = main.currentTime; };
    const onRate = (): void => { for (const a of els) a.playbackRate = main.playbackRate; };
    const onTime = (): void => syncTime();
    main.addEventListener('play', onPlay);
    main.addEventListener('pause', onPause);
    main.addEventListener('seeking', onSeek);
    main.addEventListener('seeked', onSeek);
    main.addEventListener('ratechange', onRate);
    main.addEventListener('timeupdate', onTime);
    if (!main.paused) onPlay(); else syncTime();
    return () => {
      main.removeEventListener('play', onPlay);
      main.removeEventListener('pause', onPause);
      main.removeEventListener('seeking', onSeek);
      main.removeEventListener('seeked', onSeek);
      main.removeEventListener('ratechange', onRate);
      main.removeEventListener('timeupdate', onTime);
      for (const a of els) a.pause();
    };
  }, [recordedMicAudio, recordedSystemAudio]);

  // Apply master × per-track volume to each recorded audio element.
  useEffect(() => {
    if (micAudioRef.current) {
      micAudioRef.current.volume = Math.max(0, Math.min(1, audioVolume * micVolume));
    }
  }, [audioVolume, micVolume]);
  useEffect(() => {
    if (systemAudioRef.current) {
      systemAudioRef.current.volume = Math.max(0, Math.min(1, audioVolume * systemVolume));
    }
  }, [audioVolume, systemVolume]);

  // Release recorded audio object URLs when the recording is replaced.
  useEffect(() => {
    return () => {
      if (recordedMicAudio?.url) { try { URL.revokeObjectURL(recordedMicAudio.url); } catch { /* ignore */ } }
      if (recordedSystemAudio?.url) { try { URL.revokeObjectURL(recordedSystemAudio.url); } catch { /* ignore */ } }
    };
  }, [recordedMicAudio, recordedSystemAudio]);
  const hasSeparateAudio = !!(recordedMicAudio || recordedSystemAudio);
  const bgMusicAudioRef = useRef<HTMLAudioElement | null>(null);
  // A phone clip is portrait by nature, so default the canvas to 9:16 when
  // the recording's primary subject is a phone. The user can still change it.
  const [aspectRatioId, setAspectRatioId] = useState<string>(
    () => initialDoc?.aspectRatioId ?? (recording.mobile ? '9:16' : 'auto'),
  );
  const [aspectMenuOpen, setAspectMenuOpen] = useState(false);
  const aspectMenuRef = useRef<HTMLDivElement | null>(null);
  const [addLayerMenuOpen, setAddLayerMenuOpen] = useState(false);
  const addLayerMenuRef = useRef<HTMLDivElement | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const [mobileOptions, setMobileOptions] = useState<MobileOptions>(() => initialDoc?.mobileOptions ?? loadMobileOptions());
  const [mobileAvailable, setMobileAvailable] = useState(false);
  const mobileVideoRef = useRef<HTMLVideoElement | null>(null);
  const [blurRegions, setBlurRegions] = useState<BlurRegion[]>(() => initialDoc?.blurRegions ?? []);
  const [selectedBlurId, setSelectedBlurId] = useState<string | null>(null);
  const [blurMode, setBlurMode] = useState<boolean>(false);
  const [overlays, setOverlays] = useState<Overlay[]>(() => initialDoc?.overlays ?? []);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [savingProject, setSavingProject] = useState(false);

  const exportCrop: Crop | null = isFullCrop(crop) ? null : crop;

  const aspectOption = useMemo<AspectOption>(
    () => ASPECT_OPTIONS.find((o) => o.id === aspectRatioId) ?? ASPECT_OPTIONS[0]!,
    [aspectRatioId],
  );

  const previewSurroundStyle = useMemo<CSSProperties>(() => {
    if (background.type === 'color') {
      return { background: background.value || '#0b0d12' };
    }
    if (background.type === 'gradient') {
      const angle = background.angle == null ? 135 : background.angle;
      return { background: `linear-gradient(${angle}deg, ${background.from}, ${background.to})` };
    }
    if (background.type === 'image') {
      // The canvas renders the image cover-fit to its own size; matching that
      // exactly in CSS on the larger .preview rect would require runtime layout
      // math, so we fall back to the dark surround here to avoid a visible seam.
      return {};
    }
    const preset = WALLPAPER_PRESETS[background.value] ?? WALLPAPER_PRESETS['default']!;
    return { background: `linear-gradient(135deg, ${preset.from}, ${preset.to})` };
  }, [background]);

  useEffect(() => {
    if (!aspectMenuOpen) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (target && aspectMenuRef.current?.contains(target)) return;
      setAspectMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAspectMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [aspectMenuOpen]);

  useEffect(() => {
    if (!addLayerMenuOpen) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (target && addLayerMenuRef.current?.contains(target)) return;
      setAddLayerMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAddLayerMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [addLayerMenuOpen]);

  const clicks = useMemo<KlipeMouseEvent[]>(
    () => recording.mouse.events.filter((e) => e.type === 'click'),
    [recording.mouse],
  );

  const selected = useMemo<ZoomSegment | null>(
    () => segments.find((s) => s.id === selectedId) ?? null,
    [segments, selectedId],
  );

  const duration = useMemo(() => totalOutputDuration(fragments), [fragments]);

  const fragmentsRef = useRef<Fragment[]>(fragments);
  fragmentsRef.current = fragments;
  const segmentsRef = useRef<ZoomSegment[]>(segments);
  segmentsRef.current = segments;
  const blurRegionsRef = useRef<BlurRegion[]>(blurRegions);
  blurRegionsRef.current = blurRegions;
  const overlaysRef = useRef<Overlay[]>(overlays);
  overlaysRef.current = overlays;
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const historyRef = useRef<{ past: HistorySnapshot[]; future: HistorySnapshot[] }>({
    past: [],
    future: [],
  });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const syncHistoryFlags = useCallback((): void => {
    const h = historyRef.current;
    setCanUndo(h.past.length > 0);
    setCanRedo(h.future.length > 0);
  }, []);

  const snapshot = useCallback((): HistorySnapshot => ({
    fragments: fragmentsRef.current,
    segments: segmentsRef.current,
    blurRegions: blurRegionsRef.current,
    overlays: overlaysRef.current,
  }), []);

  // The full editor state, gathered for project persistence. Mirrors the
  // fields the export pipeline consumes plus zoomDefaults / aspectRatioId.
  const buildEditDocument = useCallback((): EditDocument => ({
    fragments,
    segments,
    background,
    crop,
    zoomDefaults,
    cameraOptions,
    cursorOptions,
    frameOptions,
    audioFxOptions,
    backgroundMusic,
    audioVolume,
    micVolume,
    systemVolume,
    aspectRatioId,
    mobileOptions,
    blurRegions,
    overlays,
  }), [
    fragments, segments, background, crop, zoomDefaults, cameraOptions,
    cursorOptions, frameOptions, audioFxOptions, backgroundMusic, audioVolume,
    micVolume, systemVolume, aspectRatioId, mobileOptions, blurRegions, overlays,
  ]);

  const handleSaveProject = useCallback(async (): Promise<void> => {
    setSavingProject(true);
    try {
      if (projectPath) {
        // Re-save to the known folder without re-prompting (json + music only).
        const res = await saveProjectDoc(projectPath, recording, buildEditDocument());
        if (!res.ok) console.error('[project] save failed:', res.error);
        else onProjectSaved?.(projectPath, recording.name || 'Untitled');
      } else {
        // First save: prompt for a location and write everything.
        const res = await saveProject(recording, buildEditDocument());
        if (res.error) console.error('[project] save failed:', res.error);
        else if (!res.canceled && res.projectPath) {
          onProjectSaved?.(res.projectPath, recording.name || 'Untitled');
        }
      }
    } catch (e) {
      console.error('[project] save failed:', e);
    } finally {
      setSavingProject(false);
    }
  }, [projectPath, recording, buildEditDocument, onProjectSaved]);

  // Debounced autosave: once a project has a folder on disk, persist edit-doc
  // changes ~1.5s after the user stops editing. Rewrites only project.json
  // (and music bytes), never the immutable video blobs. buildEditDocument's
  // identity changes whenever any document field changes, re-arming the timer.
  useEffect(() => {
    if (!projectPath) return;
    const t = setTimeout(() => {
      void saveProjectDoc(projectPath, recording, buildEditDocument()).catch(() => {
        /* autosave is best-effort — the explicit Save surfaces errors */
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [projectPath, recording, buildEditDocument]);

  // Master volume for the recording's own audio. With separate mic/system
  // tracks the screen blob has no audio, so the main <video> is muted and the
  // per-track <audio> elements carry the sound (master × per-track gain). For
  // legacy recordings (audio baked into the screen blob) the main <video> plays
  // it at the master volume.
  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.muted = hasSeparateAudio;
      v.volume = audioVolume;
    }
    const mic = micAudioRef.current;
    if (mic) mic.volume = Math.max(0, Math.min(1, audioVolume * micVolume));
    const sys = systemAudioRef.current;
    if (sys) sys.volume = Math.max(0, Math.min(1, audioVolume * systemVolume));
  }, [audioVolume, micVolume, systemVolume, hasSeparateAudio]);

  const handleVolumeChange = useCallback((v: number): void => {
    setAudioVolume(v);
    if (v > 0) lastVolumeRef.current = v;
  }, []);

  const toggleMute = useCallback((): void => {
    setAudioVolume((cur) => {
      if (cur > 0) { lastVolumeRef.current = cur; return 0; }
      return lastVolumeRef.current > 0 ? lastVolumeRef.current : 1;
    });
  }, []);

  const pushHistory = useCallback((): void => {
    const h = historyRef.current;
    h.past.push(snapshot());
    if (h.past.length > HISTORY_LIMIT) h.past.shift();
    h.future = [];
    syncHistoryFlags();
  }, [snapshot, syncHistoryFlags]);

  const applySnapshot = useCallback((snap: HistorySnapshot): void => {
    fragmentsRef.current = snap.fragments;
    segmentsRef.current = snap.segments;
    blurRegionsRef.current = snap.blurRegions;
    overlaysRef.current = snap.overlays;
    setFragments(snap.fragments);
    setSegments(snap.segments);
    setBlurRegions(snap.blurRegions);
    setOverlays(snap.overlays);
  }, []);

  const undo = useCallback((): void => {
    const h = historyRef.current;
    if (!h.past.length) return;
    const prev = h.past.pop()!;
    h.future.push(snapshot());
    if (h.future.length > HISTORY_LIMIT) h.future.shift();
    applySnapshot(prev);
    syncHistoryFlags();
  }, [applySnapshot, snapshot, syncHistoryFlags]);

  const redo = useCallback((): void => {
    const h = historyRef.current;
    if (!h.future.length) return;
    const next = h.future.pop()!;
    h.past.push(snapshot());
    if (h.past.length > HISTORY_LIMIT) h.past.shift();
    applySnapshot(next);
    syncHistoryFlags();
  }, [applySnapshot, snapshot, syncHistoryFlags]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onLoaded = (): void => {
      const d = isFinite(v.duration) && v.duration > 0
        ? v.duration
        : (recording.mouse.events.at(-1)?.t ?? 0) / 1000;
      setSourceDuration(d);
      setFragments((prev) => (prev.length === 0 ? [createFragment(0, d)] : prev));
    };
    const onEnd = (): void => setPlaying(false);
    v.addEventListener('loadedmetadata', onLoaded);
    v.addEventListener('durationchange', onLoaded);
    v.addEventListener('ended', onEnd);
    return () => {
      v.removeEventListener('loadedmetadata', onLoaded);
      v.removeEventListener('durationchange', onLoaded);
      v.removeEventListener('ended', onEnd);
    };
  }, [recording]);

  // Drive playback through fragments. Each frame, derive output-time from the
  // <video> element's source-time + the active fragment's start offset; when the
  // source crosses the fragment's srcEnd, advance to the next fragment.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const frags = fragmentsRef.current;
      if (!frags.length) return;
      const out = currentTimeRef.current;
      const m = outputToSource(frags, out);
      if (!m) return;
      if (!playingRef.current || v.paused) return;

      const src = v.currentTime;
      if (src >= m.fragment.srcEnd - 0.01) {
        const nextIdx = m.index + 1;
        if (nextIdx >= frags.length) {
          v.pause();
          setPlaying(false);
          setCurrentTime(totalOutputDuration(frags));
        } else {
          const nf = frags[nextIdx]!;
          v.currentTime = nf.srcStart;
          setCurrentTime(m.fragOutputStart + fragmentDuration(m.fragment));
        }
        return;
      }
      if (src < m.fragment.srcStart - 0.05) {
        v.currentTime = m.fragment.srcStart;
        return;
      }
      const offset = Math.max(0, src - m.fragment.srcStart);
      setCurrentTime(m.fragOutputStart + offset);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seek = useCallback((outputT: number): void => {
    const v = videoRef.current;
    if (!v) return;
    const total = totalOutputDuration(fragmentsRef.current);
    const t = Math.max(0, Math.min(total, outputT));
    const m = outputToSource(fragmentsRef.current, t);
    if (m) v.currentTime = m.srcTime;
    currentTimeRef.current = t;
    setCurrentTime(t);
  }, []);

  const togglePlay = (): void => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      const total = totalOutputDuration(fragmentsRef.current);
      if (currentTimeRef.current >= total - 0.02) {
        seek(0);
      } else {
        const m = outputToSource(fragmentsRef.current, currentTimeRef.current);
        if (m) v.currentTime = m.srcTime;
      }
      v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const fmt = (s: number): string => {
    const m = Math.floor(s / 60);
    const r = (s % 60).toFixed(2).padStart(5, '0');
    return `${String(m).padStart(2, '0')}:${r}`;
  };

  const handleAddZoom = useCallback(() => {
    const m = outputToSource(fragmentsRef.current, currentTime);
    const tMs = (m ? m.srcTime : 0) * 1000;
    const seg = createManualSegment({
      tMs,
      durationMs: zoomDefaults.duration,
      easeIn: zoomDefaults.easeIn,
      easeOut: zoomDefaults.easeOut,
      scale: zoomDefaults.scale,
      easing: zoomDefaults.easing,
      display: recording.display,
    });
    pushHistory();
    setSegments((prev) => addSegment(prev, seg));
    setSelectedId(seg.id);
  }, [currentTime, zoomDefaults, recording.display, pushHistory]);

  const handleCut = useCallback(() => {
    const m = outputToSource(fragmentsRef.current, currentTimeRef.current);
    if (!m) return;
    const next = cutFragmentAtSource(fragmentsRef.current, m.index, m.srcTime);
    if (next === fragmentsRef.current) return;
    pushHistory();
    setFragments(next);
  }, [pushHistory]);

  const handleUpdateFragments = useCallback((next: Fragment[]) => {
    setFragments(next);
  }, []);

  const handleSelectFragment = useCallback((id: string | null) => {
    setSelectedFragmentId(id);
    if (id) {
      setSelectedId(null);
      setSelectedBlurId(null);
    }
  }, []);

  const handleSelectZoom = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setSelectedBlurId(null);
  }, []);

  const handleFragmentEdge = useCallback(
    (index: number, edge: 'start' | 'end', srcTime: number) => {
      setFragments((prev) => setFragmentEdge(prev, index, edge, srcTime));
    },
    [],
  );

  const handleDeleteFragment = useCallback(() => {
    const prev = fragmentsRef.current;
    if (!selectedFragmentId) return;
    const idx = prev.findIndex((f) => f.id === selectedFragmentId);
    if (idx < 0) return;
    const next = removeFragmentAt(prev, idx);
    if (next === prev) return;
    pushHistory();
    const newTotal = next.reduce((acc, f) => acc + fragmentDuration(f), 0);
    const out = Math.min(currentTimeRef.current, newTotal);
    const m = outputToSource(next, out);
    const v = videoRef.current;
    if (v && m) v.currentTime = m.srcTime;
    currentTimeRef.current = out;
    setCurrentTime(out);
    setFragments(next);
    setSelectedFragmentId(null);
  }, [selectedFragmentId, pushHistory]);

  const handleUpdateSegment = useCallback((id: string, patch: Partial<ZoomSegment>) => {
    setSegments((prev) => updateSegment(prev, id, patch));
  }, []);

  const handleRemoveSegment = useCallback((id: string) => {
    pushHistory();
    setSegments((prev) => removeSegment(prev, id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, [pushHistory]);

  const handleApplyToAll = useCallback((patch: Partial<ZoomSegment>) => {
    pushHistory();
    setSegments((prev) => prev.map((s) => ({ ...s, ...patch })));
  }, [pushHistory]);

  const handleSetDefault = useCallback((patch: Partial<ZoomDefaults>) => {
    setZoomDefaults((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const handleCameraOptionsChange = useCallback((next: CameraOptions) => {
    setCameraOptions(next);
    try { localStorage.setItem(CAMERA_OPTIONS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  const handleMobileOptionsChange = useCallback((next: MobileOptions) => {
    setMobileOptions(next);
    try { localStorage.setItem(MOBILE_OPTIONS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  const handleCursorOptionsChange = useCallback((next: CursorOptions) => {
    setCursorOptions(next);
    try { localStorage.setItem(CURSOR_OPTIONS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  const handleFrameOptionsChange = useCallback((next: FrameOptions) => {
    setFrameOptions(next);
    try { localStorage.setItem(FRAME_OPTIONS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  const handleAudioFxOptionsChange = useCallback((next: AudioFxOptions) => {
    setAudioFxOptions(next);
    try { localStorage.setItem(AUDIO_FX_OPTIONS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  // Map current output time → source time once per render so the overlay,
  // inspector, and any blur action invoked from the panel all agree.
  const currentSrcMs = useMemo<number>(() => {
    const m = outputToSource(fragments, currentTime);
    return (m ? m.srcTime : 0) * 1000;
  }, [fragments, currentTime]);

  const sourceDurationMs = useMemo<number>(
    () => Math.max(0, sourceDuration * 1000),
    [sourceDuration],
  );

  const selectedBlur = useMemo<BlurRegion | null>(
    () => blurRegions.find((r) => r.id === selectedBlurId) ?? null,
    [blurRegions, selectedBlurId],
  );

  const selectedOverlay = useMemo<Overlay | null>(
    () => overlays.find((o) => o.id === selectedOverlayId) ?? null,
    [overlays, selectedOverlayId],
  );

  const handleSelectBlur = useCallback((id: string | null) => {
    setSelectedBlurId(id);
    if (id) setSelectedId(null);
  }, []);

  const handleBlurModeChange = useCallback((next: boolean) => {
    setBlurMode(next);
    if (!next) setSelectedBlurId(null);
  }, []);

  const handleAddBlurAtPlayhead = useCallback(() => {
    // Default region: 30%×20% centered at playhead, 4-second window clamped
    // to the source. Drops the user straight into the new region with the
    // overlay visible so they can immediately drag it where it belongs.
    const tStart = Math.max(0, currentSrcMs - 2000);
    const tEnd = Math.min(sourceDurationMs > 0 ? sourceDurationMs : currentSrcMs + 4000, currentSrcMs + 2000);
    const region = createBlurRegion({
      tStart,
      tEnd,
      initial: { tMs: currentSrcMs, x: 0.35, y: 0.4, width: 0.3, height: 0.2 },
    });
    pushHistory();
    setBlurRegions((prev) => addBlurRegion(prev, region));
    setSelectedBlurId(region.id);
    setBlurMode(true);
    setSelectedId(null);
  }, [currentSrcMs, sourceDurationMs, pushHistory]);

  const handleCreateBlur = useCallback((rect: BlurSampleRect) => {
    const tStart = Math.max(0, currentSrcMs - 2000);
    const tEnd = Math.min(sourceDurationMs > 0 ? sourceDurationMs : currentSrcMs + 4000, currentSrcMs + 2000);
    const region = createBlurRegion({
      tStart,
      tEnd,
      initial: { tMs: currentSrcMs, ...rect },
    });
    pushHistory();
    setBlurRegions((prev) => addBlurRegion(prev, region));
    setSelectedBlurId(region.id);
    setSelectedId(null);
  }, [currentSrcMs, sourceDurationMs, pushHistory]);

  const handleDragBlurRect = useCallback((id: string, rect: BlurSampleRect) => {
    setBlurRegions((prev) => prev.map((r) => (r.id === id ? commitKeyframeAtTime(r, currentSrcMs, rect) : r)));
  }, [currentSrcMs]);

  const handleCommitBlurRect = useCallback((_id: string) => {
    pushHistory();
  }, [pushHistory]);

  const handleUpdateBlur = useCallback((patch: Partial<BlurRegion>) => {
    if (!selectedBlurId) return;
    setBlurRegions((prev) => updateBlurRegion(prev, selectedBlurId, patch));
  }, [selectedBlurId]);

  const handleRemoveBlur = useCallback((id: string) => {
    pushHistory();
    setBlurRegions((prev) => removeBlurRegion(prev, id));
    setSelectedBlurId((cur) => (cur === id ? null : cur));
  }, [pushHistory]);

  const handleAddBlurKeyframe = useCallback(() => {
    if (!selectedBlurId) return;
    pushHistory();
    setBlurRegions((prev) => prev.map((r) => (r.id === selectedBlurId ? addKeyframeAt(r, currentSrcMs) : r)));
  }, [selectedBlurId, currentSrcMs, pushHistory]);

  const handleRemoveBlurKeyframe = useCallback((tMs: number) => {
    if (!selectedBlurId) return;
    pushHistory();
    setBlurRegions((prev) => prev.map((r) => (r.id === selectedBlurId ? removeKeyframe(r, tMs) : r)));
  }, [selectedBlurId, pushHistory]);

  // ---------------------------------------------------------------------------
  // Overlay mutators
  // ---------------------------------------------------------------------------

  /**
   * Default visibility window for a newly added overlay: a 3-second bar
   * starting at the current playhead, clamped to the clip's end. If the
   * playhead is within 500 ms of the end, we slide the start earlier so the
   * user still gets a draggable bar instead of a 0-width sliver.
   */
  const defaultVisibility = useCallback((): { visibleFrom: number; visibleTo: number } => {
    const DEFAULT_MS = 3000;
    const MIN_MS = 500;
    const totalMs = Math.max(0, Math.round(duration * 1000));
    let fromMs = Math.round(currentTimeRef.current * 1000);
    let toMs = Math.min(fromMs + DEFAULT_MS, totalMs);
    if (toMs - fromMs < MIN_MS) {
      fromMs = Math.max(0, toMs - MIN_MS);
    }
    return { visibleFrom: fromMs, visibleTo: toMs };
  }, [duration]);

  const handleAddTextOverlay = useCallback(() => {
    pushHistory();
    const base = createTextOverlay(overlaysRef.current);
    const overlay = { ...base, ...defaultVisibility() };
    setOverlays((prev) => [...prev, overlay]);
    setSelectedOverlayId(overlay.id);
    setSelectedId(null);
    setSelectedBlurId(null);
    setSelectedFragmentId(null);
  }, [pushHistory, defaultVisibility]);

  const handleAddImageOverlay = useCallback(async () => {
    const bridge = window.klipe;
    if (!bridge?.openImageFile) return;
    const result = await bridge.openImageFile();
    if (!result || 'error' in result) return;
    const img = new Image();
    img.src = result.dataUrl;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image'));
    });
    pushHistory();
    const base = createImageOverlay(
      overlaysRef.current,
      result.dataUrl,
      img.naturalWidth || 800,
      img.naturalHeight || 600,
      result.name,
    );
    const overlay = { ...base, ...defaultVisibility() };
    setOverlays((prev) => [...prev, overlay]);
    setSelectedOverlayId(overlay.id);
    setSelectedId(null);
    setSelectedBlurId(null);
    setSelectedFragmentId(null);
  }, [pushHistory, defaultVisibility]);

  const handleSelectOverlay = useCallback((id: string | null) => {
    setSelectedOverlayId(id);
    if (id) {
      setSelectedId(null);
      setSelectedBlurId(null);
      setSelectedFragmentId(null);
    }
  }, []);

  const handleUpdateOverlay = useCallback((id: string, patch: Partial<Overlay>) => {
    const timingChanged = 'visibleFrom' in patch || 'visibleTo' in patch;
    setOverlays((prev) => prev.map((o) => {
      if (o.id !== id) return o;
      const merged = { ...o, ...patch } as Overlay;
      // When timing moves, re-apply the detected animation so its keyframes
      // shift with visibleFrom / visibleTo. Without this, a "Fade In" applied
      // at t=0 keeps firing at t=0 even after the user drags the bar to t=2s.
      if (timingChanged) {
        const kind = detectAnimation(o);
        if (kind !== 'none') return applyAnimation(merged, kind);
      }
      return merged;
    }));
  }, []);

  const handleRemoveOverlay = useCallback((id: string) => {
    pushHistory();
    setOverlays((prev) => prev.filter((o) => o.id !== id));
    setSelectedOverlayId((cur) => (cur === id ? null : cur));
  }, [pushHistory]);

  const handleApplyOverlayAnimation = useCallback((id: string, kind: AnimationKind) => {
    pushHistory();
    setOverlays((prev) => prev.map((o) => (o.id === id ? applyAnimation(o, kind) : o)));
  }, [pushHistory]);

  // Editor keyboard shortcuts. Defined after every handler it calls so the deps
  // can reference them safely. Typing in text inputs is never hijacked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      // Undo/redo: Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z (redo), Cmd/Ctrl+Y (redo).
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
        return;
      }

      switch (e.key) {
        case ' ':
          if (tag === 'BUTTON') return; // let Space activate a focused button
          e.preventDefault();
          togglePlay();
          break;
        case 'Delete':
        case 'Backspace':
          // Remove the selected item (priority: zoom > blur > overlay > clip).
          if (selectedId) { e.preventDefault(); handleRemoveSegment(selectedId); }
          else if (selectedBlurId) { e.preventDefault(); handleRemoveBlur(selectedBlurId); }
          else if (selectedOverlayId) { e.preventDefault(); handleRemoveOverlay(selectedOverlayId); }
          else if (selectedFragmentId && fragments.length > 1) { e.preventDefault(); handleDeleteFragment(); }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seek(currentTimeRef.current - (e.shiftKey ? 1 : 1 / 30));
          break;
        case 'ArrowRight':
          e.preventDefault();
          seek(currentTimeRef.current + (e.shiftKey ? 1 : 1 / 30));
          break;
        case 'Home':
          e.preventDefault();
          seek(0);
          break;
        case 'End':
          e.preventDefault();
          seek(totalOutputDuration(fragmentsRef.current));
          break;
        case 'c':
        case 'C':
          e.preventDefault();
          handleCut();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    undo, redo, togglePlay, seek, handleCut,
    handleRemoveSegment, handleRemoveBlur, handleRemoveOverlay, handleDeleteFragment,
    selectedId, selectedBlurId, selectedOverlayId, selectedFragmentId, fragments.length,
  ]);

  const handleMoveOverlay = useCallback((id: string, base: { x: number; y: number }) => {
    setOverlays((prev) =>
      prev.map((o) => (o.id === id ? ({ ...o, base: { ...o.base, x: base.x, y: base.y } } as Overlay) : o)),
    );
  }, []);

  const handleToggleHideOverlay = useCallback((id: string) => {
    pushHistory();
    setOverlays((prev) => prev.map((o) => (o.id === id ? ({ ...o, hidden: !o.hidden } as Overlay) : o)));
  }, [pushHistory]);

  const handleRenameOverlay = useCallback((id: string, name: string) => {
    setOverlays((prev) => prev.map((o) => (o.id === id ? ({ ...o, name: name || undefined } as Overlay) : o)));
  }, []);

  const handleDuplicateOverlay = useCallback((id: string) => {
    const source = overlaysRef.current.find((o) => o.id === id);
    if (!source) return;
    pushHistory();
    const copy: Overlay = {
      ...source,
      id: `${source.type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      z: overlaysRef.current.reduce((acc, o) => Math.max(acc, o.z), 0) + 1,
      // Slight offset so the duplicate is visible, not stacked exactly on top.
      base: {
        ...source.base,
        x: Math.min(1, source.base.x + 0.03),
        y: Math.min(1, source.base.y + 0.03),
      },
      transform: structuredClone(source.transform),
    };
    setOverlays((prev) => [...prev, copy]);
    setSelectedOverlayId(copy.id);
  }, [pushHistory]);

  /**
   * Reorder an overlay to a new index. `toIndex` is the position in the
   * visible list (sorted by z descending). We re-stamp z values from the new
   * array so the displayed order stays canonical.
   */
  const handleReorderOverlays = useCallback((fromId: string, toIndex: number) => {
    pushHistory();
    setOverlays((prev) => {
      const sorted = [...prev].sort((a, b) => b.z - a.z);
      const fromIndex = sorted.findIndex((o) => o.id === fromId);
      if (fromIndex < 0 || toIndex < 0 || toIndex >= sorted.length || fromIndex === toIndex) {
        return prev;
      }
      const next = [...sorted];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return prev;
      next.splice(toIndex, 0, moved);
      // Top of list = highest z. Re-stamp so z is canonical.
      const n = next.length;
      return next.map((o, i) => ({ ...o, z: n - i } as Overlay));
    });
  }, [pushHistory]);

  const handleBackgroundMusicChange = useCallback((next: BackgroundMusic | null) => {
    setBackgroundMusic((prev) => {
      // Revoke the previous object URL when the source actually changes.
      if (prev && prev.src && prev.src !== next?.src) {
        try { URL.revokeObjectURL(prev.src); } catch { /* ignore */ }
      }
      return next;
    });
  }, []);

  const handleUpdateBackgroundMusic = useCallback((patch: Partial<BackgroundMusic>) => {
    setBackgroundMusic((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  // Keep a hidden <audio> in sync with playback so the editor previews
  // background music alongside the video. Music plays only while
  // currentTime is within [startMs, endMs]; outside that window it is
  // silent (paused).
  useEffect(() => {
    if (!backgroundMusic) {
      if (bgMusicAudioRef.current) {
        bgMusicAudioRef.current.pause();
        bgMusicAudioRef.current.src = '';
        bgMusicAudioRef.current = null;
      }
      return undefined;
    }
    let el = bgMusicAudioRef.current;
    if (!el || el.src !== backgroundMusic.src) {
      el?.pause();
      el = new Audio(backgroundMusic.src);
      el.loop = true;
      el.preload = 'auto';
      bgMusicAudioRef.current = el;
      // When metadata arrives, fill in the natural duration and pick a
      // sensible default end if the user hasn't trimmed yet.
      el.addEventListener('loadedmetadata', () => {
        const natural = isFinite(el!.duration) ? el!.duration * 1000 : 0;
        setBackgroundMusic((prev) => {
          if (!prev || prev.src !== el!.src) return prev;
          if (prev.durationMs === natural && prev.endMs > prev.startMs) return prev;
          const clipMs = duration * 1000;
          const defaultEnd = clipMs > 0
            ? Math.min(natural || clipMs, clipMs)
            : (natural || prev.endMs);
          return {
            ...prev,
            durationMs: natural,
            endMs: prev.endMs > prev.startMs ? prev.endMs : defaultEnd,
          };
        });
      }, { once: true });
    }
    el.volume = Math.max(0, Math.min(1, backgroundMusic.volume));
    return () => {
      // Note: don't tear down here — only on unmount or src change above.
    };
  }, [backgroundMusic, duration]);

  useEffect(() => {
    const el = bgMusicAudioRef.current;
    if (!el || !backgroundMusic) return;
    const tSec = currentTime;
    const startSec = backgroundMusic.startMs / 1000;
    const endSec = backgroundMusic.endMs / 1000;
    const sourceStartSec = (backgroundMusic.sourceStartMs || 0) / 1000;
    const inWindow = tSec >= startSec && tSec < endSec;
    if (playing && inWindow) {
      // Sync source position: start from sourceStartSec when at the window's
      // left edge, and loop modulo natural duration if the window outlasts
      // (natural - sourceStartSec).
      const natural = el.duration && isFinite(el.duration) ? el.duration : 0;
      if (natural > 0) {
        const wantTime = (sourceStartSec + (tSec - startSec)) % natural;
        if (Math.abs(el.currentTime - wantTime) > 0.25) {
          el.currentTime = wantTime;
        }
      }
      void el.play().catch(() => { /* user gesture needed */ });
    } else {
      el.pause();
    }
  }, [playing, currentTime, backgroundMusic]);

  useEffect(() => () => {
    // On unmount, free the object URL.
    if (backgroundMusic?.src) {
      try { URL.revokeObjectURL(backgroundMusic.src); } catch { /* ignore */ }
    }
    if (bgMusicAudioRef.current) {
      bgMusicAudioRef.current.pause();
      bgMusicAudioRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useAudioFx({
    mouse: recording.mouse,
    fragments,
    options: audioFxOptions,
    playing,
    currentTime,
  });

  // Camera source for the editor preview. If the recording has baked-in
  // camera footage, play it back from the blob URL — that's what was
  // actually captured while the user was recording. Otherwise fall back
  // to a live stream so legacy recordings (or recordings made with the
  // camera disabled) still get a camera in the editor if the user wants
  // one composited at render time.
  const recordedCamera = recording.camera ?? null;
  useEffect(() => {
    const v = cameraVideoRef.current;
    if (!v) return undefined;

    if (recordedCamera) {
      v.srcObject = null;
      v.src = recordedCamera.url;
      v.muted = true;
      v.loop = false;
      v.preload = 'auto';
      v.load();
      // Mirror playback state from the main video so the camera frame
      // always matches the screen frame the canvas is currently drawing.
      const main = videoRef.current;
      if (main) {
        v.currentTime = main.currentTime || 0;
        if (!main.paused) v.play().catch(() => { /* will retry on next play */ });
      }
      setCameraAvailable(true);
      return () => {
        v.pause();
        v.removeAttribute('src');
        v.load();
      };
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraAvailable(false);
      return undefined;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        v.src = '';
        v.srcObject = s;
        v.play().catch(() => { /* ignore */ });
        setCameraAvailable(true);
      })
      .catch(() => {
        if (!cancelled) setCameraAvailable(false);
      });
    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      v.srcObject = null;
    };
  }, [recordedCamera]);

  // Keep the recorded camera video in lockstep with the main video. We
  // mirror play/pause/seek/rate; nothing else can drift the two playheads
  // because both videos started recording at the same wall-clock instant.
  useEffect(() => {
    if (!recordedCamera) return undefined;
    const main = videoRef.current;
    const cam = cameraVideoRef.current;
    if (!main || !cam) return undefined;

    const SYNC_THRESHOLD_S = 0.06;

    const syncTime = (): void => {
      const drift = Math.abs(cam.currentTime - main.currentTime);
      if (drift > SYNC_THRESHOLD_S) cam.currentTime = main.currentTime;
    };
    const onPlay = (): void => {
      syncTime();
      cam.playbackRate = main.playbackRate;
      cam.play().catch(() => { /* ignored — next play will retry */ });
    };
    const onPause = (): void => {
      cam.pause();
      syncTime();
    };
    const onSeeking = (): void => { cam.currentTime = main.currentTime; };
    const onSeeked = (): void => { cam.currentTime = main.currentTime; };
    const onRate = (): void => { cam.playbackRate = main.playbackRate; };
    const onTime = (): void => { syncTime(); };

    main.addEventListener('play', onPlay);
    main.addEventListener('pause', onPause);
    main.addEventListener('seeking', onSeeking);
    main.addEventListener('seeked', onSeeked);
    main.addEventListener('ratechange', onRate);
    main.addEventListener('timeupdate', onTime);

    // If the main video is already playing when this effect runs (e.g.,
    // after a hot reload), sync immediately.
    if (!main.paused) onPlay();
    else syncTime();

    return () => {
      main.removeEventListener('play', onPlay);
      main.removeEventListener('pause', onPause);
      main.removeEventListener('seeking', onSeeking);
      main.removeEventListener('seeked', onSeeked);
      main.removeEventListener('ratechange', onRate);
      main.removeEventListener('timeupdate', onTime);
    };
  }, [recordedCamera]);

  // Release the recorded camera blob URL when this recording is replaced.
  useEffect(() => {
    if (!recordedCamera) return undefined;
    return () => { URL.revokeObjectURL(recordedCamera.url); };
  }, [recordedCamera]);

  // Mobile (phone) playback. Mirrors the camera path verbatim: load the
  // recorded blob, sync to the main video, revoke the URL on unmount.
  // Unlike camera, there is NO live fallback — the phone stream only exists
  // during recording, so if the user didn't record with a phone connected,
  // the overlay simply doesn't render.
  const recordedMobile = recording.mobile ?? null;
  useEffect(() => {
    const v = mobileVideoRef.current;
    if (!v) return undefined;
    if (recordedMobile) {
      v.srcObject = null;
      v.src = recordedMobile.url;
      v.muted = true;
      v.loop = false;
      v.preload = 'auto';
      v.load();
      const main = videoRef.current;
      if (main) {
        v.currentTime = main.currentTime || 0;
        if (!main.paused) v.play().catch(() => { /* will retry on next play */ });
      }
      setMobileAvailable(true);
      return () => {
        v.pause();
        v.removeAttribute('src');
        v.load();
      };
    }
    setMobileAvailable(false);
    return undefined;
  }, [recordedMobile]);

  useEffect(() => {
    if (!recordedMobile) return undefined;
    const main = videoRef.current;
    const mob = mobileVideoRef.current;
    if (!main || !mob) return undefined;

    const SYNC_THRESHOLD_S = 0.06;

    const syncTime = (): void => {
      const drift = Math.abs(mob.currentTime - main.currentTime);
      if (drift > SYNC_THRESHOLD_S) mob.currentTime = main.currentTime;
    };
    const onPlay = (): void => {
      syncTime();
      mob.playbackRate = main.playbackRate;
      mob.play().catch(() => { /* retry on next play */ });
    };
    const onPause = (): void => {
      mob.pause();
      syncTime();
    };
    const onSeeking = (): void => { mob.currentTime = main.currentTime; };
    const onSeeked  = (): void => { mob.currentTime = main.currentTime; };
    const onRate    = (): void => { mob.playbackRate = main.playbackRate; };
    const onTime    = (): void => { syncTime(); };

    main.addEventListener('play', onPlay);
    main.addEventListener('pause', onPause);
    main.addEventListener('seeking', onSeeking);
    main.addEventListener('seeked', onSeeked);
    main.addEventListener('ratechange', onRate);
    main.addEventListener('timeupdate', onTime);

    if (!main.paused) onPlay();
    else syncTime();

    return () => {
      main.removeEventListener('play', onPlay);
      main.removeEventListener('pause', onPause);
      main.removeEventListener('seeking', onSeeking);
      main.removeEventListener('seeked', onSeeked);
      main.removeEventListener('ratechange', onRate);
      main.removeEventListener('timeupdate', onTime);
    };
  }, [recordedMobile]);

  useEffect(() => {
    if (!recordedMobile) return undefined;
    return () => { URL.revokeObjectURL(recordedMobile.url); };
  }, [recordedMobile]);

  return (
    <div className="editor pro">
      <div className="editor-top">
      <div className="editor-side">
        <SidebarPanel
          background={background}
          onBackgroundChange={setBackground}
          frame={frameOptions}
          onFrameChange={handleFrameOptionsChange}
          crop={crop}
          onCropChange={setCrop}
          cameraOptions={cameraOptions}
          onCameraOptionsChange={handleCameraOptionsChange}
          cameraAvailable={cameraAvailable}
          mobileOptions={mobileOptions}
          onMobileOptionsChange={handleMobileOptionsChange}
          mobileAvailable={mobileAvailable}
          cursorOptions={cursorOptions}
          onCursorOptionsChange={handleCursorOptionsChange}
          audioFxOptions={audioFxOptions}
          onAudioFxOptionsChange={handleAudioFxOptionsChange}
          backgroundMusic={backgroundMusic}
          onBackgroundMusicChange={handleBackgroundMusicChange}
          micVolume={micVolume}
          systemVolume={systemVolume}
          onMicVolumeChange={setMicVolume}
          onSystemVolumeChange={setSystemVolume}
          hasMicAudio={!!recordedMicAudio}
          hasSystemAudio={!!recordedSystemAudio}
          inputEvents={recording.mouse.events}
          blurRegions={blurRegions}
          blurMode={blurMode}
          onBlurModeChange={handleBlurModeChange}
          selectedBlurId={selectedBlurId}
          onSelectBlur={handleSelectBlur}
          onAddBlurAtPlayhead={handleAddBlurAtPlayhead}
          onRemoveBlur={handleRemoveBlur}
        />
      </div>
      <div className="editor-right">
      <div className="editor-main">

        {recording.hasAudio === false && (
          <div
            style={{
              margin: '0 0 8px',
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--danger, #e5484d)',
              color: 'var(--danger, #e5484d)',
              fontSize: 13,
              background: 'rgba(229,72,77,0.08)',
            }}
          >
            🔇 No audio was captured in this recording. Check the microphone
            permission for Klipe (Windows Settings → Privacy → Microphone), or
            enable “System audio” in the toolbar before recording.
          </div>
        )}

        <div className="preview-wrap">
          <div className="preview" style={previewSurroundStyle}>
            <video
              ref={videoRef}
              src={recording.url}
              style={{ display: 'none' }}
              playsInline
            />
            <VideoCanvas
              videoRef={videoRef}
              segments={segments}
              mouse={recording.mouse}
              display={recording.display}
              background={background}
              width={1280}
              height={720}
              crop={exportCrop}
              cropMode={cropMode}
              onCropChange={setCrop}
              cameraVideoRef={cameraVideoRef}
              cameraOptions={cameraOptions}
              mobileVideoRef={mobileVideoRef}
              mobileOptions={recordedMobile ? mobileOptions : null}
              mobilePrimary={!!recordedMobile}
              cursorOptions={cursorOptions}
              cameraStyle={zoomDefaults.cameraStyle}
              zoomBlur={zoomDefaults.zoomBlur}
              playing={playing}
              frameOptions={frameOptions}
              aspectRatio={aspectOption.value}
              blurRegions={blurRegions}
              blurMode={blurMode}
              selectedBlurId={selectedBlurId}
              currentSrcMs={currentSrcMs}
              onSelectBlur={handleSelectBlur}
              onDragBlurRect={handleDragBlurRect}
              onCommitBlurRect={handleCommitBlurRect}
              onCreateBlur={handleCreateBlur}
              overlays={overlays}
              overlayTimeMs={currentTime * 1000}
              selectedOverlayId={selectedOverlayId}
              onSelectOverlay={handleSelectOverlay}
              onMoveOverlay={handleMoveOverlay}
            />
            <video
              ref={cameraVideoRef}
              style={{ display: 'none' }}
              muted
              playsInline
              autoPlay
            />
            <video
              ref={mobileVideoRef}
              style={{ display: 'none' }}
              muted
              playsInline
              autoPlay
            />
            <audio ref={micAudioRef} style={{ display: 'none' }} preload="auto" />
            <audio ref={systemAudioRef} style={{ display: 'none' }} preload="auto" />
          </div>
        </div>

        {selected && (
          <div className="editor-side-right">
            <ZoomInspector
              segment={selected}
              zoomDefaults={zoomDefaults}
              onChange={(patch) => handleUpdateSegment(selected.id, patch)}
              onRemove={() => handleRemoveSegment(selected.id)}
              onApplyToAll={handleApplyToAll}
              onSetDefault={handleSetDefault}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}

        {!selected && selectedBlur && (
          <div className="editor-side-right">
            <BlurInspector
              region={selectedBlur}
              currentSrcMs={currentSrcMs}
              sourceDurationMs={sourceDurationMs}
              onChange={handleUpdateBlur}
              onRemove={() => handleRemoveBlur(selectedBlur.id)}
              onAddKeyframe={handleAddBlurKeyframe}
              onRemoveKeyframe={handleRemoveBlurKeyframe}
              onClose={() => setSelectedBlurId(null)}
            />
          </div>
        )}

        {!selected && !selectedBlur && overlays.length > 0 && (
          <div className="editor-side-right overlay-side">
            <OverlayLayerList
              overlays={overlays}
              selectedId={selectedOverlayId}
              onSelect={handleSelectOverlay}
              onToggleHide={handleToggleHideOverlay}
              onRename={handleRenameOverlay}
              onDuplicate={handleDuplicateOverlay}
              onRemove={handleRemoveOverlay}
              onReorder={handleReorderOverlays}
            />
            {selectedOverlay && (
              <OverlayInspector
                overlay={selectedOverlay}
                onChange={(patch) => handleUpdateOverlay(selectedOverlay.id, patch)}
                onRemove={() => handleRemoveOverlay(selectedOverlay.id)}
                onApplyAnimation={(kind) => handleApplyOverlayAnimation(selectedOverlay.id, kind)}
                onClose={() => setSelectedOverlayId(null)}
              />
            )}
          </div>
        )}
      </div>

        <div className="controls-pro">
          <div className="controls-left">
            <div className="aspect-select" ref={addLayerMenuRef}>
              <button
                type="button"
                className="add-layer-btn"
                onClick={() => setAddLayerMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={addLayerMenuOpen}
                title="Add a text or image overlay"
              >
                <PlusIcon /> Add Layer <ChevronDownSmallIcon />
              </button>
              {addLayerMenuOpen && (
                <div className="aspect-select-menu" role="menu">
                  <button
                    type="button"
                    className="aspect-select-item"
                    role="menuitem"
                    onClick={() => {
                      setAddLayerMenuOpen(false);
                      handleAddTextOverlay();
                    }}
                  >
                    <span className="aspect-select-label">Text</span>
                    <span className="aspect-select-value">T</span>
                  </button>
                  <button
                    type="button"
                    className="aspect-select-item"
                    role="menuitem"
                    onClick={() => {
                      setAddLayerMenuOpen(false);
                      void handleAddImageOverlay();
                    }}
                  >
                    <span className="aspect-select-label">Image</span>
                    <span className="aspect-select-value">📁</span>
                  </button>
                </div>
              )}
            </div>
            <button
              className="icon-btn"
              onClick={handleAddZoom}
              disabled={!duration}
              title="Add zoom segment at playhead"
            >
              <ZoomInIcon />
            </button>
            <button
              className="icon-btn"
              onClick={handleCut}
              disabled={!duration}
              title="Cut fragment at playhead"
            >
              <ScissorsIcon />
            </button>
            <button
              className="icon-btn danger-btn"
              onClick={handleDeleteFragment}
              disabled={!selectedFragmentId || fragments.length <= 1}
              title="Delete selected fragment"
            >
              <TrashIcon />
            </button>
            <span className="controls-divider" aria-hidden="true" />
            <div className="aspect-select" ref={aspectMenuRef}>
              <button
                type="button"
                className="aspect-select-trigger"
                onClick={() => setAspectMenuOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={aspectMenuOpen}
                aria-label="Aspect ratio"
              >
                <AspectShapeIcon ratio={aspectOption.value} />
                <span className="aspect-select-text">
                  <span className="aspect-select-label">{aspectOption.label}</span>
                  {aspectOption.ratio && (
                    <span className="aspect-select-value">{aspectOption.ratio}</span>
                  )}
                </span>
                <ChevronDownIcon />
              </button>
              {aspectMenuOpen && (
                <div className="aspect-select-menu" role="listbox">
                  {ASPECT_OPTIONS.map((opt) => {
                    const selected = opt.id === aspectRatioId;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        className={`aspect-select-item ${selected ? 'is-selected' : ''}`}
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          setAspectRatioId(opt.id);
                          setAspectMenuOpen(false);
                        }}
                      >
                        <AspectShapeIcon ratio={opt.value} />
                        <span className="aspect-select-label">{opt.label}</span>
                        {opt.ratio && (
                          <span className="aspect-select-value">{opt.ratio}</span>
                        )}
                        {selected && <CheckIcon />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <button
              className={`tool-btn ${cropMode ? 'active' : ''}`}
              onClick={() => setCropMode((v) => !v)}
              title="Crop the video"
            >
              <CropIcon /> Crop Video
            </button>
          </div>

          <div className="controls-center">
            <span className="time-pro">{fmt(currentTime)}</span>
            <button className="icon-btn" onClick={() => seek(0)} title="Skip to start">
              <SkipBackIcon />
            </button>
            <button
              onClick={togglePlay}
              className="play-btn"
              title={playing ? 'Pause' : 'Play'}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="icon-btn" onClick={() => seek(duration)} title="Skip to end">
              <SkipForwardIcon />
            </button>
            <span className="time-pro dim">{fmt(duration)}</span>
            <span className="controls-divider" aria-hidden="true" />
            <div className="volume-control" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                className="icon-btn"
                onClick={toggleMute}
                title={audioVolume === 0 ? 'Unmute' : 'Mute'}
                aria-label={audioVolume === 0 ? 'Unmute' : 'Mute'}
              >
                {audioVolume === 0 ? <VolumeMuteIcon /> : <VolumeHighIcon />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={audioVolume}
                onChange={(e) => handleVolumeChange(Number(e.target.value))}
                className="volume-slider"
                style={{ width: 90 }}
                aria-label="Recording volume"
                title="Recording volume"
              />
            </div>
          </div>

          <div className="controls-right">
            <button
              className="icon-btn"
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              <UndoIcon />
            </button>
            <button
              className="icon-btn"
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl+Y)"
              aria-label="Redo"
            >
              <RedoIcon />
            </button>
            <button
              className="icon-btn"
              onClick={() => setZoomLevel((z) => Math.max(25, z - 25))}
              title="Zoom out timeline"
            >
              <MinusIcon />
            </button>
            <span className="zoom-level">{zoomLevel}%</span>
            <button
              className="icon-btn"
              onClick={() => setZoomLevel((z) => Math.min(400, z + 25))}
              title="Zoom in timeline"
            >
              <PlusIcon />
            </button>
            <button className="icon-btn ghost-btn" onClick={onNew} title="New recording">
              <RefreshIcon />
            </button>
          </div>
        </div>
      </div>
      </div>

      <div className="editor-timeline">
        {duration > 0 ? (
          <Timeline
            duration={duration}
            currentTime={currentTime}
            onSeek={seek}
            clicks={clicks}
            segments={segments}
            selectedId={selectedId}
            onSelectSegment={handleSelectZoom}
            onUpdateSegment={handleUpdateSegment}
            fragments={fragments}
            sourceDuration={sourceDuration}
            selectedFragmentId={selectedFragmentId}
            onSelectFragment={handleSelectFragment}
            onUpdateFragments={handleUpdateFragments}
            onFragmentEdge={handleFragmentEdge}
            onBeginEdit={pushHistory}
            backgroundMusic={backgroundMusic}
            onUpdateBackgroundMusic={handleUpdateBackgroundMusic}
            overlays={overlays}
            selectedOverlayId={selectedOverlayId}
            onSelectOverlay={handleSelectOverlay}
            onUpdateOverlay={handleUpdateOverlay}
          />
        ) : (
          <div className="empty">Loading clip…</div>
        )}
      </div>

      {navExtraEl && createPortal(
        <>
          <button
            className="ghost"
            onClick={handleSaveProject}
            disabled={savingProject || !duration}
            title="Save project (.klipestudio)"
          >
            {savingProject ? 'Saving…' : 'Save'}
          </button>
          <ExportButton
            onClick={() => setExportOpen(true)}
            disabled={!duration}
          />
        </>,
        navExtraEl,
      )}

      {exportOpen && (
        <ExportModal
          sourceBlob={recordedMobile ? recordedMobile.blob : recording.blob}
          mouse={recording.mouse}
          segments={segments}
          display={recording.display}
          background={background}
          fragments={fragments}
          duration={duration}
          crop={exportCrop}
          cursorOptions={cursorOptions}
          cameraStyle={zoomDefaults.cameraStyle}
          zoomBlur={zoomDefaults.zoomBlur}
          frame={frameOptions}
          mobileOptions={recordedMobile ? mobileOptions : null}
          mobilePrimary={!!recordedMobile}
          audioFx={audioFxOptions}
          backgroundMusic={backgroundMusic}
          audioVolume={audioVolume}
          micBlob={recordedMicAudio?.blob ?? null}
          systemBlob={recordedSystemAudio?.blob ?? null}
          micVolume={micVolume}
          systemVolume={systemVolume}
          blurRegions={blurRegions}
          overlays={overlays}
          sourceLabel={recording.name || 'recording'}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

function VolumeHighIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H3v6h3l5 4V5z" />
      <path d="M16 9a3 3 0 0 1 0 6" />
      <path d="M19 6.5a7 7 0 0 1 0 11" />
    </svg>
  );
}

function VolumeMuteIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H3v6h3l5 4V5z" />
      <path d="M22 9l-5 5M17 9l5 5" />
    </svg>
  );
}

function PlayIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function PauseIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}
function SkipBackIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6h2v12H6zM9.5 12L20 4v16z" />
    </svg>
  );
}
function SkipForwardIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 6h2v12h-2zM4 4l10.5 8L4 20z" />
    </svg>
  );
}
function PlusIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function MinusIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M5 12h14" />
    </svg>
  );
}
function ZoomInIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.5-4.5M11 8v6M8 11h6" />
    </svg>
  );
}
function TrashIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
function ScissorsIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </svg>
  );
}
function CropIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </svg>
  );
}
function ChevronDownIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
function CheckIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="5 12 10 17 19 7" />
    </svg>
  );
}
function AspectShapeIcon({ ratio }: { ratio: number | null }): JSX.Element {
  // Bounding box 14x14; the rect is scaled to the requested ratio.
  const box = 14;
  const r = ratio && isFinite(ratio) && ratio > 0 ? ratio : 16 / 9;
  let w: number;
  let h: number;
  if (r >= 1) {
    w = box;
    h = box / r;
  } else {
    h = box;
    w = box * r;
  }
  const x = (box - w) / 2;
  const y = (box - h) / 2;
  return (
    <svg
      className="aspect-shape"
      width="14"
      height="14"
      viewBox={`0 0 ${box} ${box}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <rect x={x + 0.7} y={y + 0.7} width={Math.max(1, w - 1.4)} height={Math.max(1, h - 1.4)} rx="1.5" />
    </svg>
  );
}
function ChevronDownSmallIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
function UndoIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  );
}
function RedoIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 14 20 9 15 4" />
      <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
    </svg>
  );
}
function RefreshIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
