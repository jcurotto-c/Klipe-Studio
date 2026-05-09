import { useMemo } from 'react';
import { DEFAULT_AUDIO_FX } from '../../lib/sound-fx';
import type { AudioFxMode, AudioFxOptions, KlipeMouseEvent } from '../../types';

interface AudioPanelProps {
  value: AudioFxOptions | null | undefined;
  onChange: (next: AudioFxOptions) => void;
  events: ReadonlyArray<KlipeMouseEvent>;
}

const MODES: ReadonlyArray<{ id: AudioFxMode; label: string; help: string }> = [
  { id: 'auto', label: 'Auto', help: 'Play sounds when matching events were captured.' },
  { id: 'on',   label: 'On',   help: 'Always play the enabled sounds.' },
  { id: 'off',  label: 'Off',  help: 'Mute all generated sound effects.' },
];

export default function AudioPanel({ value, onChange, events }: AudioPanelProps): JSX.Element {
  const opts: AudioFxOptions = { ...DEFAULT_AUDIO_FX, ...(value ?? {}) };
  const update = (patch: Partial<AudioFxOptions>): void => onChange({ ...opts, ...patch });
  const reset = (): void => onChange({ ...DEFAULT_AUDIO_FX });

  const counts = useMemo(() => {
    let clicks = 0;
    let keys = 0;
    for (const e of events) {
      if (e.type === 'click') clicks++;
      else if (e.type === 'key') keys++;
    }
    return { clicks, keys };
  }, [events]);

  const clicksAuto = opts.mode === 'auto';
  const clicksWillPlay = opts.mode === 'off'
    ? false
    : opts.clickEnabled && (opts.mode === 'on' || counts.clicks > 0);
  const keysWillPlay = opts.mode === 'off'
    ? false
    : opts.keyEnabled && (opts.mode === 'on' || counts.keys > 0);

  return (
    <div className="panel-pro audio-panel">
      <div className="section-card">
        <div className="section-head">
          <span className="section-title">Sound Effects</span>
          <button className="link-action" onClick={reset}>Reset</button>
        </div>

        <div className="section-body">
          <div className="audio-mode">
            <div className="seg-tabs three">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`seg-tab ${opts.mode === m.id ? 'active' : ''}`}
                  onClick={() => update({ mode: m.id })}
                  title={m.help}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="audio-mode-help">
              {MODES.find((m) => m.id === opts.mode)?.help}
            </div>
          </div>
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">
          <span className="section-title">Click Sound</span>
          <span className={`pill ${clicksWillPlay ? 'on' : 'off'}`}>
            {clicksWillPlay ? 'Active' : clicksAuto && counts.clicks === 0 ? 'No clicks' : 'Off'}
          </span>
        </div>
        <div className="section-body">
          <ToggleRow
            label="Play click sound"
            checked={opts.clickEnabled}
            onChange={(v) => update({ clickEnabled: v })}
          />
          <VolumeRow
            label="Volume"
            value={opts.clickVolume}
            disabled={!opts.clickEnabled || opts.mode === 'off'}
            onChange={(v) => update({ clickVolume: v })}
          />
          <div className="audio-meta dim">
            {counts.clicks} click{counts.clicks === 1 ? '' : 's'} detected
          </div>
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">
          <span className="section-title">Keyboard Sound</span>
          <span className={`pill ${keysWillPlay ? 'on' : 'off'}`}>
            {keysWillPlay ? 'Active' : clicksAuto && counts.keys === 0 ? 'No typing' : 'Off'}
          </span>
        </div>
        <div className="section-body">
          <ToggleRow
            label="Play typing sound"
            checked={opts.keyEnabled}
            onChange={(v) => update({ keyEnabled: v })}
          />
          <VolumeRow
            label="Volume"
            value={opts.keyVolume}
            disabled={!opts.keyEnabled || opts.mode === 'off'}
            onChange={(v) => update({ keyVolume: v })}
          />
          <div className="audio-meta dim">
            {counts.keys} keystroke{counts.keys === 1 ? '' : 's'} detected
          </div>
        </div>
      </div>
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function ToggleRow({ label, checked, onChange }: ToggleRowProps): JSX.Element {
  return (
    <div className="toggle-row pro">
      <span className="toggle-row-label-pro">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
    </div>
  );
}

interface VolumeRowProps {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
}

function VolumeRow({ label, value, disabled, onChange }: VolumeRowProps): JSX.Element {
  const pct = Math.round(value * 100);
  return (
    <div className={`cursor-slider ${disabled ? 'disabled' : ''}`}>
      <div className="cursor-slider-label">{label}</div>
      <div
        className="cursor-slider-track"
        style={{ ['--fill' as string]: `${pct}%` }}
      >
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="cursor-slider-value">{pct}%</span>
      </div>
    </div>
  );
}
