/**
 * Track sampling — convert a keyframe track + time → a concrete value.
 *
 * Identical shape regardless of property type: bracket the time between two
 * keyframes, normalize, apply the easing of the *ending* keyframe, lerp.
 * Outside the track's range we clamp to the first/last value — extrapolation
 * surprises users more often than it helps.
 *
 * The non-null assertions on bracketed array reads are safe because the
 * function reaches them only after explicit length / range checks; required
 * because tsconfig enables `noUncheckedIndexedAccess`.
 */

import type { Keyframe, NumberTrack, Vec2, VecTrack } from '../types';
import { applyEasing } from './easings';

export function sampleNumber(
  track: NumberTrack | undefined,
  tMs: number,
  fallback: number,
): number {
  if (!track || track.keys.length === 0) return fallback;
  const keys = track.keys;
  const first = keys[0]!;
  if (tMs <= first.t) return first.value;
  const last = keys[keys.length - 1]!;
  if (tMs >= last.t) return last.value;
  const seg = findSegment(keys, tMs);
  const a = keys[seg]!;
  const b = keys[seg + 1]!;
  const u = (tMs - a.t) / (b.t - a.t);
  const eased = applyEasing(b.easing, u);
  return a.value + (b.value - a.value) * eased;
}

export function sampleVec(
  track: VecTrack | undefined,
  tMs: number,
  fallbackX: number,
  fallbackY: number,
): Vec2 {
  if (!track || track.keys.length === 0) return { x: fallbackX, y: fallbackY };
  const keys = track.keys;
  const first = keys[0]!;
  if (tMs <= first.t) return { ...first.value };
  const last = keys[keys.length - 1]!;
  if (tMs >= last.t) return { ...last.value };
  const seg = findSegment(keys, tMs);
  const a = keys[seg]!;
  const b = keys[seg + 1]!;
  const u = (tMs - a.t) / (b.t - a.t);
  const eased = applyEasing(b.easing, u);
  return {
    x: a.value.x + (b.value.x - a.value.x) * eased,
    y: a.value.y + (b.value.y - a.value.y) * eased,
  };
}

function findSegment<T>(keys: Keyframe<T>[], tMs: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t <= tMs) lo = mid;
    else hi = mid;
  }
  return lo;
}
