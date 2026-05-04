import { useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react';
import { WALLPAPER_PRESETS } from '../../lib/renderer';
import type { Background } from '../../types';

type BgTab = 'wallpaper' | 'gradient' | 'color' | 'image';

const TABS: ReadonlyArray<{ id: BgTab; label: string }> = [
  { id: 'wallpaper', label: 'Wallpaper' },
  { id: 'gradient',  label: 'Gradient' },
  { id: 'color',     label: 'Color' },
  { id: 'image',     label: 'Image' },
];

function tabFromValue(bg: Background | null | undefined): BgTab {
  if (!bg) return 'wallpaper';
  if (TABS.some((t) => t.id === bg.type)) return bg.type;
  return 'wallpaper';
}

interface BackgroundPanelProps {
  value: Background | null | undefined;
  onChange: (next: Background) => void;
}

export default function BackgroundPanel({ value, onChange }: BackgroundPanelProps): JSX.Element {
  const [tab, setTab] = useState<BgTab>(() => tabFromValue(value));
  const blur = (value && 'blur' in value && value.blur) || 0;

  const update = (patch: Partial<Background> & { type?: BgTab }): void => {
    const merged = { ...(value ?? {}), ...patch } as Background;
    onChange(merged);
  };

  const switchTab = (id: BgTab): void => {
    setTab(id);
    if (id === 'wallpaper') {
      const v = value && value.type === 'wallpaper' ? value.value : 'default';
      onChange({ type: 'wallpaper', value: v, blur });
    }
    if (id === 'gradient') {
      const from = value && value.type === 'gradient' ? value.from : '#7c5cff';
      const to = value && value.type === 'gradient' ? value.to : '#5cc4ff';
      const angle = value && value.type === 'gradient' && value.angle != null ? value.angle : 135;
      onChange({ type: 'gradient', from, to, angle, blur });
    }
    if (id === 'color') {
      const v = value && value.type === 'color' ? value.value : '#7c5cff';
      onChange({ type: 'color', value: v, blur });
    }
    if (id === 'image') {
      const src = value && value.type === 'image' ? value.src : null;
      onChange({ type: 'image', src, blur });
    }
  };

  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-label">
          <BgIcon /> Background
        </div>
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => switchTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'wallpaper' && <WallpaperTab value={value} update={update} />}
      {tab === 'gradient' && <GradientTab value={value} update={update} />}
      {tab === 'color' && <ColorTab value={value} update={update} />}
      {tab === 'image' && <ImageTab value={value} update={update} />}

      <div className="panel-section">
        <div className="panel-label">
          <BlurIcon /> Background blur
        </div>
        <input
          type="range"
          min={0}
          max={40}
          step={1}
          value={blur}
          onChange={(e) => update({ blur: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}

interface SubTabProps {
  value: Background | null | undefined;
  update: (patch: Partial<Background> & { type?: BgTab }) => void;
}

function WallpaperTab({ value, update }: SubTabProps): JSX.Element {
  const active = value && value.type === 'wallpaper' ? value.value : 'default';
  return (
    <div className="panel-section">
      <div className="panel-sublabel">Presets</div>
      <div className="wallpaper-grid">
        {Object.entries(WALLPAPER_PRESETS).map(([key, p]) => (
          <button
            key={key}
            className={`wallpaper-swatch ${active === key ? 'active' : ''}`}
            style={{ background: `linear-gradient(135deg, ${p.from}, ${p.to})` }}
            onClick={() => update({ type: 'wallpaper', value: key })}
            title={key}
          />
        ))}
      </div>
    </div>
  );
}

function GradientTab({ value, update }: SubTabProps): JSX.Element {
  const from = value && value.type === 'gradient' ? value.from : '#7c5cff';
  const to = value && value.type === 'gradient' ? value.to : '#5cc4ff';
  const angle = value && value.type === 'gradient' && value.angle != null ? value.angle : 135;
  return (
    <div className="panel-section">
      <div className="panel-sublabel">Gradient</div>
      <div
        className="gradient-preview"
        style={{ background: `linear-gradient(${angle}deg, ${from}, ${to})` }}
      />
      <div className="field-row">
        <label>From</label>
        <input type="color" value={from} onChange={(e) => update({ type: 'gradient', from: e.target.value, to, angle })} />
      </div>
      <div className="field-row">
        <label>To</label>
        <input type="color" value={to} onChange={(e) => update({ type: 'gradient', from, to: e.target.value, angle })} />
      </div>
      <div className="field-row">
        <label>Angle</label>
        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={angle}
          onChange={(e) => update({ type: 'gradient', from, to, angle: Number(e.target.value) })}
        />
        <span className="field-value">{angle}°</span>
      </div>
    </div>
  );
}

function ColorTab({ value, update }: SubTabProps): JSX.Element {
  const color = value && value.type === 'color' ? value.value : '#7c5cff';
  return (
    <div className="panel-section">
      <div className="panel-sublabel">Color</div>
      <div className="field-row">
        <input
          type="color"
          value={color}
          onChange={(e) => update({ type: 'color', value: e.target.value })}
        />
        <input
          type="text"
          className="hex-input"
          value={color}
          onChange={(e) => update({ type: 'color', value: e.target.value })}
        />
      </div>
    </div>
  );
}

function ImageTab({ value, update }: SubTabProps): JSX.Element {
  const src = value && value.type === 'image' ? value.src : null;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const readFile = (file: File | null | undefined): void => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') update({ type: 'image', src: result });
    };
    reader.readAsDataURL(file);
  };

  const onPick = (): void => inputRef.current?.click();
  const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    readFile(file);
    e.target.value = '';
  };
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    const file = Array.from(e.dataTransfer.files || []).find((f) => f.type.startsWith('image/'));
    readFile(file);
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>): void => {
    const file = Array.from(e.clipboardData?.files || []).find((f) => f.type.startsWith('image/'));
    if (file) readFile(file);
  };

  return (
    <div className="panel-section">
      <div className="panel-sublabel">Background image</div>
      <div
        className={`image-dropzone ${dragging ? 'dragging' : ''} ${src ? 'has-image' : ''}`}
        onClick={onPick}
        onPaste={onPaste}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        tabIndex={0}
        style={src ? { backgroundImage: `url(${src})` } : undefined}
      >
        {!src && (
          <div className="dropzone-hint">
            <PhotoIcon />
            <span>Click to select, drop image, or paste while focused.</span>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={onChange}
        />
      </div>
      {src && (
        <button className="ghost panel-btn" onClick={() => update({ type: 'image', src: null })}>
          Remove image
        </button>
      )}
    </div>
  );
}

function BgIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="1.5" fill="currentColor" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}
function BlurIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}
function PhotoIcon(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="M21 17l-5-5-9 9" />
    </svg>
  );
}
