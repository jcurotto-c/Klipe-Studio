/**
 * Intro / Outro panel — build full-screen title cards prepended/appended to the
 * recording: a solid/gradient background, animated text blocks (fade or
 * typewriter, sequenced for appear→disappear→next), and a brand logo.
 *
 * Card items are authored in CARD-LOCAL time (0..durationMs). Editing timing
 * rebuilds the opacity envelope so the bar always animates in/out cleanly.
 */

import { type CSSProperties, useMemo, useRef, useState } from 'react';
import type { Background } from '../../types';
import type { ImageOverlay, Overlay, OverlayTransform, TextOverlay } from '../../overlays/types';
import { createImageOverlay, applyAnimation } from '../../overlays/factories';
import type { Card, CardSet, RevealConfig, RevealImageRef } from '../../cards/types';
import { MAX_CARD_DURATION_MS, MAX_CARD_TRANSITION_MS, MIN_CARD_DURATION_MS } from '../../cards/types';
import { createCard, createCardText, sequenceWindows } from '../../cards/factories';
import { buildTemplate, templatesFor } from '../../cards/templates';
import { buildRevealCard } from '../../cards/reveal';
import { brandConfigOf } from '../../cards/brand-card';
import type { BrandCardConfig } from '../../cards/types';
import { FONT_OPTIONS, fontStackById, resolveFontId } from '../../overlays/fonts';
import { makeTypewriter } from '../../overlays/engine/typewriter';

type Side = 'intro' | 'outro' | 'mid';
type TextAnim = 'fade' | 'rise' | 'zoom' | 'blur' | 'typewriter';

const TEXT_ANIMS: ReadonlyArray<{ id: TextAnim; label: string }> = [
  { id: 'fade', label: 'Fade in / out' },
  { id: 'rise', label: 'Rise (slide up)' },
  { id: 'zoom', label: 'Zoom in' },
  { id: 'blur', label: 'Blur in' },
  { id: 'typewriter', label: 'Typewriter' },
];

/** CSS background mirroring a card Background, for the template thumbnails. */
function bgStyle(bg: Background): CSSProperties {
  if (bg.type === 'gradient') return { background: `linear-gradient(${bg.angle ?? 135}deg, ${bg.from}, ${bg.to})` };
  if (bg.type === 'image') return { backgroundColor: '#0b0d12', backgroundImage: `url(${bg.src})`, backgroundSize: 'cover', backgroundPosition: 'center' };
  if (bg.type === 'color') return { background: bg.value || '#0b0d12' };
  return { background: '#0b0d12' };
}

/**
 * CSS stand-in for a brand card: its pattern as a repeating background plus its
 * plate. Returns null for every other template.
 */
function brandThumb(card: Card): JSX.Element | null {
  const cfg = brandConfigOf(card);
  if (!cfg) return null;
  const dot = cfg.patternColor;
  const pattern: CSSProperties =
    cfg.pattern === 'dots'
      ? { backgroundImage: `radial-gradient(${dot} 22%, transparent 23%)`, backgroundSize: '6px 6px' }
      : cfg.pattern === 'grid'
        ? {
            backgroundImage: `linear-gradient(${dot} 1px, transparent 1px), linear-gradient(90deg, ${dot} 1px, transparent 1px)`,
            backgroundSize: '9px 9px',
          }
        : cfg.pattern === 'rings'
          ? { backgroundImage: `repeating-radial-gradient(circle at 50% 48%, ${dot} 0 1px, transparent 1px 9px)` }
          : {};
  return (
    <>
      {cfg.pattern !== 'none' && (
        <span
          style={{
            position: 'absolute', inset: 0, opacity: cfg.patternOpacity * 0.85,
            // Mirrors the painter's centre-weighted falloff.
            WebkitMaskImage: 'radial-gradient(circle at 50% 48%, #000 0%, rgba(0,0,0,0.55) 45%, transparent 100%)',
            ...pattern,
          }}
        />
      )}
      {cfg.cardStyle !== 'none' && (
        <span
          style={{
            position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
            width: '30%', aspectRatio: '1', borderRadius: 4,
            background: cfg.cardStyle === 'glass' ? 'rgba(255,255,255,0.18)' : '#fff',
            border: cfg.cardStyle === 'glass' ? '1px solid rgba(255,255,255,0.4)' : 'none',
            boxShadow: cfg.cardStyle === 'glass' ? 'none' : '0 4px 10px rgba(0,0,0,0.25)',
          }}
        />
      )}
      {cfg.cardStyle === 'none' && (
        <span
          style={{
            position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
            width: '34%', height: '9%', borderRadius: 2, background: cfg.textColor, opacity: 0.85,
          }}
        />
      )}
    </>
  );
}

