import { useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import {
  computeInsetRect,
  clampCrop,
  PREVIEW_PADDING_SCALE,
  MIN_CROP_NORM,
} from '../lib/layout';
import type { Crop } from '../types';

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type DragMode = 'move' | HandleId;

interface HandleDef {
  id: HandleId;
  cx: number;
  cy: number;
  cursor: string;
}

const HANDLES: HandleDef[] = [
  { id: 'nw', cx: 0,   cy: 0,   cursor: 'nwse-resize' },
  { id: 'n',  cx: 0.5, cy: 0,   cursor: 'ns-resize' },
  { id: 'ne', cx: 1,   cy: 0,   cursor: 'nesw-resize' },
  { id: 'e',  cx: 1,   cy: 0.5, cursor: 'ew-resize' },
  { id: 'se', cx: 1,   cy: 1,   cursor: 'nwse-resize' },
  { id: 's',  cx: 0.5, cy: 1,   cursor: 'ns-resize' },
  { id: 'sw', cx: 0,   cy: 1,   cursor: 'nesw-resize' },
  { id: 'w',  cx: 0,   cy: 0.5, cursor: 'ew-resize' },
];

interface CropOverlayProps {
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  crop: Crop | null | undefined;
  onChange: (next: Crop) => void;
  paddingScale?: number;
}

interface DragState {
  mode: DragMode;
  start: { sx: number; sy: number };
  origin: Crop;
}

export default function CropOverlay({
  canvasWidth,
  canvasHeight,
  sourceWidth,
  sourceHeight,
  crop,
  onChange,
  paddingScale = PREVIEW_PADDING_SCALE,
}: CropOverlayProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const inset = useMemo(
    () => computeInsetRect(canvasWidth, canvasHeight, sourceWidth, sourceHeight, paddingScale),
    [canvasWidth, canvasHeight, sourceWidth, sourceHeight, paddingScale],
  );

  const baseN = useMemo(() => ({
    left: inset.baseX / canvasWidth,
    top: inset.baseY / canvasHeight,
    width: inset.baseW / canvasWidth,
    height: inset.baseH / canvasHeight,
  }), [inset, canvasWidth, canvasHeight]);

  const active: Crop = crop ?? { x: 0, y: 0, width: 1, height: 1 };

  const rectN = useMemo(() => ({
    left: baseN.left + active.x * baseN.width,
    top: baseN.top + active.y * baseN.height,
    width: active.width * baseN.width,
    height: active.height * baseN.height,
  }), [baseN, active]);

  const pointerToSource = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const rect = wrapperRef.current!.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    return {
      sx: (px - baseN.left) / baseN.width,
      sy: (py - baseN.top) / baseN.height,
    };
  }, [baseN]);

  const startDrag = useCallback((e: ReactPointerEvent<HTMLElement>, mode: DragMode) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = pointerToSource(e);
    dragRef.current = { mode, start, origin: { ...active } };
  }, [pointerToSource, active]);

  const onMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const cur = pointerToSource(e);
    const dx = cur.sx - drag.start.sx;
    const dy = cur.sy - drag.start.sy;
    const o = drag.origin;
    let next: Crop = { ...o };

    if (drag.mode === 'move') {
      next.x = Math.min(1 - o.width, Math.max(0, o.x + dx));
      next.y = Math.min(1 - o.height, Math.max(0, o.y + dy));
    } else {
      let l = o.x;
      let r = o.x + o.width;
      let t = o.y;
      let b = o.y + o.height;
      if (drag.mode.includes('w')) l = Math.min(r - MIN_CROP_NORM, Math.max(0, o.x + dx));
      if (drag.mode.includes('e')) r = Math.max(l + MIN_CROP_NORM, Math.min(1, o.x + o.width + dx));
      if (drag.mode.includes('n')) t = Math.min(b - MIN_CROP_NORM, Math.max(0, o.y + dy));
      if (drag.mode.includes('s')) b = Math.max(t + MIN_CROP_NORM, Math.min(1, o.y + o.height + dy));
      next = { x: l, y: t, width: r - l, height: b - t };
    }
    onChange(clampCrop(next));
  }, [pointerToSource, onChange]);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
  }, []);

  const pct = (v: number): string => `${(v * 100).toFixed(4)}%`;

  return (
    <div ref={wrapperRef} className="crop-overlay">
      <div
        className="crop-rect"
        style={{
          left: pct(rectN.left),
          top: pct(rectN.top),
          width: pct(rectN.width),
          height: pct(rectN.height),
        }}
        onPointerDown={(e) => startDrag(e, 'move')}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="crop-grid" />
        {HANDLES.map((h) => (
          <div
            key={h.id}
            className={`crop-handle crop-handle-${h.id}`}
            style={{
              left: `${h.cx * 100}%`,
              top: `${h.cy * 100}%`,
              cursor: h.cursor,
            }}
            onPointerDown={(e) => startDrag(e, h.id)}
            onPointerMove={onMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        ))}
      </div>
    </div>
  );
}
