/**
 * The "brand card" outro template: a halftone dot field with a white logo card
 * scaling up in the centre.
 *
 * Structurally this is a completely ordinary card — it extends the timeline the
 * usual way, crossfades with the recording the usual way, and needs nothing
 * from `cards/timeline.ts`. The only thing special about it is that its pixels
 * come from `drawBrandReveal` instead of a background fill plus OverlayStage
 * items, which is why the three card painters branch on `template`.
 */

import type { Card, BrandCardConfig } from './types';
import { DEFAULT_BRAND_CARD_CONFIG, DEFAULT_CARD_TRANSITION_MS } from './types';

/** Long enough for the card to land and hold for a beat. */
export const DEFAULT_BRAND_CARD_MS = 2600;

let counter = 0;

export function buildBrandCard(
  cfg: BrandCardConfig = DEFAULT_BRAND_CARD_CONFIG,
  kind: 'intro' | 'outro' = 'outro',
): Card {
  counter += 1;
  return {
    id: `card-brand-${Date.now().toString(36)}-${counter}`,
    kind,
    durationMs: DEFAULT_BRAND_CARD_MS,
    transitionMs: DEFAULT_CARD_TRANSITION_MS,
    background: cfg.background,
    // Everything is painted by lib/brand-reveal.ts, so there are no overlay
    // items to author or drag.
    items: [],
    audio: 'silence',
    template: 'brand-card',
    brandConfig: cfg,
  };
}

/** Ready-made looks. Each is just a preset of the pattern / plate knobs. */
export const BRAND_PRESETS: ReadonlyArray<{ id: string; label: string; cfg: BrandCardConfig }> = [
  {
    id: 'brand-card',
    label: 'Brand Card',
    cfg: DEFAULT_BRAND_CARD_CONFIG,
  },
  {
    id: 'brand-grid',
    label: 'Blueprint',
    cfg: {
      ...DEFAULT_BRAND_CARD_CONFIG,
      background: { type: 'gradient', from: '#10131a', to: '#242c3b', angle: 160, blur: 0 },
      pattern: 'grid',
      patternColor: '#6f83a8',
      patternOpacity: 0.75,
    },
  },
  {
    id: 'brand-rings',
    label: 'Spotlight',
    cfg: {
      ...DEFAULT_BRAND_CARD_CONFIG,
      background: { type: 'gradient', from: '#1b1430', to: '#43305c', angle: 165, blur: 0 },
      pattern: 'rings',
      patternColor: '#d3b0ea',
      patternOpacity: 0.5,
    },
  },
  {
    id: 'brand-glass',
    label: 'Glass',
    cfg: {
      ...DEFAULT_BRAND_CARD_CONFIG,
      background: { type: 'gradient', from: '#0b1a2b', to: '#1d4266', angle: 155, blur: 0 },
      pattern: 'dots',
      patternColor: '#8fc4e8',
      patternOpacity: 0.7,
      cardStyle: 'glass',
      textColor: '#ffffff',
    },
  },
  {
    id: 'brand-mark',
    label: 'Mark',
    cfg: {
      ...DEFAULT_BRAND_CARD_CONFIG,
      background: { type: 'color', value: '#f4f2ee', blur: 0 },
      pattern: 'none',
      cardStyle: 'none',
      textColor: '#12141a',
    },
  },
];

export function brandPreset(id: string): BrandCardConfig | null {
  return BRAND_PRESETS.find((p) => p.id === id)?.cfg ?? null;
}

/** Normalize a config that may be partial, hand-edited, or from an older build. */
export function resolveBrandConfig(
  c: Partial<BrandCardConfig> | null | undefined,
): BrandCardConfig {
  // `dotColor` / `dotOpacity` were the pre-pattern field names; map them so a
  // project saved before the extra styles keeps the look it was given.
  const legacy = c as (Partial<BrandCardConfig> & { dotColor?: string; dotOpacity?: number }) | null | undefined;
  const merged: BrandCardConfig = {
    ...DEFAULT_BRAND_CARD_CONFIG,
    ...(legacy?.dotColor ? { patternColor: legacy.dotColor } : {}),
    ...(typeof legacy?.dotOpacity === 'number' ? { patternOpacity: legacy.dotOpacity } : {}),
    ...(c ?? {}),
  };
  return {
    ...merged,
    patternOpacity: Math.max(0, Math.min(1, merged.patternOpacity)),
    padX: Math.max(0, Math.min(0.45, merged.padX)),
    padY: Math.max(0, Math.min(0.4, merged.padY)),
  };
}

/** The brand config to paint a card with, or null if it isn't one. */
export function brandConfigOf(card: Card | null | undefined): BrandCardConfig | null {
  if (!card || card.template !== 'brand-card' || !card.brandConfig) return null;
  return resolveBrandConfig(card.brandConfig);
}
