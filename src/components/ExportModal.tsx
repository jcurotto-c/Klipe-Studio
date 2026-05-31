import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import VideoCanvas from './VideoCanvas';
import {
  exportVideo,
  getResolution,
  QUALITY_PRESETS,
  type ExportFormat,
  type ExportProgressStage,
  type QualityName,
  type ResolutionName,
} from '../lib/exporter';
import { PLATFORMS, getPlatform, type PlatformId } from '../lib/platforms';
import type {
  AudioFxOptions,
  Background,
  BackgroundMusic,
  BlurRegion,
  CameraFollowStyle,
  CameraOptions,
  Crop,
  CursorOptions,
  Display,
  FrameOptions,
  Fragment,
  MobileOptions,
  MouseTrack,
  ZoomSegment,
} from '../types';
import type { Overlay } from '../overlays/types';

interface FormatDef {
  id: ExportFormat;
  label: string;
  enabled: boolean;
}

const FORMATS: FormatDef[] = [
  { id: 'mp4',  label: 'MP4',  enabled: true },
  { id: 'webm', label: 'WebM', enabled: true },
];

const FPS_OPTIONS: number[] = [24, 30, 60];

const SIZES: ReadonlyArray<{ id: ResolutionName; label: string }> = [
  { id: '720p',  label: '720p'  },
  { id: '1080p', label: '1080p' },
  { id: '4K',    label: '4K'    },
];

const QUALITIES: QualityName[] = ['studio', 'social', 'web', 'webLow'];

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

type Stage = 'settings' | 'progress' | 'error';

interface ExportModalProps {
  sourceBlob: Blob;
  mouse: MouseTrack;
  segments: ZoomSegment[];
  display: Display;
  background: Background;
  fragments: Fragment[];
  duration: number;
  crop: Crop | null;
  cursorOptions: CursorOptions;
  cameraStyle?: CameraFollowStyle | null;
  zoomBlur?: number | null;
  frame?: FrameOptions | null;
  /** Recorded webcam track + its disc styling, composited into the export. */
  cameraBlob?: Blob | null;
  cameraOptions?: CameraOptions | null;
  /** Phone-frame styling when in phone-primary mode. */
  mobileOptions?: MobileOptions | null;
  /**
   * When true, the source video IS the phone capture; the exporter
   * renders it centered inside an iPhone frame using `mobileOptions`.
   */
  mobilePrimary?: boolean;
  audioFx?: AudioFxOptions | null;
  backgroundMusic?: BackgroundMusic | null;
  audioVolume?: number;
  micBlob?: Blob | null;
  systemBlob?: Blob | null;
  micVolume?: number;
  systemVolume?: number;
  blurRegions?: BlurRegion[] | null;
  overlays?: Overlay[] | null;
  /** Active social-platform preset id (editor-owned state). */
  platformId?: string;
  /** Apply a platform preset upstream (updates the editor's aspect ratio). */
  onPlatform?: (id: PlatformId) => void;
  /** Current output aspect (w/h) from the editor; null follows the source. */
  outputAspect?: number | null;
  /**
   * Live-preview wiring. The editor's media elements are reused so the modal
   * can render the same composition (with the chosen aspect + safe-zone guides)
   * in a side pane — the editor's own preview is suspended while the modal is
   * open, so only one canvas renders at a time.
   */
  videoRef?: RefObject<HTMLVideoElement> | null;
  cameraVideoRef?: RefObject<HTMLVideoElement> | null;
  mobileVideoRef?: RefObject<HTMLVideoElement> | null;
  /** Editor playhead in output ms, for overlay keyframe sampling in the preview. */
  previewTimeMs?: number;
  /** Playback transport for the preview (drives the shared editor <video>). */
  playing?: boolean;
  currentTime?: number;
  onTogglePlay?: () => void;
  onSeek?: (t: number) => void;
  sourceLabel?: string;
  onClose: () => void;
}

