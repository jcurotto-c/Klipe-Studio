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
  cursorPositionAt,
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
import { isFullCrop, CROSS_ASPECT_EPSILON } from '../lib/layout';
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
import { DEFAULT_MOBILE_OPTIONS, migrateMobileOptions } from './panels/MobilePanel';
import { DEFAULT_CURSOR_OPTIONS } from '../lib/cursor-engine';
import { DEFAULT_FRAME_OPTIONS, WALLPAPER_PRESETS } from '../lib/renderer';
import { DEFAULT_AUDIO_FX } from '../lib/sound-fx';
import { useAudioFx } from '../lib/use-audio-fx';
import { getPlatform, type PlatformId } from '../lib/platforms';
import type {
  AudioFxOptions,
  Background,
  BackgroundMusic,
  BlurRegion,
  BlurSampleRect,
  CameraOptions,
  Crop,
  CursorOptions,
  FitMode,
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
import {
  captionsToOverlays,
  makeCaptionId,
  DEFAULT_CAPTION_STYLE,
  type Caption,
  type CaptionStyle,
} from '../overlays/captions';
import { generateCaptions, type CaptionProgress } from '../lib/transcription';
import { saveProject, saveProjectDoc, saveProjectToLibrary, type EditDocument } from '../lib/project';
import { capturePoster } from '../lib/poster';
import { releaseFilmstrip } from '../lib/filmstrip';
import type { Card, CardSet } from '../cards/types';
import { createMidCard } from '../cards/factories';
import {
  buildCardTimeline,
  resolvePhase,
  resolveTransition,
  activeSegment,
  globalToBodyMs,
  globalToBodySec,
  bodyToGlobalMs,
} from '../cards/timeline';

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
    return migrateMobileOptions(parsed);
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
  navExtraEl: HTMLElement | null;
  /** When opening a saved .klipestudio project, the edit document to hydrate from. */
  initialDoc?: EditDocument | null;
  /** Folder of the currently-open project, if any (enables quick-save + autosave). */
  projectPath?: string | null;
  /** Called after a successful explicit save with the project's folder + name. */
  onProjectSaved?: (path: string, name: string) => void;
  /** Claim the one-time library auto-save for this recording. Returns false if it
   *  was already started (e.g. by a previous mount), so it never double-writes. */
  beginLibraryAutoSave?: (recordingUrl: string) => boolean;
  /** Called when the decoupled library auto-save finishes (may be post-unmount). */
  onLibraryAutoSaved?: (recordingUrl: string, path: string, name: string) => void;
}

