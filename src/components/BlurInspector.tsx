import type { BlurRegion, BlurShape, BlurStyle } from '../types';

interface BlurInspectorProps {
  region: BlurRegion;
  /** Current source time, in ms — used by "Add keyframe at playhead". */
  currentSrcMs: number;
  /** Total source duration, in ms. */
  sourceDurationMs: number;
  onChange: (patch: Partial<BlurRegion>) => void;
  onRemove: () => void;
  onAddKeyframe: () => void;
  onRemoveKeyframe: (tMs: number) => void;
  onClose: () => void;
}

const STYLES: ReadonlyArray<{ id: BlurStyle; label: string }> = [
  { id: 'gaussian', label: 'Gaussian' },
  { id: 'pixelate', label: 'Pixelate' },
];

const SHAPES: ReadonlyArray<{ id: BlurShape; label: string }> = [
  { id: 'rect',    label: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse'   },
];

function fmt(ms: number): string {
  const s = ms / 1000;
  return `${s.toFixed(2)}s`;
}

export default function BlurInspector({
  region,
  currentSrcMs,
  sourceDurationMs,
  onChange,
  onRemove,
  onAddKeyframe,
  onRemoveKeyframe,
  onClose,
}: BlurInspectorProps): JSX.Element {
  const setStrength = (v: string): void => onChange({ strength: Math.max(0, Math.min(100, Number(v))) });
  const setStyle = (style: BlurStyle): void => onChange({ style });
  const setShape = (shape: BlurShape): void => onChange({ shape });

  const setStartSec = (v: string): void => {
    const ns = Math.max(0, Math.min(region.tEnd - 100, Number(v) * 1000));
    onChange({ tStart: ns });
  };
  const setEndSec = (v: string): void => {
    const ne = Math.max(region.tStart + 100, Math.min(sourceDurationMs, Number(v) * 1000));
    onChange({ tEnd: ne });
  };

  const animated = region.keyframes.length > 1;

  return (
    <aside className="zoom-inspector">
      <div className="zi-header">
        <div>
          <div className="zi-title">Blur region</div>
          <div className="zi-sub">{animated ? `${region.keyframes.length} keyframes` : 'Static'}</div>
        </div>
        <button className="ghost zi-close" onClick={onClose} title="Close">✕</button>
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Strength</label>
          <span className="zi-value">{Math.round(region.strength)}</span>
        </div>
        <div className="zi-help">
          {region.style === 'pixelate' ? 'Larger = chunkier blocks.' : 'Larger = more blur.'}
        </div>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={region.strength}
          onChange={(e) => setStrength(e.target.value)}
        />
      </div>

      <div className="zi-field">
        <div className="zi-row"><label>Effect</label></div>
        <div className="seg-tabs">
          {STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`seg-tab ${region.style === s.id ? 'active' : ''}`}
              onClick={() => setStyle(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="zi-field">
        <div className="zi-row"><label>Shape</label></div>
        <div className="seg-tabs">
          {SHAPES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`seg-tab ${region.shape === s.id ? 'active' : ''}`}
              onClick={() => setShape(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Starts at</label>
          <span className="zi-value">{fmt(region.tStart)}</span>
        </div>
        <input
          type="range"
          min="0"
          max={Math.max(0, sourceDurationMs / 1000)}
          step="0.05"
          value={region.tStart / 1000}
          onChange={(e) => setStartSec(e.target.value)}
        />
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Ends at</label>
          <span className="zi-value">{fmt(region.tEnd)}</span>
        </div>
        <input
          type="range"
          min="0"
          max={Math.max(0, sourceDurationMs / 1000)}
          step="0.05"
          value={region.tEnd / 1000}
          onChange={(e) => setEndSec(e.target.value)}
        />
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Keyframes</label>
          <button type="button" className="link-action" onClick={onAddKeyframe}>+ Add at playhead</button>
        </div>
        <div className="zi-help">
          Drag the region in the preview to keyframe its position over time.
        </div>
        <div className="blur-keyframe-list">
          {region.keyframes.map((k) => {
            const active = Math.abs(k.tMs - currentSrcMs) <= 80;
            return (
              <div key={k.tMs} className={`blur-keyframe-row ${active ? 'is-active' : ''}`}>
                <span className="blur-keyframe-time">{fmt(k.tMs)}</span>
                <span className="blur-keyframe-pos">
                  {Math.round(k.x * 100)},{Math.round(k.y * 100)} · {Math.round(k.width * 100)}×{Math.round(k.height * 100)}
                </span>
                {region.keyframes.length > 1 && (
                  <button
                    type="button"
                    className="link-action"
                    title="Remove keyframe"
                    onClick={() => onRemoveKeyframe(k.tMs)}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="zi-actions">
        <button className="danger" onClick={onRemove}>🗑 Remove blur</button>
      </div>
    </aside>
  );
}