export default function ExportModal({
  sourceBlob,
  mouse,
  segments,
  display,
  background,
  fragments,
  duration,
  crop,
  cursorOptions,
  cameraStyle,
  zoomBlur,
  frame,
  cameraBlob,
  cameraOptions,
  mobileOptions,
  mobilePrimary,
  audioFx,
  backgroundMusic,
  audioVolume,
  micBlob,
  systemBlob,
  micVolume,
  systemVolume,
  blurRegions,
  overlays,
  platformId = 'none',
  onPlatform,
  outputAspect = null,
  videoRef = null,
  cameraVideoRef = null,
  mobileVideoRef = null,
  previewTimeMs = 0,
  playing = false,
  currentTime = 0,
  onTogglePlay,
  onSeek,
  sourceLabel,
  onClose,
}: ExportModalProps): React.ReactPortal {
  const [stage, setStage] = useState<Stage>('settings');
  // Seed format/size from the active platform preset (if any), then let the
  // user override them freely.
  const [format, setFormat] = useState<ExportFormat>(() => getPlatform(platformId).format);
  const [fps, setFps] = useState<number>(60);
  const [size, setSize] = useState<ResolutionName>(() => getPlatform(platformId).resolution);
  const [quality, setQuality] = useState<QualityName>('studio');

  // Picking a platform fills in size/format here and applies its aspect ratio
  // upstream (the editor owns aspect, so the preview + safe-zone guides react).
  const handlePlatform = useCallback((id: PlatformId) => {
    const p = getPlatform(id);
    setSize(p.resolution);
    setFormat(p.format);
    onPlatform?.(id);
  }, [onPlatform]);

  const [progress, setProgress] = useState(0);
  const [progressStage, setProgressStage] = useState<ExportProgressStage | ''>('');
  const [destPath, setDestPath] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const startedAtRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // Throttle progress re-renders: the exporter fires onProgress once per frame
  // (thousands of times for a long clip). Re-rendering the modal that often
  // repaints the blurred backdrop each time, which steals work from the export.
  const lastFlushRef = useRef(0);
  const lastPctRef = useRef(-1);

  const exportSeconds = duration || 0;

  const dims = getResolution(size);
  const previewPlatform = getPlatform(platformId);
  const hasPreview = !!videoRef;
  const estBytes = useMemo(() => {
    const base = size === '4K' ? 24_000_000 : size === '1080p' ? 12_000_000 : 6_000_000;
    const mult = QUALITY_PRESETS[quality]?.multiplier ?? 1;
    const audio = 192_000;
    return Math.round(((base * mult) + audio) * exportSeconds / 8);
  }, [size, quality, exportSeconds]);

  const elapsed = progress > 0
    ? (performance.now() - startedAtRef.current) / 1000
    : 0;
  const eta = progress > 0.02 ? Math.max(0, elapsed / progress - elapsed) : 0;

  const handleClose = useCallback(() => {
    if (stage === 'progress') return;
    onClose?.();
  }, [stage, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose]);

  const handleExportToFile = useCallback(async () => {
    if (!sourceBlob || !exportSeconds) return;
    if (!window.klipe) {
      setErrorMsg('Electron bridge unavailable.');
      setStage('error');
      return;
    }
    setErrorMsg('');
    setProgress(0);
    setProgressStage('encoding');
    setDestPath('');
    setStage('progress');
    startedAtRef.current = performance.now();
    lastFlushRef.current = 0;
    lastPctRef.current = -1;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { bytes, mimeType, ext } = await exportVideo({
        sourceBlob,
        mouse,
        segments,
        display,
        background,
        crop,
        fragments,
        resolution: size,
        outputAspect,
        fps,
        format,
        quality,
        cursorOptions,
        cameraStyle,
        zoomBlur,
        frame,
        cameraBlob,
        cameraOptions,
        mobileOptions,
        mobilePrimary,
        audioFx,
        backgroundMusic,
        audioVolume,
        micBlob,
        systemBlob,
        micVolume,
        systemVolume,
        blurRegions,
        overlays,
        signal: controller.signal,
        onProgress: (s, v) => {
          const now = performance.now();
          const pct = Math.round(v * 100);
          // Flush at most ~4×/sec, plus on every whole-percent change, plus
          // always on the terminal 'done' so the bar reliably lands on 100%.
          if (s === 'done' || pct !== lastPctRef.current || now - lastFlushRef.current > 250) {
            lastPctRef.current = pct;
            lastFlushRef.current = now;
            setProgressStage(s);
            setProgress(v);
          }
        },
      });

      const result = await window.klipe.saveVideoBlob({
        buffer: bytes.buffer as ArrayBuffer,
        suggestedName: `klipe-${Date.now()}.${ext}`,
        mimeType,
      });
      if (result?.canceled) {
        setStage('settings');
      } else {
        setDestPath(result?.filePath || '');
        onClose?.();
      }
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e?.name === 'AbortError') {
        setStage('settings');
      } else {
        setErrorMsg(String(e?.message || err));
        setStage('error');
      }
    } finally {
      abortRef.current = null;
    }
  }, [
    sourceBlob, exportSeconds, mouse, segments, display, background, crop,
    fragments, size, outputAspect, fps, format, quality, cursorOptions, cameraStyle, zoomBlur, frame, cameraBlob, cameraOptions, mobileOptions, mobilePrimary,
    audioFx, backgroundMusic, blurRegions, overlays, onClose,
  ]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={handleClose}>
      <div
        className={`modal-card export-modal ${stage === 'settings' && hasPreview ? 'has-preview' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Export"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {stage === 'settings' && (
          <div className="export-layout">
            <div className="export-settings-pane">
              <ExportSettings
                platformId={platformId}
                onPlatform={handlePlatform}
                format={format}
                onFormat={setFormat}
                fps={fps}
                onFps={setFps}
                size={size}
                onSize={setSize}
                quality={quality}
                onQuality={setQuality}
                dims={dims}
                estBytes={estBytes}
                estSeconds={exportSeconds}
                canExport={!!sourceBlob && exportSeconds > 0}
                onExport={handleExportToFile}
                onCancel={handleClose}
              />
            </div>
            {hasPreview && videoRef && (
              <div className="export-preview-pane">
                <div className="export-preview-label">Preview · {previewPlatform.label}</div>
                <div className="export-preview-stage">
                  <VideoCanvas
                    videoRef={videoRef}
                    segments={segments}
                    mouse={mouse}
                    display={display}
                    background={background}
                    crop={crop}
                    cameraVideoRef={cameraVideoRef}
                    cameraOptions={cameraOptions ?? null}
                    mobileVideoRef={mobileVideoRef}
                    mobileOptions={mobileOptions ?? null}
                    mobilePrimary={mobilePrimary}
                    cursorOptions={cursorOptions}
                    cameraStyle={cameraStyle}
                    zoomBlur={zoomBlur}
                    playing={playing}
                    frameOptions={frame ?? null}
                    aspectRatio={outputAspect}
                    safeZones={previewPlatform.safe ?? null}
                    blurRegions={blurRegions ?? undefined}
                    overlays={overlays ?? undefined}
                    overlayTimeMs={previewTimeMs}
                  />
                </div>
                <div className="export-preview-transport">
                  <button
                    type="button"
                    className="pv-play"
                    onClick={onTogglePlay}
                    disabled={!onTogglePlay || !(duration > 0)}
                    aria-label={playing ? 'Pause' : 'Play'}
                    title={playing ? 'Pause' : 'Play'}
                  >
                    {playing ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  <span className="pv-time">{fmtTime(currentTime)}</span>
                  <input
                    type="range"
                    className="pv-scrubber"
                    min={0}
                    max={duration || 0}
                    step={0.01}
                    value={Math.min(currentTime, duration || 0)}
                    onChange={(e) => onSeek?.(Number(e.target.value))}
                    disabled={!onSeek || !(duration > 0)}
                    aria-label="Preview position"
                  />
                  <span className="pv-time dim">{fmtTime(duration)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {stage === 'progress' && (
          <ExportProgress
            sourceLabel={sourceLabel || 'recording'}
            destLabel={destPath || `klipe-export.${format}`}
            progress={progress}
            progressStage={progressStage}
            elapsed={elapsed}
            eta={eta}
            onStop={handleStop}
          />
        )}

        {stage === 'error' && (
          <ExportError
            message={errorMsg}
            onBack={() => setStage('settings')}
            onClose={handleClose}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

interface ExportSettingsProps {
  platformId: string;
  onPlatform: (id: PlatformId) => void;
  format: ExportFormat;
  onFormat: (f: ExportFormat) => void;
  fps: number;
  onFps: (n: number) => void;
  size: ResolutionName;
  onSize: (s: ResolutionName) => void;
  quality: QualityName;
  onQuality: (q: QualityName) => void;
  dims: { w: number; h: number };
  estBytes: number;
  estSeconds: number;
  canExport: boolean;
  onExport: () => void;
  onCancel: () => void;
}

function ExportSettings({
  platformId, onPlatform,
  format, onFormat,
  fps, onFps,
  size, onSize,
  quality, onQuality,
  dims, estBytes, estSeconds,
  canExport,
  onExport, onCancel,
}: ExportSettingsProps): JSX.Element {
  return (
    <>
      <div className="export-field full">
        <div className="export-label">
          <ShareIcon /> Platform
        </div>
        <div className="export-platforms">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`platform-btn ${platformId === p.id ? 'active' : ''}`}
              onClick={() => onPlatform(p.id)}
              title={p.label}
              aria-pressed={platformId === p.id}
            >
              {p.icon
                ? <img src={p.icon} alt="" className="platform-icon" draggable={false} />
                : <CustomPlatformIcon />}
              <span className="platform-label">{p.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="export-row export-row-top">
        <div className="export-field">
          <div className="export-label">
            <ExportIcon /> Export as
          </div>
          <div className="seg-tabs">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`seg-tab ${format === f.id ? 'active' : ''}`}
                onClick={() => f.enabled && onFormat(f.id)}
                disabled={!f.enabled}
                title={f.enabled ? f.label : 'Coming soon'}
              >
                {f.label}
                {!f.enabled && <span className="soon">soon</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="export-field">
          <div className="export-label">
            <FrameRateIcon /> Frame rate
          </div>
          <select
            className="export-select"
            value={fps}
            onChange={(e) => onFps(Number(e.target.value))}
          >
            {FPS_OPTIONS.map((v) => (
              <option key={v} value={v}>{v} FPS</option>
            ))}
          </select>
        </div>
      </div>

      <div className="export-row">
        <div className="export-field full">
          <div className="export-label">
            <SizeIcon /> Output Size
          </div>
          <div className="seg-tabs three">
            {SIZES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`seg-tab ${size === s.id ? 'active' : ''}`}
                onClick={() => onSize(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="export-meta">{dims.w}px × {dims.h}px</div>
        </div>

        <div className="export-field full">
          <div className="export-label">
            <QualityIcon /> Quality (Compression level)
          </div>
          <div className="seg-tabs four">
            {QUALITIES.map((q) => (
              <button
                key={q}
                type="button"
                className={`seg-tab ${quality === q ? 'active' : ''}`}
                onClick={() => onQuality(q)}
              >
                {QUALITY_PRESETS[q].label}
              </button>
            ))}
          </div>
          <div className="export-meta">{QUALITY_PRESETS[quality].description}</div>
          <div className="export-meta dim">Quality setting does not impact export speed.</div>
        </div>
      </div>

      <div className="export-actions">
        <button
          type="button"
          className="primary"
          onClick={onExport}
          disabled={!canExport}
        >
          Export to file <kbd>↵</kbd>
        </button>
        <button
          type="button"
          className="ghost-action"
          disabled
          title="Coming soon"
        >
          <ClipboardIcon /> Copy to clipboard <kbd>⌘ ⏎</kbd>
          <span className="soon">soon</span>
        </button>
        <div className="spacer" />
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>

      <div className="export-foot">
        <div>Estimated export time ~ {fmtTime(estSeconds)}</div>
        <div>Estimated max output size: {fmtBytes(estBytes)}</div>
      </div>
    </>
  );
}

interface ExportProgressProps {
  sourceLabel: string;
  destLabel: string;
  progress: number;
  progressStage: ExportProgressStage | '';
  elapsed: number;
  eta: number;
  onStop: () => void;
}

function ExportProgress({ sourceLabel, destLabel, progress, progressStage, elapsed, eta, onStop }: ExportProgressProps): JSX.Element {
  const pct = Math.round(progress * 100);
  return (
    <div className="export-progress">
      <div className="ep-path">
        <span className="ep-src">{sourceLabel}</span>
        <ArrowRightIcon />
        <span className="ep-dst">{destLabel}</span>
      </div>

      <div className="ep-title">Exporting video — {pct}%</div>

      <div className="ep-bar">
        <div className="ep-bar-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="ep-meta">
        {fmtTime(elapsed)} · {progressStage || 'starting'} · {eta > 0 ? `${fmtTime(eta)} left` : 'estimating…'}
      </div>

      <button type="button" className="ghost" onClick={onStop}>
        Stop export
      </button>
    </div>
  );
}

interface ExportErrorProps {
  message: string;
  onBack: () => void;
  onClose: () => void;
}

function ExportError({ message, onBack, onClose }: ExportErrorProps): JSX.Element {
  return (
    <div className="export-error">
      <div className="ee-title">Export failed</div>
      <pre className="ee-msg">{message}</pre>
      <div className="export-actions">
        <button type="button" className="primary" onClick={onBack}>Back</button>
        <div className="spacer" />
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function ExportIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
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
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
function ShareIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
      <line x1="15.4" y1="6.5" x2="8.6" y2="10.5" />
    </svg>
  );
}
function CustomPlatformIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18M3 12h18" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
function FrameRateIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}
function SizeIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 9h4M7 13h7" />
    </svg>
  );
}
function QualityIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0z" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  );
}
function ClipboardIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="3" width="8" height="4" rx="1" />
      <path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
    </svg>
  );
}
function ArrowRightIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}
