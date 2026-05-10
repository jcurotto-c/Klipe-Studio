import type {
  BlurKeyframe,
  BlurRegion,
  BlurSampleRect,
  BlurShape,
  BlurStyle,
} from '../types';

export const DEFAULT_BLUR_STRENGTH = 60;
export const DEFAULT_BLUR_STYLE: BlurStyle = 'gaussian';
export const DEFAULT_BLUR_SHAPE: BlurShape = 'rect';

const KEYFRAME_MATCH_TOLERANCE_MS = 80;

let _idCounter = 0;
const newId = (): string => `b_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;

function sortKeyframes(kfs: BlurKeyframe[]): BlurKeyframe[] {
  return [...kfs].sort((a, b) => a.tMs - b.tMs);
}

export interface CreateBlurRegionArgs {
  /** Active window start (source time, ms). */
  tStart: number;
  /** Active window end (source time, ms). */
  tEnd: number;
  /** Initial keyframe (in source-normalized coords). */
  initial: BlurKeyframe;
  style?: BlurStyle;
  shape?: BlurShape;
  strength?: number;
}

export function createBlurRegion({
  tStart,
  tEnd,
  initial,
  style = DEFAULT_BLUR_STYLE,
  shape = DEFAULT_BLUR_SHAPE,
  strength = DEFAULT_BLUR_STRENGTH,
}: CreateBlurRegionArgs): BlurRegion {
  return {
    id: newId(),
    tStart: Math.max(0, Math.min(tStart, tEnd)),
    tEnd: Math.max(tStart, tEnd),
    style,
    shape,
    strength: Math.max(0, Math.min(100, strength)),
    keyframes: [initial],
  };
}

export function addBlurRegion(regions: BlurRegion[], region: BlurRegion): BlurRegion[] {
  return [...regions, region].sort((a, b) => a.tStart - b.tStart);
}

export function updateBlurRegion(
  regions: BlurRegion[],
  id: string,
  patch: Partial<BlurRegion>,
): BlurRegion[] {
  let changed = false;
  const next = regions.map((r) => {
    if (r.id !== id) return r;
    changed = true;
    const merged: BlurRegion = { ...r, ...patch };
    if (patch.keyframes) merged.keyframes = sortKeyframes(patch.keyframes);
    if (merged.tEnd < merged.tStart) merged.tEnd = merged.tStart;
    return merged;
  });
  if (!changed) return regions;
  return next.sort((a, b) => a.tStart - b.tStart);
}

export function removeBlurRegion(regions: BlurRegion[], id: string): BlurRegion[] {
  return regions.filter((r) => r.id !== id);
}

/**
 * Drag-time helper: when the user moves/resizes a region in the preview at a
 * given source time, decide whether to update the nearest existing keyframe
 * or insert a new one. Within ±80ms of an existing keyframe we update in
 * place (so a single drag doesn't fragment the timeline); otherwise we
 * insert a new keyframe at `tMs` so the user gets natural Premiere-style
 * keyframing. With only one keyframe we always update it — single-keyframe
 * regions are static and shouldn't grow new keyframes from a fine-tuning drag.
 */
export function commitKeyframeAtTime(
  region: BlurRegion,
  tMs: number,
  rect: BlurSampleRect,
): BlurRegion {
  const kfs = region.keyframes;
  if (kfs.length <= 1) {
    return {
      ...region,
      keyframes: [{ tMs: kfs[0]?.tMs ?? tMs, ...rect }],
    };
  }
  let nearestIdx = 0;
  let nearestDelta = Math.abs(kfs[0]!.tMs - tMs);
  for (let i = 1; i < kfs.length; i++) {
    const d = Math.abs(kfs[i]!.tMs - tMs);
    if (d < nearestDelta) {
      nearestIdx = i;
      nearestDelta = d;
    }
  }
  if (nearestDelta <= KEYFRAME_MATCH_TOLERANCE_MS) {
    const nextKfs = kfs.map((k, i) => (i === nearestIdx ? { ...k, ...rect } : k));
    return { ...region, keyframes: sortKeyframes(nextKfs) };
  }
  const inserted: BlurKeyframe = { tMs, ...rect };
  return { ...region, keyframes: sortKeyframes([...kfs, inserted]) };
}

export function addKeyframeAt(
  region: BlurRegion,
  tMs: number,
): BlurRegion {
  const rect = sampleBlurRegion(region, tMs);
  if (!rect) return region;
  // If a keyframe already exists at this time, no-op.
  for (const k of region.keyframes) {
    if (Math.abs(k.tMs - tMs) <= KEYFRAME_MATCH_TOLERANCE_MS) return region;
  }
  const kf: BlurKeyframe = { tMs, ...rect };
  return { ...region, keyframes: sortKeyframes([...region.keyframes, kf]) };
}

export function removeKeyframe(region: BlurRegion, tMs: number): BlurRegion {
  if (region.keyframes.length <= 1) return region;
  const idx = region.keyframes.findIndex(
    (k) => Math.abs(k.tMs - tMs) <= KEYFRAME_MATCH_TOLERANCE_MS,
  );
  if (idx < 0) return region;
  const next = region.keyframes.filter((_, i) => i !== idx);
  return { ...region, keyframes: next };
}

/**
 * Returns the region's rect (in source-normalized coords) at the given source
 * time, or `null` if `tMs` falls outside the active window. With a single
 * keyframe the region is static; with multiple keyframes the rect linearly
 * interpolates between bracketing keyframes (clamped at the endpoints).
 */
export function sampleBlurRegion(
  region: BlurRegion,
  tMs: number,
): BlurSampleRect | null {
  if (tMs < region.tStart || tMs > region.tEnd) return null;
  const kfs = region.keyframes;
  if (!kfs.length) return null;
  if (kfs.length === 1) {
    const k = kfs[0]!;
    return { x: k.x, y: k.y, width: k.width, height: k.height };
  }
  if (tMs <= kfs[0]!.tMs) {
    const k = kfs[0]!;
    return { x: k.x, y: k.y, width: k.width, height: k.height };
  }
  const last = kfs[kfs.length - 1]!;
  if (tMs >= last.tMs) {
    return { x: last.x, y: last.y, width: last.width, height: last.height };
  }
  for (let i = 1; i < kfs.length; i++) {
    const a = kfs[i - 1]!;
    const b = kfs[i]!;
    if (tMs >= a.tMs && tMs <= b.tMs) {
      const span = Math.max(1, b.tMs - a.tMs);
      const f = (tMs - a.tMs) / span;
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        width: a.width + (b.width - a.width) * f,
        height: a.height + (b.height - a.height) * f,
      };
    }
  }
  // Unreachable: tMs is bracketed by the first/last checks above.
  const k = kfs[0]!;
  return { x: k.x, y: k.y, width: k.width, height: k.height };
}

/** Maps user strength (0–100) to a Gaussian blur radius in canvas pixels. */
export function strengthToBlurPx(strength: number): number {
  const s = Math.max(0, Math.min(100, strength));
  return (s / 100) * 40;
}

/** Maps user strength (0–100) to a pixelation block size in canvas pixels. */
export function strengthToBlockPx(strength: number): number {
  const s = Math.max(0, Math.min(100, strength));
  return 4 + (s / 100) * 60;
}
