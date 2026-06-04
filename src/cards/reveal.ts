/**
 * "Reveal" card builder — a multi-stage choreography for intros/outros:
 *
 *   1. Title fades/rises in centred.
 *   2. Title slides left while images cascade in from the right, one by one,
 *      and stack into an overlapping pile.
 *   3. Title exits fully left; the pile collapses and recentres.
 *   4. The front ("hero") image zooms up to fill while the others fade out.
 *   5. Thin leader lines draw on toward fine callout labels.
 *
 * The whole sequence is expressed as keyframe tracks on plain Text / Image /
 * Line overlays, so the existing `OverlayStage.renderAt` animates it identically
 * in the live preview and the export — no bespoke render code.
 *
 * Outro cards mirror the choreography in time (`reverse`) for a symmetric close.
 *
 * The card is PARAMETRIC: it stores `revealConfig` and the items are regenerated
 * from it, so the panel edits the config rather than the raw keyframes.
 */

import type {
  Easing,
  ImageOverlay,
  Keyframe,
  LineOverlay,
  Overlay,
  OverlayTransform,
  TextOverlay,
  Vec2,
} from '../overlays/types';
import { createImageOverlay, createTextOverlay } from '../overlays/factories';
import type { Background } from '../types';
import { createCard } from './factories';
import type { Card, RevealConfig, RevealImageRef } from './types';

/** A reveal needs room for five stages; this is the default card length. */
export const REVEAL_DEFAULT_DURATION_MS = 5000;

/** Stage boundaries as fractions of the card duration. */
const S = {
  titleIn: 0.12,
  cascadeEnd: 0.45,
  recenterEnd: 0.62,
  zoomEnd: 0.82,
};

const TITLE_COLOR = '#0b0d12';
const DEFAULT_ACCENT = '#3a3f4b';
/** Cascade image long-edge as a fraction of canvas height (pile size). */
const IMAGE_SIZE_REL = 0.46;

/** Vertical-gradient portrait placeholder, so the template animates before the
 * user uploads their own images. */
