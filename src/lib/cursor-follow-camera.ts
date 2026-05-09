/**
 * Cursor-follow camera for active zoom regions.
 *
 * While a zoom region is active, the camera holds its position until the
 * cursor leaves an inner "safe zone" of the visible (zoomed) viewport. When
 * it does, the focus shifts just enough to bring the cursor back to the safe
 * edge. This avoids the twitchy pan you get from chasing every pixel of
 * cursor motion, while still keeping the cursor on screen.
 *
 * When zoom strength drops back toward zero, the focus freezes at its last
 * position so the zoom-out doesn't visibly drift.
 *
 * Coordinates are in source-pixel space (the same space as the recorded
 * video and the cursor telemetry).
 */

import { CursorSpringValue } from './cursor-spring';

export interface CursorFollowState {
  initialized: boolean;
  /** Target focus computed from the safe-zone rule (un-smoothed). */
  targetX: number;
  targetY: number;
  /** Frozen target while the zoom is fading out. */
  frozenX: number;
  frozenY: number;
  reachedFullZoom: boolean;
  lastTms: number | null;
  /** Springs that chase the target focus — what gives the cinematic glide. */
  springX: CursorSpringValue;
  springY: CursorSpringValue;
  /** Previous cursor position, for velocity calculation. */
  prevCursorX: number;
  prevCursorY: number;
  /** Smoothed cursor speed in px/s — drives adaptive zoom. */
  speedSpring: CursorSpringValue;
}

export interface CursorFollowConfig {
  /**
   * 0 — no safe zone, camera tracks every cursor move.
   * 0.5 — safe zone fills the entire viewport (camera never moves).
   * Default 0.25 leaves a comfortable inner area before the camera reacts.
   */
  safeZoneRatio: number;
  /** Spring stiffness for focus chase. Lower = floatier, higher = snappier. */
  focusStiffness: number;
  /** Spring damping for focus chase. Higher = less overshoot. */
  focusDamping: number;
  /** Spring mass for focus chase. Higher = heavier, more lag. */
  focusMass: number;
  /** Cursor speed (px/s) at which adaptive zoom is at minScaleFactor. */
  speedReferencePxs: number;
  /** Lower bound for zoom scale when cursor is moving fast. 1 = no easing. */
  minScaleFactor: number;
}

export const DEFAULT_CURSOR_FOLLOW: CursorFollowConfig = {
  safeZoneRatio: 0.25,
  // Tuned for an under-damped, cinematic glide: catches up briskly,
  // settles without visible overshoot. Higher stiffness here than for the
  // cursor itself because the focus moves much less often (only on safe-zone
  // exit), so we want it to arrive soon after reacting.
  focusStiffness: 110,
  focusDamping: 22,
  focusMass: 1,
  // Above ~2400 px/s the camera backs off so the user can see what they're
  // flying past. 0.85 = full zoom drops to 85% during fast motion. Set
  // minScaleFactor to 1 to disable adaptive zoom.
  speedReferencePxs: 2400,
  minScaleFactor: 0.85,
};

function makeSpring(cfg: CursorFollowConfig): CursorSpringValue {
  return new CursorSpringValue({
    stiffness: cfg.focusStiffness,
    damping: cfg.focusDamping,
    mass: cfg.focusMass,
  });
}

function makeSpeedSpring(): CursorSpringValue {
  // Speed ramps quickly when the cursor accelerates but unwinds slowly so
  // the camera doesn't snap back to full zoom the instant the cursor pauses.
  return new CursorSpringValue({ stiffness: 80, damping: 30, mass: 1 });
}

export function createCursorFollowState(): CursorFollowState {
  return {
    initialized: false,
    targetX: 0,
    targetY: 0,
    frozenX: 0,
    frozenY: 0,
    reachedFullZoom: false,
    lastTms: null,
    springX: makeSpring(DEFAULT_CURSOR_FOLLOW),
    springY: makeSpring(DEFAULT_CURSOR_FOLLOW),
    prevCursorX: 0,
    prevCursorY: 0,
    speedSpring: makeSpeedSpring(),
  };
}

export function resetCursorFollowState(state: CursorFollowState): void {
  state.initialized = false;
  state.targetX = 0;
  state.targetY = 0;
  state.frozenX = 0;
  state.frozenY = 0;
  state.reachedFullZoom = false;
  state.lastTms = null;
  state.springX.reset();
  state.springY.reset();
  state.prevCursorX = 0;
  state.prevCursorY = 0;
  state.speedSpring.reset();
}

interface ApplyArgs {
  state: CursorFollowState;
  /** Configured center of the zoom region (where it would settle without follow). */
  baseFocusX: number;
  baseFocusY: number;
  cursorX: number;
  cursorY: number;
  /** Effective zoom scale (≥ 1). */
  scale: number;
  /** Zoom progress 0..1 (used for freeze-on-out). */
  zoomP: number;
  /** Source-pixel dimensions — the coordinate space cursor & focus live in. */
  sourceWidth: number;
  sourceHeight: number;
  tMs: number;
  config?: CursorFollowConfig;
}

