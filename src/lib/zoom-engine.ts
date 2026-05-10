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
  /** Two interactions within this gap belong to the same cluster. */
  mergeGap: number;
  /** Padding added before the first interaction of a cluster. */
  padBefore: number;
  /** Padding added after the last interaction of a cluster. */
  padAfter: number;
  /** Minimum keystrokes for a typing burst to count as an interaction. */
  typingMinKeys: number;
  /** Minimum dwell-time on a UI-focus cursor type before it triggers a zoom (ms). */
  uiFocusMinMs: number;
}

const AUTO_OPTS: AutoZoomOptions = {
  ...DEFAULT_ZOOM,
  mergeGap: 2500,
  padBefore: 500,
  padAfter: 500,
  typingMinKeys: 2,
  uiFocusMinMs: 600,
};

let _idCounter = 0;
const newId = (): string => `z_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;

function sortInPlace(segs: ZoomSegment[]): ZoomSegment[] {
  segs.sort((a, b) => a.tStart - b.tStart);
  return segs;
}

/**
 * Unified "interaction" — anything that signals user intent worth zooming in
 * for: a click, a typing burst, or a sustained UI-focus cursor type
 * (text-field hover, button hover). Each carries a position (looked up from
 * the nearest move/click sample), a time span, and a strength score so
 * clusters choose the most authoritative focus point.
 */
type InteractionKind = 'click' | 'type' | 'focus';

interface Interaction {
  kind: InteractionKind;
  startT: number;
  endT: number;
  x: number;
  y: number;
  /** Higher = more authoritative when this interaction wins a cluster's focus. */
  strength: number;
}

function lookupCursorPos(
  events: readonly KlipeMouseEvent[],
  t: number,
): { x: number; y: number } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.t > t) continue;
    if (e.type === 'move' || e.type === 'click') return { x: e.x, y: e.y };
  }
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i]!;
    if (e.type === 'move' || e.type === 'click') return { x: e.x, y: e.y };
  }
  return null;
}

/**
 * Walk the click stream and emit one interaction per click, scoring
 * double-clicks and right/middle clicks higher. Mirrors the prior behavior so
 * legacy single-click zooms land on the same focus.
 */
function buildClickInteractions(events: readonly KlipeMouseEvent[]): Interaction[] {
  const clicks = events.filter((e): e is MouseClickEvent => e.type === 'click');
  const out: Interaction[] = [];
  for (let i = 0; i < clicks.length; i += 1) {
    const c = clicks[i]!;
    let strength = c.button === 'left' ? 1 : 1.5;
    const next = clicks[i + 1];
    if (
      next &&
      c.button === 'left' &&
      next.button === 'left' &&
      next.t - c.t <= 350 &&
      Math.hypot(next.x - c.x, next.y - c.y) <= 30
    ) {
      strength = 2;
    }
    out.push({ kind: 'click', startT: c.t, endT: c.t, x: c.x, y: c.y, strength });
  }
  return out;
}

/**
 * Group runs of key events (≤ mergeGap apart) into typing bursts. A burst
 * counts only once it has at least `typingMinKeys` keys — single keypresses
 * are usually keyboard shortcuts, not "the user is writing here." Burst
 * focus is the cursor position at burst start (text caret usually doesn't
 * move much during a burst).
 */
function buildTypingInteractions(
  events: readonly KlipeMouseEvent[],
  mergeGap: number,
  minKeys: number,
): Interaction[] {
  const keys = events.filter((e) => e.type === 'key') as Array<Extract<KlipeMouseEvent, { type: 'key' }>>;
  if (!keys.length) return [];
  const out: Interaction[] = [];
  let burst: Array<Extract<KlipeMouseEvent, { type: 'key' }>> = [keys[0]!];
  const flush = (): void => {
    if (burst.length < minKeys) return;
    const first = burst[0]!;
    const last = burst[burst.length - 1]!;
    const pos = lookupCursorPos(events, first.t);
    if (!pos) return;
    out.push({
      kind: 'type',
      startT: first.t,
      endT: last.t,
      x: pos.x,
      y: pos.y,
      // Typing dwells longer than a click but is less of a precise "look at this
      // exact pixel" — score 1.2 so a colocated click still wins the focus.
      strength: 1.2,
    });
  };
  for (let i = 1; i < keys.length; i += 1) {
    const k = keys[i]!;
    const prev = burst[burst.length - 1]!;
    if (k.t - prev.t <= mergeGap) {
      burst.push(k);
    } else {
      flush();
      burst = [k];
    }
  }
  flush();
  return out;
}

/**
 * Sustained `text` (typing field) and `pointer` (clickable hover) cursor
 * types signal that the user is focusing on a UI element. Each window where
 * the type stays in {text, pointer} for ≥ uiFocusMinMs becomes a focus
 * interaction. Position is the cursor position at the focus midpoint.
 */
function buildFocusInteractions(
  events: readonly KlipeMouseEvent[],
  minMs: number,
): Interaction[] {
  const out: Interaction[] = [];
  let focusStart: number | null = null;
  let focusKind: 'text' | 'pointer' | null = null;
  for (const e of events) {
    if (e.type !== 'cursorType') continue;
    const isFocus = e.cursorType === 'text' || e.cursorType === 'pointer';
    if (isFocus) {
      if (focusStart == null) {
        focusStart = e.t;
        focusKind = e.cursorType as 'text' | 'pointer';
      }
    } else if (focusStart != null) {
      const dur = e.t - focusStart;
      if (dur >= minMs) {
        const mid = focusStart + dur / 2;
        const pos = lookupCursorPos(events, mid);
        if (pos) {
          out.push({
            kind: 'focus',
            startT: focusStart,
            endT: e.t,
            x: pos.x,
            y: pos.y,
            // Hover/text-cursor dwell is the weakest signal — it loses to any
            // colocated click or typing burst when both are in the cluster.
            strength: focusKind === 'text' ? 1.0 : 0.9,
          });
        }
      }
      focusStart = null;
      focusKind = null;
    }
  }
  return out;
}

interface InteractionCluster {
  items: Interaction[];
  firstT: number;
  lastT: number;
  /** Highest-strength interaction in the cluster — its (x, y) wins the focus. */
  dominant: Interaction;
}

function clusterInteractions(
  items: readonly Interaction[],
  mergeGap: number,
): InteractionCluster[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.startT - b.startT);
  const clusters: InteractionCluster[] = [];
  let current: InteractionCluster = {
    items: [sorted[0]!],
    firstT: sorted[0]!.startT,
    lastT: sorted[0]!.endT,
    dominant: sorted[0]!,
  };
  for (let i = 1; i < sorted.length; i += 1) {
    const it = sorted[i]!;
    // Cluster on (item.start - cluster.lastEnd) so a long typing burst doesn't
    // accidentally end the cluster simply because its end stretches the window.
    if (it.startT - current.lastT <= mergeGap) {
      current.items.push(it);
      current.lastT = Math.max(current.lastT, it.endT);
      if (it.strength > current.dominant.strength) {
        current.dominant = it;
      }
    } else {
      clusters.push(current);
      current = { items: [it], firstT: it.startT, lastT: it.endT, dominant: it };
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

  const interactions: Interaction[] = [
    ...buildClickInteractions(mouse.events),
    ...buildTypingInteractions(mouse.events, o.mergeGap, o.typingMinKeys),
    ...buildFocusInteractions(mouse.events, o.uiFocusMinMs),
  ];
  if (!interactions.length) return [];

  const clusters = clusterInteractions(interactions, o.mergeGap);

  // Sustain time at full zoom is whatever is left of `duration` after we've
  // accounted for ease-in + ease-out. Single-click clusters feel the same
  // length as before; typing/UI-focus clusters naturally dwell longer because
  // their `lastT` extends to the end of the burst.
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
