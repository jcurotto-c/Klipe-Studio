/**
 * OverlayCanvas — transparent Pixi canvas stacked over the Editor's main
 * VideoCanvas. Renders text/image overlay layers using OverlayStage.
 *
 * Sizing: mirrors the host wrap element (the .canvas-wrap inside VideoCanvas)
 * via ResizeObserver, so it always covers the same CSS rect as the video
 * canvas. Internal pixel buffer scales to devicePixelRatio.
 *
 * Render cadence: re-renders whenever `overlays` or `timeMs` props change.
 * The Editor's playback RAF updates currentTime ~30/sec, so this hook
 * effectively renders at that cadence. For a paused editor, it renders once
 * per state change — no idle GPU work.
 *
 * Pointer events: enabled when `interactive` is true. Click selects the
 * topmost overlay under the cursor (or clears selection on empty space), and
 * dragging a selected overlay moves its base position. Coordinates are
 * normalized to canvas fractions before being forwarded to onMove.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { OverlayStage } from './engine/OverlayStage';
import type { Overlay } from './types';

const DRAG_THRESHOLD_PX = 3;

interface DragState {
  overlayId: string;
  startCanvasX: number;
  startCanvasY: number;
  startBaseX: number;
  startBaseY: number;
  active: boolean;
}

interface OverlayCanvasProps {
  /** The element whose bounding rect the overlay canvas should match. */
  hostRef: RefObject<HTMLElement>;
  overlays: Overlay[];
  /** Current playhead in output-time ms — drives keyframe sampling. */
  timeMs: number;
  /** When true, the overlay canvas captures pointer events. */
  interactive?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Called while dragging — `{ x, y }` are fractional canvas units. */
  onMove?: (id: string, base: { x: number; y: number }) => void;
}

export default function OverlayCanvas({
  hostRef,
  overlays,
  timeMs,
  interactive = false,
  selectedId = null,
  onSelect,
  onMove,
}: OverlayCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<OverlayStage | null>(null);
  const mountedRef = useRef(false);
  const pendingFrameRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const overlaysRef = useRef<Overlay[]>(overlays);
  overlaysRef.current = overlays;
  const timeRef = useRef(timeMs);
  timeRef.current = timeMs;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  // Mount Pixi once.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    // Always mounts as a child of VideoCanvas's .canvas-wrap. The parent
    // sizes the wrap in *its* useLayoutEffect, which runs AFTER ours (React
    // commits children first). So at this point the host can still be 0×0;
    // we mount Pixi at a placeholder 1×1 and re-sync below after the async
    // init completes, by which time the parent layout has settled.
    const measure = (): { w: number; h: number } => {
      const r = host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return {
        w: Math.max(1, Math.round(r.width * dpr)),
        h: Math.max(1, Math.round(r.height * dpr)),
      };
    };
    const initial = measure();
    let cancelled = false;
    const stage = new OverlayStage();
    stageRef.current = stage;
    void stage.mount(canvas, initial.w, initial.h).then(() => {
      if (cancelled) { stage.dispose(); return; }
      mountedRef.current = true;
      // Re-measure: by the time the async init resolves, the parent wrap
      // has almost certainly been sized. Without this, an overlay added
      // immediately after mount renders into a 1×1 buffer and is invisible
      // once the canvas is CSS-stretched to the real preview rect.
      const after = measure();
      if (after.w !== initial.w || after.h !== initial.h) {
        canvas.width = after.w;
        canvas.height = after.h;
        stage.resize(after.w, after.h);
      }
      stage.setSelected(selectedId);
      void stage.setOverlays(overlays).then(() => {
        if (cancelled) return;
        stage.renderAt(timeMs);
      });
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      stage.dispose();
      stageRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track host size — mirror it on the overlay canvas so the two pixel grids align.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const apply = (): void => {
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      stageRef.current?.resize(w, h);
      if (mountedRef.current) stageRef.current?.renderAt(timeRef.current);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(host);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostRef]);

  // Push overlay set + selection + time into the stage. Coalesce renders to
  // one per RAF tick so rapid React state updates don't queue redundant renders.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !mountedRef.current) return;
    let cancelled = false;
    stage.setSelected(selectedId);
    void stage.setOverlays(overlays).then(() => {
      if (cancelled) return;
      if (pendingFrameRef.current != null) cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = requestAnimationFrame(() => {
        pendingFrameRef.current = null;
        if (mountedRef.current) stage.renderAt(timeMs);
      });
    });
    return () => { cancelled = true; };
  }, [overlays, timeMs, selectedId]);

  const canvasCoords = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const stage = stageRef.current;
    if (!stage || !mountedRef.current) return;
    const { x, y } = canvasCoords(e);
    const hitId = stage.hitTest(x, y, timeRef.current);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!hitId) {
      onSelectRef.current?.(null);
      dragRef.current = null;
      return;
    }
    onSelectRef.current?.(hitId);
    const overlay = overlaysRef.current.find((o) => o.id === hitId);
    if (!overlay) { dragRef.current = null; return; }
    dragRef.current = {
      overlayId: hitId,
      startCanvasX: x,
      startCanvasY: y,
      startBaseX: overlay.base.x,
      startBaseY: overlay.base.y,
      active: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    if (!drag || e.buttons !== 1) return;
    const stage = stageRef.current;
    if (!stage) return;
    const { x, y } = canvasCoords(e);
    const dx = x - drag.startCanvasX;
    const dy = y - drag.startCanvasY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
    }
    onMoveRef.current?.(drag.overlayId, {
      x: drag.startBaseX + dx / stage.width,
      y: drag.startBaseY + dy / stage.height,
    });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    dragRef.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: interactive ? 'auto' : 'none',
        cursor: interactive ? (selectedId ? 'move' : 'default') : 'default',
      }}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUp : undefined}
    />
  );
}
