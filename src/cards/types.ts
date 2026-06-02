/**
 * Intro / outro title cards.
 *
 * A card is a full-screen synthetic segment prepended (intro) or appended
 * (outro) to the recording. Unlike body overlays — which live in the editor's
 * *output-time* clock — a card's items are authored in **card-local time**
 * (0 = the moment the card starts), so a card is self-contained and its length
 * can change without rewriting every keyframe.
 *
 * Cards EXTEND the total video duration: a 3 s intro + a 3 s outro make a 26 s
 * recording export as 32 s. See `cards/timeline.ts` for the global-clock math.
 */

import type { Background } from '../types';
import type { Overlay } from '../overlays/types';

export interface Card {
  id: string;
  kind: 'intro' | 'outro' | 'mid';
  /** Card length in ms. The body is untouched; the total video grows by this. */
  durationMs: number;
  /** Reuses the editor Background type (color | gradient | wallpaper | image). */
  background: Background;
  /** Text + image layers; their times are relative to the card (0..durationMs). */
  items: Overlay[];
  /** Audio behaviour over the card. MVP only supports silence. */
  audio?: 'silence';
  /**
   * Crossfade duration (ms) blending the card with the recording. 0 = hard cut.
   * The fade overlaps the adjacent body: a card dissolves IN over the body just
   * before it and dissolves OUT over the body just after it (intro has no
   * "before", outro has no "after"). Card lengths are unchanged.
   */
  transitionMs?: number;
  /**
   * Body-output-time (ms) at which a MID-ROLL card is inserted — it splits the
   * recording there, pausing it full-screen, then resuming. Only meaningful for
   * cards in `CardSet.mid`; ignored for intro (anchored at 0) / outro (at end).
   */
  atBodyMs?: number;
}

/** Persisted on EditDocument. Either end may be null (no card there). */
export interface CardSet {
  intro: Card | null;
  outro: Card | null;
  /**
   * Mid-roll interstitials inserted at arbitrary points in the recording (each
   * carries its own `atBodyMs`). Absent on projects saved before the feature.
   */
  mid?: Card[];
}

export const DEFAULT_CARD_DURATION_MS = 3000;
export const MIN_CARD_DURATION_MS = 500;
export const MAX_CARD_DURATION_MS = 10000;

/** Crossfade defaults. 0 keeps a hard cut; capped so it can't swallow the body. */
export const DEFAULT_CARD_TRANSITION_MS = 500;
export const MAX_CARD_TRANSITION_MS = 2000;
