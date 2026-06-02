/**
 * Global-clock math for intro / mid-roll / outro cards.
 *
 * The editor's playhead is a GLOBAL output-time clock. The recording ("body")
 * keeps its own output-time (0 = first recorded frame), but cards are spliced
 * into the global clock and EXTEND it: an intro before the body, an outro after
 * it, and any number of mid-roll interstitials that split the body at a chosen
 * body-output-time (pausing the recording full-screen, then resuming).
 *
 * Everything is modelled as an ordered list of SEGMENTS on the global clock —
 * body chunks interleaved with card segments. Body content (overlays, zoom,
 * music, audio FX) is authored in body-output-time and mapped to/from the
 * global clock with `bodyToGlobalMs` / `globalToBodyMs`, which account for every
 * card before a given point (not just a single intro offset).
 */

import type { Card, CardSet } from './types';

export interface BodySegment {
  kind: 'body';
  gStartMs: number;
  gEndMs: number;
  /** Body-output-time span this chunk covers. */
  bodyStartMs: number;
  bodyEndMs: number;
}

export interface CardSegment {
  kind: 'card';
  slot: 'intro' | 'mid' | 'outro';
  gStartMs: number;
  gEndMs: number;
  card: Card;
  /** Body-output-time the card is anchored at (intro=0, outro=bodyMs, mid=atBodyMs). */
  atBodyMs: number;
}

export type ClockSegment = BodySegment | CardSegment;

export interface CardTimeline {
  /** Intro length in ms (0 if no intro). */
  introMs: number;
  /** Body (recording) length in ms = totalOutputDuration(fragments) * 1000. */
  bodyMs: number;
  /** Outro length in ms (0 if no outro). */
  outroMs: number;
  /** Sum of all segment lengths (intro + body + outro + every mid card). */
  totalMs: number;
  /** Ordered global-clock segments. */
  segments: ClockSegment[];
}

export type Phase =
  | { kind: 'body'; bodyOutSec: number }
  | { kind: 'intro' | 'mid' | 'outro'; localMs: number; card: Card };

/** A card with a non-positive duration is treated as absent. */
function cardMs(card: Card | null | undefined): number {
  if (!card) return 0;
  return card.durationMs > 0 ? card.durationMs : 0;
}

/** Sorted, clamped mid-roll cards with a positive duration. */
function midList(cards: CardSet | null | undefined, bodyMs: number): Array<{ card: Card; at: number }> {
  const list = cards?.mid ?? [];
  return list
    .filter((c) => c && c.durationMs > 0)
    .map((c) => ({ card: c, at: Math.max(0, Math.min(bodyMs, c.atBodyMs ?? 0)) }))
    .sort((a, b) => a.at - b.at);
}

export function buildCardTimeline(
  cards: CardSet | null | undefined,
  bodySec: number,
): CardTimeline {
  const bodyMs = Math.max(0, bodySec * 1000);
  const introMs = cardMs(cards?.intro);
  const outroMs = cardMs(cards?.outro);
  const mids = midList(cards, bodyMs);

  const segments: ClockSegment[] = [];
  let g = 0;

  if (introMs > 0 && cards?.intro) {
    segments.push({ kind: 'card', slot: 'intro', gStartMs: 0, gEndMs: introMs, card: cards.intro, atBodyMs: 0 });
    g = introMs;
  }

  let prevBody = 0;
  for (const m of mids) {
    const chunk = Math.max(0, m.at - prevBody);
    segments.push({ kind: 'body', gStartMs: g, gEndMs: g + chunk, bodyStartMs: prevBody, bodyEndMs: m.at });
    g += chunk;
    segments.push({ kind: 'card', slot: 'mid', gStartMs: g, gEndMs: g + m.card.durationMs, card: m.card, atBodyMs: m.at });
    g += m.card.durationMs;
    prevBody = m.at;
  }
  // Final (or only) body chunk.
  const tail = Math.max(0, bodyMs - prevBody);
  segments.push({ kind: 'body', gStartMs: g, gEndMs: g + tail, bodyStartMs: prevBody, bodyEndMs: bodyMs });
  g += tail;

  if (outroMs > 0 && cards?.outro) {
    segments.push({ kind: 'card', slot: 'outro', gStartMs: g, gEndMs: g + outroMs, card: cards.outro, atBodyMs: bodyMs });
    g += outroMs;
  }

  return { introMs, bodyMs, outroMs, totalMs: g, segments };
}

/** The segment containing a global time (clamped; end maps to the last segment). */
function segmentAt(tl: CardTimeline, globalMs: number): ClockSegment {
  const t = Math.max(0, Math.min(tl.totalMs, globalMs));
  for (const s of tl.segments) {
    if (t >= s.gStartMs && t < s.gEndMs) return s;
  }
  return tl.segments[tl.segments.length - 1]!;
}

