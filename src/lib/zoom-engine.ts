import { springProgress } from './spring';
import type {
  Display,
  KlipeMouseEvent,
  MouseClickEvent,
  MouseTrack,
  Vec2,
  ZoomDefaults,
  ZoomSample,
  ZoomSegment,
} from '../types';

const FOCAL_GLIDE_GAP_MS = 1500;

export const DEFAULT_ZOOM: ZoomDefaults = {
  scale: 1.8,
  duration: 2000,
  easeIn: 400,
  easeOut: 600,
};

interface AutoZoomOptions extends ZoomDefaults {
  /** Two clicks within this gap belong to the same cluster (one zoom region). */
  mergeGap: number;
  /** Padding added before the first click of a cluster. */
  padBefore: number;
  /** Padding added after the last click of a cluster. */
  padAfter: number;
}

const AUTO_OPTS: AutoZoomOptions = {
  ...DEFAULT_ZOOM,
  mergeGap: 2500,
  padBefore: 500,
  padAfter: 500,
};

let _idCounter = 0;
const newId = (): string => `z_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;

function sortInPlace(segs: ZoomSegment[]): ZoomSegment[] {
  segs.sort((a, b) => a.tStart - b.tStart);
  return segs;
}

/**
 * Heuristic strength score for an individual click.
 *  - Right/middle clicks rate higher: they're rare and almost always intentional.
 *  - Double-clicks (two left clicks ≤350ms apart, ≤30px apart) score even higher
 *    because they signal a strong "look here" intent.
 * Strength is used to choose a cluster's focus point.
 */
function scoreClicks(events: readonly KlipeMouseEvent[]): Map<MouseClickEvent, number> {
  const scores = new Map<MouseClickEvent, number>();
  const clicks = events.filter((e): e is MouseClickEvent => e.type === 'click');
  for (let i = 0; i < clicks.length; i += 1) {
    const c = clicks[i]!;
    let s = c.button === 'left' ? 1 : 1.5;
    const next = clicks[i + 1];
    if (
      next &&
      c.button === 'left' &&
      next.button === 'left' &&
      next.t - c.t <= 350 &&
      Math.hypot(next.x - c.x, next.y - c.y) <= 30
    ) {
      s = 2;
    }
    scores.set(c, s);
  }
  return scores;
}

interface ClickCluster {
  clicks: MouseClickEvent[];
  firstT: number;
  lastT: number;
  /** Click with the highest strength — its position becomes the cluster focus. */
  dominant: MouseClickEvent;
}

function clusterClicks(
  clicks: readonly MouseClickEvent[],
  scores: Map<MouseClickEvent, number>,
  mergeGap: number,
): ClickCluster[] {
  if (clicks.length === 0) return [];
  const sorted = [...clicks].sort((a, b) => a.t - b.t);
  const clusters: ClickCluster[] = [];
  let current: ClickCluster = {
    clicks: [sorted[0]!],
    firstT: sorted[0]!.t,
    lastT: sorted[0]!.t,
    dominant: sorted[0]!,
  };
  for (let i = 1; i < sorted.length; i += 1) {
    const c = sorted[i]!;
    if (c.t - current.lastT <= mergeGap) {
      current.clicks.push(c);
      current.lastT = c.t;
      if ((scores.get(c) ?? 1) > (scores.get(current.dominant) ?? 1)) {
        current.dominant = c;
      }
    } else {
      clusters.push(current);
      current = { clicks: [c], firstT: c.t, lastT: c.t, dominant: c };
    }
  }
  clusters.push(current);
  return clusters;
}

export function generateZoomSegments(
  mouse: MouseTrack | null | undefined,
  opts: Partial<AutoZoomOptions> = {},
): ZoomSegment[] {
  const o: AutoZoomOptions = { ...AUTO_OPTS, ...opts };
  if (!mouse || !mouse.events) return [];
  const clicks = mouse.events.filter((e): e is MouseClickEvent => e.type === 'click');
  if (!clicks.length) return [];

  const scores = scoreClicks(mouse.events);
  const clusters = clusterClicks(clicks, scores, o.mergeGap);

  // Sustain time at full zoom is whatever is left of `duration` after we've
  // accounted for ease-in + ease-out. Keeps single-click zooms feeling the same
  // length as before, while multi-click clusters naturally dwell longer.
  const sustain = Math.max(0, o.duration - o.easeIn - o.easeOut);

  return clusters.map((cluster) => ({
    id: newId(),
    source: 'auto',
    center: { x: cluster.dominant.x, y: cluster.dominant.y },
    scale: o.scale,
    tStart: Math.max(0, cluster.firstT - o.padBefore),
    tEnd: cluster.lastT + o.padAfter + sustain + o.easeOut,
    easeIn: o.easeIn,
    easeOut: o.easeOut,
  }));
}

export interface CreateManualSegmentArgs {
  tMs: number;
  durationMs?: number;
  easeIn?: number;
  easeOut?: number;
  scale?: number;
  center?: Vec2;
  display?: Display | null;
}

export function createManualSegment({
  tMs,
  durationMs = DEFAULT_ZOOM.duration,
  easeIn = DEFAULT_ZOOM.easeIn,
  easeOut = DEFAULT_ZOOM.easeOut,
  scale = DEFAULT_ZOOM.scale,
  center,
  display,
}: CreateManualSegmentArgs): ZoomSegment {
  const c: Vec2 = center ?? {
    x: (display?.width ?? 1920) / 2,
    y: (display?.height ?? 1080) / 2,
  };
  const half = durationMs / 2;
  return {
    id: newId(),
    source: 'manual',
    center: { x: c.x, y: c.y },
    scale,
    tStart: Math.max(0, tMs - half),
    tEnd: tMs + half,
    easeIn,
    easeOut,
  };
}

export function updateSegment(
  segments: ZoomSegment[],
  id: string,
  patch: Partial<ZoomSegment>,
): ZoomSegment[] {
  const next = segments.map((s) => (s.id === id ? { ...s, ...patch } : s));
  return sortInPlace(next);
}

export function addSegment(segments: ZoomSegment[], segment: ZoomSegment): ZoomSegment[] {
  return sortInPlace([...segments, segment]);
}

export function removeSegment(segments: ZoomSegment[], id: string): ZoomSegment[] {
  return segments.filter((s) => s.id !== id);
}

export function sampleZoom(segments: ZoomSegment[] | null | undefined, t: number): ZoomSample {
  if (!segments || !segments.length) return { scale: 1, cx: null, cy: null, p: 0 };
  const idx = segments.findIndex((s) => t >= s.tStart && t <= s.tEnd);
  if (idx === -1) return { scale: 1, cx: null, cy: null, p: 0 };
  const seg = segments[idx]!;

  const inEnd = seg.tStart + seg.easeIn;
  const outStart = seg.tEnd - seg.easeOut;

  let scale: number;
  let p: number;
  if (t < inEnd) {
    const q = springProgress(t - seg.tStart, seg.easeIn);
    scale = 1 + (seg.scale - 1) * q;
    p = q;
  } else if (t > outStart) {
    const q = springProgress(t - outStart, seg.easeOut);
    scale = seg.scale + (1 - seg.scale) * q;
    p = 1 - q;
  } else {
    scale = seg.scale;
    p = 1;
  }

  if (scale < 1) scale = 1;
  if (p < 0) p = 0;

  let cx = seg.center.x;
  let cy = seg.center.y;
  if (t < inEnd && idx > 0) {
    const prev = segments[idx - 1]!;
    if (seg.tStart - prev.tEnd < FOCAL_GLIDE_GAP_MS) {
      const f = Math.max(0, Math.min(1, p));
      cx = prev.center.x + (seg.center.x - prev.center.x) * f;
      cy = prev.center.y + (seg.center.y - prev.center.y) * f;
    }
  }

  return { scale, cx, cy, p };
}
