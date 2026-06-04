import { useEffect, useRef, useState } from 'react';
import type { MobileFinish, MobileOptions, MobilePosition } from '../../types';
import { MOBILE_DEVICES, getMobileDevice, type MobileDeviceSpec } from '../../lib/mobile-frame';

/** All nine cells are selectable — the phone defaults to dead-center. */
export const MOBILE_POSITIONS: ReadonlyArray<ReadonlyArray<MobilePosition>> = [
  ['top-left',     'top-center',    'top-right'],
  ['middle-left',  'middle-center', 'middle-right'],
  ['bottom-left',  'bottom-center', 'bottom-right'],
];

/** Current settings schema version. Bump when persisted semantics change. */
const MOBILE_OPTIONS_VERSION = 4;

export const DEFAULT_MOBILE_OPTIONS: MobileOptions = {
  hide: false,
  position: 'middle-center',
  size: 85,
  sizeDuringZoom: 11,
  zoomDifferent: true,
  tilt: 0,
  showIsland: true,
  device: 'iphone-island',
  finish: 'graphite',
  v: MOBILE_OPTIONS_VERSION,
};

/**
 * Bring persisted phone settings up to the current schema.
 *  - Pre-v2 recordings stored position/size values the renderer ignored (the
 *    phone was always centered + auto-fit), so those reset to the live defaults.
 *  - v4 introduced `device`; older recordings derive it from the legacy
 *    `showIsland` toggle (off → notch iPhone, on → Dynamic Island iPhone).
 */
export function migrateMobileOptions(
  raw: Partial<MobileOptions> | null | undefined,
): MobileOptions {
  const merged: MobileOptions = { ...DEFAULT_MOBILE_OPTIONS, ...(raw ?? {}) };
  if (!raw || (raw.v ?? 0) < 2) {
    merged.position = DEFAULT_MOBILE_OPTIONS.position;
    merged.size = DEFAULT_MOBILE_OPTIONS.size;
  }
  if (!raw?.device) {
    merged.device = raw?.showIsland === false ? 'iphone-notch' : 'iphone-island';
  }
  merged.v = MOBILE_OPTIONS_VERSION;
  return merged;
}

/** Size presets — phone height as % of canvas height. */
const SIZE_PRESETS: ReadonlyArray<{ key: string; value: number }> = [
  { key: 'S',  value: 55 },
  { key: 'M',  value: 70 },
  { key: 'L',  value: 85 },
  { key: 'XL', value: 100 },
];

const FINISH_SWATCHES: ReadonlyArray<{ id: MobileFinish; label: string; color: string }> = [
  { id: 'graphite', label: 'Graphite', color: '#26282e' },
  { id: 'silver',   label: 'Silver',   color: '#cfd4dc' },
  { id: 'gold',     label: 'Gold',     color: '#dcbf8c' },
  { id: 'black',    label: 'Black',    color: '#0a0a0c' },
];

// Stage geometry — mirrors the renderer so the miniature is WYSIWYG.
const STAGE_FALLBACK_ASPECT = 9 / 16;  // phone recordings default to portrait
const STAGE_PAD_RATIO = 0.025;   // matches MOBILE_PADDING_RATIO in renderer.ts
const STAGE_MIN_PAD = 6;
const STAGE_MAX_H = 280;         // cap so a portrait stage doesn't dominate the panel
const MOVE_MS = 380;
const MOVE_EASING = 'cubic-bezier(0.34, 1.4, 0.64, 1)';

interface MobilePanelProps {
  value: MobileOptions | null | undefined;
  onChange: (next: MobileOptions) => void;
  available?: boolean;
  /** Output aspect (width/height) so the position preview matches the export. */
  stageAspect?: number | null;
}

