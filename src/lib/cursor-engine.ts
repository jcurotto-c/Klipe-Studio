/**
 * Cursor render engine — stateful per-frame solver for the on-canvas cursor.
 *
 * Pipeline per frame:
 *
 *   raw target (xt, yt)  ──►  spring   ──►  smoothed (x, y)
 *                                         │
 *                                         ├─►  velocity → motion-blur strength + angle
 *                                         ├─►  velocity direction → sway rotation
 *                                         └─►  click event proximity → bounce scale dip
 */

import type {
  CursorOptions,
  CursorSample,
  CursorState,
  CursorStyle,
  KlipeMouseEvent,
  MouseTrack,
  SpringScalarState,
} from '../types';

export const CURSOR_STYLES: CursorStyle[] = ['arrow', 'arrow-outline', 'arrow-mini', 'dot', 'figma'];

export const DEFAULT_CURSOR_OPTIONS: CursorOptions = {
  show: true,
  loop: false,
  style: 'dot',
  size: 3.0,
  smoothing: 0.67,
  motionBlur: 0.40,
  clickBounce: 2.5,
  bounceSpeed: 350,
  sway: 0.13,
};

interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
}

const SMOOTHING_LEGACY_MAX = 0.5;
const SMOOTHING_MAX = 2;

const SWAY_MAX_ROTATION = Math.PI / 18;
const SWAY_SPEED_REFERENCE = 1400;
const SWAY_VERTICAL_WEIGHT = 0.65;
const SWAY_INTENSITY_SCALE = 3;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clampDt(deltaMs: number, fallback = 1000 / 60): number {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return fallback;
  return Math.min(80, Math.max(1, deltaMs));
}

export function springConfigFromSmoothing(smoothing: number): SpringConfig {
  const s = clamp(smoothing, 0, SMOOTHING_MAX);
  if (s <= 0) return { stiffness: 1000, damping: 100, mass: 1 };
  if (s <= SMOOTHING_LEGACY_MAX) {
    const n = s / SMOOTHING_LEGACY_MAX;
    return {
      stiffness: 760 - n * 420,
      damping: 34 + n * 24,
      mass: 0.55 + n * 0.45,
    };
  }
  const n = (s - SMOOTHING_LEGACY_MAX) / (SMOOTHING_MAX - SMOOTHING_LEGACY_MAX);
  return {
    stiffness: 340 - n * 180,
    damping: 58 + n * 22,
    mass: 1 + n * 0.35,
  };
}

function stepSpring(
  state: SpringScalarState,
  target: number,
  dtMs: number,
  cfg: SpringConfig,
): number {
  if (!state.init || !Number.isFinite(state.value)) {
    state.value = target;
    state.velocity = 0;
    state.init = true;
    return state.value;
  }

  const restDelta = 0.0005;
  const restSpeed = 0.02;
  if (Math.abs(target - state.value) <= restDelta && Math.abs(state.velocity) <= restSpeed) {
    state.value = target;
    state.velocity = 0;
    return state.value;
  }

  const dt = clampDt(dtMs) / 1000;
  const w0 = Math.sqrt(cfg.stiffness / cfg.mass);
  const zeta = cfg.damping / (2 * Math.sqrt(cfg.stiffness * cfg.mass));
  const x0 = target - state.value;
  const v0 = -state.velocity;

  const solve = (t: number): number => {
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      const env = Math.exp(-zeta * w0 * t);
      return target - env * (((v0 + zeta * w0 * x0) / wd) * Math.sin(wd * t) + x0 * Math.cos(wd * t));
    }
    if (zeta === 1) {
      return target - Math.exp(-w0 * t) * (x0 + (v0 + w0 * x0) * t);
    }
    const wd = w0 * Math.sqrt(zeta * zeta - 1);
    const env = Math.exp(-zeta * w0 * t);
    const ft = Math.min(wd * t, 300);
    return target - (env * ((v0 + zeta * w0 * x0) * Math.sinh(ft) + wd * x0 * Math.cosh(ft))) / wd;
  };

  const next = solve(dt);

  if (zeta >= 1) {
    const crossed =
      (state.value <= target && next > target) ||
      (state.value >= target && next < target);
    if (crossed) {
      state.value = target;
      state.velocity = 0;
      return state.value;
    }
  }

  const eps = 0.0001;
  const ahead = solve(dt + eps);
  state.value = next;
  state.velocity = (ahead - next) / eps;
  return state.value;
}

export function createCursorState(): CursorState {
  return {
    sx: { value: 0, velocity: 0, init: false },
    sy: { value: 0, velocity: 0, init: false },
    rot: { value: 0, velocity: 0, init: false },
    lastTms: null,
  };
}

export function resetCursorState(state: CursorState): void {
  state.sx.init = false;
  state.sy.init = false;
  state.rot.init = false;
  state.sx.velocity = 0;
  state.sy.velocity = 0;
  state.rot.velocity = 0;
  state.lastTms = null;
}

type PositionalEvent = Extract<KlipeMouseEvent, { x: number; y: number }>;