interface FollowResult {
  cx: number;
  cy: number;
  /** Multiplier applied to the configured zoom scale (≤ 1). */
  scaleFactor: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Update the camera focus for one frame.
 * Returns the focus point to use for the zoom transform this frame.
 */
export function applyCursorFollow({
  state,
  baseFocusX,
  baseFocusY,
  cursorX,
  cursorY,
  scale,
  zoomP,
  sourceWidth,
  sourceHeight,
  tMs,
  config = DEFAULT_CURSOR_FOLLOW,
}: ApplyArgs): FollowResult {
  // Compute deltaMs once — used to step the springs uniformly below.
  const dtMs = state.lastTms == null ? 16 : tMs - state.lastTms;
  state.lastTms = tMs;

  // Smoothed cursor speed in px/s feeds the adaptive-zoom factor below.
  // Computed every call (even when not zoomed) so it doesn't snap on entry.
  const dtSec = Math.max(0.001, dtMs / 1000);
  const dxC = cursorX - state.prevCursorX;
  const dyC = cursorY - state.prevCursorY;
  const rawSpeed = state.lastTms == null
    ? 0
    : Math.hypot(dxC, dyC) / dtSec;
  state.prevCursorX = cursorX;
  state.prevCursorY = cursorY;
  const speed = state.speedSpring.step(rawSpeed, dtMs);
  const speedNorm = clamp(speed / Math.max(1, config.speedReferencePxs), 0, 1);
  const scaleFactor = 1 - speedNorm * (1 - clamp(config.minScaleFactor, 0.5, 1));

  // Not zoomed → return base focus and reset focus state for the next cycle.
  if (zoomP < 0.01 || scale <= 1) {
    if (state.initialized) {
      state.initialized = false;
      state.reachedFullZoom = false;
      state.springX.reset();
      state.springY.reset();
    }
    return { cx: baseFocusX, cy: baseFocusY, scaleFactor: 1 };
  }

  if (zoomP >= 0.99) {
    state.reachedFullZoom = true;
  }

  // Already past full zoom, now fading out → spring continues to chase the
  // frozen target so the easing-out is smooth (no last-frame jolt).
  if (state.reachedFullZoom && zoomP < 0.99) {
    const sx = state.springX.step(state.frozenX, dtMs);
    const sy = state.springY.step(state.frozenY, dtMs);
    return { cx: sx, cy: sy, scaleFactor };
  }

  // Time discontinuity (scrub) → reset cleanly.
  if (Math.abs(dtMs) > 200) {
    state.initialized = false;
    state.reachedFullZoom = false;
    state.springX.reset();
    state.springY.reset();
  }

  // First frame in this zoom cycle — seat target and springs at the base
  // focus so the camera enters the zoom centered on the click point and
  // glides outward only if the cursor leaves the safe zone.
  if (!state.initialized) {
    state.targetX = baseFocusX;
    state.targetY = baseFocusY;
    state.springX.snap(baseFocusX);
    state.springY.snap(baseFocusY);
    state.initialized = true;
  }

  // Apply spring chase config in case caller tuned it.
  state.springX.setTuning({
    stiffness: config.focusStiffness,
    damping: config.focusDamping,
    mass: config.focusMass,
  });
  state.springY.setTuning({
    stiffness: config.focusStiffness,
    damping: config.focusDamping,
    mass: config.focusMass,
  });

  // Visible window in source pixels at full zoom.
  const visW = sourceWidth / scale;
  const visH = sourceHeight / scale;
  const safeRatio = clamp(config.safeZoneRatio, 0, 0.49);
  // Half-width of the safe zone (the inner "no-pan" rectangle).
  const safeHalfW = (visW / 2) * (1 - 2 * safeRatio);
  const safeHalfH = (visH / 2) * (1 - 2 * safeRatio);

  // Update the target focus only if the cursor leaves the safe zone around
  // the *previous target* (not the current spring value) — this keeps the
  // safe-zone test stable while the spring is mid-glide.
  let nextX = state.targetX;
  let nextY = state.targetY;
  if (cursorX > state.targetX + safeHalfW) {
    nextX = cursorX - safeHalfW;
  } else if (cursorX < state.targetX - safeHalfW) {
    nextX = cursorX + safeHalfW;
  }
  if (cursorY > state.targetY + safeHalfH) {
    nextY = cursorY - safeHalfH;
  } else if (cursorY < state.targetY - safeHalfH) {
    nextY = cursorY + safeHalfH;
  }

  // Don't let the visible window extend past the source.
  const halfVisW = visW / 2;
  const halfVisH = visH / 2;
  nextX = clamp(nextX, halfVisW, sourceWidth - halfVisW);
  nextY = clamp(nextY, halfVisH, sourceHeight - halfVisH);

  state.targetX = nextX;
  state.targetY = nextY;
  state.frozenX = nextX;
  state.frozenY = nextY;

  // Spring chases the target — this is what makes the pan look cinematic.
  const sx = state.springX.step(nextX, dtMs);
  const sy = state.springY.step(nextY, dtMs);
  return { cx: sx, cy: sy, scaleFactor };
}
