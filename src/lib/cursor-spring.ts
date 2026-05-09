/**
 * Stateful spring chasing a moving target. Uses semi-implicit Euler
 * integration — small per-frame steps, target may change every frame.
 * (The repo's other spring.ts is a closed-form `f(t)` solver intended
 * for offline animation curves; this one is for live cursor chasing.)
 */

export interface SpringTuning {
  stiffness: number;
  damping: number;
  mass: number;
}

export const DEFAULT_CURSOR_SPRING: Readonly<SpringTuning> = Object.freeze({
  stiffness: 320,
  damping: 32,
  mass: 1,
});

export class CursorSpringValue {
  value = 0;
  velocity = 0;
  private initialized = false;
  private tuning: SpringTuning;

  constructor(tuning: SpringTuning = DEFAULT_CURSOR_SPRING) {
    this.tuning = tuning;
  }

  setTuning(tuning: SpringTuning): void {
    this.tuning = tuning;
  }

  reset(value = 0): void {
    this.value = value;
    this.velocity = 0;
    this.initialized = false;
  }

  snap(value: number): void {
    this.value = value;
    this.velocity = 0;
    this.initialized = true;
  }

  step(target: number, deltaMs: number): number {
    if (!this.initialized || !Number.isFinite(this.value)) {
      this.value = target;
      this.velocity = 0;
      this.initialized = true;
      return this.value;
    }

    const dt = Math.max(1, Math.min(80, deltaMs)) / 1000;
    const { stiffness, damping, mass } = this.tuning;

    // Sub-step for stability when dt is large or stiffness is high.
    const steps = Math.max(1, Math.ceil(dt * 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      const accel = (stiffness * (target - this.value) - damping * this.velocity) / mass;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }

    if (Math.abs(target - this.value) < 0.0005 && Math.abs(this.velocity) < 0.02) {
      this.value = target;
      this.velocity = 0;
    }
    return this.value;
  }
}
