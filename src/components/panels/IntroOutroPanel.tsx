/**
 * Intro / Outro panel — build full-screen title cards prepended/appended to the
 * recording: a solid/gradient background, animated text blocks (fade or
 * typewriter, sequenced for appear→disappear→next), and a brand logo.
 *
 * Card items are authored in CARD-LOCAL time (0..durationMs). Editing timing
 * rebuilds the opacity envelope so the bar always animates in/out cleanly.
 */

import { useState } from 'react';
import type { Background } from '../../types';
import type { ImageOverlay, Overlay, TextOverlay } from '../../overlays/types';
import { createImageOverlay, applyAnimation } from '../../overlays/factories';
import type { Card, CardSet } from '../../cards/types';
import { MAX_CARD_DURATION_MS, MAX_CARD_TRANSITION_MS, MIN_CARD_DURATION_MS } from '../../cards/types';
import { createCard, createCardText, sequenceWindows } from '../../cards/factories';
import { CARD_TEMPLATES, buildTemplate } from '../../cards/templates';
import { FONT_OPTIONS, fontStackById, resolveFontId } from '../../overlays/fonts';

type Side = 'intro' | 'outro' | 'mid';
type TextAnim = 'fade' | 'typewriter';

interface IntroOutroPanelProps {
  cards: CardSet;
  onChange: (next: CardSet) => void;
  /** Insert a mid-roll card at the current playhead (owned by the editor). */
  onAddMidCardAtPlayhead: () => void;
}

const FADE_MS = 350;