export default function MobilePanel({ value, onChange, available = true, stageAspect }: MobilePanelProps): JSX.Element {
  const opts: MobileOptions = { ...DEFAULT_MOBILE_OPTIONS, ...(value ?? {}) };
  const update = (patch: Partial<MobileOptions>): void => onChange({ ...opts, ...patch });

  // Light up the preset nearest the current size so the segmented control still
  // reflects state when the fine slider lands on an in-between value.
  const nearestSizeKey = SIZE_PRESETS.reduce((best, p) =>
    Math.abs(p.value - opts.size) < Math.abs(best.value - opts.size) ? p : best,
  ).key;

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
        <div className="panel-sublabel">Device</div>
        <div className={`mobile-device-row ${opts.hide ? 'disabled' : ''}`}>
          {Object.values(MOBILE_DEVICES).map((d) => {
            const active = opts.device === d.id;
            return (
              <button
                key={d.id}
                type="button"
                className={`mobile-device-btn ${active ? 'active' : ''}`}
                onClick={() => !opts.hide && update({ device: d.id })}
                aria-pressed={active}
                aria-label={d.label}
                title={d.label}
                disabled={opts.hide}
              >
                <DeviceGlyph spec={d} />
                <span className="mobile-device-label">{d.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="panel-divider" />

      <div className="panel-section">
        <div className="panel-sublabel">Position</div>
        <PhonePositionStage
          position={opts.position}
          sizePct={opts.size}
          aspect={stageAspect}
          device={getMobileDevice(opts.device)}
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
            help="Phone height as % of the canvas. Aspect ratio follows the selected device."
            value={opts.size}
            min={40}
            max={100}
            step={1}
            unit="%"
            disabled={opts.hide}
            onChange={(v) => update({ size: v })}
            onReset={() => update({ size: DEFAULT_MOBILE_OPTIONS.size })}
          />
        </div>
      </div>

      <div className="panel-divider" />

      <div className="panel-section">
        <div className="cam-fine">
          <SliderField
            label="Tilt"
            help="Subtle rotation. Side buttons are skipped at non-zero tilt to avoid odd intersections."
            value={opts.tilt}
            min={-10}
            max={10}
            step={1}
            unit="°"
            disabled={opts.hide}
            onChange={(v) => update({ tilt: v })}
            onReset={() => update({ tilt: DEFAULT_MOBILE_OPTIONS.tilt })}
          />
        </div>
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
        <div className="panel-empty">
          Tip: add a zoom segment on the timeline to push the camera into the
          phone screen — the zoom focuses on the spot you set.
        </div>
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

interface PhonePositionStageProps {
  position: MobilePosition;
  sizePct: number;
  aspect?: number | null;
  /** Selected phone model — drives the chip's aspect + corner radius. */
  device: MobileDeviceSpec;
  disabled?: boolean;
  onChange: (next: MobilePosition) => void;
}

/**
 * Miniature of the recording canvas with the phone chip living inside it.
 * Clicking a zone springs the chip to that slot; hovering shows a dotted ghost
 * of where it would land. The stage matches the output aspect, and the chip's
 * footprint (height-driven, device aspect, width-clamped) tracks the Size
 * control 1:1 with the renderer's phone-primary layout, so it's a true preview.
 */
function PhonePositionStage({ position, sizePct, aspect, device, disabled, onChange }: PhonePositionStageProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(0);
  const [hover, setHover] = useState<MobilePosition | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw) setWrapW(cw);
    });
    ro.observe(el);
    setWrapW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Stage box: fill the panel width at the output aspect, but cap the height so
  // a portrait (9:16) canvas doesn't produce an absurdly tall preview.
  const ar = aspect && aspect > 0 ? aspect : STAGE_FALLBACK_ASPECT; // width/height
  let stageW = wrapW;
  let stageH = wrapW / ar;
  if (stageH > STAGE_MAX_H) {
    stageH = STAGE_MAX_H;
    stageW = STAGE_MAX_H * ar;
  }

  const pad = Math.max(STAGE_MIN_PAD, stageW * STAGE_PAD_RATIO);
  // Mirror the renderer: height drives the footprint (% of canvas height), width
  // follows the device aspect, with a width safety clamp for ultra-narrow stages.
  let elemH = (sizePct / 100) * stageH;
  let elemW = elemH / device.aspect;
  if (elemW > stageW * 0.98) {
    elemW = stageW * 0.98;
    elemH = elemW * device.aspect;
  }
  const radius = elemW * device.radiusRatio;

  // Mirror renderer.ts mobileSlot(): anchor to the relevant edge, or center.
  const slot = (p: MobilePosition): { x: number; y: number } => {
    const [v, h] = p.split('-');
    const x = h === 'left' ? pad : h === 'right' ? stageW - elemW - pad : (stageW - elemW) / 2;
    const y = v === 'top' ? pad : v === 'bottom' ? stageH - elemH - pad : (stageH - elemH) / 2;
    return { x, y };
  };

  const measured = stageW > 0;
  const cur = measured ? slot(position) : { x: 0, y: 0 };
  const ghostActive = !disabled && hover != null && hover !== position;
  const ghostXY = measured ? slot(ghostActive ? (hover as MobilePosition) : position) : { x: 0, y: 0 };

  return (
    <div ref={wrapRef} className="phone-stage-wrap">
    <div
      className={`cam-stage ${disabled ? 'disabled' : ''}`}
      style={{ width: stageW || undefined, height: stageH || undefined }}
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
            className="cam-stage-cam phone"
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
            <PhoneGlyph />
          </div>
        </>
      )}

      <div className="cam-stage-zones">
        {MOBILE_POSITIONS.map((row) =>
          row.map((cell) => {
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

function PhonePanelIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </svg>
  );
}

function PhoneGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </svg>
  );
}

/**
 * Miniature silhouette of a device for the picker — a true preview using the
 * model's own aspect, corner radius and camera cutout so the three options read
 * as visibly different chassis.
 */
function DeviceGlyph({ spec }: { spec: MobileDeviceSpec }): JSX.Element {
  const H = 34;
  const W = Math.round(H / spec.aspect);
  const radius = W * spec.radiusRatio;
  return (
    <span
      className="device-glyph"
      style={{ width: W, height: H, borderRadius: radius }}
      aria-hidden
    >
      <span className={`device-cutout ${spec.cutout}`} />
    </span>
  );
}
