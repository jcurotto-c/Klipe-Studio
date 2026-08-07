import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react';
import { WALLPAPER_PRESETS, IMAGE_PRESETS, DEFAULT_FRAME_OPTIONS } from '../../lib/renderer';
import { resolveWindowChrome } from '../../lib/window-chrome';
import type {
  Background,
  BlurRegion,
  Crop,
  FrameOptions,
  WindowChromeOptions,
  WindowChromeStyle,
} from '../../types';

type BgTab = 'image' | 'video' | 'color' | 'gradient';

const CUSTOM_IMAGES_STORAGE_KEY = 'klipe.customImagePresets.v1';

interface CustomImagePreset {
  id: string;
  src: string;
  label: string;
}

interface CustomVideoPreset {
  id: string;
  src: string;
  label: string;
}

function loadCustomImages(): CustomImagePreset[] {
  try {
    const raw = localStorage.getItem(CUSTOM_IMAGES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is CustomImagePreset =>
        !!x && typeof x === 'object'
        && typeof (x as CustomImagePreset).id === 'string'
        && typeof (x as CustomImagePreset).src === 'string'
        && typeof (x as CustomImagePreset).label === 'string',
    );
  } catch {
    return [];
  }
}

function saveCustomImages(list: CustomImagePreset[]): void {
  try {
    localStorage.setItem(CUSTOM_IMAGES_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage may be unavailable; ignore */
  }
}

const TABS: ReadonlyArray<{ id: BgTab; label: string; disabled?: boolean }> = [
  { id: 'image',    label: 'Image' },
  { id: 'video',    label: 'Video' },
  { id: 'color',    label: 'Color' },
  { id: 'gradient', label: 'Gradient' },
];

const WINDOW_STYLES: ReadonlyArray<{ id: WindowChromeStyle; label: string }> = [
  { id: 'none',    label: 'None' },
  { id: 'macos',   label: 'macOS' },
  { id: 'browser', label: 'Browser' },
  { id: 'windows', label: 'Windows' },
];

function tabFromValue(bg: Background | null | undefined): BgTab {
  if (!bg) return 'color';
  if (bg.type === 'wallpaper') return 'color';
  if (bg.type === 'gradient') return 'gradient';
  if (bg.type === 'color') return 'color';
  if (bg.type === 'image') return 'image';
  if (bg.type === 'video') return 'video';
  return 'color';
}

interface BackgroundPanelProps {
  value: Background | null | undefined;
  onChange: (next: Background) => void;
  frame: FrameOptions;
  onFrameChange: (next: FrameOptions) => void;
  crop: Crop | null;
  onCropChange: (next: Crop | null) => void;
  blurRegions: BlurRegion[];
  blurMode: boolean;
  onBlurModeChange: (next: boolean) => void;
  selectedBlurId: string | null;
  onSelectBlur: (id: string | null) => void;
  onAddBlurAtPlayhead: () => void;
  onRemoveBlur: (id: string) => void;
}

export default function BackgroundPanel({
  value,
  onChange,
  frame,
  onFrameChange,
  crop,
  onCropChange,
  blurRegions,
  blurMode,
  onBlurModeChange,
  selectedBlurId,
  onSelectBlur,
  onAddBlurAtPlayhead,
  onRemoveBlur,
}: BackgroundPanelProps): JSX.Element {
  const [tab, setTab] = useState<BgTab>(() => tabFromValue(value));
  const [customImages, setCustomImages] = useState<CustomImagePreset[]>(() => loadCustomImages());
  // Uploaded videos are kept in-session only (not localStorage): a video data
  // URL is far larger than an image and would blow the storage quota. The
  // ACTIVE selection still persists via the project document; this gallery just
  // lets you flip between clips added this session.
  const [customVideos, setCustomVideos] = useState<CustomVideoPreset[]>([]);
  const blur = (value && 'blur' in value && value.blur) || 0;

  useEffect(() => {
    saveCustomImages(customImages);
  }, [customImages]);

  const addCustomImage = (src: string): CustomImagePreset => {
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const label = `Custom ${customImages.length + 1}`;
    const next: CustomImagePreset = { id, src, label };
    setCustomImages((prev) => [...prev, next]);
    return next;
  };

  const removeCustomImage = (id: string): void => {
    setCustomImages((prev) => prev.filter((c) => c.id !== id));
  };

  const addCustomVideo = (src: string): CustomVideoPreset => {
    const id = `vid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const label = `Video ${customVideos.length + 1}`;
    const next: CustomVideoPreset = { id, src, label };
    setCustomVideos((prev) => [...prev, next]);
    return next;
  };

  const removeCustomVideo = (id: string): void => {
    setCustomVideos((prev) => prev.filter((c) => c.id !== id));
  };

  const update = (patch: Partial<Background>): void => {
    const merged = { ...(value ?? {}), ...patch } as Background;
    onChange(merged);
  };

  const switchTab = (id: BgTab): void => {
    setTab(id);
    if (id === 'image') {
      if (value && value.type === 'image') return;
      const firstKey = Object.keys(IMAGE_PRESETS)[0];
      const src = firstKey ? IMAGE_PRESETS[firstKey]!.src : null;
      onChange({ type: 'image', src, blur });
    }
    if (id === 'video') {
      if (value && value.type === 'video') return;
      // No presets ship with the app — start empty so the tab shows its upload
      // prompt. Picking a file in VideoTab fills in the src.
      onChange({ type: 'video', src: null, blur });
    }
    if (id === 'gradient') {
      const from = value && value.type === 'gradient' ? value.from : '#ffffff';
      const to = value && value.type === 'gradient' ? value.to : '#d4d7dd';
      const angle = value && value.type === 'gradient' && value.angle != null ? value.angle : 135;
      onChange({ type: 'gradient', from, to, angle, blur });
    }
    if (id === 'color') {
      if (value && (value.type === 'color' || value.type === 'wallpaper')) return;
      onChange({ type: 'wallpaper', value: 'default', blur });
    }
  };

  const updateFrame = (patch: Partial<FrameOptions>): void => {
    onFrameChange({ ...frame, ...patch });
  };

  // Named `winChrome`, not `chrome`: the latter shadows the browser global.
  const winChrome = resolveWindowChrome(frame.window);
  // Always write a COMPLETE object: the merges downstream (renderer,
  // loadFrameOptions) are shallow and would not fill in missing members.
  const setChrome = (patch: Partial<WindowChromeOptions>): void => {
    updateFrame({ window: { ...winChrome, ...patch } });
  };

  const resetBackground = (): void => {
    onChange({ type: 'wallpaper', value: 'default', blur: 0 });
    setTab('color');
  };

  const resetFrame = (): void => {
    // DEFAULT_FRAME_OPTIONS carries no `window`, so this also clears the window
    // chrome and its title — intentional: the chrome lives in the Frame card.
    onFrameChange({ ...DEFAULT_FRAME_OPTIONS, removeBackground: frame.removeBackground });
  };

  const cropTop = crop ? Math.round(crop.y * 100) : 0;
  const cropBottom = crop ? Math.round((1 - crop.y - crop.height) * 100) : 0;
  const cropLeft = crop ? Math.round(crop.x * 100) : 0;
  const cropRight = crop ? Math.round((1 - crop.x - crop.width) * 100) : 0;

  const updateCrop = (next: Partial<{ top: number; bottom: number; left: number; right: number }>): void => {
    const t = Math.max(0, Math.min(95, next.top ?? cropTop));
    const b = Math.max(0, Math.min(95 - t, next.bottom ?? cropBottom));
    const l = Math.max(0, Math.min(95, next.left ?? cropLeft));
    const r = Math.max(0, Math.min(95 - l, next.right ?? cropRight));
    const x = l / 100;
    const y = t / 100;
    const width = Math.max(0.05, 1 - x - r / 100);
    const height = Math.max(0.05, 1 - y - b / 100);
    if (x === 0 && y === 0 && width >= 0.999 && height >= 0.999) {
      onCropChange(null);
    } else {
      onCropChange({ x, y, width, height });
    }
  };

  return (
    <div className="panel-pro">
      {/* BACKGROUND */}
      <SectionCard
        title="Background"
        action={<ResetBtn onClick={resetBackground} />}
      >
        <NumericRow
          label="Background Blur"
          value={blur}
          unit="px"
          min={0}
          max={40}
          step={0.1}
          onChange={(v) => update({ blur: v })}
        />

        <div className="seg-tabs four">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`seg-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => switchTab(t.id)}
              disabled={t.disabled}
            >
              {t.label}
              {t.disabled && <span className="soon">soon</span>}
            </button>
          ))}
        </div>

        {tab === 'image' && (
          <WallpaperImageTab
            value={value}
            update={update}
            customImages={customImages}
            onAddCustomImage={addCustomImage}
            onRemoveCustomImage={removeCustomImage}
          />
        )}
        {tab === 'video' && (
          <VideoTab
            value={value}
            update={update}
            customVideos={customVideos}
            onAddCustomVideo={addCustomVideo}
            onRemoveCustomVideo={removeCustomVideo}
          />
        )}
        {tab === 'gradient' && <GradientTab value={value} update={update} />}
        {tab === 'color' && <ColorTab value={value} update={update} />}
      </SectionCard>

      {/* FRAME */}
      <SectionCard
        title="Frame"
        action={<ResetBtn onClick={resetFrame} />}
      >
        <NumericRow
          label="Shadow"
          value={frame.shadow}
          unit="%"
          min={0}
          max={100}
          step={1}
          onChange={(v) => updateFrame({ shadow: v })}
        />
        <NumericRow
          label="Radius"
          value={frame.radius}
          unit="px"
          min={0}
          max={80}
          step={1}
          onChange={(v) => updateFrame({ radius: v })}
        />

        <div className="seg-tabs four" style={{ marginTop: 6 }}>
          {WINDOW_STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`seg-tab ${winChrome.style === s.id ? 'active' : ''}`}
              onClick={() => setChrome({ style: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>

        {winChrome.style !== 'none' && (
          <>
            <div className="grad-row">
              <label>Theme</label>
              <div className="seg-tabs" style={{ flex: 1 }}>
                {(['dark', 'light'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`seg-tab ${winChrome.theme === t ? 'active' : ''}`}
                    onClick={() => setChrome({ theme: t })}
                  >
                    {t === 'dark' ? 'Dark' : 'Light'}
                  </button>
                ))}
              </div>
            </div>
            {/* Browser has no title bar to put a title in — only an address
                field — so the control is hidden rather than left inert. */}
            {winChrome.style !== 'browser' && (
              <div className="grad-row">
                <label>Title</label>
                <input
                  type="text"
                  className="hex-input"
                  value={winChrome.title}
                  placeholder="Optional"
                  maxLength={80}
                  onChange={(e) => setChrome({ title: e.target.value })}
                />
              </div>
            )}
            {winChrome.style === 'browser' && (
              <div className="grad-row">
                <label>URL</label>
                <input
                  type="text"
                  className="hex-input"
                  value={winChrome.url ?? ''}
                  placeholder="example.com"
                  maxLength={120}
                  onChange={(e) => setChrome({ url: e.target.value })}
                />
              </div>
            )}
          </>
        )}
      </SectionCard>

      {/* PADDING */}
      <SectionCard
        title="Padding"
        action={<button className="link-action">Advanced</button>}
      >
        <NumericRow
          label=""
          value={frame.padding}
          unit="%"
          min={0}
          max={50}
          step={1}
          onChange={(v) => updateFrame({ padding: v })}
        />

        <ToggleRow
          label="Remove background"
          checked={frame.removeBackground}
          onChange={(v) => updateFrame({ removeBackground: v })}
        />
      </SectionCard>

      {/* CROP */}
      <SectionCard title="Crop">
        <NumericRow
          label="Top"
          value={cropTop}
          unit="%"
          min={0}
          max={95}
          step={1}
          onChange={(v) => updateCrop({ top: v })}
        />
        <NumericRow
          label="Bottom"
          value={cropBottom}
          unit="%"
          min={0}
          max={95}
          step={1}
          onChange={(v) => updateCrop({ bottom: v })}
        />
        <NumericRow
          label="Left"
          value={cropLeft}
          unit="%"
          min={0}
          max={95}
          step={1}
          onChange={(v) => updateCrop({ left: v })}
        />
        <NumericRow
          label="Right"
          value={cropRight}
          unit="%"
          min={0}
          max={95}
          step={1}
          onChange={(v) => updateCrop({ right: v })}
        />
      </SectionCard>

      {/* BLUR */}
      <SectionCard
        title="Blur & Redaction"
        action={
          <button className="link-action" onClick={onAddBlurAtPlayhead}>
            + Add region
          </button>
        }
      >
        <ToggleRow
          label="Blur mode"
          checked={blurMode}
          onChange={onBlurModeChange}
        />
        <div className="blur-region-list">
          {blurRegions.length === 0 ? (
            <div className="blur-region-empty">
              {blurMode
                ? 'Drag on the preview to draw a region, or click "+ Add region".'
                : 'Enable Blur mode, then draw a region on the preview.'}
            </div>
          ) : (
            blurRegions.map((r, i) => {
              const isSel = r.id === selectedBlurId;
              const startSec = (r.tStart / 1000).toFixed(1);
              const endSec = (r.tEnd / 1000).toFixed(1);
              const animated = r.keyframes.length > 1;
              return (
                <div
                  key={r.id}
                  className={`blur-region-row ${isSel ? 'is-selected' : ''}`}
                  onClick={() => onSelectBlur(isSel ? null : r.id)}
                >
                  <span className={`blur-region-dot shape-${r.shape}`} />
                  <span className="blur-region-name">
                    Region {i + 1}
                    {animated && <span className="blur-region-badge">anim</span>}
                  </span>
                  <span className="blur-region-meta">
                    {r.style} · {startSec}–{endSec}s
                  </span>
                  <button
                    type="button"
                    className="blur-region-remove"
                    title="Remove region"
                    aria-label={`Remove region ${i + 1}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveBlur(r.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })
          )}
        </div>
      </SectionCard>
    </div>
  );
}

interface SectionCardProps {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}

function SectionCard({ title, children, action }: SectionCardProps): JSX.Element {
  return (
    <div className="section-card">
      <div className="section-head">
        <span className="section-title">{title}</span>
        {action}
      </div>
      <div className="section-body">{children}</div>
    </div>
  );
}

function ResetBtn({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button className="link-action" onClick={onClick}>
      Reset
    </button>
  );
}

interface NumericRowProps {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
}

function NumericRow({ label, value, unit, min, max, step, onChange }: NumericRowProps): JSX.Element {
  const fillPct = ((value - min) / (max - min)) * 100;
  return (
    <div className="num-row">
      {label && <span className="num-row-label">{label}</span>}
      <div className="num-row-control" style={{ ['--fill' as string]: `${fillPct}%` }}>
        <span className="num-row-value">
          {step < 1 ? value.toFixed(1) : Math.round(value)}{unit}
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
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

interface SubTabProps {
  value: Background | null | undefined;
  update: (patch: Partial<Background>) => void;
}

interface WallpaperImageTabProps extends SubTabProps {
  customImages: CustomImagePreset[];
  onAddCustomImage: (src: string) => CustomImagePreset;
  onRemoveCustomImage: (id: string) => void;
}

function WallpaperImageTab({
  value,
  update,
  customImages,
  onAddCustomImage,
  onRemoveCustomImage,
}: WallpaperImageTabProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const currentSrc = value && value.type === 'image' ? value.src : null;
  const presetEntries = Object.entries(IMAGE_PRESETS);
  const matchedPresetKey = currentSrc
    ? presetEntries.find(([, p]) => p.src === currentSrc)?.[0] ?? null
    : null;
  const matchedCustomId = currentSrc
    ? customImages.find((c) => c.src === currentSrc)?.id ?? null
    : null;

  const readFile = (file: File | null | undefined): void => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      const added = onAddCustomImage(result);
      update({ type: 'image', src: added.src });
    };
    reader.readAsDataURL(file);
  };

  const onPick = (): void => inputRef.current?.click();
  const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    readFile(file);
    e.target.value = '';
  };
  const onDrop = (e: DragEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    setDragging(false);
    const file = Array.from(e.dataTransfer.files || []).find((f) => f.type.startsWith('image/'));
    readFile(file);
  };
  const onPaste = (e: ClipboardEvent<HTMLButtonElement>): void => {
    const file = Array.from(e.clipboardData?.files || []).find((f) => f.type.startsWith('image/'));
    if (file) readFile(file);
  };

  const handleRemoveCustom = (e: React.MouseEvent, custom: CustomImagePreset): void => {
    e.stopPropagation();
    onRemoveCustomImage(custom.id);
    if (currentSrc === custom.src) {
      const fallback = presetEntries[0]?.[1].src ?? null;
      update({ type: 'image', src: fallback });
    }
  };

  return (
    <div className="wallpaper-block">
      <button
        className={`upload-btn ${dragging ? 'dragging' : ''}`}
        onClick={onPick}
        onPaste={onPaste}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <UploadIcon />
        <span>Upload Custom</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={onChange}
        />
      </button>

      <div className="wallpaper-grid-pro">
        {presetEntries.map(([key, p]) => (
          <button
            key={key}
            className={`wallpaper-swatch-pro image-swatch ${matchedPresetKey === key ? 'active' : ''}`}
            style={{
              backgroundImage: `url(${p.thumbnail || p.src})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
            onClick={() => update({ type: 'image', src: p.src })}
            title={p.label || key}
          />
        ))}
        {customImages.map((c) => (
          <div
            key={c.id}
            className={`wallpaper-swatch-pro image-swatch custom-swatch ${matchedCustomId === c.id ? 'active' : ''}`}
            style={{
              backgroundImage: `url(${c.src})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
            onClick={() => update({ type: 'image', src: c.src })}
            title={c.label}
            role="button"
          >
            <button
              type="button"
              className="custom-swatch-remove"
              title="Remove"
              aria-label={`Remove ${c.label}`}
              onClick={(e) => handleRemoveCustom(e, c)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

interface VideoTabProps extends SubTabProps {
  customVideos: CustomVideoPreset[];
  onAddCustomVideo: (src: string) => CustomVideoPreset;
  onRemoveCustomVideo: (id: string) => void;
}

function VideoTab({
  value,
  update,
  customVideos,
  onAddCustomVideo,
  onRemoveCustomVideo,
}: VideoTabProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const currentSrc = value && value.type === 'video' ? value.src : null;

  // Always show the active clip as a swatch, even after a reload emptied the
  // in-session gallery — it lives in the project document, not this list.
  const items: CustomVideoPreset[] = [...customVideos];
  if (currentSrc && !items.some((v) => v.src === currentSrc)) {
    items.unshift({ id: 'active', src: currentSrc, label: 'Current' });
  }

  const readFile = (file: File | null | undefined): void => {
    if (!file) return;
    // Object URL, NOT a data URL: the clip is referenced by a short blob: string
    // in the document (no base64 bloat in state or in the autosaved JSON). The
    // project saver persists the bytes to a separate file and rebuilds this URL
    // on open (see project.ts readBgVideoMedia / reconstructProject).
    const url = URL.createObjectURL(file);
    const added = onAddCustomVideo(url);
    update({ type: 'video', src: added.src });
  };

  const onPick = (): void => inputRef.current?.click();
  const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
    readFile(e.target.files?.[0]);
    e.target.value = '';
  };
  const onDrop = (e: DragEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    setDragging(false);
    const file = Array.from(e.dataTransfer.files || []).find((f) => f.type.startsWith('video/'));
    readFile(file);
  };

  const handleRemove = (e: React.MouseEvent, vid: CustomVideoPreset): void => {
    e.stopPropagation();
    if (vid.id !== 'active') {
      onRemoveCustomVideo(vid.id);
      // Free the blob this gallery entry owned (the synthetic 'active' swatch
      // points at a reopened/in-use URL we don't own, so never revoke that one).
      if (vid.src.startsWith('blob:')) {
        try { URL.revokeObjectURL(vid.src); } catch { /* ignore */ }
      }
    }
    if (currentSrc === vid.src) {
      // Fall back to another clip if one remains, else clear the selection (the
      // tab then shows its upload prompt — clear feedback that it's unset).
      const next = customVideos.find((c) => c.src !== vid.src) ?? null;
      update({ type: 'video', src: next ? next.src : null });
    }
  };

  return (
    <div className="wallpaper-block">
      <button
        className={`upload-btn ${dragging ? 'dragging' : ''}`}
        onClick={onPick}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <UploadIcon />
        <span>Upload Video</span>
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          onChange={onChange}
        />
      </button>

      {items.length === 0 ? (
        <div className="blur-region-empty">
          Upload a short looping clip (MP4 or WebM). It plays muted behind your
          recording and is baked into the export.
        </div>
      ) : (
        <div className="wallpaper-grid-pro">
          {items.map((v) => (
            <div
              key={v.id}
              className={`wallpaper-swatch-pro image-swatch custom-swatch ${currentSrc === v.src ? 'active' : ''}`}
              onClick={() => update({ type: 'video', src: v.src })}
              title={v.label}
              role="button"
            >
              {/* Only the active swatch autoplays — multiple decoding <video>s
                  would spike CPU and lag the live preview. The rest preload a
                  frame and stay paused. */}
              <video
                src={v.src}
                muted
                loop
                autoPlay={currentSrc === v.src}
                playsInline
                preload="metadata"
                style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', pointerEvents: 'none' }}
              />
              <button
                type="button"
                className="custom-swatch-remove"
                title="Remove"
                aria-label={`Remove ${v.label}`}
                onClick={(e) => handleRemove(e, v)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GradientTab({ value, update }: SubTabProps): JSX.Element {
  const from = value && value.type === 'gradient' ? value.from : '#ffffff';
  const to = value && value.type === 'gradient' ? value.to : '#d4d7dd';
  const angle = value && value.type === 'gradient' && value.angle != null ? value.angle : 135;
  return (
    <div className="grad-block">
      <div
        className="gradient-preview-pro"
        style={{ background: `linear-gradient(${angle}deg, ${from}, ${to})` }}
      />
      <div className="grad-row">
        <label>From</label>
        <input type="color" value={from} onChange={(e) => update({ type: 'gradient', from: e.target.value, to, angle })} />
        <input
          type="text"
          className="hex-input"
          value={from}
          onChange={(e) => update({ type: 'gradient', from: e.target.value, to, angle })}
        />
      </div>
      <div className="grad-row">
        <label>To</label>
        <input type="color" value={to} onChange={(e) => update({ type: 'gradient', from, to: e.target.value, angle })} />
        <input
          type="text"
          className="hex-input"
          value={to}
          onChange={(e) => update({ type: 'gradient', from, to: e.target.value, angle })}
        />
      </div>
      <NumericRow
        label="Angle"
        value={angle}
        unit="°"
        min={0}
        max={360}
        step={1}
        onChange={(v) => update({ type: 'gradient', from, to, angle: v })}
      />
    </div>
  );
}

function ColorTab({ value, update }: SubTabProps): JSX.Element {
  const isWallpaper = !!value && value.type === 'wallpaper';
  const activeWallpaper = isWallpaper ? value.value : null;
  const color = value && value.type === 'color' ? value.value : '#ffffff';

  let previewBg = color;
  if (isWallpaper) {
    const preset = WALLPAPER_PRESETS[value.value] ?? WALLPAPER_PRESETS['default']!;
    previewBg = `linear-gradient(135deg, ${preset.from}, ${preset.to})`;
  }

  return (
    <div className="grad-block">
      <div className="wallpaper-grid-pro">
        {Object.entries(WALLPAPER_PRESETS).map(([key, p]) => (
          <button
            key={key}
            className={`wallpaper-swatch-pro ${activeWallpaper === key ? 'active' : ''}`}
            style={{ background: `linear-gradient(135deg, ${p.from}, ${p.to})` }}
            onClick={() => update({ type: 'wallpaper', value: key })}
            title={key}
          />
        ))}
      </div>
      <div className="gradient-preview-pro" style={{ background: previewBg }} />
      <div className="grad-row">
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

function UploadIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
