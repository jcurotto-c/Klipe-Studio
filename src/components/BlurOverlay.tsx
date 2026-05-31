import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { PREVIEW_PADDING_SCALE, computeSourceInset } from '../lib/layout';
import { sampleBlurRegion } from '../lib/blur-engine';
import type { BlurRegion, BlurSampleRect, Crop, FitMode } from '../types';

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type DragMode = 'move' | HandleId;

const HANDLES: ReadonlyArray<{ id: HandleId; cx: number; cy: number; cursor: string }> = [
  { id: 'nw', cx: 0,   cy: 0,   cursor: 'nwse-resize' },
  { id: 'n',  cx: 0.5, cy: 0,   cursor: 'ns-resize'   },
  { id: 'ne', cx: 1,   cy: 0,   cursor: 'nesw-resize' },
  { id: 'e',  cx: 1,   cy: 0.5, cursor: 'ew-resize'   },
  { id: 'se', cx: 1,   cy: 1,   cursor: 'nwse-resize' },
  { id: 's',  cx: 0.5, cy: 1,   cursor: 'ns-resize'   },
  { id: 'sw', cx: 0,   cy: 1,   cursor: 'nesw-resize' },
  { id: 'w',  cx: 0,   cy: 0.5, cursor: 'ew-resize'   },
];

const MIN_REGION_SIZE = 0.02;

interface BlurOverlayProps {
  /** Unused, kept for API compatibility with CropOverlay-like callers. */
  canvasWidth?: number;
  canvasHeight?: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Output aspect (w/h). Null = follow source aspect. */
  aspectRatio?: number | null;
  /**
   * How a non-matching output aspect is fitted. Must mirror what the renderer
   * uses or the blur handles land off the baked region: 'fit' contains the
   * source (letterboxed), 'fill' cover-crops it. Defaults to 'fit'.
   */
  fitMode?: FitMode;
  crop: Crop | null | undefined;
  paddingScale?: number;
  regions: BlurRegion[];
  /** Current source time (ms) — drives keyframe interpolation. */
  currentSrcMs: number;
  selectedId: string | null;
  /** Master toggle. When false the overlay is invisible and inert. */
  enabled: boolean;
  onSelect: (id: string | null) => void;
  /** Called while dragging a region; should update its keyframe(s). */
  onDragRect: (id: string, rect: BlurSampleRect) => void;
  /** Called once on mouse-up so the consumer can record undo history. */
  onCommitRect?: (id: string) => void;
  /**
   * Called when the user finishes drawing a brand-new region. The consumer
   * decides time window + initial keyframe from the supplied rect.
   */
  onCreate: (rect: BlurSampleRect) => void;
}

