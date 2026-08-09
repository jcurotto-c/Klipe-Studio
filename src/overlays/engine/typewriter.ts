/**
 * Timing for the typewriter reveal.
 *
 * A linear `floor(elapsed × cps)` reveal reads as a wipe, not as typing. Three
 * things make it read as a person at a keyboard, and all three are here:
 *
 *   1. A HUMAN SPEED. Typing is 5–10 characters per second; the old formula
 *      scaled speed with text length so every line finished in a third of a
 *      second regardless of how much there was to type.
 *   2. RHYTHM. Keystrokes aren't evenly spaced, and the gaps that read loudest
 *      are the ones at word ends and after punctuation — that's where a typist
 *      actually pauses.
 *   3. A CARET. Solid while typing, blinking once the line lands.
 *
 * Every wobble is derived from the character index by hash, never from
 * `Math.random`: the preview and the export must produce identical frames for
 * the same time, and the exporter renders each frame independently.
 */

import type { Typewriter } from '../types';

/**
 * Speeds in characters per second. The floor is a slow-but-deliberate typist;
 * the ceiling is as fast as it can go while still reading as keystrokes rather
 * than as a wipe.
 */
const MIN_CPS = 9;
const MAX_CPS = 26;
/** Share of a text block's visible window the typing should occupy. */
const WINDOW_FILL = 0.6;

const DEFAULT_HUMANIZE = 0.45;
/** Full on/off cycle of the idle caret, ms. */
const CARET_PERIOD_MS = 1060;
/** Occupies one cell in a mono font, so blinking can't shift the layout. */
export const CARET_CHAR = '|';

/**
 * Build a typewriter for `text` that lands comfortably inside its own visible
 * window. Shared by the card factory and the panel's animation picker so the
 * two can't drift apart.
 */
export function makeTypewriter(text: string, startMs: number, windowMs: number): Typewriter {
  const n = Math.max(1, text.length);
  const budgetSec = Math.max(0.2, (windowMs * WINDOW_FILL) / 1000);
  const needed = n / budgetSec;
  return {
    startMs,
    charsPerSecond: Math.max(MIN_CPS, Math.min(MAX_CPS, needed)),
    humanize: DEFAULT_HUMANIZE,
    caret: true,
  };
}

export interface ResolvedTypewriter {
  startMs: number;
  cps: number;
  humanize: number;
  caret: boolean;
}

/**
 * Fill in the optional fields and pull the speed back into the human band.
 *
 * The clamp applies to every card, including ones saved before the rhythm
 * existed — those have a baked `charsPerSecond` of up to 60, which is the very
 * thing that made the effect look wrong. There is no UI for raw speed, so
 * nothing legitimate wants a value outside the band.
 */
export function resolveTypewriter(tw: Typewriter): ResolvedTypewriter {
  return {
    startMs: tw.startMs,
    cps: Math.max(MIN_CPS, Math.min(MAX_CPS, tw.charsPerSecond || MIN_CPS)),
    humanize: Math.max(0, Math.min(1, tw.humanize ?? DEFAULT_HUMANIZE)),
    caret: tw.caret ?? true,
  };
}

/** Deterministic 0..1 from an integer (xorshift-style finaliser). */
function hash01(i: number): number {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * Cumulative ms at which each character appears.
 *
 * Pauses key off the PREVIOUS character: a typist rests after finishing a word
 * or a sentence, not before starting one.
 */
function buildSchedule(text: string, cps: number, humanize: number): number[] {
  const base = 1000 / cps;
  const out: number[] = new Array(text.length);
  let t = 0;
  for (let i = 0; i < text.length; i++) {
    let d = base;
    if (humanize > 0) d *= 1 + (hash01(i) * 2 - 1) * humanize;
    const prev = i > 0 ? text[i - 1]! : '';
    if (prev && '.!?…'.includes(prev)) d += base * 6;
    else if (prev && ',;:—'.includes(prev)) d += base * 3;
    else if (prev === ' ') d += base * 0.9;
    t += Math.max(base * 0.25, d);
    out[i] = t;
  }
  return out;
}

// Schedules are pure functions of (text, cps, humanize) and get asked for on
// every frame, so they're memoised. Card text is short and there are only ever
// a handful of blocks on screen.
const scheduleCache = new Map<string, number[]>();

function schedule(text: string, cps: number, humanize: number): number[] {
  const key = `${cps.toFixed(2)}|${humanize.toFixed(2)}|${text}`;
  let s = scheduleCache.get(key);
  if (!s) {
    if (scheduleCache.size > 256) scheduleCache.clear();
    s = buildSchedule(text, cps, humanize);
    scheduleCache.set(key, s);
  }
  return s;
}

/** How many characters have been typed `elapsedMs` into the reveal. */
export function typedCount(text: string, tw: ResolvedTypewriter, elapsedMs: number): number {
  if (elapsedMs <= 0 || text.length === 0) return 0;
  const s = schedule(text, tw.cps, tw.humanize);
  // Binary search the first entry past `elapsedMs`.
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid]! <= elapsedMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The text to render, caret included.
 *
 * The caret always occupies one character slot — it swaps to a space rather
 * than disappearing — so a blink can't nudge centred text sideways.
 */
export function typewriterText(full: string, tw: ResolvedTypewriter, elapsedMs: number): string {
  const chars = typedCount(full, tw, elapsedMs);
  const shown = full.slice(0, chars);
  if (!tw.caret) return shown;
  // Solid while typing; a real cursor only blinks once it's idle.
  if (chars < full.length) return `${shown}${CARET_CHAR}`;
  const on = Math.floor(elapsedMs / (CARET_PERIOD_MS / 2)) % 2 === 0;
  return `${shown}${on ? CARET_CHAR : ' '}`;
}
