import React from 'react';

export const CAMERA_POSITIONS = [
  ['top-left',     'top-center',    'top-right'],
  ['middle-left',  null,            'middle-right'],
  ['bottom-left',  'bottom-center', 'bottom-right']
];

export const DEFAULT_CAMERA_OPTIONS = {
  hide: false,
  position: 'bottom-right',
  mirror: false,
  roundness: 100,
  size: 20,
  zoomDifferent: true,
  sizeDuringZoom: 12
};

export default function CameraPanel({ value, onChange, available = true }) {
  const opts = { ...DEFAULT_CAMERA_OPTIONS, ...(value || {}) };

  const update = (patch) => onChange({ ...opts, ...patch });

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
        <PositionGrid
          value={opts.position}
          onChange={(p) => update({ position: p })}
          disabled={opts.hide}
        />
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

      <div className="panel-section">
        <SliderField
          label="Roundness"
          value={opts.roundness}
          min={0}
          max={100}
          step={1}
          disabled={opts.hide}
          onChange={(v) => update({ roundness: v })}
          onReset={() => update({ roundness: DEFAULT_CAMERA_OPTIONS.roundness })}
        />
      </div>

      <div className="panel-section">
        <SliderField
          label="Size"
          help="Size of camera when recording is not zoomed in"
          value={opts.size}
          min={5}
          max={40}
          step={1}
          disabled={opts.hide}
          onChange={(v) => update({ size: v })}
          onReset={() => update({ size: DEFAULT_CAMERA_OPTIONS.size })}
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
          <SliderField
            label="Size during zoom"
            value={opts.sizeDuringZoom}
            min={5}
            max={Math.max(5, opts.size)}
            step={1}
            onChange={(v) => update({ sizeDuringZoom: v })}
            onReset={() => update({ sizeDuringZoom: DEFAULT_CAMERA_OPTIONS.sizeDuringZoom })}
          />
        )}
      </div>
    </div>
  );
}

function ToggleRow({ label, help, checked, onChange, disabled }) {
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

function PositionGrid({ value, onChange, disabled }) {
  return (
    <div className={`position-grid ${disabled ? 'disabled' : ''}`}>
      {CAMERA_POSITIONS.map((row, ri) =>
        row.map((cell, ci) => {
          if (cell == null) return <div key={`${ri}-${ci}`} className="position-cell empty" />;
          const active = value === cell;
          return (
            <button
              key={cell}
              type="button"
              className={`position-cell ${active ? 'active' : ''}`}
              onClick={() => !disabled && onChange(cell)}
              aria-label={cell}
              aria-pressed={active}
              disabled={disabled}
            >
              <span className="position-dot" />
            </button>
          );
        })
      )}
    </div>
  );
}

function SliderField({ label, help, value, min, max, step, disabled, onChange, onReset }) {
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
        <span className="field-value">{Math.round(value)}</span>
      </div>
    </div>
  );
}

function CamIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M22 8l-6 4 6 4V8z" />
    </svg>
  );
}
