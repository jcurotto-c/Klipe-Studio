/**
 * Captions — timed subtitle text, rendered as a thin layer on top of the
 * overlay engine.
 *
 * Captions are a DEDICATED model (not user overlays): a flat list of timed text
 * segments sharing ONE global `CaptionStyle` (classic-subtitle look — bottom
 * centred, 1–2 lines). They never carry per-item position, z, keyframes or
 * animation. At render/export time `captionsToOverlays` converts the list into
 * ephemeral `TextOverlay`s so the SAME `OverlayStage` draws them — full reuse,
 * zero engine changes to the core render path.
 *
 * Times are in milliseconds, output-time space (the timeline clock), like
 * overlays' `visibleFrom`/`visibleTo`.
 */

import type { OverlayBase, TextOverlay } from './types';

export interface Caption {
  id: string;
  text: string;
  /** Output-time window, ms. */
  startMs: number;
  endMs: number;
}

export interface CaptionStyle {
  /** Font id from the registry (src/overlays/fonts.ts). Absent → default. */
  fontFamily?: string;
  weight?: number;
  /** Text height as a fraction of canvas height. */
  sizeRel: number;
  color: string;
  uppercase?: boolean;
  /** Distance of the text baseline band from the BOTTOM edge, 0..1. */
  bottomOffsetRel: number;
  /** Max line width before wrapping, as a fraction of canvas width. */
  maxWidthRel: number;
  align: 'left' | 'center' | 'right';
  /** Background pill behind the text (off when null). */
  box?: { color: string; opacity: number; padRel: number } | null;
  /** Outline stroke for legibility over video (off when null). */
  outline?: { color: string; width: number } | null;
  /** Legibility drop-shadow. Default on. */
  shadow?: boolean;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'inter',
  weight: 700,
  sizeRel: 0.05,
  color: '#ffffff',
  uppercase: false,
  bottomOffsetRel: 0.12,
  maxWidthRel: 0.8,
  align: 'center',
  box: null,
  outline: null,
  shadow: true,
};

/** Captions render above user overlays. */
const CAPTION_Z = 100000;

const DEFAULT_BASE: OverlayBase = {
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  opacity: 1,
  blur: 0,
};

let counter = 0;
export function makeCaptionId(): string {
  counter += 1;
  return `cap-${Date.now().toString(36)}-${counter}`;
}

/**
 * Horizontal anchor x for the caption block given the style align + max width.
 * Centre → 0.5; left/right hug the inner edge of the max-width band so wrapped
 * lines stay on-screen.
 */
function blockX(style: CaptionStyle): number {
  const margin = (1 - Math.min(1, Math.max(0.1, style.maxWidthRel))) / 2;
  if (style.align === 'left') return margin;
  if (style.align === 'right') return 1 - margin;
  return 0.5;
}

/**
 * Convert the caption list + shared style into ephemeral text overlays the
 * OverlayStage can render. Pure — called from a memo in the editor and inline
 * at export time.
 */
export function captionsToOverlays(captions: Caption[], style: CaptionStyle): TextOverlay[] {
  const x = blockX(style);
  const y = 1 - Math.min(0.95, Math.max(0, style.bottomOffsetRel));
  return captions.map((cap) => ({
    id: cap.id,
    name: cap.text.slice(0, 24),
    type: 'text' as const,
    z: CAPTION_Z,
    visibleFrom: cap.startMs,
    visibleTo: cap.endMs,
    text: cap.text,
    sizeRel: style.sizeRel,
    color: style.color,
    weight: style.weight ?? 700,
    align: style.align,
    uppercase: style.uppercase,
    shadow: style.shadow ?? true,
    fontFamily: style.fontFamily,
    base: { ...DEFAULT_BASE, x, y },
    transform: {},
    wordWrapRel: style.maxWidthRel,
    stroke: style.outline ?? undefined,
    box: style.box ?? undefined,
  }));
}
