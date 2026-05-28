/**
 * Easing curves for zoom transitions. Every function maps normalized
 * progress `p ∈ [0, 1]` to an eased value (which may briefly leave [0, 1]
 * for the `snap`/`anticipate` overshoot curves). They are PURE and
 * deterministic — the renderer evaluates them with an arbitrary `tMs` for
 * both the live preview and every export frame, so the two passes stay in
 * sync.
 */

import { springAt, springSettleTime } from './spring';
import type { ZoomEasing } from '../types';

/**
 * `spring` reproduces the original `springProgress(elapsed, window)` look:
 * progress `p` is stretched across the spring's settle time so the curve
 * fully resolves by `p = 1`.
 */
function springEase(p: number): number {
  if (p <= 0) return 0;
  return springAt(p * springSettleTime());
}

function linear(p: number): number {
  return p;
}

function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

// easeOutBack — overshoots past 1 near the end, then settles back to 1.
const BACK_C1 = 1.70158;
const BACK_C3 = BACK_C1 + 1;
function easeOutBack(p: number): number {
  const q = p - 1;
  return 1 + BACK_C3 * q * q * q + BACK_C1 * q * q;
}

// easeInBack — dips below 0 early (the "pull-back"), then accelerates in.
function easeInBack(p: number): number {
  return BACK_C3 * p * p * p - BACK_C1 * p * p;
}

export const ZOOM_EASINGS: Record<ZoomEasing, (p: number) => number> = {
  spring: springEase,
  ease: easeInOutCubic,
  snap: easeOutBack,
  linear,
  anticipate: easeInBack,
};

export const ZOOM_EASING_LABELS: Record<ZoomEasing, string> = {
  spring: 'Smooth',
  ease: 'Keynote',
  snap: 'Snap',
  linear: 'Linear',
  anticipate: 'Anticipate',
};

/**
 * Normalized eased progress for a transition window: 0 before it starts,
 * the eased value across it, clamped at the window's end.
 */
export function easeProgress(
  easing: ZoomEasing | undefined,
  elapsedMs: number,
  windowMs: number,
): number {
  if (elapsedMs <= 0) return 0;
  if (windowMs <= 0) return 1;
  const fn = ZOOM_EASINGS[easing ?? 'spring'];
  return fn(Math.min(1, elapsedMs / windowMs));
}
