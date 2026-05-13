/**
 * Factories — make new overlays + apply animation presets.
 *
 * Layer IDs are generated client-side; no server roundtrip. Position defaults
 * to canvas center (0.5, 0.5) so newly added layers are immediately visible.
 */

import type {
  ImageOverlay,
  Overlay,
  OverlayBase,
  TextOverlay,
} from './types';

const DEFAULT_BASE: OverlayBase = {
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  opacity: 1,
  blur: 0,
};

let counter = 0;
function makeId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

function maxZ(overlays: Overlay[]): number {
  return overlays.reduce((acc, o) => Math.max(acc, o.z), 0);
}

export function createTextOverlay(overlays: Overlay[], text = 'Heading'): TextOverlay {
  return {
    id: makeId('text'),
    name: text.slice(0, 24),
    type: 'text',
    z: maxZ(overlays) + 1,
    text,
    sizeRel: 0.08, // ~ 86px at 1080p
    color: '#ffffff',
    weight: 700,
    align: 'center',
    base: { ...DEFAULT_BASE },
    transform: {},
  };
}

export function createImageOverlay(
  overlays: Overlay[],
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  name?: string,
): ImageOverlay {
  return {
    id: makeId('image'),
    name: name ?? 'Image',
    type: 'image',
    z: maxZ(overlays) + 1,
    src,
    naturalWidth,
    naturalHeight,
    sizeRel: 0.4, // 40% of canvas height as the long edge
    base: { ...DEFAULT_BASE },
    transform: {},
  };
}

// ---------------------------------------------------------------------------
// Animation presets
// ---------------------------------------------------------------------------

export type AnimationKind =
  | 'none'
  | 'fadeIn'
  | 'fadeOut'
  | 'slideInLeft'
  | 'slideInRight'
  | 'slideInTop'
  | 'slideInBottom'
  | 'popIn'
  | 'typewriter';

export interface AnimationPreset {
  id: AnimationKind;
  label: string;
  appliesTo: 'in' | 'out';
  /** True if this preset only works on text overlays. */
  textOnly?: boolean;
}

export const ANIMATION_PRESETS: ReadonlyArray<AnimationPreset> = [
  { id: 'none',          label: 'None',           appliesTo: 'in' },
  { id: 'fadeIn',        label: 'Fade In',        appliesTo: 'in' },
  { id: 'slideInLeft',   label: 'Slide ← Left',   appliesTo: 'in' },
  { id: 'slideInRight',  label: 'Slide → Right',  appliesTo: 'in' },
  { id: 'slideInTop',    label: 'Slide ↑ Top',    appliesTo: 'in' },
  { id: 'slideInBottom', label: 'Slide ↓ Bottom', appliesTo: 'in' },
  { id: 'popIn',         label: 'Pop In',         appliesTo: 'in' },
  { id: 'typewriter',    label: 'Typewriter',     appliesTo: 'in', textOnly: true },
  { id: 'fadeOut',       label: 'Fade Out',       appliesTo: 'out' },
];

const ENTRANCE_MS = 500;

/**
 * Apply an animation preset to an overlay. Mutates the overlay's transform
 * tracks (and typewriter for that preset) in place; returns a new overlay so
 * callers can drop it into setState. Earlier keyframes on the same track from
 * a previous preset are wiped — one preset at a time, simple model.
 */
export function applyAnimation(overlay: Overlay, kind: AnimationKind): Overlay {
  const trigger = overlay.visibleFrom ?? 0;
  const end = ENTRANCE_MS;
  const base = overlay.base;

  // Start from a clean slate for the tracks this preset touches.
  const next: Overlay = {
    ...overlay,
    transform: { ...overlay.transform },
  };
  if (overlay.type === 'text') {
    (next as TextOverlay).typewriter = undefined;
  }

  switch (kind) {
    case 'none':
      next.transform = {};
      if (next.type === 'text') (next as TextOverlay).typewriter = undefined;
      break;

    case 'fadeIn':
      next.transform.opacity = {
        keys: [
          { t: trigger, value: 0 },
          { t: trigger + end, value: base.opacity, easing: 'easeOutQuint' },
        ],
      };
      break;

    case 'fadeOut': {
      const out = overlay.visibleTo ?? trigger + 5000;
      next.transform.opacity = {
        keys: [
          { t: out - end, value: base.opacity },
          { t: out, value: 0, easing: 'easeOutQuint' },
        ],
      };
      break;
    }

    case 'slideInLeft':
      next.transform.position = {
        keys: [
          { t: trigger, value: { x: -0.3, y: base.y } },
          { t: trigger + end, value: { x: base.x, y: base.y }, easing: 'easeOutQuint' },
        ],
      };
      break;

    case 'slideInRight':
      next.transform.position = {
        keys: [
          { t: trigger, value: { x: 1.3, y: base.y } },
          { t: trigger + end, value: { x: base.x, y: base.y }, easing: 'easeOutQuint' },
        ],
      };
      break;

    case 'slideInTop':
      next.transform.position = {
        keys: [
          { t: trigger, value: { x: base.x, y: -0.2 } },
          { t: trigger + end, value: { x: base.x, y: base.y }, easing: 'easeOutQuint' },
        ],
      };
      break;

    case 'slideInBottom':
      next.transform.position = {
        keys: [
          { t: trigger, value: { x: base.x, y: 1.2 } },
          { t: trigger + end, value: { x: base.x, y: base.y }, easing: 'easeOutQuint' },
        ],
      };
      break;

    case 'popIn':
      next.transform.scale = {
        keys: [
          { t: trigger, value: 0 },
          { t: trigger + end, value: base.scale, easing: 'easeOutBack' },
        ],
      };
      next.transform.opacity = {
        keys: [
          { t: trigger, value: 0 },
          { t: trigger + 200, value: base.opacity, easing: 'easeOutQuint' },
        ],
      };
      break;

    case 'typewriter':
      if (next.type === 'text') {
        (next as TextOverlay).typewriter = {
          startMs: trigger,
          charsPerSecond: Math.max(8, Math.min(60, (next as TextOverlay).text.length * 3)),
        };
      }
      break;
  }
  return next;
}

/** Best-effort: detect which preset (if any) matches the overlay's current state. */
export function detectAnimation(overlay: Overlay): AnimationKind {
  if (overlay.type === 'text' && overlay.typewriter) return 'typewriter';
  const tx = overlay.transform;
  const opacity = tx.opacity?.keys;
  const position = tx.position?.keys;
  const scale = tx.scale?.keys;
  if (scale?.length === 2 && scale[0]!.value === 0) return 'popIn';
  if (position?.length === 2) {
    const start = position[0]!.value;
    const ending = position[1]!.value;
    if (start.x < -0.1 && start.y === ending.y) return 'slideInLeft';
    if (start.x > 1.1 && start.y === ending.y) return 'slideInRight';
    if (start.y < -0.05 && start.x === ending.x) return 'slideInTop';
    if (start.y > 1.05 && start.x === ending.x) return 'slideInBottom';
  }
  if (opacity?.length === 2) {
    if (opacity[0]!.value === 0 && opacity[1]!.value > 0) return 'fadeIn';
    if (opacity[0]!.value > 0 && opacity[1]!.value === 0) return 'fadeOut';
  }
  return 'none';
}