const FONT_CATEGORIES: ReadonlyArray<{ id: 'sans' | 'display' | 'mono' | 'serif'; label: string }> = [
  { id: 'display', label: 'Display (titles)' },
  { id: 'sans', label: 'Sans' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Mono' },
];

/** Recompute a text item's opacity envelope + typewriter for its window. */
function applyTextTiming(item: TextOverlay, fromMs: number, toMs: number, anim: TextAnim): TextOverlay {
  const span = Math.max(1, toMs - fromMs);
  const fade = Math.min(FADE_MS, span / 3);
  return {
    ...item,
    visibleFrom: fromMs,
    visibleTo: toMs,
    transform: {
      opacity: {
        keys: [
          { t: fromMs, value: 0 },
          { t: fromMs + fade, value: 1, easing: 'easeOutQuint' },
          { t: Math.max(fromMs + fade, toMs - fade), value: 1 },
          { t: toMs, value: 0, easing: 'easeOutQuint' },
        ],
      },
    },
    typewriter: anim === 'typewriter'
      ? { startMs: fromMs, charsPerSecond: Math.max(8, Math.min(60, item.text.length * 4)) }
      : undefined,
  };
}

/** Shift every keyframe time of an animation track by `delta` ms (keeps the
 * type — works for both number and vec tracks). */
function shiftTrack<T extends { keys: Array<{ t: number }> }>(track: T | undefined, delta: number): T | undefined {
  if (!track || delta === 0) return track;
  return { ...track, keys: track.keys.map((k) => ({ ...k, t: Math.max(0, Math.round(k.t + delta)) })) };
}

/**
 * Retime a logo (image) item to a new [from, to] window. Changing the START
 * shifts the entrance animation (pop-in) keyframes with it so the logo still
 * animates in at its new start instead of appearing instantly; END only trims
 * the visibility window.
 */
function retimeLogo(item: ImageOverlay, fromMs: number, toMs: number, durationMs: number): ImageOverlay {
  const lo = Math.round(Math.max(0, Math.min(durationMs - 100, fromMs)));
  const hi = Math.round(Math.max(lo + 100, Math.min(durationMs, toMs)));
  const delta = lo - (item.visibleFrom ?? 0);
  const tx = item.transform;
  return {
    ...item,
    visibleFrom: lo,
    visibleTo: hi,
    transform: {
      ...tx,
      position: shiftTrack(tx.position, delta),
      scale: shiftTrack(tx.scale, delta),
      rotation: shiftTrack(tx.rotation, delta),
      opacity: shiftTrack(tx.opacity, delta),
      blur: shiftTrack(tx.blur, delta),
    },
  };
}

export default function IntroOutroPanel({ cards, onChange, onAddMidCardAtPlayhead }: IntroOutroPanelProps): JSX.Element {
  const [side, setSide] = useState<Side>('intro');
  const [selectedMidId, setSelectedMidId] = useState<string | null>(null);
  const midCards = cards.mid ?? [];
  // The card being edited: the intro/outro slot, or the selected mid-roll card.
  const card: Card | null = side === 'mid'
    ? (midCards.find((c) => c.id === selectedMidId) ?? null)
    : cards[side];

  const setCard = (next: Card | null): void => {
    if (side === 'mid') {
      if (!next) {
        onChange({ ...cards, mid: midCards.filter((c) => c.id !== selectedMidId) });
        setSelectedMidId(null);
      } else {
        onChange({ ...cards, mid: midCards.map((c) => (c.id === next.id ? next : c)) });
      }
      return;
    }
    onChange({ ...cards, [side]: next });
  };
  const updateCard = (patch: Partial<Card>): void => {
    if (!card) return;
    setCard({ ...card, ...patch });
  };
  const setItems = (items: Overlay[]): void => updateCard({ items });
  const updateItem = (id: string, next: Overlay): void => {
    if (!card) return;
    setItems(card.items.map((o) => (o.id === id ? next : o)));
  };
  const removeItem = (id: string): void => {
    if (!card) return;
    setItems(card.items.filter((o) => o.id !== id));
  };

  const textItems = (card?.items ?? []).filter((o): o is TextOverlay => o.type === 'text');
  const logoItem = (card?.items ?? []).find((o): o is ImageOverlay => o.type === 'image') ?? null;

  const addText = (): void => {
    if (!card) return;
    const from = 0;
    const to = card.durationMs;
    const item = createCardText(card.items, 'New text', from, to, { y: 0.5 });
    setItems([...card.items, item]);
  };

  const sequenceText = (): void => {
    if (!card || textItems.length === 0) return;
    const windows = sequenceWindows(textItems.length, card.durationMs);
    let wi = 0;
    const next = card.items.map((o) => {
      if (o.type !== 'text') return o;
      const w = windows[wi++]!;
      const anim: TextAnim = o.typewriter ? 'typewriter' : 'fade';
      return applyTextTiming(o, w.fromMs, w.toMs, anim);
    });
    setItems(next);
  };

  const addLogo = async (): Promise<void> => {
    if (!card) return;
    const bridge = window.klipe;
    if (!bridge?.openImageFile) return;
    const result = await bridge.openImageFile();
    if (!result || 'error' in result) return;
    const img = new Image();
    img.src = result.dataUrl;
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); });
    const base = createImageOverlay(card.items, result.dataUrl, img.naturalWidth || 512, img.naturalHeight || 512, result.name);
    const withTiming: ImageOverlay = { ...base, sizeRel: 0.28, base: { ...base.base, y: 0.5 }, visibleFrom: 0, visibleTo: card.durationMs };
    const animated = applyAnimation(withTiming, 'popIn') as ImageOverlay;
    // popIn keys are anchored at visibleFrom (0), which is what we want.
    setItems([...card.items.filter((o) => o.type !== 'image'), animated]);
  };

  const durSec = (card?.durationMs ?? 0) / 1000;
  const transSec = (card?.transitionMs ?? 0) / 1000;

  return (
    <div className="panel-pro">
      <div className="seg-tabs">
        <button className={`seg-tab ${side === 'intro' ? 'active' : ''}`} onClick={() => setSide('intro')}>
          Intro {cards.intro ? '•' : ''}
        </button>
        <button className={`seg-tab ${side === 'mid' ? 'active' : ''}`} onClick={() => setSide('mid')}>
          Mid-roll {midCards.length > 0 ? `(${midCards.length})` : ''}
        </button>
        <button className={`seg-tab ${side === 'outro' ? 'active' : ''}`} onClick={() => setSide('outro')}>
          Outro {cards.outro ? '•' : ''}
        </button>
      </div>

      {side !== 'mid' ? (
        <div className="section-card">
          <div className="section-head">
            <span className="section-title">{side === 'intro' ? 'Intro card' : 'Outro card'}</span>
            <button
              type="button"
              role="switch"
              aria-checked={!!card}
              className={`switch ${card ? 'on' : ''}`}
              onClick={() => setCard(card ? null : createCard(side))}
            >
              <span className="switch-thumb" />
            </button>
          </div>
          {!card && (
            <div className="section-body">
              <p className="muted-note" style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
                {side === 'intro'
                  ? 'Add a full-screen opening card before your recording.'
                  : 'Add a closing card with your brand after your recording.'}
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="section-card">
          <div className="section-head">
            <span className="section-title">Mid-roll cards</span>
            <button className="link-action" onClick={onAddMidCardAtPlayhead} title="Insert a card at the playhead">
              + Add at playhead
            </button>
          </div>
          <div className="section-body">
            {midCards.length === 0 && (
              <p className="muted-note" style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
                Move the playhead where you want a full-screen card, then “Add at playhead”. It splits the recording there.
              </p>
            )}
            {midCards.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[...midCards]
                  .sort((a, b) => (a.atBodyMs ?? 0) - (b.atBodyMs ?? 0))
                  .map((c) => (
                    <button
                      key={c.id}
                      className={`seg-tab ${selectedMidId === c.id ? 'active' : ''}`}
                      style={{ width: '100%', justifyContent: 'space-between', display: 'flex' }}
                      onClick={() => setSelectedMidId(c.id)}
                    >
                      <span>Card @ {((c.atBodyMs ?? 0) / 1000).toFixed(1)}s</span>
                      <span style={{ opacity: 0.6 }}>{(c.durationMs / 1000).toFixed(1)}s</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {card && (
        <>
          {side === 'mid' && (
            <div className="section-card">
              <div className="section-head">
                <span className="section-title">Editing this card</span>
                <button className="link-action" onClick={() => setCard(null)} title="Remove this mid-roll card">
                  Remove
                </button>
              </div>
            </div>
          )}
          {/* TEMPLATES */}
          <div className="section-card">
            <div className="section-head"><span className="section-title">Template</span></div>
            <div className="section-body">
              <div className="wallpaper-grid-pro">
                {CARD_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    className="seg-tab"
                    style={{ width: '100%' }}
                    onClick={() => {
                      const tpl = buildTemplate(t.id, side === 'outro' ? 'outro' : 'intro');
                      // Applying a template to a mid card keeps its identity/anchor.
                      setCard(side === 'mid' && card
                        ? { ...tpl, id: card.id, kind: 'mid', atBodyMs: card.atBodyMs }
                        : tpl);
                    }}
                    title={`Apply the “${t.label}” template`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* DURATION & TRANSITION */}
          <div className="section-card">
            <div className="section-head"><span className="section-title">Duration</span></div>
            <div className="section-body">
              <NumRow
                label="Length"
                value={durSec}
                unit="s"
                min={MIN_CARD_DURATION_MS / 1000}
                max={MAX_CARD_DURATION_MS / 1000}
                step={0.1}
                onChange={(v) => updateCard({ durationMs: Math.round(v * 1000) })}
              />
              <NumRow
                label="Crossfade"
                value={transSec}
                unit="s"
                min={0}
                max={MAX_CARD_TRANSITION_MS / 1000}
                step={0.05}
                onChange={(v) => updateCard({ transitionMs: Math.round(v * 1000) })}
              />
              <p style={{ fontSize: 11, opacity: 0.6, margin: '4px 0 0' }}>
                {side === 'intro'
                  ? 'Dissolves into the recording. 0 = hard cut. Card length is unchanged.'
                  : side === 'outro'
                    ? 'Dissolves in from the recording. 0 = hard cut. Card length is unchanged.'
                    : 'Dissolves in and out of the recording on both sides. 0 = hard cut.'}
              </p>
            </div>
          </div>

          {/* BACKGROUND */}
          <div className="section-card">
            <div className="section-head"><span className="section-title">Background</span></div>
            <div className="section-body">
              <CardBackground value={card.background} onChange={(bg) => updateCard({ background: bg })} />
            </div>
          </div>

          {/* TEXT BLOCKS */}
          <div className="section-card">
            <div className="section-head">
              <span className="section-title">Text</span>
              <div style={{ display: 'flex', gap: 8 }}>
                {textItems.length > 1 && (
                  <button className="link-action" onClick={sequenceText} title="Lay text blocks out back-to-back">
                    Sequence
                  </button>
                )}
                <button className="link-action" onClick={addText}>+ Add</button>
              </div>
            </div>
            <div className="section-body">
              {textItems.length === 0 && (
                <p style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>No text yet. Add a block to write a heading.</p>
              )}
              {textItems.map((item, i) => (
                <TextBlockEditor
                  key={item.id}
                  index={i}
                  item={item}
                  durationMs={card.durationMs}
                  onChange={(next) => updateItem(item.id, next)}
                  onRemove={() => removeItem(item.id)}
                />
              ))}
            </div>
          </div>

          {/* LOGO */}
          <div className="section-card">
            <div className="section-head">
              <span className="section-title">Logo</span>
              {logoItem && (
                <button className="link-action" onClick={() => removeItem(logoItem.id)}>Remove</button>
              )}
            </div>
            <div className="section-body">
              {logoItem && (
                <div className="logo-preview">
                  <img src={logoItem.src} alt="logo" />
                </div>
              )}
              <button className="upload-btn" onClick={() => void addLogo()}>
                <UploadIcon />
                <span>{logoItem ? 'Replace logo' : 'Upload logo (PNG/SVG)'}</span>
              </button>
              {logoItem && (
                <>
                <p className="muted-note" style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
                  Drag the logo on the preview to position it.
                </p>
                <NumRow
                  label="Logo size"
                  value={logoItem.sizeRel}
                  unit=""
                  min={0.1}
                  max={0.8}
                  step={0.01}
                  onChange={(v) => updateItem(logoItem.id, { ...logoItem, sizeRel: v })}
                />
                <NumRow
                  label="Start"
                  value={(logoItem.visibleFrom ?? 0) / 1000}
                  unit="s"
                  min={0}
                  max={(card?.durationMs ?? 0) / 1000}
                  step={0.1}
                  onChange={(v) => updateItem(
                    logoItem.id,
                    retimeLogo(logoItem, v * 1000, logoItem.visibleTo ?? (card?.durationMs ?? 0), card?.durationMs ?? 0),
                  )}
                />
                <NumRow
                  label="End"
                  value={(logoItem.visibleTo ?? (card?.durationMs ?? 0)) / 1000}
                  unit="s"
                  min={0}
                  max={(card?.durationMs ?? 0) / 1000}
                  step={0.1}
                  onChange={(v) => updateItem(
                    logoItem.id,
                    retimeLogo(logoItem, logoItem.visibleFrom ?? 0, v * 1000, card?.durationMs ?? 0),
                  )}
                />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text block editor
// ---------------------------------------------------------------------------

interface TextBlockEditorProps {
  index: number;
  item: TextOverlay;
  durationMs: number;
  onChange: (next: TextOverlay) => void;
  onRemove: () => void;
}

function TextBlockEditor({ index, item, durationMs, onChange, onRemove }: TextBlockEditorProps): JSX.Element {
  const anim: TextAnim = item.typewriter ? 'typewriter' : 'fade';
  const fontId = resolveFontId(item.fontFamily, item.mono);
  const fromMs = item.visibleFrom ?? 0;
  const toMs = item.visibleTo ?? durationMs;

  const retime = (from: number, to: number, a: TextAnim): void => {
    const lo = Math.max(0, Math.min(durationMs - 100, from));
    const hi = Math.max(lo + 100, Math.min(durationMs, to));
    onChange(applyTextTiming(item, Math.round(lo), Math.round(hi), a));
  };

  return (
    <div className="card-text-block">
      <div className="card-text-head">
        <span className="card-text-index">#{index + 1}</span>
        <input
          type="text"
          className="hex-input"
          style={{ flex: 1 }}
          value={item.text}
          placeholder="Text…"
          onChange={(e) => {
            const text = e.target.value;
            const next: TextOverlay = { ...item, text, name: text.slice(0, 24) };
            // Keep typewriter speed sensible for the new length.
            onChange(item.typewriter ? applyTextTiming(next, fromMs, toMs, 'typewriter') : next);
          }}
        />
        <button className="link-action" onClick={onRemove} title="Remove text block">✕</button>
      </div>

      <div className="grad-row">
        <label>Font</label>
        <select
          className="export-select"
          style={{ flex: 1, fontFamily: fontStackById(fontId) }}
          value={fontId}
          onChange={(e) => onChange({ ...item, fontFamily: e.target.value })}
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
        <label>Animation</label>
        <select
          className="export-select"
          style={{ flex: 1 }}
          value={anim}
          onChange={(e) => retime(fromMs, toMs, e.target.value as TextAnim)}
        >
          <option value="fade">Fade in / out</option>
          <option value="typewriter">Typewriter</option>
        </select>
        <input
          type="color"
          value={item.color}
          onChange={(e) => onChange({ ...item, color: e.target.value })}
          title="Text color"
        />
      </div>

      <NumRow
        label="Size"
        value={item.sizeRel}
        unit=""
        min={0.03}
        max={0.18}
        step={0.005}
        onChange={(v) => onChange({ ...item, sizeRel: v })}
      />
      <NumRow
        label="Start"
        value={fromMs / 1000}
        unit="s"
        min={0}
        max={durationMs / 1000}
        step={0.1}
        onChange={(v) => retime(v * 1000, toMs, anim)}
      />
      <NumRow
        label="End"
        value={toMs / 1000}
        unit="s"
        min={0}
        max={durationMs / 1000}
        step={0.1}
        onChange={(v) => retime(fromMs, v * 1000, anim)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card background (color | gradient | image), compact
// ---------------------------------------------------------------------------

function CardBackground({ value, onChange }: { value: Background; onChange: (bg: Background) => void }): JSX.Element {
  const tab: 'color' | 'gradient' | 'image' =
    value.type === 'gradient' ? 'gradient' : value.type === 'image' ? 'image' : 'color';
  const color = value.type === 'color' ? value.value : '#0b0d12';
  const from = value.type === 'gradient' ? value.from : '#7c5cff';
  const to = value.type === 'gradient' ? value.to : '#5cc4ff';
  const angle = value.type === 'gradient' && value.angle != null ? value.angle : 135;

  const pickImage = async (): Promise<void> => {
    const bridge = window.klipe;
    if (!bridge?.openImageFile) return;
    const result = await bridge.openImageFile();
    if (!result || 'error' in result) return;
    onChange({ type: 'image', src: result.dataUrl, blur: 0 });
  };

  return (
    <div className="grad-block">
      <div className="seg-tabs">
        <button className={`seg-tab ${tab === 'color' ? 'active' : ''}`} onClick={() => onChange({ type: 'color', value: color, blur: 0 })}>Color</button>
        <button className={`seg-tab ${tab === 'gradient' ? 'active' : ''}`} onClick={() => onChange({ type: 'gradient', from, to, angle, blur: 0 })}>Gradient</button>
        <button className={`seg-tab ${tab === 'image' ? 'active' : ''}`} onClick={() => void pickImage()}>Image</button>
      </div>

      {tab === 'color' && (
        <div className="grad-row">
          <input type="color" value={color} onChange={(e) => onChange({ type: 'color', value: e.target.value, blur: 0 })} />
          <input type="text" className="hex-input" value={color} onChange={(e) => onChange({ type: 'color', value: e.target.value, blur: 0 })} />
        </div>
      )}

      {tab === 'gradient' && (
        <>
          <div className="gradient-preview-pro" style={{ background: `linear-gradient(${angle}deg, ${from}, ${to})` }} />
          <div className="grad-row">
            <label>From</label>
            <input type="color" value={from} onChange={(e) => onChange({ type: 'gradient', from: e.target.value, to, angle, blur: 0 })} />
          </div>
          <div className="grad-row">
            <label>To</label>
            <input type="color" value={to} onChange={(e) => onChange({ type: 'gradient', from, to: e.target.value, angle, blur: 0 })} />
          </div>
          <NumRow label="Angle" value={angle} unit="°" min={0} max={360} step={1} onChange={(v) => onChange({ type: 'gradient', from, to, angle: v, blur: 0 })} />
        </>
      )}

      {tab === 'image' && (
        <div className="grad-row">
          <button className="upload-btn" onClick={() => void pickImage()}>
            <UploadIcon />
            <span>{value.type === 'image' && value.src ? 'Replace image' : 'Choose image'}</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small reusable controls (mirror BackgroundPanel's look)
// ---------------------------------------------------------------------------

interface NumRowProps {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
}

function NumRow({ label, value, unit, min, max, step, onChange }: NumRowProps): JSX.Element {
  const fillPct = ((value - min) / Math.max(0.0001, max - min)) * 100;
  return (
    <div className="num-row">
      {label && <span className="num-row-label">{label}</span>}
      <div className="num-row-control" style={{ ['--fill' as string]: `${fillPct}%` }}>
        <span className="num-row-value">{step < 1 ? value.toFixed(2) : Math.round(value)}{unit}</span>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
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
