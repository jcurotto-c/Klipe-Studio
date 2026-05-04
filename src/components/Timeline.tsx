import {
  useRef,
  useCallback,
  useState,
  useEffect,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { KlipeMouseEvent, Trim, ZoomSegment } from '../types';

const fmt = (s: number): string => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  const h = Math.floor((s % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}.${String(h).padStart(2, '0')}`;
};

const MIN_SEG_MS = 200;

type DragState =
  | { kind: 'playhead' }
  | { kind: 'trimStart' }
  | { kind: 'trimEnd' }
  | { kind: 'seg' | 'segStart' | 'segEnd'; id: string; startX: number; origStart: number; origEnd: number };

interface TimelineProps {
  duration: number;
  currentTime: number;
  onSeek: (t: number) => void;
  clicks: ReadonlyArray<KlipeMouseEvent>;
  segments: ZoomSegment[];
  selectedId: string | null;
  onSelectSegment?: (id: string | null) => void;
  onUpdateSegment: (id: string, patch: Partial<ZoomSegment>) => void;
  trim: Trim;
  onTrimChange: (next: Trim) => void;
}

export default function Timeline({
  duration,
  currentTime,
  onSeek,
  clicks,
  segments,
  selectedId,
  onSelectSegment,
  onUpdateSegment,
  trim,
  onTrimChange,
}: TimelineProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const xToTime = useCallback(
    (clientX: number) => {
      const r = trackRef.current!.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return ratio * duration;
    },
    [duration],
  );

  const xDeltaToMs = useCallback((dx: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return (dx / r.width) * duration * 1000;
  }, [duration]);

  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent): void => {
      const t = xToTime(e.clientX);
      if (drag.kind === 'playhead') {
        onSeek(t);
      } else if (drag.kind === 'trimStart') {
        onTrimChange({ start: Math.min(t, trim.end - 0.1), end: trim.end });
      } else if (drag.kind === 'trimEnd') {
        onTrimChange({ start: trim.start, end: Math.max(t, trim.start + 0.1) });
      } else if (drag.kind === 'seg') {
        const dx = e.clientX - drag.startX;
        const dMs = xDeltaToMs(dx);
        const len = drag.origEnd - drag.origStart;
        let ns = drag.origStart + dMs;
        ns = Math.max(0, Math.min(duration * 1000 - len, ns));
        onUpdateSegment(drag.id, { tStart: ns, tEnd: ns + len });
      } else if (drag.kind === 'segStart') {
        const dx = e.clientX - drag.startX;
        const dMs = xDeltaToMs(dx);
        let ns = drag.origStart + dMs;
        ns = Math.max(0, Math.min(drag.origEnd - MIN_SEG_MS, ns));
        onUpdateSegment(drag.id, { tStart: ns });
      } else if (drag.kind === 'segEnd') {
        const dx = e.clientX - drag.startX;
        const dMs = xDeltaToMs(dx);
        let ne = drag.origEnd + dMs;
        ne = Math.max(drag.origStart + MIN_SEG_MS, Math.min(duration * 1000, ne));
        onUpdateSegment(drag.id, { tEnd: ne });
      }
    };
    const up = (): void => setDrag(null);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [drag, onSeek, onTrimChange, onUpdateSegment, xToTime, xDeltaToMs, trim, duration]);

  const onTrackMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    if (target.dataset['handle']) return;
    if (target.closest('.zoom-seg')) return;
    onSelectSegment?.(null);
    onSeek(xToTime(e.clientX));
    setDrag({ kind: 'playhead' });
  };

  const onSegMouseDown = (e: ReactMouseEvent<HTMLDivElement>, seg: ZoomSegment): void => {
    e.stopPropagation();
    onSelectSegment?.(seg.id);
    setDrag({
      kind: 'seg',
      id: seg.id,
      startX: e.clientX,
      origStart: seg.tStart,
      origEnd: seg.tEnd,
    });
  };

  const onSegEdgeMouseDown = (
    e: ReactMouseEvent<HTMLDivElement>,
    seg: ZoomSegment,
    edge: 'start' | 'end',
  ): void => {
    e.stopPropagation();
    onSelectSegment?.(seg.id);
    setDrag({
      kind: edge === 'start' ? 'segStart' : 'segEnd',
      id: seg.id,
      startX: e.clientX,
      origStart: seg.tStart,
      origEnd: seg.tEnd,
    });
  };

  const tickEvery = duration > 60 ? 10 : duration > 20 ? 5 : 1;
  const ticks: number[] = [];
  for (let s = 0; s <= duration; s += tickEvery) {
    ticks.push(s);
  }

  const pct = (t: number): string => `${(t / duration) * 100}%`;
  const w = (a: number, b: number): string => `${((b - a) / duration) * 100}%`;

  return (
    <div className="timeline">
      <div className="ruler">
        {ticks.map((s) => (
          <div key={s} className="tick" style={{ left: pct(s) }}>
            {fmt(s)}
          </div>
        ))}
      </div>

      <div className="track" ref={trackRef} onMouseDown={onTrackMouseDown}>
        {segments.map((seg) => {
          const isSel = seg.id === selectedId;
          return (
            <div
              key={seg.id}
              className={`zoom-seg ${isSel ? 'selected' : ''} ${seg.source === 'manual' ? 'manual' : 'auto'}`}
              style={{
                left: pct(seg.tStart / 1000),
                width: w(seg.tStart / 1000, seg.tEnd / 1000),
              }}
              title={`Zoom ${seg.scale.toFixed(2)}x · ${seg.source}`}
              onMouseDown={(e) => onSegMouseDown(e, seg)}
            >
              <span className="zoom-seg-label">
                {`${seg.scale.toFixed(1)}× ${seg.source === 'manual' ? 'Manual' : 'Auto'}`}
              </span>
              <div
                className="zoom-seg-handle left"
                data-handle="seg-start"
                onMouseDown={(e) => onSegEdgeMouseDown(e, seg, 'start')}
              />
              <div
                className="zoom-seg-handle right"
                data-handle="seg-end"
                onMouseDown={(e) => onSegEdgeMouseDown(e, seg, 'end')}
              />
            </div>
          );
        })}

        {clicks.map((c, i) => (
          <div
            key={i}
            className="marker"
            style={{ left: pct(c.t / 1000) }}
            title={`Click @ ${(c.t / 1000).toFixed(2)}s`}
          />
        ))}

        <div className="trim" style={{ left: 0, width: pct(trim.start) }} />
        <div className="trim" style={{ left: pct(trim.end), width: `calc(${pct(duration - trim.end)})` }} />
        <div
          className="trim-handle"
          data-handle="start"
          style={{ left: pct(trim.start) }}
          onMouseDown={(e) => {
            e.stopPropagation();
            setDrag({ kind: 'trimStart' });
          }}
        />
        <div
          className="trim-handle"
          data-handle="end"
          style={{ left: `calc(${pct(trim.end)} - 8px)` }}
          onMouseDown={(e) => {
            e.stopPropagation();
            setDrag({ kind: 'trimEnd' });
          }}
        />

        <div className="playhead" style={{ left: pct(currentTime) }} />
      </div>
    </div>
  );
}
