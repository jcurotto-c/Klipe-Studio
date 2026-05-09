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
import { DEFAULT_CAMERA_OPTIONS } from './panels/CameraPanel';
import { DEFAULT_CURSOR_OPTIONS } from '../lib/cursor-engine';
import { DEFAULT_FRAME_OPTIONS } from '../lib/renderer';
import type {
  Background,
  CameraOptions,
  Crop,
  CursorOptions,
  FrameOptions,
  KlipeMouseEvent,
  Recording,
  Trim,
  ZoomDefaults,
  ZoomSegment,
} from '../types';

const DEFAULTS_KEY = 'klipe.zoomDefaults';
const CAMERA_OPTIONS_KEY = 'klipe.cameraOptions';
const CURSOR_OPTIONS_KEY = 'klipe.cursorOptions';
const FRAME_OPTIONS_KEY = 'klipe.frameOptions';

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

interface EditorViewProps {
  recording: Recording;
  onNew: () => void;
  navExtraEl: HTMLElement | null;
}

export default function EditorView({ recording, onNew, navExtraEl }: EditorViewProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [trim, setTrim] = useState<Trim>({ start: 0, end: 0 });
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

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onLoaded = (): void => {
      const d = isFinite(v.duration) && v.duration > 0
        ? v.duration
        : (recording.mouse.events.at(-1)?.t ?? 0) / 1000;
      setDuration(d);
      setTrim({ start: 0, end: d });
    };
    const onTime = (): void => setCurrentTime(v.currentTime);
    const onEnd = (): void => setPlaying(false);
    v.addEventListener('loadedmetadata', onLoaded);
    v.addEventListener('durationchange', onLoaded);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('ended', onEnd);
    return () => {
      v.removeEventListener('loadedmetadata', onLoaded);
      v.removeEventListener('durationchange', onLoaded);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('ended', onEnd);
    };
  }, [recording]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (currentTime < trim.start) v.currentTime = trim.start;
    if (currentTime > trim.end && trim.end > 0) {
      v.pause();
      setPlaying(false);
    }
  }, [currentTime, trim]);

  const togglePlay = (): void => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < trim.start || v.currentTime >= trim.end) v.currentTime = trim.start;
      v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const seek = (t: number): void => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration, t));
  };

  const fmt = (s: number): string => {
    const m = Math.floor(s / 60);
    const r = (s % 60).toFixed(2).padStart(5, '0');
    return `${String(m).padStart(2, '0')}:${r}`;
  };

  const handleAddZoom = useCallback(() => {
    const tMs = currentTime * 1000;
    const seg = createManualSegment({
      tMs,
      durationMs: zoomDefaults.duration,
      easeIn: zoomDefaults.easeIn,
      easeOut: zoomDefaults.easeOut,
      scale: zoomDefaults.scale,
      display: recording.display,
    });
    setSegments((prev) => addSegment(prev, seg));
    setSelectedId(seg.id);
  }, [currentTime, zoomDefaults, recording.display]);

  const handleUpdateSegment = useCallback((id: string, patch: Partial<ZoomSegment>) => {
    setSegments((prev) => updateSegment(prev, id, patch));
  }, []);

  const handleRemoveSegment = useCallback((id: string) => {
    setSegments((prev) => removeSegment(prev, id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  const handleApplyToAll = useCallback((patch: Partial<ZoomSegment>) => {
    setSegments((prev) => prev.map((s) => ({ ...s, ...patch })));
  }, []);

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
      <div className="editor-main">
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
          />
        </div>

        <div className="preview-wrap">
          <div className="preview-toolbar">
            <div className="preview-toolbar-left" />
            <div className="preview-toolbar-right">
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
              >
                <CropIcon /> Crop Video
              </button>
            </div>
          </div>

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
              trim={trim}
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

      <div className="editor-bottom">
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
              disabled
              title="Cut at playhead (coming soon)"
            >
              <ScissorsIcon />
            </button>
          </div>

          <div className="controls-center">
            <span className="time-pro">{fmt(currentTime)}</span>
            <button className="icon-btn" onClick={() => seek(trim.start)} title="Skip to start">
              <SkipBackIcon />
            </button>
            <button
              onClick={togglePlay}
              className="play-btn"
              title={playing ? 'Pause' : 'Play'}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="icon-btn" onClick={() => seek(trim.end)} title="Skip to end">
              <SkipForwardIcon />
            </button>
            <span className="time-pro dim">{fmt(duration)}</span>
          </div>

          <div className="controls-right">
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
            trim={trim}
            onTrimChange={setTrim}
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
          trim={trim}
          duration={duration}
          crop={exportCrop}
          cursorOptions={cursorOptions}
          frame={frameOptions}
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
function RefreshIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
