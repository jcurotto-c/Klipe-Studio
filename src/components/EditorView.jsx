import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import VideoCanvas from './VideoCanvas.jsx';
import Timeline from './Timeline.jsx';
import ExportButton from './ExportButton.jsx';
import ExportModal from './ExportModal.jsx';
import ZoomInspector from './ZoomInspector.jsx';
import SidebarPanel from './SidebarPanel.jsx';
import {
  generateZoomSegments,
  createManualSegment,
  addSegment,
  updateSegment,
  removeSegment,
  DEFAULT_ZOOM
} from '../lib/zoom-engine.js';
import { isFullCrop } from '../lib/layout.js';
import { DEFAULT_CAMERA_OPTIONS } from './panels/CameraPanel.jsx';

const DEFAULTS_KEY = 'klipe.zoomDefaults';
const CAMERA_OPTIONS_KEY = 'klipe.cameraOptions';

function loadDefaults() {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    if (!raw) return DEFAULT_ZOOM;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_ZOOM, ...parsed };
  } catch {
    return DEFAULT_ZOOM;
  }
}

function loadCameraOptions() {
  try {
    const raw = localStorage.getItem(CAMERA_OPTIONS_KEY);
    if (!raw) return DEFAULT_CAMERA_OPTIONS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CAMERA_OPTIONS, ...parsed };
  } catch {
    return DEFAULT_CAMERA_OPTIONS;
  }
}

export default function EditorView({ recording, onNew, navExtraEl }) {
  const videoRef = useRef(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [trim, setTrim] = useState({ start: 0, end: 0 });
  const [background, setBackground] = useState({ type: 'wallpaper', value: 'default', blur: 0 });
  const [cropMode, setCropMode] = useState(false);
  const [crop, setCrop] = useState(null);
  const [zoomDefaults, setZoomDefaults] = useState(loadDefaults);
  const [segments, setSegments] = useState(() =>
    recording.autoZoom === false ? [] : generateZoomSegments(recording.mouse)
  );
  const [selectedId, setSelectedId] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [cameraOptions, setCameraOptions] = useState(loadCameraOptions);
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const cameraVideoRef = useRef(null);

  const exportCrop = isFullCrop(crop) ? null : crop;

  const clicks = useMemo(
    () => recording.mouse.events.filter((e) => e.type === 'click'),
    [recording.mouse]
  );

  const selected = useMemo(
    () => segments.find((s) => s.id === selectedId) || null,
    [segments, selectedId]
  );

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onLoaded = () => {
      const d = isFinite(v.duration) && v.duration > 0
        ? v.duration
        : (recording.mouse.events.at(-1)?.t || 0) / 1000;
      setDuration(d);
      setTrim({ start: 0, end: d });
    };
    const onTime = () => setCurrentTime(v.currentTime);
    const onEnd = () => setPlaying(false);
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

  const togglePlay = () => {
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

  const seek = (t) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration, t));
  };

  const fmt = (s) => {
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
      display: recording.display
    });
    setSegments((prev) => addSegment(prev, seg));
    setSelectedId(seg.id);
  }, [currentTime, zoomDefaults, recording.display]);

  const handleUpdateSegment = useCallback((id, patch) => {
    setSegments((prev) => updateSegment(prev, id, patch));
  }, []);

  const handleRemoveSegment = useCallback((id) => {
    setSegments((prev) => removeSegment(prev, id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  const handleApplyToAll = useCallback((patch) => {
    setSegments((prev) => prev.map((s) => ({ ...s, ...patch })));
  }, []);

  const handleSetDefault = useCallback((patch) => {
    setZoomDefaults((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  const handleCameraOptionsChange = useCallback((next) => {
    setCameraOptions(next);
    try { localStorage.setItem(CAMERA_OPTIONS_KEY, JSON.stringify(next)); } catch {}
  }, []);

  // Live webcam stream feeds the camera overlay preview. The recording
  // itself doesn't capture the camera — this is purely visual configuration.
  useEffect(() => {
    let cancelled = false;
    let stream = null;

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
          v.play().catch(() => {});
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
        navExtraEl
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
          sourceLabel={recording.name || 'recording'}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}
