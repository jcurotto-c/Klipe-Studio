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
  /** Smoothed cursor velocity components — drive look-ahead bias. */
  velSpringX: CursorSpringValue;
  velSpringY: CursorSpringValue;
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
  /**
   * Look-ahead window in seconds. The camera leads the cursor by
   * `velocity * lookAheadSec`, capped at `maxLookAheadFraction` of the
   * visible window. Gives the cursor empty space in the direction of motion
   * — the "movement room" that turns rigid centering into cinematic framing.
   * Set to 0 to disable.
   */
  lookAheadSec: number;
  /**
   * Cap on look-ahead bias as a fraction of the visible (zoomed) window.
   * 0.18 means the camera can lead the anchor by up to 18% of the visible
   * width/height — enough to feel intentional, small enough to never hide
   * the cursor.
   */
  maxLookAheadFraction: number;
  /**
   * Extra zoom-in multiplier applied while the cursor is at rest. When the
   * cursor stops moving, the camera tightens by this factor over what the
   * configured zoom asks for. 1 = no extra dwell-zoom; 1.08 = up to 8% closer
   * when fully idle. The boost smoothly retracts as the cursor accelerates.
   */
  restScaleFactor: number;
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
  lookAheadSec: 0.22,
  maxLookAheadFraction: 0.18,
  restScaleFactor: 1.06,
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

function makeVelSpring(): CursorSpringValue {
  // Velocity components feed look-ahead bias. Tuned to react quickly on
  // sustained motion but smooth out single-frame velocity spikes from
  // sample noise — otherwise the lead jitters with cursor jitter.
  return new CursorSpringValue({ stiffness: 60, damping: 22, mass: 1 });
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
    velSpringX: makeVelSpring(),
    velSpringY: makeVelSpring(),
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
  state.velSpringX.reset();
  state.velSpringY.reset();
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
  /**
   * Multiplier applied to the configured zoom scale. Ranges from
   * `restScaleFactor` (≥ 1, slight zoom-in at rest) down to `minScaleFactor`
   * (≤ 1, zoom-out at full speed) — see CursorFollowConfig.
   */
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
  const rawVelX = state.lastTms == null ? 0 : dxC / dtSec;
  const rawVelY = state.lastTms == null ? 0 : dyC / dtSec;
  state.prevCursorX = cursorX;
  state.prevCursorY = cursorY;
  const speed = state.speedSpring.step(rawSpeed, dtMs);
  const velX = state.velSpringX.step(rawVelX, dtMs);
  const velY = state.velSpringY.step(rawVelY, dtMs);
  const speedNorm = clamp(speed / Math.max(1, config.speedReferencePxs), 0, 1);
  // Adaptive zoom: at rest, multiply UP to restScaleFactor (tighter framing
  // on idle) and at full speed, multiply DOWN to minScaleFactor (back off so
  // the user sees what they're flying past). The two ends interpolate
  // linearly through speedNorm.
  const restMul = Math.max(1, config.restScaleFactor);
  const minMul = clamp(config.minScaleFactor, 0.5, 1);
  const scaleFactor = restMul + (minMul - restMul) * speedNorm;

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

  // First frame in this zoom cycle — seat springs at the base focus so the
  // camera enters the zoom centered on the configured point.
  if (!state.initialized) {
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

  // Cinematic look-ahead. When the cursor is moving, push the safe-zone
  // anchor in the same direction so the cursor sits off-center, with empty
  // space ahead of it. Capped to a fraction of the visible window so the
  // cursor never disappears from frame even at full sprint.
  const lookAheadSec = Math.max(0, config.lookAheadSec);
  const leadCap = Math.max(0, config.maxLookAheadFraction);
  const maxLeadX = visW * leadCap;
  const maxLeadY = visH * leadCap;
  const leadX = clamp(velX * lookAheadSec, -maxLeadX, maxLeadX);
  const leadY = clamp(velY * lookAheadSec, -maxLeadY, maxLeadY);

  // Anchor the camera at the user's configured focus and shift only when the
  // cursor leaves the safe zone *around the anchor*. This keeps manual focus
  // authoritative — dragging the inspector's Focus slider moves the camera —
  // while still auto-panning to keep the cursor on screen during recording
  // playback. The look-ahead lead is added on top of the anchor so motion
  // direction biases the framing without breaking the dead-zone behavior.
  let nextX = baseFocusX + leadX;
  let nextY = baseFocusY + leadY;
  if (cursorX > nextX + safeHalfW) {
    nextX = cursorX - safeHalfW + leadX;
  } else if (cursorX < nextX - safeHalfW) {
    nextX = cursorX + safeHalfW + leadX;
  }
  if (cursorY > nextY + safeHalfH) {
    nextY = cursorY - safeHalfH + leadY;
  } else if (cursorY < nextY - safeHalfH) {
    nextY = cursorY + safeHalfH + leadY;
  }

  // Keep the focus point inside the source's coordinate space, but allow it
  // to reach the edges. The renderer applies its own clamp on draw position
  // (it knows about padding in contain mode and overflow in fill mode), so
  // limiting focus to half-the-visible-window from each edge — as we did
  // before — would silently veto the user's slider when they aim at the
  // recording's borders.
  nextX = clamp(nextX, 0, sourceWidth);
  nextY = clamp(nextY, 0, sourceHeight);

  state.targetX = nextX;
  state.targetY = nextY;
  state.frozenX = nextX;
  state.frozenY = nextY;

  // Spring chases the target — this is what makes the pan look cinematic.
  const sx = state.springX.step(nextX, dtMs);
  const sy = state.springY.step(nextY, dtMs);
  return { cx: sx, cy: sy, scaleFactor };
}
