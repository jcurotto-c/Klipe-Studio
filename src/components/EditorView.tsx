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
import type {
  Background,
  CameraOptions,
  Crop,
  CursorOptions,
  KlipeMouseEvent,
  Recording,
  Trim,
  ZoomDefaults,
  ZoomSegment,
} from '../types';

const DEFAULTS_KEY = 'klipe.zoomDefaults';
const CAMERA_OPTIONS_KEY = 'klipe.cameraOptions';
const CURSOR_OPTIONS_KEY = 'klipe.cursorOptions';

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
    <div className="editor">
      <div className="editor-main">
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
          />
          <video
            ref={cameraVideoRef}
            style={{ display: 'none' }}
            muted
            playsInline
            autoPlay
          />
        </div>

        <div className="editor-side">
          {selected && (
            <ZoomInspector
              segment={selected}
              display={recording.display}
              onChange={(patch) => handleUpdateSegment(selected.id, patch)}
              onRemove={() => handleRemoveSegment(selected.id)}
              onApplyToAll={handleApplyToAll}
              onSetDefault={handleSetDefault}
              onClose={() => setSelectedId(null)}
            />
          )}

          <SidebarPanel
            background={background}
            onBackgroundChange={setBackground}
            cameraOptions={cameraOptions}
            onCameraOptionsChange={handleCameraOptionsChange}
            cameraAvailable={cameraAvailable}
            cursorOptions={cursorOptions}
            onCursorOptionsChange={handleCursorOptionsChange}
          />
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <div className="controls">
          <button onClick={togglePlay} className="primary">
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <button onClick={() => seek(trim.start)}>⏮ Start</button>
          <span className="time">
            {fmt(currentTime)} / {fmt(duration)}
          </span>
          <button
            className="tool"
            onClick={handleAddZoom}
            disabled={!duration}
            title="Add a zoom segment at the playhead"
          >
            ⊕ Add zoom
          </button>
          <button
            className={cropMode ? 'tool active' : 'tool'}
            onClick={() => setCropMode((v) => !v)}
            title="Toggle crop mode"
          >
            ▢ Crop
          </button>
          {(cropMode || !isFullCrop(crop)) && (
            <button
              className="tool"
              onClick={() => setCrop(null)}
              title="Reset crop to full frame"
            >
              ↺ Reset Crop
            </button>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
            <button onClick={onNew}>+ New recording</button>
          </span>
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
          sourceLabel={recording.name || 'recording'}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}
