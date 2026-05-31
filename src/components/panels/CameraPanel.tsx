import { useEffect, useRef, useState } from 'react';
import type { CameraOptions, CameraPosition, CameraShape } from '../../types';
import { CAMERA_SHAPE_ASPECT, CAMERA_SHAPE_ROUNDNESS } from '../../lib/camera-shape';

export const CAMERA_POSITIONS: ReadonlyArray<ReadonlyArray<CameraPosition | null>> = [
  ['top-left',     'top-center',    'top-right'],
  ['middle-left',  null,            'middle-right'],
  ['bottom-left',  'bottom-center', 'bottom-right'],
];

export const DEFAULT_CAMERA_OPTIONS: CameraOptions = {
  hide: false,
  position: 'bottom-right',
  mirror: false,
  roundness: 100,
  size: 20,
  shape: 'circle',
  zoomDifferent: true,
  sizeDuringZoom: 12,
};

/** Size presets (% of canvas width) surfaced by the segmented control. */
const SIZE_PRESETS: ReadonlyArray<{ key: string; value: number }> = [
  { key: 'XS', value: 12 },
  { key: 'S',  value: 18 },
  { key: 'M',  value: 26 },
  { key: 'L',  value: 34 },
];

const SHAPE_OPTIONS: ReadonlyArray<{ key: CameraShape; label: string }> = [
  { key: 'circle', label: 'Circle' },
  { key: 'card',   label: 'Card' },
  { key: 'pill',   label: 'Pill' },
];

// Stage geometry — mirrors the renderer so the miniature is WYSIWYG.
const STAGE_ASPECT = 16 / 10;
const STAGE_PAD_RATIO = 0.025;   // matches CAMERA_PADDING_RATIO in renderer.ts
const STAGE_MIN_PAD = 6;         // px floor so the chip clears the corner brackets
const MOVE_MS = 380;
const MOVE_EASING = 'cubic-bezier(0.34, 1.4, 0.64, 1)';

interface CameraPanelProps {
  value: CameraOptions | null | undefined;
  onChange: (next: CameraOptions) => void;
  available?: boolean;
}

