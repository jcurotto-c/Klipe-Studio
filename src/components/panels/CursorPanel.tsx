import { DEFAULT_CURSOR_OPTIONS } from '../../lib/cursor-engine';
import type { CursorMovement, CursorOptions, CursorStyle } from '../../types';

interface StyleTileDefinition {
  id: CursorStyle;
  render: () => JSX.Element;
}

interface MovementPreset {
  id: CursorMovement;
  label: string;
  /** Slider values the preset writes when selected (advanced sliders stay editable). */
  values: Pick<CursorOptions, 'movement' | 'smoothing' | 'motionBlur' | 'sway'>;
}

// smoothing 0.67 (SMOOTHING_ANCHOR) makes the spring-backed presets return
// their exact Screen Studio anchor; the slider then fine-tunes from there.
const MOVEMENT_PRESETS: MovementPreset[] = [
  { id: 'raw',      label: 'Raw',      values: { movement: 'raw',      smoothing: 0,    motionBlur: 0,    sway: 0 } },
  { id: 'smooth',   label: 'Smooth',   values: { movement: 'smooth',   smoothing: 0.67, motionBlur: 0.40, sway: 0.13 } },
  { id: 'glide',    label: 'Glide',    values: { movement: 'glide',    smoothing: 0.67, motionBlur: 0.80, sway: 0.30 } },
  { id: 'snappy',   label: 'Snappy',   values: { movement: 'snappy',   smoothing: 0.67, motionBlur: 0.50, sway: 0.18 } },
  { id: 'magnetic', label: 'Magnetic', values: { movement: 'magnetic', smoothing: 0.40, motionBlur: 0.30, sway: 0.10 } },
];

const STYLE_TILES: StyleTileDefinition[] = [
  { id: 'arrow',         render: ArrowTile },
  { id: 'arrow-outline', render: ArrowOutlineTile },
  { id: 'arrow-mini',    render: ArrowMiniTile },
  { id: 'dot',           render: DotTile },
  { id: 'figma',         render: FigmaTile },
];

interface CursorPanelProps {
  value: CursorOptions | null | undefined;
  onChange: (next: CursorOptions) => void;
}

export default function CursorPanel({ value, onChange }: CursorPanelProps): JSX.Element {
  const opts: CursorOptions = { ...DEFAULT_CURSOR_OPTIONS, ...(value ?? {}) };
  const update = (patch: Partial<CursorOptions>): void => onChange({ ...opts, ...patch });
  const reset = (): void => onChange({ ...DEFAULT_CURSOR_OPTIONS });

  return (
    <div className="panel cursor-panel">
      <div className="panel-section">
        <div className="cursor-head">
          <span className="cursor-head-title">CURSOR</span>
          <button type="button" className="link-btn" onClick={reset}>Reset</button>
          <div className="cursor-head-toggles">
            <ToggleInline
              label="Show Cursor"
              checked={opts.show}
              onChange={(v) => update({ show: v })}
            />
            <ToggleInline
              label="Loop cursor"
              checked={opts.loop}
              onChange={(v) => update({ loop: v })}
            />
          </div>
        </div>
      </div>

      <div className="panel-section">
        <div className="cursor-style-grid">
          {STYLE_TILES.slice(0, 4).map((t) => (
            <StyleTile
              key={t.id}
              active={opts.style === t.id}
              onClick={() => update({ style: t.id })}
            >
              {t.render()}
            </StyleTile>
          ))}
        </div>
        <div className="cursor-style-grid second">
          <StyleTile
            active={opts.style === 'figma'}
            onClick={() => update({ style: 'figma' })}
          >
            <FigmaTile />
          </StyleTile>
        </div>
      </div>

      <div className="panel-section">
        <div className="cursor-custom-head">
          <span className="cursor-custom-title">MOVEMENT</span>
          <span className="cursor-custom-hint">Presets tune the sliders below</span>
        </div>
        <div className="cursor-movement-grid">
          {MOVEMENT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`cursor-move-btn ${(opts.movement ?? 'smooth') === p.id ? 'active' : ''}`}
              onClick={() => update(p.values)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="panel-section cursor-sliders">
        <CursorSlider
          label="Cursor Size"
          value={opts.size}
          min={0.5} max={5} step={0.05}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => update({ size: v })}
        />
        <CursorSlider
          label="Cursor Smoothing"
          value={opts.smoothing}
          min={0} max={2} step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(v) => update({ smoothing: v })}
        />
        <CursorSlider
          label="Cursor Motion Blur"
          value={opts.motionBlur}
          min={0} max={2} step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => update({ motionBlur: v })}
        />
        <CursorSlider
          label="Cursor Click Bounce"
          value={opts.clickBounce}
          min={0} max={5} step={0.05}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => update({ clickBounce: v })}
        />
        <CursorSlider
          label="Bounce Speed"
          value={opts.bounceSpeed}
          min={60} max={800} step={10}
          format={(v) => `${Math.round(v)} ms`}
          onChange={(v) => update({ bounceSpeed: v })}
        />
        <CursorSlider
          label="Cursor Sway"
          value={opts.sway}
          min={0} max={1} step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => update({ sway: v })}
        />
      </div>
    </div>
  );
}

interface StyleTileProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function StyleTile({ active, onClick, children }: StyleTileProps): JSX.Element {
  return (
    <button
      type="button"
      className={`cursor-tile ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      <div className="cursor-tile-inner">{children}</div>
    </button>
  );
}

interface ToggleInlineProps {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function ToggleInline({ label, checked, onChange }: ToggleInlineProps): JSX.Element {
  return (
    <label className="toggle-inline">
      <span className="toggle-inline-label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`switch sm ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
    </label>
  );
}

interface CursorSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}

function CursorSlider({ label, value, min, max, step, format, onChange }: CursorSliderProps): JSX.Element {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="cursor-slider">
      <div className="cursor-slider-label">{label}</div>
      <div
        className="cursor-slider-track"
        style={{ '--fill': `${pct}%` }}
      >
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="cursor-slider-value">{format(value)}</span>
      </div>
    </div>
  );
}

function ArrowTile(): JSX.Element {
  return (
    <svg width="22" height="26" viewBox="0 0 22 26" fill="white" stroke="rgba(0,0,0,0.85)" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M3 2 L3 21 L8 17 L11 23 L14 22 L11 16 L18 16 Z" />
    </svg>
  );
}
function ArrowOutlineTile(): JSX.Element {
  return (
    <svg width="22" height="26" viewBox="0 0 22 26" fill="none" stroke="white" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M3 2 L3 21 L8 17 L11 23 L14 22 L11 16 L18 16 Z" />
    </svg>
  );
}
function ArrowMiniTile(): JSX.Element {
  return (
    <svg width="20" height="22" viewBox="0 0 20 22" fill="white" stroke="rgba(0,0,0,0.85)" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M4 3 L4 17 L8 14 L10 19 L13 18 L11 13 L16 13 Z" />
    </svg>
  );
}
function DotTile(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <circle cx="7" cy="7" r="6" fill="white" />
    </svg>
  );
}
function FigmaTile(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="white" stroke="rgba(0,0,0,0.85)" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M3 3 L19 11 L12 13 L9 19 Z" />
    </svg>
  );
}