interface Inset {
  /** Wrapper-normalized [0..1] rect where the visible source content sits. */
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DragState {
  mode: DragMode;
  regionId: string;
  startSrc: { x: number; y: number };
  origin: BlurSampleRect;
  /** Set on the first move so we don't push history for click-only events. */
  moved: boolean;
}

interface DrawState {
  startSrc: { x: number; y: number };
  current: BlurSampleRect;
}

export default function BlurOverlay({
  sourceWidth,
  sourceHeight,
  aspectRatio = null,
  fitMode = 'fit',
  crop,
  paddingScale = PREVIEW_PADDING_SCALE,
  regions,
  currentSrcMs,
  selectedId,
  enabled,
  onSelect,
  onDragRect,
  onCommitRect,
  onCreate,
}: BlurOverlayProps): JSX.Element | null {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [drawing, setDrawing] = useState<DrawState | null>(null);

  // Where the visible source sits inside the wrapper, as wrapper-normalized
  // fractions [0..1] — mirrors the renderer's transform so a rect drawn here
  // applies to the same canvas pixels at export. Shared with the renderer and
  // the zoom-placement overlay via computeSourceInset (see lib/layout).
  const inset = useMemo<Inset>(
    () => computeSourceInset(sourceWidth, sourceHeight, aspectRatio, fitMode, paddingScale),
    [sourceWidth, sourceHeight, aspectRatio, fitMode, paddingScale],
  );

  const cropRect: Crop = crop ?? { x: 0, y: 0, width: 1, height: 1 };

  // Pointer position → FULL-source-normalized coords [0..1].
  const pointerToSource = useCallback(
    (e: ReactPointerEvent<HTMLElement>): { x: number; y: number } => {
      const r = wrapperRef.current!.getBoundingClientRect();
      const wx = (e.clientX - r.left) / r.width;
      const wy = (e.clientY - r.top) / r.height;
      // Position within the visible (post-crop) source [0..1].
      const lx = (wx - inset.left) / inset.width;
      const ly = (wy - inset.top) / inset.height;
      return {
        x: cropRect.x + lx * cropRect.width,
        y: cropRect.y + ly * cropRect.height,
      };
    },
    [inset, cropRect],
  );

  // Source-normalized rect → wrapper-normalized rect for CSS positioning.
  const rectToWrapper = useCallback(
    (r: BlurSampleRect) => {
      const lx = (r.x - cropRect.x) / cropRect.width;
      const ly = (r.y - cropRect.y) / cropRect.height;
      const lw = r.width / cropRect.width;
      const lh = r.height / cropRect.height;
      return {
        left: inset.left + lx * inset.width,
        top: inset.top + ly * inset.height,
        width: lw * inset.width,
        height: lh * inset.height,
      };
    },
    [inset, cropRect],
  );

  const clampRect = (r: BlurSampleRect): BlurSampleRect => ({
    x: Math.max(0, Math.min(1 - MIN_REGION_SIZE, r.x)),
    y: Math.max(0, Math.min(1 - MIN_REGION_SIZE, r.y)),
    width: Math.max(MIN_REGION_SIZE, Math.min(1 - r.x, r.width)),
    height: Math.max(MIN_REGION_SIZE, Math.min(1 - r.y, r.height)),
  });

  // Normalize a rect that may have negative width/height (mid-draw).
  const normRect = (r: BlurSampleRect): BlurSampleRect => {
    const x = r.width < 0 ? r.x + r.width : r.x;
    const y = r.height < 0 ? r.y + r.height : r.y;
    return {
      x,
      y,
      width: Math.abs(r.width),
      height: Math.abs(r.height),
    };
  };

  const startDragRegion = useCallback(
    (e: ReactPointerEvent<HTMLElement>, region: BlurRegion, mode: DragMode): void => {
      const rect = sampleBlurRegion(region, currentSrcMs);
      if (!rect) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      onSelect(region.id);
      dragRef.current = {
        mode,
        regionId: region.id,
        startSrc: pointerToSource(e),
        origin: rect,
        moved: false,
      };
    },
    [currentSrcMs, onSelect, pointerToSource],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (drawing) {
        const cur = pointerToSource(e);
        const next: BlurSampleRect = {
          x: drawing.startSrc.x,
          y: drawing.startSrc.y,
          width: cur.x - drawing.startSrc.x,
          height: cur.y - drawing.startSrc.y,
        };
        setDrawing({ ...drawing, current: next });
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const cur = pointerToSource(e);
      const dx = cur.x - drag.startSrc.x;
      const dy = cur.y - drag.startSrc.y;
      const o = drag.origin;
      let next: BlurSampleRect = { ...o };
      if (drag.mode === 'move') {
        next.x = o.x + dx;
        next.y = o.y + dy;
        next.x = Math.max(0, Math.min(1 - o.width, next.x));
        next.y = Math.max(0, Math.min(1 - o.height, next.y));
      } else {
        let l = o.x;
        let r = o.x + o.width;
        let t = o.y;
        let b = o.y + o.height;
        if (drag.mode.includes('w')) l = Math.min(r - MIN_REGION_SIZE, Math.max(0, o.x + dx));
        if (drag.mode.includes('e')) r = Math.max(l + MIN_REGION_SIZE, Math.min(1, o.x + o.width + dx));
        if (drag.mode.includes('n')) t = Math.min(b - MIN_REGION_SIZE, Math.max(0, o.y + dy));
        if (drag.mode.includes('s')) b = Math.max(t + MIN_REGION_SIZE, Math.min(1, o.y + o.height + dy));
        next = { x: l, y: t, width: r - l, height: b - t };
      }
      drag.moved = true;
      onDragRect(drag.regionId, clampRect(next));
    },
    [drawing, pointerToSource, onDragRect],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (drawing) {
        const final = clampRect(normRect(drawing.current));
        if (final.width >= MIN_REGION_SIZE * 2 && final.height >= MIN_REGION_SIZE * 2) {
          onCreate(final);
        }
        setDrawing(null);
        return;
      }
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag && drag.moved) onCommitRect?.(drag.regionId);
    },
    [drawing, onCreate, onCommitRect],
  );

  const onWrapperDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!enabled) return;
    const target = e.target as HTMLElement;
    if (target.closest('.blur-region')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect(null);
    const start = pointerToSource(e);
    setDrawing({
      startSrc: start,
      current: { x: start.x, y: start.y, width: 0, height: 0 },
    });
  };

  if (!enabled) return null;

  const pct = (v: number): string => `${(v * 100).toFixed(4)}%`;

  return (
    <div
      ref={wrapperRef}
      className="blur-overlay"
      onPointerDown={onWrapperDown}
      onPointerMove={onMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {regions.map((region) => {
        const rect = sampleBlurRegion(region, currentSrcMs);
        if (!rect) return null;
        const isSelected = region.id === selectedId;
        const w = rectToWrapper(rect);
        return (
          <div
            key={region.id}
            className={`blur-region ${isSelected ? 'is-selected' : ''} shape-${region.shape}`}
            style={{
              left: pct(w.left),
              top: pct(w.top),
              width: pct(w.width),
              height: pct(w.height),
            }}
            onPointerDown={(e) => startDragRegion(e, region, 'move')}
          >
            <div className="blur-region-fill" />
            {isSelected && HANDLES.map((h) => (
              <div
                key={h.id}
                className={`blur-handle blur-handle-${h.id}`}
                style={{ left: `${h.cx * 100}%`, top: `${h.cy * 100}%`, cursor: h.cursor }}
                onPointerDown={(e) => startDragRegion(e, region, h.id)}
              />
            ))}
          </div>
        );
      })}

      {drawing && (() => {
        const r = clampRect(normRect(drawing.current));
        const w = rectToWrapper(r);
        return (
          <div
            className="blur-region drawing"
            style={{
              left: pct(w.left),
              top: pct(w.top),
              width: pct(w.width),
              height: pct(w.height),
            }}
          >
            <div className="blur-region-fill" />
          </div>
        );
      })()}
    </div>
  );
}