function svgPlaceholder(from: string, to: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='800' height='1040'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>` +
    `<stop offset='0' stop-color='${from}'/><stop offset='1' stop-color='${to}'/>` +
    `</linearGradient></defs><rect width='800' height='1040' fill='url(#g)'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const PLACEHOLDER_IMAGES: RevealImageRef[] = [
  { src: svgPlaceholder('#e9d5ff', '#c4b5fd'), naturalWidth: 800, naturalHeight: 1040 },
  { src: svgPlaceholder('#bfdbfe', '#93c5fd'), naturalWidth: 800, naturalHeight: 1040 },
  { src: svgPlaceholder('#fbcfe8', '#f9a8d4'), naturalWidth: 800, naturalHeight: 1040 },
];

/** Sensible starting config for the template grid. */
export const DEFAULT_REVEAL_CONFIG: RevealConfig = {
  title: 'Ideogram V4',
  images: [],
  labels: ['Accurate Text Rendering', 'Real-time Preview', 'No Watermark'],
};

let lineCounter = 0;

function numTrack(keys: Keyframe<number>[]): { keys: Keyframe<number>[] } {
  return { keys };
}
function vecTrack(keys: Keyframe<Vec2>[]): { keys: Keyframe<Vec2>[] } {
  return { keys };
}

/**
 * Build a fully-choreographed reveal card. `durationMs` is the clock the
 * keyframes are laid out against (so changing the card length re-fits the
 * timing). Outro cards mirror the sequence in time.
 */
export function buildRevealCard(
  kind: 'intro' | 'outro',
  config: RevealConfig,
  durationMs: number = REVEAL_DEFAULT_DURATION_MS,
): Card {
  const reverse = kind === 'outro';
  const D = Math.max(1500, Math.round(durationMs));
  const at = (frac: number): number => Math.round(frac * D);
  const accent = config.accent ?? DEFAULT_ACCENT;
  const background: Background = config.background ?? { type: 'color', value: '#ffffff', blur: 0 };

  // The cascade list ends with the HERO (the image that zooms). With an auto
  // hero the captured recording frame is appended as the hero and the uploads
  // become supporting images; otherwise the last upload (or a placeholder set)
  // is the hero.
  const autoHero = !!(config.heroFromRecording && config.heroImage);
  const images: RevealImageRef[] = autoHero
    ? [...config.images, config.heroImage!]
    : (config.images.length ? config.images : PLACEHOLDER_IMAGES);
  const n = images.length;
  const heroIndex = n - 1;

  const items: Overlay[] = [];

  // ---- Stage 1+2+3: the title -------------------------------------------------
  const titleBase = createTextOverlay(items, config.title || 'Your Title');
  const titleItem: TextOverlay = {
    ...titleBase,
    z: 100,
    sizeRel: config.titleSizeRel ?? 0.085,
    weight: 800,
    color: TITLE_COLOR,
    align: 'center',
    fontFamily: config.fontFamily,
    visibleFrom: 0,
    visibleTo: D,
    base: { ...titleBase.base, x: 0.5, y: 0.5 },
    transform: {
      position: vecTrack([
        { t: 0, value: { x: 0.5, y: 0.55 } },
        { t: at(S.titleIn), value: { x: 0.5, y: 0.5 }, easing: 'easeOutQuint' },
        { t: at(S.cascadeEnd), value: { x: 0.26, y: 0.5 }, easing: 'easeInOutCubic' },
        { t: at(S.recenterEnd), value: { x: -0.4, y: 0.5 }, easing: 'easeInOutCubic' },
      ]),
      opacity: numTrack([
        { t: 0, value: 0 },
        { t: at(0.08), value: 1, easing: 'easeOutQuint' },
        { t: at(0.5), value: 1 },
        { t: at(S.recenterEnd - 0.02), value: 0, easing: 'easeOutQuint' },
      ]),
    },
  };
  items.push(titleItem);

  // ---- Stage 2+3+4: the cascade images ---------------------------------------
  const cascadeSpan = at(S.cascadeEnd) - at(S.titleIn);
  const stagger = n > 0 ? Math.round((cascadeSpan * 0.55) / n) : 0;
  const enterDur = Math.min(650, Math.round(cascadeSpan / Math.max(1, n)) + 250);

  images.forEach((img, i) => {
    const rel = i - (n - 1) / 2; // centred index, -.. 0 .. +
    const slotX = 0.6 + rel * 0.09;
    const slotY = 0.5 + rel * 0.065;
    const tilt = rel * 0.07; // radians
    const enterStart = at(S.titleIn) + i * stagger;
    const isHero = i === heroIndex;

    const base = createImageOverlay(items, img.src, img.naturalWidth, img.naturalHeight, `Image ${i + 1}`);

    const opacityKeys: Keyframe<number>[] = [
      { t: enterStart, value: 0 },
      { t: enterStart + 180, value: 1, easing: 'easeOutQuint' },
    ];
    if (!isHero) {
      opacityKeys.push(
        { t: at(S.recenterEnd), value: 1 },
        { t: at(S.zoomEnd - 0.1), value: 0, easing: 'easeOutQuint' },
      );
    }

    const transform: OverlayTransform = {
      position: vecTrack([
        { t: enterStart, value: { x: 1.3, y: slotY } },
        { t: enterStart + enterDur, value: { x: slotX, y: slotY }, easing: 'easeOutQuint' },
        { t: at(S.cascadeEnd), value: { x: slotX, y: slotY } },
        { t: at(S.recenterEnd), value: { x: 0.5, y: 0.5 }, easing: 'easeInOutCubic' },
      ]),
      rotation: numTrack([
        { t: enterStart, value: tilt },
        { t: at(S.cascadeEnd), value: tilt },
        { t: at(S.recenterEnd), value: 0, easing: 'easeInOutCubic' },
      ]),
      opacity: numTrack(opacityKeys),
    };
    if (isHero) {
      if (autoHero) {
        // Zoom the captured frame until it fully covers the canvas by the END of
        // the card, so the last frame equals the recording's first frame and the
        // intro opens cleanly into the video. Cover scale assumes the frame's
        // aspect matches the canvas (it is a capture of it): the binding edge is
        // reached when the image height == canvas height.
        const aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
        const cover = Math.max(1, aspect) / IMAGE_SIZE_REL;
        transform.scale = numTrack([
          { t: at(S.recenterEnd), value: 1 },
          { t: D, value: cover, easing: 'easeInOutCubic' },
        ]);
      } else {
        transform.scale = numTrack([
          { t: at(S.recenterEnd), value: 1 },
          { t: at(S.zoomEnd), value: 1.8, easing: 'easeOutExpo' },
        ]);
      }
    }

    const item: ImageOverlay = {
      ...base,
      z: 10 + i,
      sizeRel: IMAGE_SIZE_REL,
      visibleFrom: enterStart,
      visibleTo: D,
      base: { ...base.base, x: slotX, y: slotY },
      transform,
    };
    items.push(item);
  });

  // ---- Stage 5: callout leader lines + thin labels ---------------------------
  const labels = config.labels.slice(0, 3);
  const m = labels.length;
  labels.forEach((label, j) => {
    const rel = m > 1 ? j / (m - 1) : 0.5; // 0..1 down the right side
    const ly = 0.32 + rel * 0.36;
    const lineStart = at(S.zoomEnd) + j * 120;

    const line: LineOverlay = {
      id: `reveal-${kind}-line-${lineCounter++}`,
      name: `Callout ${j + 1}`,
      type: 'line',
      z: 200 + j * 2,
      from: { x: 0.6, y: ly },
      to: { x: 0.72, y: ly },
      thicknessRel: 0.004,
      color: accent,
      visibleFrom: lineStart,
      visibleTo: D,
      base: { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, blur: 0 },
      transform: {
        opacity: numTrack([
          { t: lineStart, value: 0 },
          { t: lineStart + 120, value: 1, easing: 'easeOutQuint' },
        ]),
        // The `scale` track is the 0..1 draw-on progress for line overlays.
        scale: numTrack([
          { t: lineStart, value: 0 },
          { t: lineStart + 350, value: 1, easing: 'easeOutQuint' },
        ]),
      },
    };
    items.push(line);

    const labelBase = createTextOverlay(items, label);
    const labelItem: TextOverlay = {
      ...labelBase,
      z: 201 + j * 2,
      sizeRel: config.labelSizeRel ?? 0.032,
      weight: 400,
      color: accent,
      align: 'left',
      fontFamily: config.fontFamily,
      visibleFrom: lineStart + 150,
      visibleTo: D,
      base: { ...labelBase.base, x: 0.735, y: ly },
      transform: {
        opacity: numTrack([
          { t: lineStart + 150, value: 0 },
          { t: lineStart + 400, value: 1, easing: 'easeOutQuint' },
        ]),
      },
    };
    items.push(labelItem);
  });

  const card = createCard(kind);
  card.durationMs = D;
  card.background = background;
  card.template = 'reveal';
  card.revealConfig = config;
  card.items = reverse ? items.map((o) => mirrorItem(o, D)) : items;
  return card;
}

// ---------------------------------------------------------------------------
// Time mirroring for outro cards
// ---------------------------------------------------------------------------

/** Mirror a keyframe track across the card's midpoint (t' = D - t). Easings are
 * reset to a symmetric curve so the reversed motion still reads smoothly. */
function mirrorTrack<T>(
  track: { keys: Keyframe<T>[] } | undefined,
  D: number,
): { keys: Keyframe<T>[] } | undefined {
  if (!track) return undefined;
  const ease: Easing = 'easeInOutCubic';
  const keys = track.keys
    .map((k) => ({ t: Math.max(0, D - k.t), value: k.value, easing: ease }))
    .sort((a, b) => a.t - b.t);
  return { keys };
}

/** Mirror an overlay's animation (and visibility window) in time. */
function mirrorItem(o: Overlay, D: number): Overlay {
  const vf = o.visibleFrom;
  const vt = o.visibleTo;
  const tx = o.transform;
  return {
    ...o,
    visibleFrom: vt != null ? Math.max(0, D - vt) : o.visibleFrom,
    visibleTo: vf != null ? Math.max(0, D - vf) : o.visibleTo,
    transform: {
      position: mirrorTrack(tx.position, D),
      scale: mirrorTrack(tx.scale, D),
      rotation: mirrorTrack(tx.rotation, D),
      opacity: mirrorTrack(tx.opacity, D),
      blur: mirrorTrack(tx.blur, D),
    },
  } as Overlay;
}
