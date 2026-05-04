/**
 * Deterministic spring solver — same damped-harmonic-oscillator model that
 * Framer Motion uses for `type: 'spring'`. We need a closed-form `f(t)`
 * (not a stateful integrator) because the canvas renderer is invoked with
 * an arbitrary `tMs` for every preview AND every export frame; a real-time
 * spring would desync between the two passes.
 */

export interface SpringOptions {
  stiffness: number;
  damping: number;
  mass: number;
}

export const SPRING_DEFAULTS: Readonly<SpringOptions> = Object.freeze({
  stiffness: 170,
  damping: 18,
  mass: 1,
});

const SETTLE_THRESHOLD = 0.001;

export function springAt(t: number, opts?: Partial<SpringOptions>): number {
  if (t <= 0) return 0;
  const { stiffness, damping, mass } = { ...SPRING_DEFAULTS, ...opts };
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const env = Math.exp(-zeta * w0 * t);
    return 1 - env * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) {
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  }
  const a = -zeta * w0;
  const b = w0 * Math.sqrt(zeta * zeta - 1);
  const c1 = 0.5 * (1 + (zeta * w0) / b);
  const c2 = 0.5 * (1 - (zeta * w0) / b);
  return 1 - Math.exp(a * t) * (c1 * Math.exp(b * t) + c2 * Math.exp(-b * t));
}

const settleCache = new Map<string, number>();
const cacheKey = (o: SpringOptions): string => `${o.stiffness}|${o.damping}|${o.mass}`;

export function springSettleTime(opts: Partial<SpringOptions> = SPRING_DEFAULTS): number {
  const merged: SpringOptions = { ...SPRING_DEFAULTS, ...opts };
  const key = cacheKey(merged);
  const cached = settleCache.get(key);
  if (cached != null) return cached;

  const dt = 1 / 240;
  let t = 0;
  let lastBad = 0;
  while (t < 6) {
    const x = springAt(t, merged);
    if (Math.abs(x - 1) > SETTLE_THRESHOLD) lastBad = t;
    t += dt;
  }
  const settle = Math.max(0.05, lastBad + dt);
  settleCache.set(key, settle);
  return settle;
}

export function springProgress(
  elapsedMs: number,
  windowMs: number,
  opts?: Partial<SpringOptions>,
): number {
  if (elapsedMs <= 0) return 0;
  if (windowMs <= 0) return 1;
  const settle = springSettleTime(opts);
  return springAt((elapsedMs / windowMs) * settle, opts);
}
