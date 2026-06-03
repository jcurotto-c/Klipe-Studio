import { useState } from 'react';
import { FONT_OPTIONS, fontStackById, resolveFontId } from '../../overlays/fonts';
import type { Caption, CaptionStyle } from '../../overlays/captions';
import type { CaptionProgress } from '../../lib/transcription';

const FONT_CATEGORIES = [
  { id: 'sans', label: 'Sans' },
  { id: 'display', label: 'Display' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Mono' },
] as const;

const WEIGHTS = [
  { v: 400, l: 'Regular' },
  { v: 500, l: 'Medium' },
  { v: 600, l: 'Semibold' },
  { v: 700, l: 'Bold' },
  { v: 800, l: 'Extrabold' },
  { v: 900, l: 'Black' },
];

const LANGUAGES = [
  { code: '', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'ja', label: 'Japanese' },
];

const DEFAULT_BOX = { color: '#000000', opacity: 0.55, padRel: 0.35 };
const DEFAULT_OUTLINE = { color: '#000000', width: 4 };

interface CaptionPanelProps {
  captions: Caption[];
  style: CaptionStyle;
  selectedCaptionId: string | null;
  onAddCaption: () => void;
  onUpdateCaption: (id: string, patch: Partial<Caption>) => void;
  onRemoveCaption: (id: string) => void;
  onChangeStyle: (patch: Partial<CaptionStyle>) => void;
  onSelectCaption: (id: string | null) => void;
  onGenerate: (opts: { language?: string; mode: 'replace' | 'append'; onProgress?: (p: CaptionProgress) => void }) => Promise<{ ok: boolean; count?: number; error?: string }>;
  hasAudio: boolean;
  transcribing: boolean;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'downloading'; pct?: number }
  | { kind: 'transcribing' }
  | { kind: 'success'; msg: string }
  | { kind: 'error'; msg: string };

export default function CaptionPanel({
  captions,
  style,
  selectedCaptionId,
  onAddCaption,
  onUpdateCaption,
  onRemoveCaption,
  onChangeStyle,
  onSelectCaption,
  onGenerate,
  hasAudio,
  transcribing,
}: CaptionPanelProps): JSX.Element {
  const [language, setLanguage] = useState('');
  const [mode, setMode] = useState<'replace' | 'append'>('replace');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const generate = async (): Promise<void> => {
    setStatus({ kind: 'transcribing' });
    const res = await onGenerate({
      language: language || undefined,
      mode,
      onProgress: (p) => {
        if (p.stage === 'download') setStatus({ kind: 'downloading', pct: p.progress != null ? Math.round(p.progress * 100) : undefined });
        else setStatus({ kind: 'transcribing' });
      },
    });
    if (res.ok) setStatus({ kind: 'success', msg: `${res.count ?? 0} caption${res.count === 1 ? '' : 's'} generated` });
    else setStatus({ kind: 'error', msg: res.error ?? 'Transcription failed.' });
  };

  const fontId = resolveFontId(style.fontFamily);
  const canGenerate = hasAudio && !transcribing;

  const buttonLabel = status.kind === 'downloading'
    ? `Downloading model… ${status.pct != null ? `${status.pct}%` : ''}`
    : transcribing || status.kind === 'transcribing'
      ? 'Transcribing…'
      : 'Generate captions';

  return (
    <div className="panel caption-panel">
      {/* ── Auto-transcription (local, on-device) ──────────────────────── */}
      <div className="panel-section">
        <div className="panel-label">AUTO-CAPTIONS</div>

        <div className="grad-row">
          <label>Language</label>
          <select
            className="export-select"
            style={{ flex: 1 }}
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            disabled={transcribing}
          >
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>

        {captions.length > 0 && (
          <div className="grad-row">
            <label>On generate</label>
            <div className="seg-tabs" style={{ flex: 1 }}>
              <button className={`seg-tab ${mode === 'replace' ? 'active' : ''}`} onClick={() => setMode('replace')} disabled={transcribing}>Replace</button>
              <button className={`seg-tab ${mode === 'append' ? 'active' : ''}`} onClick={() => setMode('append')} disabled={transcribing}>Append</button>
            </div>
          </div>
        )}

        <button
          type="button"
          className="primary-btn full"
          disabled={!canGenerate}
          onClick={() => void generate()}
        >
          {buttonLabel}
        </button>
        {!hasAudio && <div className="panel-hint">This recording has no audio to transcribe.</div>}
        {hasAudio && status.kind === 'idle' && (
          <div className="panel-hint">Runs on-device. The speech model (~290 MB) downloads once, then works offline.</div>
        )}
        {status.kind === 'downloading' && <div className="panel-hint">Downloading the speech model (one-time)…</div>}
        {status.kind === 'transcribing' && <div className="panel-hint">Recognising speech on-device…</div>}
        {status.kind === 'error' && <div className="panel-hint error">{status.msg}</div>}
        {status.kind === 'success' && <div className="panel-hint ok">{status.msg}</div>}
      </div>

      {/* ── Shared style ───────────────────────────────────────────────── */}
      <div className="panel-section">
        <div className="panel-label">STYLE</div>

        <div className="grad-row">
          <label>Font</label>
          <select
            className="export-select"
            style={{ flex: 1, fontFamily: fontStackById(fontId) }}
            value={fontId}
            onChange={(e) => onChangeStyle({ fontFamily: e.target.value })}
          >
            {FONT_CATEGORIES.map((cat) => (
              <optgroup key={cat.id} label={cat.label}>
                {FONT_OPTIONS.filter((f) => f.category === cat.id).map((f) => (
                  <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>{f.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="grad-row">
          <label>Weight</label>
          <select
            className="export-select"
            style={{ flex: 1 }}
            value={style.weight ?? 700}
            onChange={(e) => onChangeStyle({ weight: Number(e.target.value) })}
          >
            {WEIGHTS.map((w) => <option key={w.v} value={w.v}>{w.l}</option>)}
          </select>
          <input
            type="color"
            value={style.color}
            onChange={(e) => onChangeStyle({ color: e.target.value })}
            title="Text color"
          />
        </div>

        <div className="grad-row">
          <label>Align</label>
          <div className="seg-tabs three" style={{ flex: 1 }}>
            {(['left', 'center', 'right'] as const).map((a) => (
              <button
                key={a}
                className={`seg-tab ${style.align === a ? 'active' : ''}`}
                onClick={() => onChangeStyle({ align: a })}
                title={`Align ${a}`}
              >
                {a === 'left' ? 'L' : a === 'center' ? 'C' : 'R'}
              </button>
            ))}
          </div>
          <Toggle label="UPPER" checked={!!style.uppercase} onChange={(v) => onChangeStyle({ uppercase: v })} />
        </div>

        <Slider label="Size" value={style.sizeRel} min={0.025} max={0.1} step={0.005}
          format={(v) => `${Math.round(v * 1000) / 10}%`} onChange={(v) => onChangeStyle({ sizeRel: v })} />
        <Slider label="Bottom offset" value={style.bottomOffsetRel} min={0.02} max={0.35} step={0.01}
          format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onChangeStyle({ bottomOffsetRel: v })} />
        <Slider label="Max width" value={style.maxWidthRel} min={0.4} max={0.95} step={0.05}
          format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onChangeStyle({ maxWidthRel: v })} />

        <div className="grad-row">
          <label>Shadow</label>
          <Toggle label="" checked={style.shadow ?? true} onChange={(v) => onChangeStyle({ shadow: v })} />
        </div>

        <div className="grad-row">
          <label>Outline</label>
          <Toggle label="" checked={!!style.outline} onChange={(v) => onChangeStyle({ outline: v ? { ...DEFAULT_OUTLINE } : null })} />
          {style.outline && (
            <input
              className="swatch"
              type="color"
              value={style.outline.color}
              onChange={(e) => onChangeStyle({ outline: { ...DEFAULT_OUTLINE, ...style.outline, color: e.target.value } })}
              title="Outline color"
            />
          )}
        </div>

        <div className="grad-row">
          <label>Background</label>
          <Toggle label="" checked={!!style.box} onChange={(v) => onChangeStyle({ box: v ? { ...DEFAULT_BOX } : null })} />
          {style.box && (
            <input
              className="swatch"
              type="color"
              value={style.box.color}
              onChange={(e) => onChangeStyle({ box: { ...DEFAULT_BOX, ...style.box, color: e.target.value } })}
              title="Background color"
            />
          )}
        </div>
        {style.box && (
          <Slider label="BG opacity" value={style.box.opacity} min={0} max={1} step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => onChangeStyle({ box: { ...DEFAULT_BOX, ...style.box, opacity: v } })} />
        )}
      </div>

      {/* ── Caption list ───────────────────────────────────────────────── */}
      <div className="panel-section">
        <div className="caption-list-head">
          <span className="panel-label" style={{ margin: 0 }}>CAPTIONS ({captions.length})</span>
          <button type="button" className="link-btn" onClick={onAddCaption}>+ Add</button>
        </div>

        {captions.length === 0 ? (
          <div className="panel-empty">No captions yet. Generate them from audio or add one manually.</div>
        ) : (
          <div className="caption-list">
            {captions.map((cap) => (
              <CaptionRow
                key={cap.id}
                cap={cap}
                selected={cap.id === selectedCaptionId}
                onSelect={() => onSelectCaption(cap.id)}
                onUpdate={(patch) => onUpdateCaption(cap.id, patch)}
                onRemove={() => onRemoveCaption(cap.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface CaptionRowProps {
  cap: Caption;
  selected: boolean;
  onSelect: () => void;
  onUpdate: (patch: Partial<Caption>) => void;
  onRemove: () => void;
}

function CaptionRow({ cap, selected, onSelect, onUpdate, onRemove }: CaptionRowProps): JSX.Element {
  const stop = (e: React.MouseEvent): void => e.stopPropagation();
  return (
    <div className={`caption-row ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <input
        type="text"
        className="hex-input caption-text"
        value={cap.text}
        placeholder="Caption…"
        onMouseDown={stop}
        onChange={(e) => onUpdate({ text: e.target.value })}
      />
      <div className="caption-times" onMouseDown={stop}>
        <input
          type="number" step={0.1} min={0}
          className="hex-input caption-time"
          value={(cap.startMs / 1000).toFixed(1)}
          onChange={(e) => {
            const startMs = Math.max(0, Math.round(Number(e.target.value) * 1000));
            onUpdate({ startMs, endMs: Math.max(startMs + 200, cap.endMs) });
          }}
        />
        <span>→</span>
        <input
          type="number" step={0.1} min={0}
          className="hex-input caption-time"
          value={(cap.endMs / 1000).toFixed(1)}
          onChange={(e) => {
            const endMs = Math.round(Number(e.target.value) * 1000);
            onUpdate({ endMs: Math.max(cap.startMs + 200, endMs) });
          }}
        />
        <button className="link-action" onClick={(e) => { e.stopPropagation(); onRemove(); }} title="Remove caption">✕</button>
      </div>
    </div>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}

function Slider({ label, value, min, max, step, format, onChange }: SliderProps): JSX.Element {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="cursor-slider">
      <div className="cursor-slider-label">{label}</div>
      <div className="cursor-slider-track" style={{ '--fill': `${pct}%` } as React.CSSProperties}>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="cursor-slider-value">{format(value)}</span>
      </div>
    </div>
  );
}

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function Toggle({ label, checked, onChange }: ToggleProps): JSX.Element {
  return (
    <label className="toggle-inline" style={{ flex: 'none' }}>
      {label && <span className="toggle-inline-label">{label}</span>}
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