/** A 16:9 thumbnail approximating a template (bg + its text), CSS-rendered. */
function TemplateThumb({ card, label, onClick }: { card: Card; label: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className="tpl-thumb" onClick={onClick} title={`Apply the “${label}” template`}>
      <span className="tpl-thumb-bg" style={bgStyle(card.background)} />
      {/* Brand cards paint themselves on the canvas rather than through card
          items, so the thumbnail approximates them in CSS — otherwise every
          preset in the family would show as a bare gradient. */}
      {brandThumb(card)}
      {card.items
        .filter((o): o is TextOverlay => o.type === 'text')
        .map((o) => (
          <span
            key={o.id}
            className="tpl-thumb-text"
            style={{
              left: `${o.base.x * 100}%`,
              top: `${o.base.y * 100}%`,
              color: o.color,
              fontFamily: fontStackById(resolveFontId(o.fontFamily, o.mono)),
              fontWeight: o.weight ?? 700,
              fontSize: `${o.sizeRel * 100}cqh`,
              textTransform: o.uppercase ? 'uppercase' : 'none',
            }}
          >
            {o.text}
          </span>
        ))}
      <span className="tpl-thumb-label">{label}</span>
    </button>
  );
}

/** The animation a text item is currently using (for the picker's value). */
function textAnimOf(item: TextOverlay): TextAnim {
  if (item.anim && TEXT_ANIMS.some((a) => a.id === item.anim)) return item.anim as TextAnim;
  return item.typewriter ? 'typewriter' : 'fade';
}

interface IntroOutroPanelProps {
  cards: CardSet;
  onChange: (next: CardSet) => void;
  /** Insert a mid-roll card at the current playhead (owned by the editor). */
  onAddMidCardAtPlayhead: () => void;
  /** Capture a recording still as a data URL for a freeze-frame card background. */
  onCaptureRecordingFrame: (position: 'start' | 'end' | number) => Promise<string | null>;
}

const FADE_MS = 350;

