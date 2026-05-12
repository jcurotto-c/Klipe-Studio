import type { MobileFinish, MobileOptions, MobilePosition } from '../../types';

export const MOBILE_POSITIONS: ReadonlyArray<ReadonlyArray<MobilePosition | null>> = [
  ['top-left',     'top-center',    'top-right'],
  ['middle-left',  null,            'middle-right'],
  ['bottom-left',  'bottom-center', 'bottom-right'],
];

export const DEFAULT_MOBILE_OPTIONS: MobileOptions = {
  hide: false,
  position: 'bottom-left',
  size: 18,
  sizeDuringZoom: 11,
  zoomDifferent: true,
  tilt: 0,
  showIsland: true,
  finish: 'graphite',
};

const FINISH_SWATCHES: ReadonlyArray<{ id: MobileFinish; label: string; color: string }> = [
  { id: 'graphite', label: 'Graphite', color: '#26282e' },
  { id: 'silver',   label: 'Silver',   color: '#cfd4dc' },
  { id: 'gold',     label: 'Gold',     color: '#dcbf8c' },
  { id: 'black',    label: 'Black',    color: '#0a0a0c' },
];

interface MobilePanelProps {
  value: MobileOptions | null | undefined;
  onChange: (next: MobileOptions) => void;
  available?: boolean;
}

export default function MobilePanel({ value, onChange, available = true }: MobilePanelProps): JSX.Element {
  const opts: MobileOptions = { ...DEFAULT_MOBILE_OPTIONS, ...(value ?? {}) };
  const update = (patch: Partial<MobileOptions>): void => onChange({ ...opts, ...patch });

  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-label">
          <PhonePanelIcon /> Phone
        </div>
        {!available && (
          <div className="panel-empty">
            No phone clip in this recording. Connect a phone from the floating
            toolbar before recording to add one. Settings here still persist
            for the next session.
          </div>
        )}
      </div>

      <div className="panel-section">
        <ToggleRow
          label="Hide phone"
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
        <SliderField
          label="Size"
          help="Phone width as % of the canvas. Aspect ratio is locked to 19.5:9."
          value={opts.size}
          min={5}
          max={35}
          step={1}
          disabled={opts.hide}
          onChange={(v) => update({ size: v })}
          onReset={() => update({ size: DEFAULT_MOBILE_OPTIONS.size })}
        />
      </div>

      <div className="panel-section">
        <SliderField
          label="Tilt"
          help="Subtle rotation. Side buttons are skipped at non-zero tilt to avoid odd intersections."
          value={opts.tilt}
          min={-10}
          max={10}
          step={1}
          disabled={opts.hide}
          onChange={(v) => update({ tilt: v })}
          onReset={() => update({ tilt: DEFAULT_MOBILE_OPTIONS.tilt })}
        />
      </div>

      <div className="panel-divider" />

      <div className="panel-section">
        <ToggleRow
          label="Show dynamic island"
          help="Modern iPhone pill camera/sensor cutout. Off draws a classic notch instead."
          checked={opts.showIsland}
          onChange={(v) => update({ showIsland: v })}
          disabled={opts.hide}
        />
      </div>

      <div className="panel-section">
        <div className="panel-sublabel">Finish</div>
        <div className={`mobile-finish-row ${opts.hide ? 'disabled' : ''}`}>
          {FINISH_SWATCHES.map((f) => {
            const active = opts.finish === f.id;
            return (
              <button
                key={f.id}
                type="button"
                className={`mobile-finish-swatch ${active ? 'active' : ''}`}
                onClick={() => !opts.hide && update({ finish: f.id })}
                aria-pressed={active}
                aria-label={f.label}
                title={f.label}
                disabled={opts.hide}
              >
                <span className="mobile-finish-dot" style={{ background: f.color }} />
                <span className="mobile-finish-label">{f.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="panel-divider" />

      <div className="panel-section">
        <div className="panel-sublabel">Phone during zoom</div>
        <ToggleRow
          label="Different size during zoom"
          help="Shrink the phone overlay when a zoom segment is active so it doesn't cover the recording."
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
            onReset={() => update({ sizeDuringZoom: DEFAULT_MOBILE_OPTIONS.sizeDuringZoom })}
          />
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

interface PositionGridProps {
  value: MobilePosition;
  onChange: (next: MobilePosition) => void;
  disabled?: boolean;
}

function PositionGrid({ value, onChange, disabled }: PositionGridProps): JSX.Element {
  return (
    <div className={`position-grid ${disabled ? 'disabled' : ''}`}>
      {MOBILE_POSITIONS.map((row, ri) =>
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
        }),
      )}
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
  disabled?: boolean;
  onChange: (next: number) => void;
  onReset?: () => void;
}

function SliderField({ label, help, value, min, max, step, disabled, onChange, onReset }: SliderFieldProps): JSX.Element {
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

function PhonePanelIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </svg>
  );
}