/** The active global-clock segment (body chunk or card) at a global time. */
export function activeSegment(tl: CardTimeline, globalMs: number): ClockSegment {
  return segmentAt(tl, globalMs);
}

export function resolvePhase(tl: CardTimeline, globalMs: number): Phase {
  const t = Math.max(0, Math.min(tl.totalMs, globalMs));
  const s = segmentAt(tl, t);
  if (s.kind === 'body') {
    return { kind: 'body', bodyOutSec: (s.bodyStartMs + (t - s.gStartMs)) / 1000 };
  }
  return { kind: s.slot, localMs: t - s.gStartMs, card: s.card };
}

/**
 * Global output-ms → body output-ms. Inside a body chunk it's the chunk's body
 * time; inside a card the recording is frozen at the card's anchor.
 */
export function globalToBodyMs(tl: CardTimeline, globalMs: number): number {
  const t = Math.max(0, Math.min(tl.totalMs, globalMs));
  const s = segmentAt(tl, t);
  if (s.kind === 'body') return s.bodyStartMs + (t - s.gStartMs);
  return s.atBodyMs;
}

/** Body output-ms → global output-ms (earliest body chunk containing it). */
export function bodyToGlobalMs(tl: CardTimeline, bodyMs: number): number {
  const b = Math.max(0, Math.min(tl.bodyMs, bodyMs));
  for (const s of tl.segments) {
    if (s.kind === 'body' && b >= s.bodyStartMs && b <= s.bodyEndMs) {
      return s.gStartMs + (b - s.bodyStartMs);
    }
  }
  return tl.totalMs;
}

export const globalToBodySec = (tl: CardTimeline, globalSec: number): number =>
  globalToBodyMs(tl, globalSec * 1000) / 1000;
export const bodyToGlobalSec = (tl: CardTimeline, bodySec: number): number =>
  bodyToGlobalMs(tl, bodySec * 1000) / 1000;

// ---------------------------------------------------------------------------
// Crossfade transitions
//
// A card's `transitionMs` crossfades it with the recording WITHOUT changing the
// card length or the total duration. The fade overlaps the adjacent body:
//   • a card dissolves IN ("enter", alpha 0→1) over the body chunk just before
//     it, and OUT ("exit", alpha 1→0) over the body chunk just after it.
//   • intro has no body before → only an exit fade; outro has no body after →
//     only an enter fade; mid cards have both.
// Each fade is clamped to half its adjacent body chunk so two neighbouring
// cards' fades can never overlap. `alpha` is the card layer's opacity over the
// live recording; `localMs` is the card-local time to sample its items at.
// ---------------------------------------------------------------------------

export interface CardTransition {
  /** enter: card appearing (alpha 0→1). exit: card leaving (alpha 1→0). */
  kind: 'enter' | 'exit';
  alpha: number;
  card: Card;
  /** Card-local ms to sample the card's items at during the fade. */
  localMs: number;
}

function transitionMsFor(card: Card | null | undefined): number {
  if (!card || card.durationMs <= 0) return 0;
  const t = card.transitionMs ?? 0;
  return t > 0 ? t : 0;
}

export function resolveTransition(tl: CardTimeline, globalMs: number): CardTransition | null {
  const t = Math.max(0, Math.min(tl.totalMs, globalMs));
  const segs = tl.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s.kind !== 'card') continue;
    const tmax = transitionMsFor(s.card);
    if (tmax <= 0) continue;

    const before = i > 0 && segs[i - 1]!.kind === 'body' ? (segs[i - 1] as BodySegment) : null;
    const after = i < segs.length - 1 && segs[i + 1]!.kind === 'body' ? (segs[i + 1] as BodySegment) : null;

    // Enter fade — over the END of the preceding body chunk.
    if (before) {
      const enterT = Math.min(tmax, (before.gEndMs - before.gStartMs) / 2);
      if (enterT > 0 && t >= s.gStartMs - enterT && t < s.gStartMs) {
        const p = (t - (s.gStartMs - enterT)) / enterT;
        return { kind: 'enter', alpha: p, card: s.card, localMs: 0 };
      }
    }
    // Exit fade — over the START of the following body chunk.
    if (after) {
      const exitT = Math.min(tmax, (after.gEndMs - after.gStartMs) / 2);
      if (exitT > 0 && t >= s.gEndMs && t < s.gEndMs + exitT) {
        const p = (t - s.gEndMs) / exitT;
        return { kind: 'exit', alpha: 1 - p, card: s.card, localMs: s.card.durationMs };
      }
    }
  }
  return null;
}
