/**
 * Easing curves for overlay animations.
 *
 * Default for most properties: `easeOutQuint` (Keynote/Arc Browser signature —
 * decisive arrival, no bounce). `easeOutBack` for subtle overshoot; `spring`
 * for a damped oscillation. Heavier overshoots read as cartoon.
 */

import type { Easing } from '../types';

const BACK_C1 = 1.70158;
const BACK_C3 = BACK_C1 + 1;

const SPRING_ZETA = 0.6;
const SPRING_OMEGA = 9;
const SPRING_OMEGA_D = SPRING_OMEGA * Math.sqrt(1 - SPRING_ZETA * SPRING_ZETA);

export function applyEasing(easing: Easing | undefined, t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  switch (easing) {
    case undefined:
    case 'linear':
      return x;
    case 'easeOutQuint':
      return 1 - Math.pow(1 - x, 5);
    case 'easeInOutCubic':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'easeOutExpo':
      return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
    case 'easeOutBack':
      return 1 + BACK_C3 * Math.pow(x - 1, 3) + BACK_C1 * Math.pow(x - 1, 2);
    case 'spring': {
      if (x === 0) return 0;
      if (x === 1) return 1;
      const decay = Math.exp(-SPRING_ZETA * SPRING_OMEGA * x);
      const oscillation =
        Math.cos(SPRING_OMEGA_D * x) +
        ((SPRING_ZETA * SPRING_OMEGA) / SPRING_OMEGA_D) * Math.sin(SPRING_OMEGA_D * x);
      return 1 - decay * oscillation;
    }
  }
}
