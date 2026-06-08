import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './area-select.css';

interface Rect { x: number; y: number; w: number; h: number; }

/** Ignore accidental tiny drags (CSS px). */
const MIN_SIZE = 24;

function AreaSelect(): JSX.Element {
  const [init, setInit] = useState<AreaSelectInit | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [drawing, setDrawing] = useState(false);
  const drawingRef = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const bridge = window.klipeAreaSelect;
    if (!bridge) return;
    return bridge.onInit((payload) => setInit(payload));
  }, []);

  const cancel = useCallback(() => window.klipeAreaSelect?.cancel(), []);

  const confirm = useCallback(() => {
    if (!rect || rect.w < MIN_SIZE || rect.h < MIN_SIZE) return;
    window.klipeAreaSelect?.submit({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  }, [rect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter') confirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel, confirm]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drawingRef.current = true;
    setDrawing(true);
    start.current = { x: e.clientX, y: e.clientY };
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawingRef.current || !start.current) return;
    const sx = start.current.x;
    const sy = start.current.y;
    setRect({
      x: Math.min(sx, e.clientX),
      y: Math.min(sy, e.clientY),
      w: Math.abs(e.clientX - sx),
      h: Math.abs(e.clientY - sy),
    });
  }, []);

  const onPointerUp = useCallback(() => {
    drawingRef.current = false;
    setDrawing(false);
    setRect((r) => (r && (r.w < MIN_SIZE || r.h < MIN_SIZE) ? null : r));
  }, []);

  const sf = init?.scaleFactor ?? 1;
  const pxW = rect ? Math.round(rect.w * sf) : 0;
  const pxH = rect ? Math.round(rect.h * sf) : 0;
  const ready = !!rect && rect.w >= MIN_SIZE && rect.h >= MIN_SIZE;

  return (
    <div
      className="as-root"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {!rect && (
        <div className="as-hint">
          Drag to select an area{init ? ` on ${init.label}` : ''} · <b>Enter</b> to record · <b>Esc</b> to cancel
        </div>
      )}
      {rect && (
        <div
          className={`as-rect ${ready ? 'is-ready' : ''}`}
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          <div className="as-dims">{pxW} × {pxH}</div>
        </div>
      )}
      {ready && !drawing && (
        <div className="as-toolbar" onPointerDown={(e) => e.stopPropagation()}>
          <button className="as-btn as-confirm" onClick={confirm}>Record this area</button>
          <button className="as-btn as-cancel" onClick={cancel}>Cancel</button>
        </div>
      )}
    </div>
  );
}

const rootEl = document.getElementById('area-select-root');
if (rootEl) {
  createRoot(rootEl).render(<AreaSelect />);
}
