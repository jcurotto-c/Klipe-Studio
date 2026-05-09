import { useMemo, useRef } from 'react';
import { DEFAULT_AUDIO_FX } from '../../lib/sound-fx';
import type {
  AudioFxMode,
  AudioFxOptions,
  BackgroundMusic,
  KlipeMouseEvent,
} from '../../types';

const DEFAULT_BG_MUSIC_VOLUME = 0.3;
const DEFAULT_BG_MUSIC_FADE_MS = 1200;

interface AudioPanelProps {
  value: AudioFxOptions | null | undefined;
  onChange: (next: AudioFxOptions) => void;
  backgroundMusic: BackgroundMusic | null;
  onBackgroundMusicChange: (next: BackgroundMusic | null) => void;
  events: ReadonlyArray<KlipeMouseEvent>;
}

const MODES: ReadonlyArray<{ id: AudioFxMode; label: string; help: string }> = [
  { id: 'auto', label: 'Auto', help: 'Play sounds when matching events were captured.' },
  { id: 'on',   label: 'On',   help: 'Always play the enabled sounds.' },
  { id: 'off',  label: 'Off',  help: 'Mute all generated sound effects.' },
];

export default function AudioPanel({
  value,
  onChange,
  backgroundMusic,
  onBackgroundMusicChange,
  events,
}: AudioPanelProps): JSX.Element {
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

      <BackgroundMusicSection
        value={backgroundMusic}
        onChange={onBackgroundMusicChange}
      />
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

interface BackgroundMusicSectionProps {
  value: BackgroundMusic | null;
  onChange: (next: BackgroundMusic | null) => void;
}

function BackgroundMusicSection({ value, onChange }: BackgroundMusicSectionProps): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handlePick = (): void => fileInputRef.current?.click();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const src = URL.createObjectURL(file);
    onChange({
      name: file.name,
      src,
      volume: value?.volume ?? DEFAULT_BG_MUSIC_VOLUME,
      fadeMs: value?.fadeMs ?? DEFAULT_BG_MUSIC_FADE_MS,
    });
  };

  const handleRemove = (): void => onChange(null);

  const handleVolume = (v: number): void => {
    if (!value) return;
    onChange({ ...value, volume: v });
  };

  return (
    <div className="section-card">
      <div className="section-head">
        <span className="section-title">Background Music</span>
        <span className={`pill ${value ? 'on' : 'off'}`}>{value ? 'Active' : 'None'}</span>
      </div>
      <div className="section-body">
        {value ? (
          <>
            <div className="toggle-row pro" title={value.name}>
              <span
                className="toggle-row-label-pro"
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '60%',
                }}
              >
                {value.name}
              </span>
              <button type="button" className="link-action" onClick={handleRemove}>
                Remove
              </button>
            </div>
            <VolumeRow
              label="Volume"
              value={value.volume}
              disabled={false}
              onChange={handleVolume}
            />
            <div className="audio-meta dim">Loops automatically · fades in/out on export</div>
          </>
        ) : (
          <>
            <button type="button" className="upload-btn" onClick={handlePick}>
              <UploadIcon />
              <span>Upload audio file</span>
            </button>
            <div className="audio-meta dim">MP3, WAV, OGG, M4A. Plays under the recording, looped.</div>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </div>
    </div>
  );
}

function UploadIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
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
