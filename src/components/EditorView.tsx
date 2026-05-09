import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import VideoCanvas from './VideoCanvas';
import Timeline from './Timeline';
import ExportButton from './ExportButton';
import ExportModal from './ExportModal';
import ZoomInspector from './ZoomInspector';
import SidebarPanel from './SidebarPanel';
import {
  generateZoomSegments,
  createManualSegment,
  addSegment,
  updateSegment,
  removeSegment,
  DEFAULT_ZOOM,
} from '../lib/zoom-engine';
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
import { DEFAULT_CURSOR_OPTIONS } from '../lib/cursor-engine';
import { DEFAULT_FRAME_OPTIONS } from '../lib/renderer';
import { DEFAULT_AUDIO_FX } from '../lib/sound-fx';
import { useAudioFx } from '../lib/use-audio-fx';
import type {
  AudioFxOptions,
  Background,
  CameraOptions,
  Crop,
  CursorOptions,
  FrameOptions,
  Fragment,
  KlipeMouseEvent,
  Recording,
  ZoomDefaults,
  ZoomSegment,
} from '../types';

const DEFAULTS_KEY = 'klipe.zoomDefaults';
const CAMERA_OPTIONS_KEY = 'klipe.cameraOptions';
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
}

interface HistorySnapshot {
  fragments: Fragment[];
  segments: ZoomSegment[];
}

const HISTORY_LIMIT = 100;

export default function EditorView({ recording, onNew, navExtraEl }: EditorViewProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [selectedFragmentId, setSelectedFragmentId] = useState<string | null>(null);
  const [background, setBackground] = useState<Background>({ type: 'wallpaper', value: 'default', blur: 0 });
  const [cropMode, setCropMode] = useState(false);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [zoomDefaults, setZoomDefaults] = useState<ZoomDefaults>(loadDefaults);
  const [segments, setSegments] = useState<ZoomSegment[]>(() =>
    recording.autoZoom === false ? [] : generateZoomSegments(recording.mouse),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [cameraOptions, setCameraOptions] = useState<CameraOptions>(loadCameraOptions);
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const [cursorOptions, setCursorOptions] = useState<CursorOptions>(loadCursorOptions);
  const [frameOptions, setFrameOptions] = useState<FrameOptions>(loadFrameOptions);
  const [audioFxOptions, setAudioFxOptions] = useState<AudioFxOptions>(loadAudioFxOptions);
  const [aspectRatio, setAspectRatio] = useState<string>('16:9');
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);

  const exportCrop: Crop | null = isFullCrop(crop) ? null : crop;

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

  const pushHistory = useCallback((): void => {
    const h = historyRef.current;
    h.past.push({ fragments: fragmentsRef.current, segments: segmentsRef.current });
    if (h.past.length > HISTORY_LIMIT) h.past.shift();
    h.future = [];
    syncHistoryFlags();
  }, [syncHistoryFlags]);

  const applySnapshot = useCallback((snap: HistorySnapshot): void => {
    fragmentsRef.current = snap.fragments;
    segmentsRef.current = snap.segments;
    setFragments(snap.fragments);
    setSegments(snap.segments);
  }, []);

  const undo = useCallback((): void => {
    const h = historyRef.current;
    if (!h.past.length) return;
    const prev = h.past.pop()!;
    h.future.push({ fragments: fragmentsRef.current, segments: segmentsRef.current });
    if (h.future.length > HISTORY_LIMIT) h.future.shift();
    applySnapshot(prev);
    syncHistoryFlags();
  }, [applySnapshot, syncHistoryFlags]);

  const redo = useCallback((): void => {
    const h = historyRef.current;
    if (!h.future.length) return;
    const next = h.future.pop()!;
    h.past.push({ fragments: fragmentsRef.current, segments: segmentsRef.current });
    if (h.past.length > HISTORY_LIMIT) h.past.shift();
    applySnapshot(next);
    syncHistoryFlags();
  }, [applySnapshot, syncHistoryFlags]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

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
    if (id) setSelectedId(null);
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

  useAudioFx({
    mouse: recording.mouse,
    fragments,
    options: audioFxOptions,
    playing,
    currentTime,
  });

  useEffect(() => {
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
        const v = cameraVideoRef.current;
        if (v) {
          v.srcObject = s;
          v.play().catch(() => { /* ignore */ });
        }
        setCameraAvailable(true);
      })
      .catch(() => {
        if (!cancelled) setCameraAvailable(false);
      });

    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      const v = cameraVideoRef.current;
      if (v) v.srcObject = null;
    };
  }, []);

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
          cursorOptions={cursorOptions}
          onCursorOptionsChange={handleCursorOptionsChange}
          audioFxOptions={audioFxOptions}
          onAudioFxOptionsChange={handleAudioFxOptionsChange}
          inputEvents={recording.mouse.events}
        />
      </div>
      <div className="editor-right">
      <div className="editor-main">

        <div className="preview-wrap">
          <div className="preview">
            <video
              ref={videoRef}
              src={recording.url}
              style={{ display: 'none' }}
              muted
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
              cursorOptions={cursorOptions}
              frameOptions={frameOptions}
            />
            <video
              ref={cameraVideoRef}
              style={{ display: 'none' }}
              muted
              playsInline
              autoPlay
            />
          </div>
        </div>

        {selected && (
          <div className="editor-side-right">
            <ZoomInspector
              segment={selected}
              display={recording.display}
              onChange={(patch) => handleUpdateSegment(selected.id, patch)}
              onRemove={() => handleRemoveSegment(selected.id)}
              onApplyToAll={handleApplyToAll}
              onSetDefault={handleSetDefault}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}
      </div>

        <div className="controls-pro">
          <div className="controls-left">
            <button className="add-layer-btn" disabled title="Add a media layer (coming soon)">
              <PlusIcon /> Add Layer <ChevronDownSmallIcon />
            </button>
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
            <div className="aspect-select">
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
                aria-label="Aspect ratio"
              >
                <option value="16:9">16:9</option>
                <option value="9:16">9:16</option>
                <option value="1:1">1:1</option>
                <option value="4:3">4:3</option>
                <option value="auto">Auto</option>
              </select>
              <ChevronDownIcon />
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
            onSelectSegment={setSelectedId}
            onUpdateSegment={handleUpdateSegment}
            fragments={fragments}
            sourceDuration={sourceDuration}
            selectedFragmentId={selectedFragmentId}
            onSelectFragment={handleSelectFragment}
            onUpdateFragments={handleUpdateFragments}
            onFragmentEdge={handleFragmentEdge}
            onBeginEdit={pushHistory}
          />
        ) : (
          <div className="empty">Loading clip…</div>
        )}
      </div>

      {navExtraEl && createPortal(
        <ExportButton
          onClick={() => setExportOpen(true)}
          disabled={!duration}
        />,
        navExtraEl,
      )}

      {exportOpen && (
        <ExportModal
          sourceBlob={recording.blob}
          mouse={recording.mouse}
          segments={segments}
          display={recording.display}
          background={background}
          fragments={fragments}
          duration={duration}
          crop={exportCrop}
          cursorOptions={cursorOptions}
          frame={frameOptions}
          audioFx={audioFxOptions}
          sourceLabel={recording.name || 'recording'}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
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