interface HistorySnapshot {
  fragments: Fragment[];
  segments: ZoomSegment[];
  blurRegions: BlurRegion[];
  overlays: Overlay[];
  cards: CardSet;
  captions: Caption[];
  captionStyle: CaptionStyle;
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

export default function EditorView({ recording, navExtraEl, initialDoc, projectPath, onProjectSaved, beginLibraryAutoSave, onLibraryAutoSaved }: EditorViewProps): JSX.Element {
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
  const [crop, setCrop] = useState<Crop | null>(() => initialDoc?.crop ?? recording.areaCrop ?? null);
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

  // Audio-capture warning. Shown ONLY when a source the user actually asked for
  // failed to record — an intentionally-silent take (both toggles off) raises no
  // alarm. micAudio/systemAudio are truthy whenever a track was captured (even if
  // silent), so a null for a REQUESTED source means a genuine acquisition failure
  // (mic permission denied, no/blocked input device, loopback never attached).
  // Recordings loaded from disk leave *Requested undefined, so they never warn.
  const micCaptureFailed = recording.micRequested === true && !recordedMicAudio;
  const systemCaptureFailed = recording.systemAudioRequested === true && !recordedSystemAudio;
  const audioWarning: string | null =
    micCaptureFailed && systemCaptureFailed
      ? 'No audio was captured. Klipe could not access your microphone or the system audio — check Klipe’s microphone permission (Windows Settings → Privacy → Microphone).'
      : micCaptureFailed
        ? 'No microphone audio was captured. Check Klipe’s microphone permission (Windows Settings → Privacy → Microphone) and that the right input device is selected in the toolbar.'
        : systemCaptureFailed
          ? 'System audio could not be captured. Make sure an audio output device is active and record again with “System audio” enabled.'
          : null;

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
  // How a chosen format that doesn't match the recording's shape is fitted:
  // 'fit' shows the whole frame on the chosen background, 'fill' cover-crops.
  const [fitMode, setFitMode] = useState<FitMode>(() => initialDoc?.fitMode ?? 'fit');
  // Target social platform. Choosing one in the export modal applies its
  // aspect ratio here, which drives the live preview + the safe-zone guides.
  const [platformId, setPlatformId] = useState<string>(() => initialDoc?.platformId ?? 'none');
  const [showGuides, setShowGuides] = useState(true);
  const [aspectMenuOpen, setAspectMenuOpen] = useState(false);
  const aspectMenuRef = useRef<HTMLDivElement | null>(null);
  const [addLayerMenuOpen, setAddLayerMenuOpen] = useState(false);
  const addLayerMenuRef = useRef<HTMLDivElement | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const [mobileOptions, setMobileOptions] = useState<MobileOptions>(() => (initialDoc?.mobileOptions ? migrateMobileOptions(initialDoc.mobileOptions) : loadMobileOptions()));
  const [mobileAvailable, setMobileAvailable] = useState(false);
  const mobileVideoRef = useRef<HTMLVideoElement | null>(null);
  const [blurRegions, setBlurRegions] = useState<BlurRegion[]>(() => initialDoc?.blurRegions ?? []);
  const [selectedBlurId, setSelectedBlurId] = useState<string | null>(null);
  const [blurMode, setBlurMode] = useState<boolean>(false);
  const [overlays, setOverlays] = useState<Overlay[]>(() => initialDoc?.overlays ?? []);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [cards, setCards] = useState<CardSet>(() => initialDoc?.cards ?? { intro: null, outro: null });
  const [selectedCardItemId, setSelectedCardItemId] = useState<string | null>(null);
  const [captions, setCaptions] = useState<Caption[]>(() => initialDoc?.captions ?? []);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(
    () => initialDoc?.captionStyle ?? { ...DEFAULT_CAPTION_STYLE },
  );
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [savingProject, setSavingProject] = useState(false);

  const exportCrop: Crop | null = isFullCrop(crop) ? null : crop;

  const aspectOption = useMemo<AspectOption>(
    () => ASPECT_OPTIONS.find((o) => o.id === aspectRatioId) ?? ASPECT_OPTIONS[0]!,
    [aspectRatioId],
  );

  // The Fit/Fill control only matters when the chosen format's shape differs
  // from the recording — otherwise nothing is letterboxed or cropped, so the
  // toggle stays hidden to avoid toolbar clutter.
  const aspectWouldCrop = useMemo(() => {
    if (aspectOption.value == null) return false;
    const srcW = recording.display?.width || 16;
    const srcH = recording.display?.height || 9;
    return Math.abs(aspectOption.value - srcW / srcH) > CROSS_ASPECT_EPSILON;
  }, [aspectOption, recording.display?.width, recording.display?.height]);

  const activePlatform = useMemo(() => getPlatform(platformId), [platformId]);

  // Apply a platform preset: remember it and switch the canvas to its aspect.
  const applyPlatform = useCallback((id: PlatformId) => {
    setPlatformId(id);
    setAspectRatioId(getPlatform(id).aspectId);
  }, []);

  const previewSurroundStyle = useMemo<CSSProperties>(() => {
    if (background.type === 'color') {
      return { background: background.value || '#0b0d12' };
    }
    if (background.type === 'gradient') {
      const angle = background.angle == null ? 135 : background.angle;
      return { background: `linear-gradient(${angle}deg, ${background.from}, ${background.to})` };
    }
    if (background.type === 'image' || background.type === 'video') {
      // The canvas renders the image/video cover-fit to its own size; matching
      // that exactly in CSS on the larger .preview rect would require runtime
      // layout math, so we fall back to the dark surround here to avoid a seam.
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

  // Body = the recording itself (output-time). The GLOBAL timeline splices in
  // an intro, an outro, and any number of mid-roll cards, so `duration` (what
  // the timeline, transport and export consume) spans every segment. Body
  // content is mapped to/from the global clock via globalToBody/bodyToGlobal,
  // which account for EVERY card before a point (not a single intro offset).
  const bodyDuration = useMemo(() => totalOutputDuration(fragments), [fragments]);
  const cardTimeline = useMemo(() => buildCardTimeline(cards, bodyDuration), [cards, bodyDuration]);
  const duration = cardTimeline.totalMs / 1000;
  const phase = useMemo(
    () => resolvePhase(cardTimeline, currentTime * 1000),
    [cardTimeline, currentTime],
  );
  const cardActive = phase.kind !== 'body';
  // Crossfades live INSIDE the body phase (a card dissolving in/out over the
  // adjacent body), so `cardActive` (full card) and `cardTransition` (crossfade)
  // are mutually exclusive.
  const transition = useMemo(
    () => resolveTransition(cardTimeline, currentTime * 1000),
    [cardTimeline, currentTime],
  );
  const cardTransition = !cardActive && transition !== null;
  const cardTransitionAlpha = transition?.alpha ?? 0;
  // The card whose background/items the canvas should show right now: the
  // active full card, else the card being crossfaded.
  const visualCard = cardActive ? phase.card : (transition?.card ?? null);
  const cardBackground = visualCard?.background ?? null;
  const cardItems = visualCard?.items ?? undefined;
  // Card-local time: full card → phase-local; a fade samples the card at the
  // frame the transition froze (enter → first frame, exit → last frame).
  const cardLocalMs = cardActive ? phase.localMs : (transition?.localMs ?? 0);
  const hasCards = !!(cards.intro || cards.outro || (cards.mid && cards.mid.length > 0));
  // Body output-seconds for the current global playhead. Drives body overlay
  // sampling, audio FX, and source mapping; during a card it freezes at the
  // card's body anchor.
  const bodySec = globalToBodySec(cardTimeline, currentTime);

  // Drop the card-item selection once it's no longer valid (left the card, or
  // scrubbed to a different card) so the preview doesn't show a stale "move"
  // cursor / phantom selection.
  useEffect(() => {
    if (selectedCardItemId == null) return;
    const stillValid = cardActive && !!visualCard?.items.some((i) => i.id === selectedCardItemId);
    if (!stillValid) setSelectedCardItemId(null);
  }, [cardActive, visualCard, selectedCardItemId]);

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
  const cardsRef = useRef<CardSet>(cards);
  cardsRef.current = cards;
  const captionsRef = useRef<Caption[]>(captions);
  captionsRef.current = captions;
  const captionStyleRef = useRef<CaptionStyle>(captionStyle);
  captionStyleRef.current = captionStyle;
  const cardTimelineRef = useRef(cardTimeline);
  cardTimelineRef.current = cardTimeline;
  /** Wall-clock of the previous RAF tick — advances the global clock during
   * card phases, when the <video> is paused and can't drive time. */
  const lastTickRef = useRef(0);

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
    cards: cardsRef.current,
    captions: captionsRef.current,
    captionStyle: captionStyleRef.current,
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
    fitMode,
    platformId,
    mobileOptions,
    blurRegions,
    overlays,
    cards,
    captions,
    captionStyle,
  }), [
    fragments, segments, background, crop, zoomDefaults, cameraOptions,
    cursorOptions, frameOptions, audioFxOptions, backgroundMusic, audioVolume,
    micVolume, systemVolume, aspectRatioId, fitMode, platformId, mobileOptions, blurRegions, overlays, cards,
    captions, captionStyle,
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

  // First-time auto-save into the managed library (<Videos>/KlipeStudio). A
  // fresh recording arrives with no projectPath; we persist it (media + a poster
  // thumbnail + duration) exactly once so it appears in the "My videos" gallery
  // and is NEVER lost — even if the user never explicitly saves. Recordings
  // opened from disk already have a projectPath, so they skip this.
  //
  // Deliberately decoupled from this component's lifecycle: the write must NOT be
  // cancelled if the user navigates away mid-capture (that was a data-loss bug),
  // so there is no `unmounted` guard around the disk write — the async chain runs
  // to completion regardless. De-duplication lives in App (beginLibraryAutoSave),
  // so a navigate-out-and-back remount can't kick off a second full-media write.
  // App.onLibraryAutoSaved decides whether to adopt the path (it may land after
  // unmount or after an explicit save). The poster is best-effort: a null/duration-
  // less result still saves the media; project:save-doc preserves durationMs on
  // later re-saves so the gallery badge survives.
  useEffect(() => {
    if (projectPath) return;
    if (beginLibraryAutoSave && !beginLibraryAutoSave(recording.url)) return;
    const doc = buildEditDocument();
    const url = recording.url;
    // The gallery card should show what the recording actually looks like. For a
    // phone-primary recording that is the phone footage, not the parallel PC
    // screen capture — so grab the poster frame from the phone URL when present.
    const posterUrl = recording.mobile?.url ?? recording.url;
    const name = recording.name || 'Untitled';
    void (async () => {
      let thumbnail: Uint8Array | null = null;
      let durationMs: number | null = null;
      try {
        const poster = await capturePoster(posterUrl);
        thumbnail = poster.bytes;
        durationMs = poster.durationMs > 0 ? poster.durationMs : null;
      } catch { /* poster is best-effort — save the recording regardless */ }
      try {
        const res = await saveProjectToLibrary(recording, doc, { thumbnail, durationMs });
        if (res.ok && res.projectPath) {
          onLibraryAutoSaved?.(url, res.projectPath, name);
        } else if (res.error) {
          console.error('[library] auto-save failed:', res.error);
        }
      } catch (e) {
        console.error('[library] auto-save failed:', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    cardsRef.current = snap.cards;
    captionsRef.current = snap.captions;
    captionStyleRef.current = snap.captionStyle;
    setFragments(snap.fragments);
    setSegments(snap.segments);
    setBlurRegions(snap.blurRegions);
    setOverlays(snap.overlays);
    setCards(snap.cards);
    setCaptions(snap.captions);
    setCaptionStyle(snap.captionStyle);
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

  // Drive playback on the GLOBAL clock built from segments (intro · body chunks
  // · mid-roll cards · outro). In a body chunk the <video> plays freely and we
  // map its source-time → body-output → global; when the chunk ends (a mid-card
  // anchor or the body end) we pause and hand off to the next segment. In a card
  // segment the <video> is paused and the global clock is advanced by wall-time
  // so the card animates with no leaked frames/audio; when it ends we resume the
  // next body chunk (or stop).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      const frags = fragmentsRef.current;
      if (!frags.length) return;
      if (!playingRef.current) { lastTickRef.current = now; return; }

      const tl = cardTimelineRef.current;
      const globalMs = currentTimeRef.current * 1000;
      const ph = resolvePhase(tl, globalMs);
      const seg = activeSegment(tl, globalMs);

      if (ph.kind === 'body' && seg.kind === 'body') {
        if (v.paused) void v.play().catch(() => { /* retry next tick */ });
        const bodyOutSec = globalToBodySec(tl, currentTimeRef.current);
        const m = outputToSource(frags, bodyOutSec);
        if (!m) { lastTickRef.current = now; return; }
        const src = v.currentTime;
        const offset = Math.max(0, src - m.fragment.srcStart);
        const curBodySec = m.fragOutputStart + offset;
        const fragEndBodyMs = (m.fragOutputStart + fragmentDuration(m.fragment)) * 1000;
        const atFragEnd = src >= m.fragment.srcEnd - 0.01;
        lastTickRef.current = now;

        // End of THIS body chunk (a mid-card anchor or the body end): pause and
        // hand off to the next segment. Checked BEFORE the fragment advance so a
        // fragment edge that coincides with the chunk boundary rolls into the
        // card instead of skipping ahead.
        const lastFrag = m.index + 1 >= frags.length;
        if (curBodySec * 1000 >= seg.bodyEndMs - 5
          || (atFragEnd && (lastFrag || fragEndBodyMs >= seg.bodyEndMs - 1))) {
          v.pause();
          currentTimeRef.current = seg.gEndMs / 1000;
          setCurrentTime(seg.gEndMs / 1000);
          if (seg.gEndMs >= tl.totalMs) setPlaying(false);
          return;
        }
        // Fragment boundary strictly inside the chunk: jump to the next fragment.
        // Map within the ACTIVE segment so the new time can't fall back onto a
        // preceding card boundary.
        if (atFragEnd) {
          const nf = frags[m.index + 1]!;
          v.currentTime = nf.srcStart;
          const g = (seg.gStartMs + (fragEndBodyMs - seg.bodyStartMs)) / 1000;
          currentTimeRef.current = g;
          setCurrentTime(g);
          return;
        }
        if (src < m.fragment.srcStart - 0.05) {
          v.currentTime = m.fragment.srcStart;
          return;
        }
        const g = (seg.gStartMs + (curBodySec * 1000 - seg.bodyStartMs)) / 1000;
        setCurrentTime(g);
        return;
      }

      // Card segment: keep the <video> paused, advance the global clock by dt.
      if (!v.paused) v.pause();
      const dt = Math.max(0, now - lastTickRef.current);
      lastTickRef.current = now;
      const nextMs = globalMs + dt;
      const segEnd = seg.gEndMs;

      if (nextMs >= segEnd) {
        if (segEnd >= tl.totalMs) {
          currentTimeRef.current = tl.totalMs / 1000;
          setCurrentTime(tl.totalMs / 1000);
          setPlaying(false);
          return;
        }
        // Hand off to whatever follows the card.
        const nextPh = resolvePhase(tl, segEnd + 0.5);
        if (nextPh.kind === 'body') {
          const m2 = outputToSource(frags, Math.max(0, globalToBodySec(tl, segEnd / 1000 + 0.0005)));
          if (m2) v.currentTime = m2.srcTime;
          void v.play().catch(() => { /* retry next tick */ });
        }
        currentTimeRef.current = segEnd / 1000;
        setCurrentTime(segEnd / 1000);
        return;
      }
      currentTimeRef.current = nextMs / 1000;
      setCurrentTime(nextMs / 1000);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Seek on the GLOBAL clock. In the body we map global → body → source-time
  // onto the <video>; in a card phase we just pause the <video> (it must not
  // play under a card) and park the global clock at the requested time.
  const seek = useCallback((outputT: number): void => {
    const v = videoRef.current;
    if (!v) return;
    const tl = cardTimelineRef.current;
    const t = Math.max(0, Math.min(tl.totalMs / 1000, outputT));
    const ph = resolvePhase(tl, t * 1000);
    if (ph.kind === 'body') {
      const m = outputToSource(fragmentsRef.current, globalToBodySec(tl, t));
      if (m) v.currentTime = m.srcTime;
    } else if (!v.paused) {
      v.pause();
    }
    lastTickRef.current = performance.now();
    currentTimeRef.current = t;
    setCurrentTime(t);
  }, []);

  const togglePlay = (): void => {
    const v = videoRef.current;
    if (!v) return;
    if (!playingRef.current) {
      const tl = cardTimelineRef.current;
      if (currentTimeRef.current >= tl.totalMs / 1000 - 0.02) {
        seek(0);
      }
      lastTickRef.current = performance.now();
      const ph = resolvePhase(tl, currentTimeRef.current * 1000);
      if (ph.kind === 'body') {
        const m = outputToSource(fragmentsRef.current, globalToBodySec(tl, currentTimeRef.current));
        if (m) v.currentTime = m.srcTime;
        void v.play().catch(() => { /* retry next tick */ });
      } else if (!v.paused) {
        // Resuming inside a card: the global clock (RAF) drives it; keep paused.
        v.pause();
      }
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

  // Add a manual zoom at the playhead in one click, focused on wherever the
  // cursor was at that frame (so it lands on the action, not the screen middle);
  // falls back to the screen centre when there's no mouse data. Opens it
  // selected so the level/duration can be tweaked.
  const handleAddZoom = useCallback(() => {
    const m = outputToSource(fragmentsRef.current, globalToBodySec(cardTimelineRef.current, currentTimeRef.current));
    const tMs = (m ? m.srcTime : 0) * 1000;
    const seg = createManualSegment({
      tMs,
      durationMs: zoomDefaults.duration,
      easeIn: zoomDefaults.easeIn,
      easeOut: zoomDefaults.easeOut,
      scale: zoomDefaults.scale,
      easing: zoomDefaults.easing,
      center: cursorPositionAt(recording.mouse, tMs) ?? undefined,
      display: recording.display,
    });
    pushHistory();
    setSegments((prev) => addSegment(prev, seg));
    setSelectedId(seg.id);
  }, [zoomDefaults, recording.mouse, recording.display, pushHistory]);

  const handleCut = useCallback(() => {
    const m = outputToSource(fragmentsRef.current, globalToBodySec(cardTimelineRef.current, currentTimeRef.current));
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
    const newBodyTotal = next.reduce((acc, f) => acc + fragmentDuration(f), 0);

    // The deleted fragment's body-output span: everything authored after it
    // shifts earlier by its length. Re-anchor mid cards so each keeps pointing
    // at the same recorded moment (cards inside the deleted span snap to the
    // join point) instead of silently drifting / colliding via the clamp.
    let delStart = 0;
    for (let i = 0; i < idx; i++) delStart += fragmentDuration(prev[i]!);
    const delLen = fragmentDuration(prev[idx]!);
    const delStartMs = delStart * 1000;
    const delLenMs = delLen * 1000;
    const remapMid = (at: number): number => {
      if (at <= delStartMs) return at;
      if (at >= delStartMs + delLenMs) return at - delLenMs;
      return delStartMs; // inside the deleted span → the join point
    };
    const curCards = cardsRef.current;
    const newMid = (curCards.mid ?? []).map((c) => ({
      ...c,
      atBodyMs: Math.max(0, Math.min(newBodyTotal * 1000, remapMid(c.atBodyMs ?? 0))),
    }));
    const newCards: CardSet = { ...curCards, mid: newMid };

    const bodyOut = Math.min(globalToBodySec(cardTimelineRef.current, currentTimeRef.current), newBodyTotal);
    const m = outputToSource(next, bodyOut);
    const v = videoRef.current;
    if (v && m) v.currentTime = m.srcTime;
    // Re-anchor the playhead in body-time against the post-delete timeline.
    const newTl = buildCardTimeline(newCards, newBodyTotal);
    const g = bodyToGlobalMs(newTl, bodyOut * 1000) / 1000;
    currentTimeRef.current = g;
    setCurrentTime(g);
    setCards(newCards);
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
    const m = outputToSource(fragments, bodySec);
    return (m ? m.srcTime : 0) * 1000;
  }, [fragments, bodySec]);

  const sourceDurationMs = useMemo<number>(
    () => Math.max(0, sourceDuration * 1000),
    [sourceDuration],
  );

  const selectedBlur = useMemo<BlurRegion | null>(
    () => blurRegions.find((r) => r.id === selectedBlurId) ?? null,
    [blurRegions, selectedBlurId],
  );

  // Captions become ephemeral text overlays at render time, merged ABOVE the
  // user's overlays. Both the preview canvas and the export consume this set so
  // they stay identical. Captions share the body-output-time clock.
  const previewOverlays = useMemo<Overlay[]>(
    () => [...overlays, ...captionsToOverlays(captions, captionStyle)],
    [overlays, captions, captionStyle],
  );

  const hasCaptionAudio = useMemo<boolean>(
    () => !!(recording.micAudio?.blob || recording.systemAudio?.blob
      || (recording.hasAudio !== false && recording.blob)),
    [recording],
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
    // Body overlays live in body-output-time, so map the global playhead down.
    const totalMs = Math.max(0, Math.round(bodyDuration * 1000));
    let fromMs = Math.max(0, Math.round(globalToBodyMs(cardTimelineRef.current, currentTimeRef.current * 1000)));
    let toMs = Math.min(fromMs + DEFAULT_MS, totalMs);
    if (toMs - fromMs < MIN_MS) {
      fromMs = Math.max(0, toMs - MIN_MS);
    }
    return { visibleFrom: fromMs, visibleTo: toMs };
  }, [bodyDuration]);

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
    // Captions are merged into the preview overlay set for rendering, but they
    // are NOT user overlays — clicking one on the canvas should be a no-op
    // rather than clearing the current selection.
    if (id && !overlaysRef.current.some((o) => o.id === id)) return;
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

  // ---------------------------------------------------------------------------
  // Captions (subtitles)
  // ---------------------------------------------------------------------------

  const handleAddCaption = useCallback(() => {
    pushHistory();
    // A ~2s caption starting at the playhead's body-output-time (the caption
    // clock), clamped to the body's end.
    const totalMs = Math.max(0, Math.round(bodyDuration * 1000));
    const fromMs = Math.max(0, Math.min(
      totalMs - 500,
      Math.round(globalToBodyMs(cardTimelineRef.current, currentTimeRef.current * 1000)),
    ));
    const toMs = Math.min(fromMs + 2000, totalMs);
    const cap: Caption = { id: makeCaptionId(), text: 'New caption', startMs: fromMs, endMs: Math.max(fromMs + 500, toMs) };
    setCaptions((prev) => [...prev, cap].sort((a, b) => a.startMs - b.startMs));
    setSelectedCaptionId(cap.id);
  }, [pushHistory, bodyDuration]);

  const handleUpdateCaption = useCallback((id: string, patch: Partial<Caption>) => {
    setCaptions((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, ...patch } : c));
      // Keep the list time-ordered when start times move (timeline drag / edit).
      return 'startMs' in patch ? next.sort((a, b) => a.startMs - b.startMs) : next;
    });
  }, []);

  const handleRemoveCaption = useCallback((id: string) => {
    pushHistory();
    setCaptions((prev) => prev.filter((c) => c.id !== id));
    setSelectedCaptionId((cur) => (cur === id ? null : cur));
  }, [pushHistory]);

  const handleChangeCaptionStyle = useCallback((patch: Partial<CaptionStyle>) => {
    setCaptionStyle((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSelectCaption = useCallback((id: string | null) => {
    setSelectedCaptionId(id);
    if (id) {
      const cap = captionsRef.current.find((c) => c.id === id);
      if (cap) seek(bodyToGlobalMs(cardTimelineRef.current, cap.startMs) / 1000 + 0.001);
      setSelectedId(null);
      setSelectedBlurId(null);
      setSelectedFragmentId(null);
      setSelectedOverlayId(null);
    }
  }, [seek]);

  const handleGenerateCaptions = useCallback(async (
    opts: { language?: string; mode: 'replace' | 'append'; onProgress?: (p: CaptionProgress) => void },
  ): Promise<{ ok: boolean; count?: number; error?: string }> => {
    if (transcribing) return { ok: false, error: 'Already transcribing.' };
    setTranscribing(true);
    try {
      const generated = await generateCaptions(recording, fragmentsRef.current, {
        language: opts.language,
        onProgress: opts.onProgress,
      });
      pushHistory();
      setCaptions((prev) => {
        const merged = opts.mode === 'append' ? [...prev, ...generated] : generated;
        return merged.sort((a, b) => a.startMs - b.startMs);
      });
      return { ok: true, count: generated.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      setTranscribing(false);
    }
  }, [transcribing, recording, pushHistory]);

  // ---------------------------------------------------------------------------
  // Intro / outro cards
  // ---------------------------------------------------------------------------

  const handleCardsChange = useCallback((next: CardSet) => {
    pushHistory();
    setCards(next);
  }, [pushHistory]);

  /** Seek into a card (timeline cap click) by its global start time. */
  const handleSelectCard = useCallback((globalSec: number) => {
    seek(Math.max(0, globalSec + 0.001));
  }, [seek]);

  /** Insert a mid-roll interstitial at the current playhead's body-time. */
  const handleAddMidCardAtPlayhead = useCallback(() => {
    const tl = cardTimelineRef.current;
    const bodyMs = Math.round(globalToBodyMs(tl, currentTimeRef.current * 1000));
    // Keep it a true mid-roll (not coincident with the very start/end).
    const at = Math.max(1, Math.min(Math.round(tl.bodyMs) - 1, bodyMs));
    if (!isFinite(at) || at <= 0) return;
    pushHistory();
    setCards((prev) => ({ ...prev, mid: [...(prev.mid ?? []), createMidCard(at)] }));
  }, [pushHistory]);

  /** Drag a mid-roll card to a new body-time (history pushed on drag start). */
  const handleMoveMidCard = useCallback((cardId: string, atBodyMs: number) => {
    setCards((prev) => ({
      ...prev,
      mid: (prev.mid ?? []).map((c) =>
        c.id === cardId ? { ...c, atBodyMs: Math.max(0, Math.round(atBodyMs)) } : c,
      ),
    }));
  }, []);

  const handleSelectCardItem = useCallback((id: string | null) => {
    setSelectedCardItemId(id);
  }, []);

  /**
   * Grab a still from the recording as a data URL, for use as a card background
   * ("freeze-frame" intro/outro). `position`: 'start' = first frame, 'end' =
   * last frame, or a body-output-ms for a mid-roll card. Uses an offscreen
   * <video> so the live preview isn't disturbed.
   */
  const handleCaptureRecordingFrame = useCallback(async (position: 'start' | 'end' | number): Promise<string | null> => {
    const frags = fragmentsRef.current;
    if (!frags.length) return null;
    let srcTime: number;
    if (position === 'start') srcTime = frags[0]!.srcStart;
    else if (position === 'end') srcTime = Math.max(0, frags[frags.length - 1]!.srcEnd - 0.05);
    else {
      const m = outputToSource(frags, Math.max(0, position / 1000));
      srcTime = m ? m.srcTime : frags[0]!.srcStart;
    }
    try {
      const v = document.createElement('video');
      // A card freeze-frame must come from the footage the user actually sees.
      // In phone-primary mode that's the phone clip (synced 1:1 to the master
      // clock, so the screen-time srcTime maps directly); fall back to the
      // screen capture otherwise.
      v.src = recording.mobile?.url ?? recording.url;
      v.muted = true;
      v.preload = 'auto';
      // Resolve on the event OR a timeout so a stalled decode can't hang the UI.
      await new Promise<void>((res) => {
        v.onloadeddata = () => res();
        v.onerror = () => res();
        setTimeout(res, 5000);
      });
      if (v.readyState < 2) return null;
      const target = Math.max(0, Math.min((v.duration || srcTime) - 0.01, srcTime));
      // Only seek if we're not already there (seeking to the current position is
      // a no-op that never fires 'seeked' — e.g. the first frame at t=0).
      let timedOut = false;
      if (Math.abs(v.currentTime - target) > 1e-3) {
        await new Promise<void>((res) => {
          v.onseeked = () => res();
          setTimeout(() => { timedOut = true; res(); }, 4000);
          v.currentTime = target;
        });
      }
      // Don't bake a stale/black frame if the seek hasn't actually landed.
      if (timedOut || v.seeking || v.readyState < 2) return null;
      // Cap the longest edge so the inline data URL stays small (it's persisted
      // in the project + re-serialised on every autosave).
      const vw = v.videoWidth || 1920;
      const vh = v.videoHeight || 1080;
      const scale = Math.min(1, 1280 / Math.max(vw, vh));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(vw * scale));
      c.height = Math.max(1, Math.round(vh * scale));
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', 0.85);
      v.removeAttribute('src');
      v.load();
      return url;
    } catch {
      return null;
    }
  }, [recording.url, recording.mobile]);

  /** Drag a card's text/logo item to a new fractional position (any card it
   * belongs to — ids are unique across intro/outro/mid). */
  const handleMoveCardItem = useCallback((itemId: string, base: { x: number; y: number }) => {
    const moveIn = (c: Card | null): Card | null => {
      if (!c) return c;
      return {
        ...c,
        items: c.items.map((o) => {
          if (o.id !== itemId) return o;
          // Shift any position-animation track by the drag delta too, so an
          // item whose motion overrides `base` (e.g. the "rise" entrance) still
          // follows the cursor instead of snapping back to its baked spot.
          const dx = base.x - o.base.x;
          const dy = base.y - o.base.y;
          const pos = o.transform.position;
          const shifted = pos
            ? { ...pos, keys: pos.keys.map((k) => ({ ...k, value: { x: k.value.x + dx, y: k.value.y + dy } })) }
            : pos;
          return { ...o, base: { ...o.base, x: base.x, y: base.y }, transform: { ...o.transform, position: shifted } };
        }),
      };
    };
    setCards((prev) => ({
      intro: moveIn(prev.intro),
      outro: moveIn(prev.outro),
      mid: (prev.mid ?? []).map((c) => moveIn(c)!),
    }));
  }, []);

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
          seek(cardTimelineRef.current.totalMs / 1000);
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
          const clipMs = bodyDuration * 1000;
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
  }, [backgroundMusic, bodyDuration]);

  useEffect(() => {
    const el = bgMusicAudioRef.current;
    if (!el || !backgroundMusic) return;
    const tl = cardTimelineRef.current;
    const sourceStartSec = (backgroundMusic.sourceStartMs || 0) / 1000;
    const natural = el.duration && isFinite(el.duration) ? el.duration : 0;

    // "Play through cards" (default): a soundtrack on the GLOBAL clock — the
    // body-time window maps up to global and extends to the very ends to cover
    // the intro/outro; it does NOT pause during cards. Otherwise it's body-only
    // and goes silent during cards.
    let inWindow: boolean;
    let elapsedSec: number;
    let windowSec: number;
    if (backgroundMusic.overCards ?? true) {
      const startSec = (backgroundMusic.startMs <= 1 ? 0 : bodyToGlobalMs(tl, backgroundMusic.startMs)) / 1000;
      const endSec = (backgroundMusic.endMs >= tl.bodyMs - 1 ? tl.totalMs : bodyToGlobalMs(tl, backgroundMusic.endMs)) / 1000;
      inWindow = currentTime >= startSec && currentTime < endSec;
      elapsedSec = currentTime - startSec;
      windowSec = endSec - startSec;
    } else {
      const onCard = resolvePhase(tl, currentTime * 1000).kind !== 'body';
      const tSec = globalToBodySec(tl, currentTime);
      inWindow = !onCard && tSec >= backgroundMusic.startMs / 1000 && tSec < backgroundMusic.endMs / 1000;
      elapsedSec = tSec - backgroundMusic.startMs / 1000;
      windowSec = (backgroundMusic.endMs - backgroundMusic.startMs) / 1000;
    }

    if (playing && inWindow) {
      // Mirror the export's fade-in/out gain envelope so the preview matches.
      const targetVol = Math.max(0, Math.min(1, backgroundMusic.volume));
      const fadeDur = Math.min(Math.max(0, (backgroundMusic.fadeMs || 0) / 1000), windowSec / 2);
      let gain = targetVol;
      if (fadeDur > 0) {
        const untilEnd = windowSec - elapsedSec;
        if (elapsedSec < fadeDur) gain = targetVol * Math.max(0, elapsedSec / fadeDur);
        else if (untilEnd < fadeDur) gain = targetVol * Math.max(0, untilEnd / fadeDur);
      }
      el.volume = Math.max(0, Math.min(1, gain));
      if (natural > 0) {
        const wantTime = (sourceStartSec + Math.max(0, elapsedSec)) % natural;
        if (Math.abs(el.currentTime - wantTime) > 0.25) el.currentTime = wantTime;
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
    playing: playing && !cardActive,
    currentTime: bodySec,
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
    return () => {
      // The phone URL now also backs the timeline filmstrip, so free its cached
      // thumbnails (ImageBitmaps the GC can't reclaim) before revoking the URL.
      releaseFilmstrip(recordedMobile.url);
      URL.revokeObjectURL(recordedMobile.url);
    };
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
          mobileStageAspect={aspectOption.value}
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
          cards={cards}
          onCardsChange={handleCardsChange}
          onAddMidCardAtPlayhead={handleAddMidCardAtPlayhead}
          onCaptureRecordingFrame={handleCaptureRecordingFrame}
          captions={captions}
          captionStyle={captionStyle}
          selectedCaptionId={selectedCaptionId}
          onAddCaption={handleAddCaption}
          onUpdateCaption={handleUpdateCaption}
          onRemoveCaption={handleRemoveCaption}
          onChangeCaptionStyle={handleChangeCaptionStyle}
          onSelectCaption={handleSelectCaption}
          onGenerateCaptions={handleGenerateCaptions}
          captionsHasAudio={hasCaptionAudio}
          captionsTranscribing={transcribing}
        />
      </div>
      <div className="editor-right">
      <div className="editor-main">

        {audioWarning && (
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
            🔇 {audioWarning}
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
              suspended={exportOpen}
              frameOptions={frameOptions}
              aspectRatio={aspectOption.value}
              fitMode={fitMode}
              safeZones={showGuides ? activePlatform.safe ?? null : null}
              blurRegions={blurRegions}
              blurMode={blurMode}
              selectedBlurId={selectedBlurId}
              currentSrcMs={currentSrcMs}
              onSelectBlur={handleSelectBlur}
              onDragBlurRect={handleDragBlurRect}
              onCommitBlurRect={handleCommitBlurRect}
              onCreateBlur={handleCreateBlur}
              overlays={previewOverlays}
              overlayTimeMs={bodySec * 1000}
              selectedOverlayId={selectedOverlayId}
              onSelectOverlay={handleSelectOverlay}
              onMoveOverlay={handleMoveOverlay}
              hasCards={hasCards}
              cardActive={cardActive}
              cardBackground={cardBackground}
              cardItems={cardItems}
              cardTimeMs={cardLocalMs}
              cardTransition={cardTransition}
              cardTransitionAlpha={cardTransitionAlpha}
              cardEditable={visualCard?.template !== 'reveal'}
              selectedCardItemId={selectedCardItemId}
              onSelectCardItem={handleSelectCardItem}
              onMoveCardItem={handleMoveCardItem}
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
              title="Add a zoom at the playhead"
            >
              <AddZoomIcon />
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
                          // Manually overriding the aspect away from the active
                          // platform's ratio drops the platform so its safe-zone
                          // guides don't linger on a mismatched canvas.
                          if (platformId !== 'none' && activePlatform.aspectId !== opt.id) {
                            setPlatformId('none');
                          }
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
            {aspectWouldCrop && (
              <div className="fit-toggle" role="group" aria-label="Fit mode">
                <button
                  type="button"
                  className={`fit-toggle-btn ${fitMode === 'fit' ? 'is-active' : ''}`}
                  onClick={() => setFitMode('fit')}
                  aria-pressed={fitMode === 'fit'}
                  title="Fit — show the whole video on your chosen background"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="1.6" y="1.6" width="12.8" height="12.8" rx="2.4" stroke="currentColor" strokeWidth="1.4" />
                    <rect x="3.4" y="6" width="9.2" height="4" rx="1" fill="currentColor" />
                  </svg>
                  Fit
                </button>
                <button
                  type="button"
                  className={`fit-toggle-btn ${fitMode === 'fill' ? 'is-active' : ''}`}
                  onClick={() => setFitMode('fill')}
                  aria-pressed={fitMode === 'fill'}
                  title="Fill — crop the video to fill the frame"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="1.6" y="1.6" width="12.8" height="12.8" rx="2.4" fill="currentColor" />
                  </svg>
                  Fill
                </button>
              </div>
            )}
            {activePlatform.safe && (
              <button
                className={`tool-btn ${showGuides ? 'active' : ''}`}
                onClick={() => setShowGuides((v) => !v)}
                title={`${showGuides ? 'Hide' : 'Show'} ${activePlatform.label} safe zones`}
              >
                <GuidesIcon /> Guides
              </button>
            )}
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
            // Filmstrip must show whatever the preview shows. In phone-primary
            // mode the phone footage is the main subject (the screen capture
            // runs in parallel only as the master clock), so the timeline
            // thumbnails come from the phone URL — not recording.url, which is
            // the PC screen the user never sees. The mobile <video> is synced
            // 1:1 to the master clock, so fragment src-times map unchanged.
            recordingUrl={recordedMobile ? recordedMobile.url : recording.url}
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
            captions={captions}
            selectedCaptionId={selectedCaptionId}
            onSelectCaption={handleSelectCaption}
            onUpdateCaption={handleUpdateCaption}
            cardTimeline={cardTimeline}
            onSelectCard={handleSelectCard}
            onMoveMidCard={handleMoveMidCard}
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
          cameraBlob={recordedCamera ? recordedCamera.blob : null}
          cameraOptions={recordedCamera ? cameraOptions : null}
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
          overlays={previewOverlays}
          cards={cards}
          platformId={platformId}
          onPlatform={applyPlatform}
          outputAspect={aspectOption.value}
          fitMode={fitMode}
          videoRef={videoRef}
          cameraVideoRef={cameraVideoRef}
          mobileVideoRef={mobileVideoRef}
          previewTimeMs={bodySec * 1000}
          playing={playing}
          currentTime={currentTime}
          onTogglePlay={togglePlay}
          onSeek={seek}
          hasCards={hasCards}
          cardActive={cardActive}
          cardBackground={cardBackground}
          cardItems={cardItems}
          cardTimeMs={cardLocalMs}
          cardTransition={cardTransition}
          cardTransitionAlpha={cardTransitionAlpha}
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
function AddZoomIcon(): JSX.Element {
  // Camera-style focus frame (corner brackets) with a centre dot — reads as
  // "focus / zoom here" rather than the magnifier's "enlarge/shrink".
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8V6a2 2 0 0 1 2-2h2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v2" />
      <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
      <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
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
function GuidesIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect x="7" y="7" width="10" height="10" rx="1" strokeDasharray="2 2" />
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
