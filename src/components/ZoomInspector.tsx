import type { Display, ZoomDefaults, ZoomSegment } from '../types';

interface ZoomInspectorProps {
  segment: ZoomSegment;
  display: Display | null | undefined;
  onChange: (patch: Partial<ZoomSegment>) => void;
  onRemove: () => void;
  onApplyToAll: (patch: Partial<ZoomSegment>) => void;
  onSetDefault: (patch: Partial<ZoomDefaults>) => void;
  onClose: () => void;
}

export default function ZoomInspector({
  segment,
  display,
  onChange,
  onRemove,
  onApplyToAll,
  onSetDefault,
  onClose,
}: ZoomInspectorProps): JSX.Element {
  const dw = display?.width || 1920;
  const dh = display?.height || 1080;

  const durationMs = segment.tEnd - segment.tStart;

  const setScale = (v: string): void => onChange({ scale: Number(v) });
  const setCenter = (axis: 'x' | 'y', v: string): void => {
    const px = (Number(v) / 100) * (axis === 'x' ? dw : dh);
    onChange({ center: { ...segment.center, [axis]: px } });
  };
  const setDuration = (v: string): void => {
    const ms = Math.max(200, Number(v) * 1000);
    const mid = (segment.tStart + segment.tEnd) / 2;
    onChange({ tStart: Math.max(0, mid - ms / 2), tEnd: mid + ms / 2 });
  };
  const setEase = (key: 'easeIn' | 'easeOut', v: string): void =>
    onChange({ [key]: Math.max(0, Number(v)) });

  const cx = Math.round((segment.center.x / dw) * 100);
  const cy = Math.round((segment.center.y / dh) * 100);

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
          <label>Focus X</label>
          <span className="zi-value">{cx}%</span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          step="0.5"
          value={cx}
          onChange={(e) => setCenter('x', e.target.value)}
        />
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Focus Y</label>
          <span className="zi-value">{cy}%</span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          step="0.5"
          value={cy}
          onChange={(e) => setCenter('y', e.target.value)}
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

      <div className="zi-actions">
        <button
          onClick={() => onSetDefault({
            scale: segment.scale,
            duration: segment.tEnd - segment.tStart,
            easeIn: segment.easeIn,
            easeOut: segment.easeOut,
          })}
        >
          Set as default
        </button>
        <button
          onClick={() => onApplyToAll({
            scale: segment.scale,
            easeIn: segment.easeIn,
            easeOut: segment.easeOut,
          })}
        >
          Apply to all zooms
        </button>
        <button className="danger" onClick={onRemove}>🗑 Remove zoom</button>
      </div>
    </aside>
  );
}
