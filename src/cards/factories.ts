/**
 * Card factories — build cards and their text/image items.
 *
 * Item times are CARD-LOCAL (0 = card start). Text items get an
 * appear → hold → disappear opacity envelope so sequential blocks can swap
 * cleanly; the typewriter helper layers a per-character reveal on top.
 */

import type { Overlay, TextOverlay } from '../overlays/types';
import { createTextOverlay } from '../overlays/factories';
import { makeTypewriter } from '../overlays/engine/typewriter';
import type { Card } from './types';
import { DEFAULT_CARD_DURATION_MS, DEFAULT_CARD_TRANSITION_MS } from './types';

let counter = 0;
function cardItemId(kind: string): string {
  counter += 1;
  return `card-${kind}-${Date.now().toString(36)}-${counter}`;
}

export function createCard(kind: 'intro' | 'outro'): Card {
  return {
    id: cardItemId(kind),
    kind,
    durationMs: DEFAULT_CARD_DURATION_MS,
    transitionMs: DEFAULT_CARD_TRANSITION_MS,
    background: { type: 'color', value: '#0b0d12', blur: 0 },
    items: [],
    audio: 'silence',
  };
}

/** A mid-roll interstitial anchored at `atBodyMs` (body-output-time). */
export function createMidCard(atBodyMs: number): Card {
  return {
    id: cardItemId('mid'),
    kind: 'mid',
    durationMs: DEFAULT_CARD_DURATION_MS,
    transitionMs: DEFAULT_CARD_TRANSITION_MS,
    background: { type: 'color', value: '#0b0d12', blur: 0 },
    items: [],
    audio: 'silence',
    atBodyMs: Math.max(0, Math.round(atBodyMs)),
  };
}

export interface TextItemOptions {
  y?: number;
  sizeRel?: number;
  color?: string;
  weight?: number;
  mono?: boolean;
  /** Cross-fade duration at each edge, ms. Clamped to a third of the window. */
  fadeMs?: number;
  typewriter?: boolean;
}

/**
 * A text overlay that fades in, holds, then fades out across
 * `[fromMs, toMs]` (card-local). With `typewriter`, the text also reveals
 * character-by-character from `fromMs`.
 */
export function createCardText(
  existing: Overlay[],
  text: string,
  fromMs: number,
  toMs: number,
  opts: TextItemOptions = {},
): TextOverlay {
  const base = createTextOverlay(existing, text);
  const span = Math.max(1, toMs - fromMs);
  const fade = Math.min(opts.fadeMs ?? 350, span / 3);
  const overlay: TextOverlay = {
    ...base,
    visibleFrom: fromMs,
    visibleTo: toMs,
    sizeRel: opts.sizeRel ?? base.sizeRel,
    color: opts.color ?? base.color,
    weight: opts.weight ?? base.weight,
    mono: opts.mono ?? base.mono,
    base: { ...base.base, y: opts.y ?? base.base.y },
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
  };
  if (opts.typewriter) {
    overlay.typewriter = makeTypewriter(text, fromMs, span);
  }
  return overlay;
}

/**
 * Distribute N text blocks back-to-back across a duration so each appears,
 * disappears, then the next appears (sequential swap). Returns card-local
 * windows; the last block runs to the end.
 */
export function sequenceWindows(
  count: number,
  durationMs: number,
  gapMs = 120,
): Array<{ fromMs: number; toMs: number }> {
  if (count <= 0) return [];
  if (count === 1) return [{ fromMs: 0, toMs: durationMs }];
  const slot = durationMs / count;
  const out: Array<{ fromMs: number; toMs: number }> = [];
  for (let i = 0; i < count; i++) {
    const from = Math.round(i * slot);
    const to = Math.round(i === count - 1 ? durationMs : (i + 1) * slot - gapMs);
    out.push({ fromMs: from, toMs: Math.max(from + 1, to) });
  }
  return out;
}
