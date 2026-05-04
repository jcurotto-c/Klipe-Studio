import { springProgress } from './spring';
import type {
  Display,
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
  mergeGap: number;
}

const AUTO_OPTS: AutoZoomOptions = {
  ...DEFAULT_ZOOM,
  mergeGap: 1500,
};

let _idCounter = 0;
const newId = (): string => `z_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;

function sortInPlace(segs: ZoomSegment[]): ZoomSegment[] {
  segs.sort((a, b) => a.tStart - b.tStart);
  return segs;
}

export function generateZoomSegments(
  mouse: MouseTrack | null | undefined,
  opts: Partial<AutoZoomOptions> = {},
): ZoomSegment[] {
  const o: AutoZoomOptions = { ...AUTO_OPTS, ...opts };
  if (!mouse || !mouse.events) return [];
  const clicks = mouse.events.filter((e) => e.type === 'click');
  if (!clicks.length) return [];

  const raw: ZoomSegment[] = clicks.map((c) => ({
    id: newId(),
    source: 'auto',
    center: { x: c.x, y: c.y },
    scale: o.scale,
    tStart: Math.max(0, c.t - o.easeIn),
    tEnd: c.t + o.duration,
    easeIn: o.easeIn,
    easeOut: o.easeOut,
  }));

  raw.sort((a, b) => a.tStart - b.tStart);
  const merged: ZoomSegment[] = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && seg.tStart - prev.tEnd < o.mergeGap) {
      prev.tEnd = Math.max(prev.tEnd, seg.tEnd);
      prev.center = {
        x: (prev.center.x + seg.center.x) / 2,
        y: (prev.center.y + seg.center.y) / 2,
      };
      prev.scale = Math.max(prev.scale, seg.scale);
      prev.easeOut = seg.easeOut;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
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
