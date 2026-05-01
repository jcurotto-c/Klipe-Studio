/**
 * Zoom engine.
 *
 * Mouse event input is `{ startTime, events: [{ type, x, y, t, button? }] }`,
 * where `t` is milliseconds from the recording start. (The OS-level `startTime`
 * is just metadata; what matters for the timeline is `t`.)
 *
 * Output zoom segments:
 *   { center: { x, y }, scale, tStart, tEnd, easeIn, easeOut }
 *
 * Coordinates are screen-space pixels (matching the recorded video size after
 * normalization). The renderer converts to canvas-space.
 */

export const SMOOTHSTEP = (t) => t * t * (3 - 2 * t);

const DEFAULT_OPTS = {
  scale: 1.8,
  duration: 2000,
  easeIn: 400,
  easeOut: 600,
  mergeGap: 1500
};

export function generateZoomSegments(mouse, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  if (!mouse || !mouse.events) return [];
  const clicks = mouse.events.filter((e) => e.type === 'click');
  if (!clicks.length) return [];

  const raw = clicks.map((c) => ({
    center: { x: c.x, y: c.y },
    scale: o.scale,
    tStart: Math.max(0, c.t - o.easeIn),
    tEnd: c.t + o.duration,
    easeIn: o.easeIn,
    easeOut: o.easeOut
  }));

  // Merge overlapping or near-adjacent segments (gap < mergeGap).
  raw.sort((a, b) => a.tStart - b.tStart);
  const merged = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && seg.tStart - prev.tEnd < o.mergeGap) {
      // Extend previous segment, average the centers, keep max scale.
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
 * Returns the active zoom transform { scale, cx, cy } for time `t` (ms).
 * `cx`, `cy` are the focus point in screen pixels. Returns identity when
 * outside any segment.
 */
export function sampleZoom(segments, t) {
  if (!segments || !segments.length) return { scale: 1, cx: null, cy: null };
  const seg = segments.find((s) => t >= s.tStart && t <= s.tEnd);
  if (!seg) return { scale: 1, cx: null, cy: null };

  const inEnd = seg.tStart + seg.easeIn;
  const outStart = seg.tEnd - seg.easeOut;
  let p; // 0..1 zoom amount
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