const FONT_CATEGORIES: ReadonlyArray<{ id: 'sans' | 'display' | 'mono' | 'serif'; label: string }> = [
  { id: 'display', label: 'Display (titles)' },
  { id: 'sans', label: 'Sans' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Mono' },
];

/**
 * Rebuild a text item's animation for its [from, to] window. Every animation
 * shares the same opacity envelope (fade in → hold → fade out); the entrance
 * adds ONE distinguishing track on top: rise→position, zoom→scale, blur→blur.
 * A fresh transform is built each time so switching animations clears the
 * previous one's track. Position keys are anchored to the item's current base,
 * so dragging (which shifts both base and the position track) keeps them aligned.
 */
function applyTextTiming(item: TextOverlay, fromMs: number, toMs: number, anim: TextAnim): TextOverlay {
  const span = Math.max(1, toMs - fromMs);
  const fade = Math.min(FADE_MS, span / 3);
  const enter = Math.min(500, span / 2);
  const settle = fromMs + enter;
  const bx = item.base.x;
  const by = item.base.y;

  const transform: OverlayTransform = {
    opacity: {
      keys: [
        { t: fromMs, value: 0 },
        { t: fromMs + fade, value: 1, easing: 'easeOutQuint' },
        { t: Math.max(fromMs + fade, toMs - fade), value: 1 },
        { t: toMs, value: 0, easing: 'easeOutQuint' },
      ],
    },
  };
  if (anim === 'rise') {
    transform.position = {
      keys: [
        { t: fromMs, value: { x: bx, y: by + 0.07 } },
        { t: settle, value: { x: bx, y: by }, easing: 'easeOutQuint' },
      ],
    };
  } else if (anim === 'zoom') {
    transform.scale = {
      keys: [
        { t: fromMs, value: 0.82 },
        { t: settle, value: 1, easing: 'easeOutBack' },
      ],
    };
  } else if (anim === 'blur') {
    transform.blur = {
      keys: [
        { t: fromMs, value: 16 },
        { t: settle, value: 0, easing: 'easeOutQuint' },
      ],
    };
  }

  return {
    ...item,
    anim,
    visibleFrom: fromMs,
    visibleTo: toMs,
    transform,
    typewriter: anim === 'typewriter' ? makeTypewriter(item.text, fromMs, span) : undefined,
  };
}

/**
 * Apply an alignment: move the text to the left margin / centre / right margin
 * of the frame. Sets `align` (which drives the Pixi text ANCHOR — what actually
 * moves the block) and snaps base.x to the matching margin, shifting any
 * position-animation track so a "rise" entrance follows.
 */
function applyAlign(item: TextOverlay, align: 'left' | 'center' | 'right'): TextOverlay {
  const x = align === 'left' ? 0.06 : align === 'right' ? 0.94 : 0.5;
  const dx = x - item.base.x;
  const pos = item.transform.position;
  const shifted = pos && dx !== 0
    ? { ...pos, keys: pos.keys.map((k) => ({ ...k, value: { x: k.value.x + dx, y: k.value.y } })) }
    : pos;
  return { ...item, align, base: { ...item.base, x }, transform: { ...item.transform, position: shifted } };
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

export default function IntroOutroPanel({ cards, onChange, onAddMidCardAtPlayhead, onCaptureRecordingFrame }: IntroOutroPanelProps): JSX.Element {
  const [side, setSide] = useState<Side>('intro');
  const [selectedMidId, setSelectedMidId] = useState<string | null>(null);
  const [capturingFrame, setCapturingFrame] = useState(false);
  const [capturingHero, setCapturingHero] = useState(false);
  // Build each template once per side for the thumbnail previews.
  const templatePreviews = useMemo(
    () => templatesFor(side).map((t) => ({ t, preview: buildTemplate(t.id, side === 'outro' ? 'outro' : 'intro') })),
    [side],
  );
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
      return applyTextTiming(o, w.fromMs, w.toMs, textAnimOf(o));
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

  // --- Reveal template (parametric card) ------------------------------------
  const isReveal = card?.template === 'reveal';
  const revealConfig: RevealConfig | null = card?.revealConfig ?? null;

  /** Regenerate the reveal card's items from a config + duration, preserving the
   * card's identity, anchor and crossfade. The user's background is folded into
   * the config so it persists and survives the rebuild. */
  const rebuildReveal = (nextConfig: RevealConfig, durationMs: number): void => {
    if (!card) return;
    const kindForBuild: 'intro' | 'outro' = side === 'outro' ? 'outro' : 'intro';
    const built = buildRevealCard(kindForBuild, { ...nextConfig, background: card.background }, durationMs);
    setCard({ ...built, id: card.id, kind: card.kind, atBodyMs: card.atBodyMs, transitionMs: card.transitionMs });
  };
  const setRevealConfig = (next: RevealConfig): void => {
    if (card) rebuildReveal(next, card.durationMs);
  };

  // --- Brand card (parametric card) -----------------------------------------
  const brandConfig: BrandCardConfig | null = brandConfigOf(card);
  const isBrand = brandConfig !== null;

  /** Rewrite the brand card from a config, keeping its identity and timing. */
  const patchBrand = (patch: Partial<BrandCardConfig>): void => {
    if (!card || !brandConfig) return;
    const next = { ...brandConfig, ...patch };
    setCard({
      ...card,
      background: next.background,
      brandConfig: next,
    });
  };

  const pickBrandIcon = async (): Promise<void> => {
    if (!brandConfig) return;
    const bridge = window.klipe;
    if (!bridge?.openImageFile) return;
    const result = await bridge.openImageFile();
    if (!result || 'error' in result) return;
    const img = new Image();
    img.src = result.dataUrl;
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); });
    patchBrand({
      icon: {
        src: result.dataUrl,
        naturalWidth: img.naturalWidth || 512,
        naturalHeight: img.naturalHeight || 512,
      },
    });
  };

  /** Toggle the auto-hero: capture the recording's first (intro) / last (outro)
   * frame as the zooming hero, or revert to the last uploaded image. */
  const setHeroFromRecording = async (on: boolean): Promise<void> => {
    if (!card || !revealConfig) return;
    if (!on) {
      setRevealConfig({ ...revealConfig, heroFromRecording: false });
      return;
    }
    setCapturingHero(true);
    try {
      const pos: 'start' | 'end' | number = side === 'intro' ? 'start' : side === 'outro' ? 'end' : (card.atBodyMs ?? 0);
      const url = await onCaptureRecordingFrame(pos);
      if (!url) { setRevealConfig({ ...revealConfig, heroFromRecording: false }); return; }
      const heroImg = new Image();
      heroImg.src = url;
      await new Promise<void>((resolve) => { heroImg.onload = () => resolve(); heroImg.onerror = () => resolve(); });
      const ref: RevealImageRef = { src: url, naturalWidth: heroImg.naturalWidth || 1920, naturalHeight: heroImg.naturalHeight || 1080 };
      setRevealConfig({ ...revealConfig, heroFromRecording: true, heroImage: ref });
    } finally {
      setCapturingHero(false);
    }
  };

  const addRevealImage = async (): Promise<void> => {
    if (!card || !revealConfig) return;
    const bridge = window.klipe;
    if (!bridge?.openImageFile) return;
    const result = await bridge.openImageFile();
    if (!result || 'error' in result) return;
    const img = new Image();
    img.src = result.dataUrl;
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); });
    const ref: RevealImageRef = { src: result.dataUrl, naturalWidth: img.naturalWidth || 800, naturalHeight: img.naturalHeight || 1040 };
    setRevealConfig({ ...revealConfig, images: [...revealConfig.images, ref] });
  };
  const removeRevealImage = (i: number): void => {
    if (revealConfig) setRevealConfig({ ...revealConfig, images: revealConfig.images.filter((_, k) => k !== i) });
  };
  const moveRevealImage = (i: number, dir: -1 | 1): void => {
    if (!revealConfig) return;
    const arr = [...revealConfig.images];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    setRevealConfig({ ...revealConfig, images: arr });
  };
  const setRevealLabel = (i: number, text: string): void => {
    if (revealConfig) setRevealConfig({ ...revealConfig, labels: revealConfig.labels.map((l, k) => (k === i ? text : l)) });
  };
  const addRevealLabel = (): void => {
    if (revealConfig && revealConfig.labels.length < 3) setRevealConfig({ ...revealConfig, labels: [...revealConfig.labels, 'New label'] });
  };
  const removeRevealLabel = (i: number): void => {
    if (revealConfig) setRevealConfig({ ...revealConfig, labels: revealConfig.labels.filter((_, k) => k !== i) });
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
              <div className="tpl-grid">
                {templatePreviews.map(({ t, preview }) => (
                  <TemplateThumb
                    key={t.id}
                    card={preview}
                    label={t.label}
                    onClick={() => {
                      const tpl = buildTemplate(t.id, side === 'outro' ? 'outro' : 'intro');
                      // Applying a template to a mid card keeps its identity/anchor.
                      setCard(side === 'mid' && card
                        ? { ...tpl, id: card.id, kind: 'mid', atBodyMs: card.atBodyMs }
                        : tpl);
                    }}
                  />
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
                onChange={(v) => {
                  const ms = Math.round(v * 1000);
                  if (isReveal && revealConfig) rebuildReveal(revealConfig, ms);
                  else updateCard({ durationMs: ms });
                }}
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
            <div className="section-head">
              <span className="section-title">Background</span>
            </div>
            <div className="section-body">
              <CardBackground
                value={card.background}
                onChange={(bg) => {
                  if (isBrand) patchBrand({ background: bg });
                  else if (isReveal && revealConfig) setCard({ ...card, background: bg, revealConfig: { ...revealConfig, background: bg } });
                  else updateCard({ background: bg });
                }}
                onVideoPicked={(src, durationSec) => {
                  // Size the card to the clip so a finished animation plays end
                  // to end instead of being cut off or freezing on its last frame.
                  const ms = Math.round(durationSec * 1000);
                  updateCard({
                    background: { type: 'video', src, blur: 0 },
                    durationMs: Math.max(MIN_CARD_DURATION_MS, Math.min(MAX_CARD_DURATION_MS, ms)),
                  });
                }}
              />
              <button
                type="button"
                className="upload-btn"
                disabled={capturingFrame}
                onClick={() => {
                  if (!card || capturingFrame) return;
                  const pos: 'start' | 'end' | number =
                    side === 'intro' ? 'start' : side === 'outro' ? 'end' : (card.atBodyMs ?? 0);
                  setCapturingFrame(true);
                  void onCaptureRecordingFrame(pos)
                    .then((url) => { if (url) updateCard({ background: { type: 'image', src: url, blur: 0 } }); })
                    .finally(() => setCapturingFrame(false));
                }}
              >
                <UploadIcon />
                <span>
                  {capturingFrame
                    ? 'Capturing…'
                    : side === 'intro' ? 'Use first frame of recording'
                    : side === 'outro' ? 'Use last frame of recording'
                    : 'Use the frame at this point'}
                </span>
              </button>
            </div>
          </div>

          {isBrand && brandConfig && (
            <div className="section-card">
              <div className="section-head"><span className="section-title">Brand card</span></div>
              <div className="section-body">
                <input
                  className="export-select"
                  style={{ width: '100%' }}
                  type="text"
                  value={brandConfig.cardText}
                  placeholder="Brand name"
                  onChange={(e) => patchBrand({ cardText: e.target.value })}
                />
                <input
                  className="export-select"
                  style={{ width: '100%', marginTop: 6 }}
                  type="text"
                  value={brandConfig.cardSubtext}
                  placeholder="Subtitle (optional)"
                  onChange={(e) => patchBrand({ cardSubtext: e.target.value })}
                />
                <div className="grad-row" style={{ marginTop: 8 }}>
                  <label>Font</label>
                  <select
                    className="export-select"
                    style={{ flex: 1, fontFamily: fontStackById(resolveFontId(brandConfig.fontFamily)) }}
                    value={resolveFontId(brandConfig.fontFamily)}
                    onChange={(e) => patchBrand({ fontFamily: e.target.value })}
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
                <button type="button" className="upload-btn" style={{ marginTop: 8 }} onClick={() => void pickBrandIcon()}>
                  <UploadIcon />
                  <span>{brandConfig.icon ? 'Replace logo' : 'Add logo'}</span>
                </button>
                {brandConfig.icon && (
                  <button
                    type="button"
                    className="ghost-btn"
                    style={{ marginTop: 6 }}
                    onClick={() => patchBrand({ icon: undefined })}
                  >
                    Remove logo
                  </button>
                )}
                <div className="grad-row" style={{ marginTop: 10 }}>
                  <label>Text</label>
                  <input
                    type="color"
                    value={brandConfig.textColor}
                    onChange={(e) => patchBrand({ textColor: e.target.value })}
                  />
                </div>
              </div>
            </div>
          )}

          {isBrand && brandConfig && (
            <div className="section-card">
              <div className="section-head"><span className="section-title">Style</span></div>
              <div className="section-body">
                <label className="grad-row" style={{ marginBottom: 6 }}><span>Plate</span></label>
                <div className="seg-tabs" style={{ marginBottom: 10 }}>
                  {([['solid', 'Card'], ['glass', 'Glass'], ['none', 'None']] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={`seg-tab${brandConfig.cardStyle === id ? ' active' : ''}`}
                      onClick={() => patchBrand({
                        cardStyle: id,
                        // A white plate needs dark copy; without one the copy
                        // sits on the backdrop and wants to be light. Flip it
                        // with the plate so no combination lands unreadable.
                        textColor: id === 'solid' ? '#0b0d12' : '#ffffff',
                      })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {brandConfig.cardStyle !== 'none' && (
                  <>
                    <NumRow
                      label="Box width"
                      value={Math.round(brandConfig.padX * 100)}
                      unit="%"
                      min={0}
                      max={45}
                      step={1}
                      onChange={(v) => patchBrand({ padX: v / 100 })}
                    />
                    <NumRow
                      label="Box height"
                      value={Math.round(brandConfig.padY * 100)}
                      unit="%"
                      min={0}
                      max={40}
                      step={1}
                      onChange={(v) => patchBrand({ padY: v / 100 })}
                    />
                    <p style={{ fontSize: 11, opacity: 0.6, margin: '2px 0 10px' }}>
                      Space around the logo and copy, so the box grows but never clips them.
                    </p>
                  </>
                )}
                <label className="grad-row" style={{ marginBottom: 6 }}><span>Pattern</span></label>
                <div className="seg-tabs">
                  {([['dots', 'Dots'], ['grid', 'Grid'], ['rings', 'Rings'], ['none', 'None']] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={`seg-tab${brandConfig.pattern === id ? ' active' : ''}`}
                      onClick={() => patchBrand({ pattern: id })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {brandConfig.pattern !== 'none' && (
                  <>
                    <div className="grad-row" style={{ marginTop: 10 }}>
                      <label>Colour</label>
                      <input
                        type="color"
                        value={brandConfig.patternColor}
                        onChange={(e) => patchBrand({ patternColor: e.target.value })}
                      />
                    </div>
                    <NumRow
                      label="Strength"
                      value={Math.round(brandConfig.patternOpacity * 100)}
                      unit="%"
                      min={0}
                      max={100}
                      step={5}
                      onChange={(v) => patchBrand({ patternOpacity: v / 100 })}
                    />
                  </>
                )}
              </div>
            </div>
          )}

          {isReveal && revealConfig ? (
            <>
              {/* REVEAL — TITLE */}
              <div className="section-card">
                <div className="section-head"><span className="section-title">Reveal · Title</span></div>
                <div className="section-body">
                  <input
                    className="export-select"
                    style={{ width: '100%' }}
                    type="text"
                    value={revealConfig.title}
                    placeholder="Title"
                    onChange={(e) => setRevealConfig({ ...revealConfig, title: e.target.value })}
                  />
                  <div className="grad-row" style={{ marginTop: 8 }}>
                    <label>Font</label>
                    <select
                      className="export-select"
                      style={{ flex: 1, fontFamily: fontStackById(resolveFontId(revealConfig.fontFamily)) }}
                      value={resolveFontId(revealConfig.fontFamily)}
                      onChange={(e) => setRevealConfig({ ...revealConfig, fontFamily: e.target.value })}
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
                  <NumRow
                    label="Title size"
                    value={Math.round((revealConfig.titleSizeRel ?? 0.085) * 1000)}
                    unit=""
                    min={40}
                    max={160}
                    step={5}
                    onChange={(v) => setRevealConfig({ ...revealConfig, titleSizeRel: v / 1000 })}
                  />
                  <p className="muted-note" style={{ fontSize: 11, opacity: 0.6, margin: '6px 0 0' }}>
                    {side === 'outro'
                      ? 'Outro plays the reveal in reverse for a symmetric close.'
                      : 'Title enters, slides left as images cascade in, then the hero image zooms in with callouts.'}
                  </p>
                </div>
              </div>

              {/* REVEAL — IMAGES */}
              <div className="section-card">
                <div className="section-head">
                  <span className="section-title">Reveal · Images</span>
                  <button className="link-action" onClick={() => void addRevealImage()}>+ Add image</button>
                </div>
                <div className="section-body">
                  {/* Auto-hero: pull the zooming image from the recording itself */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 12, opacity: 0.85 }}>
                      Hero from {side === 'outro' ? 'video end' : 'video start'}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!revealConfig.heroFromRecording}
                      className={`switch ${revealConfig.heroFromRecording ? 'on' : ''}`}
                      disabled={capturingHero}
                      onClick={() => void setHeroFromRecording(!revealConfig.heroFromRecording)}
                    >
                      <span className="switch-thumb" />
                    </button>
                  </div>

                  {revealConfig.heroFromRecording && revealConfig.heroImage && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <img src={revealConfig.heroImage.src} alt="hero frame" style={{ width: 52, height: 32, objectFit: 'cover', borderRadius: 4, background: '#0b0d12' }} />
                      <span style={{ flex: 1, fontSize: 12, opacity: 0.75 }}>Hero · zooms in to open the clip</span>
                      <button className="link-action" disabled={capturingHero} onClick={() => void setHeroFromRecording(true)} title="Re-capture the frame">
                        {capturingHero ? '…' : 'Re-capture'}
                      </button>
                    </div>
                  )}

                  {revealConfig.images.length === 0 && !revealConfig.heroFromRecording && (
                    <p className="muted-note" style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
                      Using placeholder images. Upload 3–5 of your own — they cascade in and the last one zooms to fill.
                    </p>
                  )}
                  {revealConfig.images.length === 0 && revealConfig.heroFromRecording && (
                    <p className="muted-note" style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
                      The video's opening frame zooms in to start the clip. Add images to cascade in front of it.
                    </p>
                  )}
                  {revealConfig.images.map((img, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <img src={img.src} alt={`image ${i + 1}`} style={{ width: 40, height: 52, objectFit: 'cover', borderRadius: 4, background: '#0b0d12' }} />
                      <span style={{ flex: 1, fontSize: 12, opacity: 0.75 }}>
                        Image {i + 1}{(!revealConfig.heroFromRecording && i === revealConfig.images.length - 1) ? ' · hero' : ''}
                      </span>
                      <button className="link-action" onClick={() => moveRevealImage(i, -1)} disabled={i === 0} title="Move up">↑</button>
                      <button className="link-action" onClick={() => moveRevealImage(i, 1)} disabled={i === revealConfig.images.length - 1} title="Move down">↓</button>
                      <button className="link-action" onClick={() => removeRevealImage(i)} title="Remove">✕</button>
                    </div>
                  ))}
                </div>
              </div>

              {/* REVEAL — CALLOUTS */}
              <div className="section-card">
                <div className="section-head">
                  <span className="section-title">Reveal · Callouts</span>
                  {revealConfig.labels.length < 3 && (
                    <button className="link-action" onClick={addRevealLabel}>+ Add</button>
                  )}
                </div>
                <div className="section-body">
                  <NumRow
                    label="Callout size"
                    value={Math.round((revealConfig.labelSizeRel ?? 0.032) * 1000)}
                    unit=""
                    min={18}
                    max={70}
                    step={2}
                    onChange={(v) => setRevealConfig({ ...revealConfig, labelSizeRel: v / 1000 })}
                  />
                  {revealConfig.labels.length === 0 && (
                    <p className="muted-note" style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
                      No callouts. Add up to 3 thin labels — each gets a leader line that draws on.
                    </p>
                  )}
                  {revealConfig.labels.map((label, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <input className="export-select" style={{ flex: 1 }} type="text" value={label} onChange={(e) => setRevealLabel(i, e.target.value)} />
                      <button className="link-action" onClick={() => removeRevealLabel(i)} title="Remove">✕</button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
          <>
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
  const anim = textAnimOf(item);
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
          {TEXT_ANIMS.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
        <input
          type="color"
          value={item.color}
          onChange={(e) => onChange({ ...item, color: e.target.value })}
          title="Text color"
        />
      </div>

      <div className="grad-row">
        <label>Align</label>
        <div className="seg-tabs three" style={{ flex: 1 }}>
          {(['left', 'center', 'right'] as const).map((a) => (
            <button
              key={a}
              className={`seg-tab ${(item.align ?? 'center') === a ? 'active' : ''}`}
              onClick={() => onChange(applyAlign(item, a))}
              title={`Align ${a}`}
            >
              {a === 'left' ? 'L' : a === 'center' ? 'C' : 'R'}
            </button>
          ))}
        </div>
      </div>

      <div className="grad-row">
        <label>Style</label>
        <div style={{ display: 'flex', gap: 6, flex: 1 }}>
          <button
            className={`seg-tab ${item.uppercase ? 'active' : ''}`}
            style={{ flex: 1 }}
            onClick={() => onChange({ ...item, uppercase: !item.uppercase })}
            title="Uppercase"
          >AA</button>
          <button
            className={`seg-tab ${item.shadow ? 'active' : ''}`}
            style={{ flex: 1 }}
            onClick={() => onChange({ ...item, shadow: !item.shadow })}
            title="Drop shadow"
          >Shadow</button>
        </div>
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
        label="Spacing"
        value={item.letterSpacing ?? 0}
        unit=""
        min={-2}
        max={24}
        step={0.5}
        onChange={(v) => onChange({ ...item, letterSpacing: v })}
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

function CardBackground({ value, onChange, onVideoPicked }: {
  value: Background;
  onChange: (bg: Background) => void;
  /** Fires with the clip's own length so the card can be sized to match it. */
  onVideoPicked?: (src: string, durationSec: number) => void;
}): JSX.Element {
  const tab: 'color' | 'gradient' | 'image' | 'video' =
    value.type === 'gradient' ? 'gradient'
      : value.type === 'image' ? 'image'
        : value.type === 'video' ? 'video' : 'color';
  const color = value.type === 'color' ? value.value : '#0b0d12';
  const from = value.type === 'gradient' ? value.from : '#7c5cff';
  const to = value.type === 'gradient' ? value.to : '#5cc4ff';
  const angle = value.type === 'gradient' && value.angle != null ? value.angle : 135;
  const videoSrc = value.type === 'video' ? value.src : null;
  const videoInputRef = useRef<HTMLInputElement | null>(null);

  const pickImage = async (): Promise<void> => {
    const bridge = window.klipe;
    if (!bridge?.openImageFile) return;
    const result = await bridge.openImageFile();
    if (!result || 'error' in result) return;
    onChange({ type: 'image', src: result.dataUrl, blur: 0 });
  };

  const readVideo = (file: File | null | undefined): void => {
    if (!file) return;
    // Object URL, NOT a data URL: the clip is referenced by a short blob: string
    // in the document. project.ts persists the bytes to a separate file and
    // rebuilds this URL on open (readCardVideoMedia / reconstructProject).
    const url = URL.createObjectURL(file);
    onChange({ type: 'video', src: url, blur: 0 });
    // Probe the length so the card can be trimmed to the clip: an ident that
    // runs 4s inside a 3s card would be cut off mid-animation.
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      const d = probe.duration;
      if (isFinite(d) && d > 0) onVideoPicked?.(url, d);
      probe.removeAttribute('src');
    };
    probe.src = url;
  };

  return (
    <div className="grad-block">
      <div className="seg-tabs">
        <button className={`seg-tab ${tab === 'color' ? 'active' : ''}`} onClick={() => onChange({ type: 'color', value: color, blur: 0 })}>Color</button>
        <button className={`seg-tab ${tab === 'gradient' ? 'active' : ''}`} onClick={() => onChange({ type: 'gradient', from, to, angle, blur: 0 })}>Gradient</button>
        <button className={`seg-tab ${tab === 'image' ? 'active' : ''}`} onClick={() => void pickImage()}>Image</button>
        <button className={`seg-tab ${tab === 'video' ? 'active' : ''}`} onClick={() => videoInputRef.current?.click()}>Video</button>
      </div>

      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={(e) => { readVideo(e.target.files?.[0]); e.target.value = ''; }}
      />

      {tab === 'video' && (
        <div style={{ marginTop: 8 }}>
          <button type="button" className="upload-btn" onClick={() => videoInputRef.current?.click()}>
            <UploadIcon />
            <span>{videoSrc ? 'Replace clip' : 'Choose a video…'}</span>
          </button>
          <p style={{ fontSize: 11, opacity: 0.6, margin: '6px 0 0' }}>
            {videoSrc
              ? 'The card length is matched to the clip. It loops if the card is longer.'
              : 'Drop in a finished animation (a logo ident, for example) to play as this card.'}
          </p>
        </div>
      )}

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
