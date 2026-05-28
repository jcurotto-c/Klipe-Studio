import { ZOOM_EASING_LABELS } from '../lib/easing';
import type { CameraFollowStyle, ZoomDefaults, ZoomEasing, ZoomSegment } from '../types';

interface ZoomInspectorProps {
  segment: ZoomSegment;
  zoomDefaults: ZoomDefaults;
  onChange: (patch: Partial<ZoomSegment>) => void;
  onRemove: () => void;
  onApplyToAll: (patch: Partial<ZoomSegment>) => void;
  onSetDefault: (patch: Partial<ZoomDefaults>) => void;
  onClose: () => void;
}

const EASING_ORDER: ZoomEasing[] = ['spring', 'ease', 'snap', 'linear', 'anticipate'];

const CAMERA_OPTIONS: ReadonlyArray<{ id: CameraFollowStyle; label: string }> = [
  { id: 'static', label: 'Static' },
  { id: 'follow', label: 'Follow' },
  { id: 'cinematic', label: 'Cinematic' },
];

export default function ZoomInspector({
  segment,
  zoomDefaults,
  onChange,
  onRemove,
  onApplyToAll,
  onSetDefault,
  onClose,
}: ZoomInspectorProps): JSX.Element {
  const durationMs = segment.tEnd - segment.tStart;
  const easing: ZoomEasing = segment.easing ?? 'spring';
  const cameraStyle: CameraFollowStyle = zoomDefaults.cameraStyle ?? 'follow';
  const zoomBlur = zoomDefaults.zoomBlur ?? 0;

  const setScale = (v: string): void => onChange({ scale: Number(v) });
  const setDuration = (v: string): void => {
    const ms = Math.max(200, Number(v) * 1000);
    const mid = (segment.tStart + segment.tEnd) / 2;
    onChange({ tStart: Math.max(0, mid - ms / 2), tEnd: mid + ms / 2 });
  };
  const setEase = (key: 'easeIn' | 'easeOut', v: string): void =>
    onChange({ [key]: Math.max(0, Number(v)) });

  return (
    <aside className="zoom-inspector">
      <div className="zi-header">
        <div>
          <div className="zi-title">Zoom segment</div>
          <div className="zi-sub">{segment.source === 'manual' ? 'Manual' : 'Auto'}</div>
        </div>
        <button className="ghost zi-close" onClick={onClose} title="Close">✕</button>
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Zoom level</label>
          <span className="zi-value">{segment.scale.toFixed(2)}×</span>
        </div>
        <div className="zi-help">How close to zoom on the focus point.</div>
        <input
          type="range"
          min="1"
          max="5"
          step="0.05"
          value={segment.scale}
          onChange={(e) => setScale(e.target.value)}
        />
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Duration</label>
          <span className="zi-value">{(durationMs / 1000).toFixed(2)}s</span>
        </div>
        <input
          type="range"
          min="0.4"
          max="10"
          step="0.1"
          value={durationMs / 1000}
          onChange={(e) => setDuration(e.target.value)}
        />
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Motion style</label>
        </div>
        <div className="zi-help">The easing curve for this zoom's in/out.</div>
        <div className="zi-segmented">
          {EASING_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              className={`zi-seg ${easing === id ? 'active' : ''}`}
              onClick={() => onChange({ easing: id })}
            >
              {ZOOM_EASING_LABELS[id]}
            </button>
          ))}
        </div>
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Ease in</label>
          <span className="zi-value">{segment.easeIn} ms</span>
        </div>
        <input
          type="range"
          min="0"
          max="2000"
          step="50"
          value={segment.easeIn}
          onChange={(e) => setEase('easeIn', e.target.value)}
        />
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Ease out</label>
          <span className="zi-value">{segment.easeOut} ms</span>
        </div>
        <input
          type="range"
          min="0"
          max="2000"
          step="50"
          value={segment.easeOut}
          onChange={(e) => setEase('easeOut', e.target.value)}
        />
      </div>

      <div className="zi-divider" />
      <div className="zi-help zi-section-label">Applies to all zooms</div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Camera</label>
        </div>
        <div className="zi-help">How the camera tracks the cursor while zoomed.</div>
        <div className="zi-segmented">
          {CAMERA_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`zi-seg ${cameraStyle === opt.id ? 'active' : ''}`}
              onClick={() => onSetDefault({ cameraStyle: opt.id })}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Zoom blur</label>
          <span className="zi-value">{Math.round(zoomBlur * 100)}%</span>
        </div>
        <div className="zi-help">Motion blur during the zoom transition.</div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={zoomBlur}
          onChange={(e) => onSetDefault({ zoomBlur: Number(e.target.value) })}
        />
      </div>

      <div className="zi-actions">
        <button
          onClick={() => onSetDefault({
            scale: segment.scale,
            duration: segment.tEnd - segment.tStart,
            easeIn: segment.easeIn,
            easeOut: segment.easeOut,
            easing,
          })}
        >
          Set as default
        </button>
        <button
          onClick={() => onApplyToAll({
            scale: segment.scale,
            easeIn: segment.easeIn,
            easeOut: segment.easeOut,
            easing,
          })}
        >
          Apply to all zooms
        </button>
        <button className="danger" onClick={onRemove}>🗑 Remove zoom</button>
      </div>
    </aside>
  );
}
