/**
 * Ready-made, professional intro/outro card templates. Each fills in a
 * background plus animated text so the user gets a polished starting point and
 * can edit on top. Templates are kind-aware (intro vs outro default copy).
 */

import type { Overlay } from '../overlays/types';
import type { Card } from './types';
import { DEFAULT_CARD_DURATION_MS } from './types';
import { createCard, createCardText, sequenceWindows } from './factories';
import { buildRevealCard, DEFAULT_REVEAL_CONFIG } from './reveal';
import { buildBrandCard, BRAND_PRESETS } from './brand-card';

export interface CardTemplate {
  id: string;
  label: string;
  build: (kind: 'intro' | 'outro') => Card;
  /** Slots this template can be used in. Absent ⇒ all of them. */
  slots?: ReadonlyArray<'intro' | 'outro' | 'mid'>;
}

const intro = (k: 'intro' | 'outro', a: string, b: string): string => (k === 'intro' ? a : b);

export const CARD_TEMPLATES: ReadonlyArray<CardTemplate> = [
  {
    id: 'minimal-dark',
    label: 'Minimal',
    build: (kind) => {
      const card = createCard(kind);
      card.background = { type: 'color', value: '#0b0d12', blur: 0 };
      const title = intro(kind, 'Welcome', 'Thanks for watching');
      card.items = [
        createCardText([], title, 0, card.durationMs, {
          y: 0.5, sizeRel: 0.085, weight: 800, color: '#ffffff',
        }),
      ];
      return card;
    },
  },
  {
    id: 'clean-white',
    label: 'Clean White',
    build: (kind) => {
      const card = createCard(kind);
      card.background = { type: 'color', value: '#ffffff', blur: 0 };
      const items: Overlay[] = [];
      const [a, b] = sequenceWindows(2, card.durationMs);
      items.push(createCardText(items, intro(kind, 'Save time', 'Try it yourself'), a!.fromMs, a!.toMs, {
        y: 0.46, sizeRel: 0.08, weight: 800, color: '#0b0d12',
      }));
      items.push(createCardText(items, intro(kind, 'with always-on agents', 'Now in the Agents Window'), b!.fromMs, b!.toMs, {
        y: 0.5, sizeRel: 0.06, weight: 600, color: '#3a3f4b',
      }));
      card.items = items;
      return card;
    },
  },
  {
    id: 'gradient-bold',
    label: 'Bold Gradient',
    build: (kind) => {
      const card = createCard(kind);
      card.background = { type: 'gradient', from: '#7c5cff', to: '#5cc4ff', angle: 135, blur: 0 };
      const items: Overlay[] = [];
      const [a, b] = sequenceWindows(2, card.durationMs);
      items.push(createCardText(items, intro(kind, 'Introducing', 'That’s a wrap'), a!.fromMs, a!.toMs, {
        y: 0.44, sizeRel: 0.06, weight: 600, color: '#ffffff',
      }));
      items.push(createCardText(items, intro(kind, 'Your Product', 'Follow for more'), b!.fromMs, b!.toMs, {
        y: 0.52, sizeRel: 0.1, weight: 900, color: '#ffffff',
      }));
      card.items = items;
      return card;
    },
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    build: (kind) => {
      const card = createCard(kind);
      card.background = { type: 'color', value: '#0b0d12', blur: 0 };
      card.items = [
        createCardText([], intro(kind, '> initializing demo…', '> see you next time_'), 0, card.durationMs, {
          y: 0.5, sizeRel: 0.06, weight: 600, color: '#5cffb1', mono: true, typewriter: true,
        }),
      ];
      return card;
    },
  },
  {
    id: 'reveal',
    label: 'Reveal',
    build: (kind) => buildRevealCard(kind, {
      ...DEFAULT_REVEAL_CONFIG,
      title: intro(kind, DEFAULT_REVEAL_CONFIG.title, 'Thanks for watching'),
    }),
  },
  // Brand-card family: same painter, different pattern / plate presets.
  ...BRAND_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    build: (kind: 'intro' | 'outro') => buildBrandCard(p.cfg, kind),
  })),
];

/** Templates offered for a given slot. */
export function templatesFor(slot: 'intro' | 'outro' | 'mid'): ReadonlyArray<CardTemplate> {
  return CARD_TEMPLATES.filter((t) => !t.slots || t.slots.includes(slot));
}

export function buildTemplate(id: string, kind: 'intro' | 'outro'): Card {
  const tpl = CARD_TEMPLATES.find((t) => t.id === id);
  if (tpl) return tpl.build(kind);
  // Fallback: a blank card of the default length.
  const card = createCard(kind);
  card.durationMs = DEFAULT_CARD_DURATION_MS;
  return card;
}
