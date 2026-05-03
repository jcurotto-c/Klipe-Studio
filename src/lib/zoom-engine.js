/**
 * Zoom engine.
 *
 * Mouse event input is `{ startTime, events: [{ type, x, y, t, button? }] }`,
 * where `t` is milliseconds from the recording start. (The OS-level `startTime`
 * is just metadata; what matters for the timeline is `t`.)
 *
 * Output zoom segments:
 *   { id, source, center: { x, y }, scale, tStart, tEnd, easeIn, easeOut }
 *
 * - `id` is stable across edits so React can key on it.
 * - `source` is 'auto' (created from click analysis) or 'manual' (user-added).
 * - `center` is in screen-space pixels matching the recorded video (the
 *   renderer remaps to canvas-space).
 */

export const SMOOTHSTEP = (t) => t * t * (3 - 2 * t);

export const DEFAULT_ZOOM = {
  scale: 1.8,
  duration: 2000,
  easeIn: 400,
  easeOut: 600
};

const AUTO_OPTS = {
  ...DEFAULT_ZOOM,
  mergeGap: 1500
};

let _idCounter = 0;
const newId = () => `z_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;

function sortInPlace(segs) {
  segs.sort((a, b) => a.tStart - b.tStart);
  return segs;
}

/**
 * Auto-generate zoom segments from cursor click events.
 */
export function generateZoomSegments(mouse, opts = {}) {
  const o = { ...AUTO_OPTS, ...opts };
  if (!mouse || !mouse.events) return [];
  const clicks = mouse.events.filter((e) => e.type === 'click');
  if (!clicks.length) return [];

  const raw = clicks.map((c) => ({
    id: newId(),
    source: 'auto',
    center: { x: c.x, y: c.y },
    scale: o.scale,
    tStart: Math.max(0, c.t - o.easeIn),
    tEnd: c.t + o.duration,
    easeIn: o.easeIn,
    easeOut: o.easeOut
  }));

  raw.sort((a, b) => a.tStart - b.tStart);
  const merged = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && seg.tStart - prev.tEnd < o.mergeGap) {
      prev.tEnd = Math.max(prev.tEnd, seg.tEnd);
      prev.center = {
        x: (prev.center.x + seg.center.x) / 2,
        y: (prev.center.y + seg.center.y) / 2
      };
      prev.scale = Math.max(prev.scale, seg.scale);
      prev.easeOut = seg.easeOut;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/**
 * Build a manual zoom segment centered at `tMs`. `display` is used to default
 * the focus point to the screen center when no cursor sample is available.
 */
export function createManualSegment({
  tMs,
  durationMs = DEFAULT_ZOOM.duration,
  easeIn = DEFAULT_ZOOM.easeIn,
  easeOut = DEFAULT_ZOOM.easeOut,
  scale = DEFAULT_ZOOM.scale,
  center,
  display
}) {
  const c = center || {
    x: (display?.width || 1920) / 2,
    y: (display?.height || 1080) / 2
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
    easeOut
  };
}

/**
 * Returns a new segments array with `patch` applied to the segment with `id`.
 * Re-sorts by tStart so the renderer's `find()` always picks the right one.
 */
export function updateSegment(segments, id, patch) {
  const next = segments.map((s) => (s.id === id ? { ...s, ...patch } : s));
  return sortInPlace(next);
}

export function addSegment(segments, segment) {
  return sortInPlace([...segments, segment]);
}

export function removeSegment(segments, id) {
  return segments.filter((s) => s.id !== id);
}

/**
 * Active zoom transform `{ scale, cx, cy, p }` for time `t` (ms). Returns
 * identity when outside any segment.
 */
export function sampleZoom(segments, t) {
  if (!segments || !segments.length) return { scale: 1, cx: null, cy: null };
  const seg = segments.find((s) => t >= s.tStart && t <= s.tEnd);
  if (!seg) return { scale: 1, cx: null, cy: null };

  const inEnd = seg.tStart + seg.easeIn;
  const outStart = seg.tEnd - seg.easeOut;
  let p;
  if (t < inEnd) {
    p = SMOOTHSTEP((t - seg.tStart) / Math.max(1, seg.easeIn));
  } else if (t > outStart) {
    p = SMOOTHSTEP(Math.max(0, (seg.tEnd - t) / Math.max(1, seg.easeOut)));
  } else {
    p = 1;
  }
  const scale = 1 + (seg.scale - 1) * p;
  return { scale, cx: seg.center.x, cy: seg.center.y, p };
}