export default function CameraPanel({ value, onChange, available = true }: CameraPanelProps): JSX.Element {
  const opts: CameraOptions = { ...DEFAULT_CAMERA_OPTIONS, ...(value ?? {}) };
  const shape: CameraShape = opts.shape ?? 'circle';

  const update = (patch: Partial<CameraOptions>): void => onChange({ ...opts, ...patch });

  // Light up the preset nearest the current size so the segmented control still
  // reflects state when the fine slider lands on an in-between value.
  const nearestSizeKey = SIZE_PRESETS.reduce((best, p) =>
    Math.abs(p.value - opts.size) < Math.abs(best.value - opts.size) ? p : best,
  ).key;

  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-label">
          <CamIcon /> Camera
        </div>
        {!available && (
          <div className="panel-empty">
            No webcam detected. Settings still apply — connect a camera to see the live preview.
          </div>
        )}
      </div>

      <div className="panel-section">
        <ToggleRow
          label="Hide camera"
          checked={opts.hide}
          onChange={(v) => update({ hide: v })}
        />
      </div>

      <div className="panel-divider" />

      <div className="panel-section">
        <div className="panel-sublabel">Position</div>
        <PositionStage
          position={opts.position}
          shape={shape}
          sizePct={opts.size}
          roundnessPct={opts.roundness}
          disabled={opts.hide}
          onChange={(p) => update({ position: p })}
        />
      </div>

      <div className="panel-divider" />

      <div className="panel-section">
        <div className="panel-sublabel">Size</div>
        <div className="seg-tabs four cam-size-seg">
          {SIZE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`seg-tab ${nearestSizeKey === p.key ? 'active' : ''}`}
              disabled={opts.hide}
              aria-pressed={nearestSizeKey === p.key}
              onClick={() => update({ size: p.value })}
            >
              {p.key}
            </button>
          ))}
        </div>
        <div className="cam-fine">
          <SliderField
            label="Fine size"
            value={opts.size}
            min={5}
            max={40}
            step={1}
            unit="%"
            disabled={opts.hide}
            onChange={(v) => update({ size: v })}
            onReset={() => update({ size: DEFAULT_CAMERA_OPTIONS.size })}
          />
        </div>
      </div>

      <div className="panel-divider" />

      <div className="panel-section">
        <div className="panel-sublabel">Shape</div>
        <div className="cam-shape-row">
          {SHAPE_OPTIONS.map((s) => {
            const active = shape === s.key;
            return (
              <button
                key={s.key}
                type="button"
                className={`cam-shape-btn ${active ? 'active' : ''}`}
                disabled={opts.hide}
                aria-pressed={active}
                onClick={() => update({ shape: s.key, roundness: CAMERA_SHAPE_ROUNDNESS[s.key] })}
              >
                <span className="cam-shape-glyph"><ShapeIcon shape={s.key} /></span>
                <span className="cam-shape-label">{s.label}</span>
              </button>
            );
          })}
        </div>
        <div className="cam-fine">
          <SliderField
            label="Roundness"
            value={opts.roundness}
            min={0}
            max={100}
            step={1}
            unit="%"
            disabled={opts.hide}
            onChange={(v) => update({ roundness: v })}
            onReset={() => update({ roundness: DEFAULT_CAMERA_OPTIONS.roundness })}
          />
        </div>
      </div>

      <div className="panel-divider" />

      <div className="panel-section">
        <ToggleRow
          label="Mirror camera"
          checked={opts.mirror}
          onChange={(v) => update({ mirror: v })}
          disabled={opts.hide}
        />
      </div>

      <div className="panel-divider" />

      <div className="panel-section">
        <div className="panel-sublabel">Camera during zoom</div>
        <ToggleRow
          label="Different size during zoom"
          help="When zooming in, the camera will shrink to avoid covering the recording itself."
          checked={opts.zoomDifferent}
          onChange={(v) => update({ zoomDifferent: v })}
          disabled={opts.hide}
        />
        {opts.zoomDifferent && !opts.hide && (
          <div className="cam-fine">
            <SliderField
              label="Size during zoom"
              value={opts.sizeDuringZoom}
              min={5}
              max={Math.max(5, opts.size)}
              step={1}
              unit="%"
              onChange={(v) => update({ sizeDuringZoom: v })}
              onReset={() => update({ sizeDuringZoom: DEFAULT_CAMERA_OPTIONS.sizeDuringZoom })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

function ToggleRow({ label, help, checked, onChange, disabled }: ToggleRowProps): JSX.Element {
  return (
    <div className={`toggle-row ${disabled ? 'disabled' : ''}`}>
      <div className="toggle-row-text">
        <div className="toggle-row-label">{label}</div>
        {help && <div className="toggle-row-help">{help}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="switch-thumb" />
      </button>
    </div>
  );
}

interface PositionStageProps {
  position: CameraPosition;
  shape: CameraShape;
  sizePct: number;
  roundnessPct: number;
  disabled?: boolean;
  onChange: (next: CameraPosition) => void;
}

/**
 * The "stage": a miniature of the recording canvas with the camera chip living
 * inside it. Clicking a zone springs the chip to that slot; hovering shows a
 * dotted ghost of where it would land. Footprint + corner radius track the
 * Shape/Size/Roundness controls 1:1 with the renderer, so it's a true preview.
 */
function PositionStage({ position, shape, sizePct, roundnessPct, disabled, onChange }: PositionStageProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(0);
  const [hover, setHover] = useState<CameraPosition | null>(null);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw) setStageW(cw);
    });
    ro.observe(el);
    setStageW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const stageH = stageW / STAGE_ASPECT;
  const pad = Math.max(STAGE_MIN_PAD, stageW * STAGE_PAD_RATIO);
  const elemW = (sizePct / 100) * stageW;
  const elemH = elemW / CAMERA_SHAPE_ASPECT[shape];
  const radius = (roundnessPct / 100) * (Math.min(elemW, elemH) / 2);

  // Mirror renderer.ts cameraSlot(): anchor to the relevant edge, not the centre.
  const slot = (p: CameraPosition): { x: number; y: number } => {
    const [v, h] = p.split('-');
    const x = h === 'left' ? pad : h === 'right' ? stageW - elemW - pad : (stageW - elemW) / 2;
    const y = v === 'top' ? pad : v === 'bottom' ? stageH - elemH - pad : (stageH - elemH) / 2;
    return { x, y };
  };

  const measured = stageW > 0;
  const cur = measured ? slot(position) : { x: 0, y: 0 };
  const ghostActive = !disabled && hover != null && hover !== position;
  const ghostXY = measured ? slot(ghostActive ? (hover as CameraPosition) : position) : { x: 0, y: 0 };

  return (
    <div
      ref={stageRef}
      className={`cam-stage ${disabled ? 'disabled' : ''}`}
      onMouseLeave={() => setHover(null)}
    >
      <div className="cam-stage-screen" aria-hidden />
      <div className="cam-stage-grid" aria-hidden />
      <span className="cam-stage-bracket tl" aria-hidden />
      <span className="cam-stage-bracket tr" aria-hidden />
      <span className="cam-stage-bracket bl" aria-hidden />
      <span className="cam-stage-bracket br" aria-hidden />

      {measured && (
        <>
          <div
            className="cam-stage-ghost"
            aria-hidden
            style={{
              left: ghostXY.x,
              top: ghostXY.y,
              width: elemW,
              height: elemH,
              borderRadius: radius,
              opacity: ghostActive ? 1 : 0,
            }}
          />
          <div
            className="cam-stage-cam"
            aria-hidden
            style={{
              left: cur.x,
              top: cur.y,
              width: elemW,
              height: elemH,
              borderRadius: radius,
              transition:
                `left ${MOVE_MS}ms ${MOVE_EASING}, top ${MOVE_MS}ms ${MOVE_EASING},` +
                ' width 180ms ease, height 180ms ease, border-radius 180ms ease',
            }}
          >
            <CamGlyph />
          </div>
        </>
      )}

      <div className="cam-stage-zones">
        {CAMERA_POSITIONS.map((row, ri) =>
          row.map((cell, ci) => {
            if (cell == null) return <div key={`${ri}-${ci}`} className="cam-stage-zone center" aria-hidden />;
            const active = position === cell;
            return (
              <button
                key={cell}
                type="button"
                className={`cam-stage-zone ${active ? 'active' : ''}`}
                aria-label={cell.replace('-', ' ')}
                aria-pressed={active}
                disabled={disabled}
                onMouseEnter={() => setHover(cell)}
                onFocus={() => setHover(cell)}
                onBlur={() => setHover(null)}
                onClick={() => onChange(cell)}
              />
            );
          }),
        )}
      </div>
    </div>
  );
}

interface SliderFieldProps {
  label: string;
  help?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  onChange: (next: number) => void;
  onReset?: () => void;
}

function SliderField({ label, help, value, min, max, step, unit, disabled, onChange, onReset }: SliderFieldProps): JSX.Element {
  return (
    <div className={`slider-field ${disabled ? 'disabled' : ''}`}>
      <div className="slider-field-head">
        <label>{label}</label>
        {onReset && (
          <button
            type="button"
            className="slider-reset"
            onClick={onReset}
            disabled={disabled}
          >
            Reset
          </button>
        )}
      </div>
      {help && <div className="slider-field-help">{help}</div>}
      <div className="slider-field-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="field-value mono">
          {Math.round(value)}
          {unit && <span className="field-unit">{unit}</span>}
        </span>
      </div>
    </div>
  );
}

function CamIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M22 8l-6 4 6 4V8z" />
    </svg>
  );
}

function CamGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M22 8l-6 4 6 4V8z" />
    </svg>
  );
}

function ShapeIcon({ shape }: { shape: CameraShape }): JSX.Element {
  if (shape === 'circle') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="8" />
      </svg>
    );
  }
  if (shape === 'card') {
    return (
      <svg width="16" height="14" viewBox="0 0 28 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="6" width="22" height="12" rx="3" />
      </svg>
    );
  }
  return (
    <svg width="16" height="12" viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="8" width="26" height="9" rx="4.5" />
    </svg>
  );
}