function getNearestSample(events: readonly KlipeMouseEvent[], t: number): PositionalEvent | null {
  let lo = 0;
  let hi = events.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (events[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  for (let i = lo; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'move' || e.type === 'click') return e;
  }
  return null;
}

function findPositionalIndex(
  events: readonly KlipeMouseEvent[],
  startIndex: number,
  direction: 1 | -1,
): number {
  for (let i = startIndex; i >= 0 && i < events.length; i += direction) {
    const e = events[i]!;
    if (e.type === 'move' || e.type === 'click') return i;
  }
  return -1;
}

/**
 * Catmull-Rom spline through 4 control points. p1 and p2 bracket the
 * sample at parameter `s` ∈ [0, 1]. p0 and p3 give the spline its tangent
 * at the endpoints — without them you get linear-looking joints between
 * samples that the spring then has to fight.
 */
function catmullRom(p0: number, p1: number, p2: number, p3: number, s: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * s +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * s3
  );
}

/**
 * Smooth interpolated cursor target at time `t` using the surrounding
 * telemetry samples. Falls back to linear at the ends and to the latest
 * sample when there's only one. This is what the spring chases.
 */
function interpolateTarget(
  events: readonly KlipeMouseEvent[],
  t: number,
): { x: number; y: number } | null {
  let lo = 0;
  let hi = events.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (events[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  const i1 = findPositionalIndex(events, lo, -1);
  if (i1 < 0) return null;
  const i2 = findPositionalIndex(events, i1 + 1, 1);
  const e1 = events[i1] as PositionalEvent;
  if (i2 < 0 || t <= e1.t) return { x: e1.x, y: e1.y };
  const e2 = events[i2] as PositionalEvent;
  if (t >= e2.t) return { x: e2.x, y: e2.y };
  const span = e2.t - e1.t;
  if (span <= 0) return { x: e1.x, y: e1.y };
  const s = (t - e1.t) / span;
  const i0 = findPositionalIndex(events, i1 - 1, -1);
  const i3 = findPositionalIndex(events, i2 + 1, 1);
  const e0 = i0 >= 0 ? (events[i0] as PositionalEvent) : e1;
  const e3 = i3 >= 0 ? (events[i3] as PositionalEvent) : e2;
  return {
    x: catmullRom(e0.x, e1.x, e2.x, e3.x, s),
    y: catmullRom(e0.y, e1.y, e2.y, e3.y, s),
  };
}

function lastClickBefore(
  events: readonly KlipeMouseEvent[],
  t: number,
  windowMs: number,
): KlipeMouseEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.t > t) continue;
    if (t - e.t > windowMs) return null;
    if (e.type === 'click') return e;
  }
  return null;
}

function swayRotation(dx: number, dy: number, dtMs: number, sway: number): number {
  if (sway <= 0) return 0;
  const dist = Math.hypot(dx, dy);
  if (!Number.isFinite(dist) || dist < 0.01) return 0;
  const speed = dist / (clampDt(dtMs) / 1000);
  const sf = clamp(speed / SWAY_SPEED_REFERENCE, 0, 1);
  if (sf <= 0) return 0;
  const bias = clamp((dx + dy * SWAY_VERTICAL_WEIGHT) / dist, -1, 1);
  return bias * sf * SWAY_MAX_ROTATION * sway * SWAY_INTENSITY_SCALE;
}

export function sampleCursor(
  state: CursorState,
  mouse: MouseTrack | null | undefined,
  tMs: number,
  opts?: Partial<CursorOptions>,
): CursorSample {
  const o: CursorOptions = { ...DEFAULT_CURSOR_OPTIONS, ...(opts ?? {}) };
  if (!o.show || !mouse || !mouse.events || !mouse.events.length) {
    return { visible: false };
  }

  const sample = getNearestSample(mouse.events, tMs);
  if (!sample) return { visible: false };
  // Catmull-Rom interpolation gives a smooth target curve between samples,
  // so the spring isn't fighting a step function. The discrete `sample` is
  // still kept for click + cursor-type lookups elsewhere.
  const interp = interpolateTarget(mouse.events, tMs) ?? { x: sample.x, y: sample.y };
  const targetX = interp.x;
  const targetY = interp.y;

  const dtMs = state.lastTms == null ? 16.7 : Math.max(0.5, tMs - state.lastTms);
  state.lastTms = tMs;

  const cfg = springConfigFromSmoothing(o.smoothing);
  const prevX = state.sx.init ? state.sx.value : targetX;
  const prevY = state.sy.init ? state.sy.value : targetY;
  const x = stepSpring(state.sx, targetX, dtMs, cfg);
  const y = stepSpring(state.sy, targetY, dtMs, cfg);

  const dx = x - prevX;
  const dy = y - prevY;

  const targetRot = swayRotation(dx, dy, dtMs, o.sway);
  const rot = stepSpring(state.rot, targetRot, dtMs, {
    stiffness: 240,
    damping: 26,
    mass: 1,
  });

  const speedPxS = Math.hypot(state.sx.velocity, state.sy.velocity);
  const motionStrength = clamp((speedPxS / SWAY_SPEED_REFERENCE) * o.motionBlur, 0, 1.5);
  const motionAngle = Math.atan2(state.sy.velocity, state.sx.velocity);

  const click = lastClickBefore(mouse.events, tMs, o.bounceSpeed);
  let scaleMul = 1;
  if (click) {
    const p = clamp((tMs - click.t) / o.bounceSpeed, 0, 1);
    scaleMul = 1 - Math.sin(p * Math.PI) * (0.08 * o.clickBounce);
  }

  return {
    visible: true,
    x,
    y,
    rotation: rot,
    scaleMul,
    motionAngle,
    motionStrength,
    sample,
  };
}
