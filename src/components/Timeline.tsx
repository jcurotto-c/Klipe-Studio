import {
  useRef,
  useCallback,
  useState,
  useEffect,
  useMemo,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  fragmentDuration,
  reorderFragment,
} from '../lib/fragments';
import type { Fragment, KlipeMouseEvent, ZoomSegment } from '../types';

const fmt = (s: number): string => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  const h = Math.floor((s % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}.${String(h).padStart(2, '0')}`;
};

const MIN_SEG_MS = 200;

const FRAG_DRAG_THRESHOLD_PX = 6;

type DragState =
  | { kind: 'playhead' }
  | { kind: 'fragMove'; id: string; index: number; startX: number; armed: boolean }
  | { kind: 'fragEdge'; index: number; edge: 'start' | 'end'; startX: number; origSrc: number }
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
  fragments: Fragment[];
  sourceDuration: number;
  selectedFragmentId: string | null;
  onSelectFragment: (id: string | null) => void;
  onUpdateFragments: (next: Fragment[]) => void;
  onFragmentEdge: (index: number, edge: 'start' | 'end', srcTime: number) => void;
  onBeginEdit?: () => void;
}

interface FragmentLayout {
  fragment: Fragment;
  index: number;
  outputStart: number;
  outputEnd: number;
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
  fragments,
  sourceDuration,
  selectedFragmentId,
  onSelectFragment,
  onUpdateFragments,
  onFragmentEdge,
  onBeginEdit,
}: TimelineProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const layouts = useMemo<FragmentLayout[]>(() => {
    const out: FragmentLayout[] = [];
    let acc = 0;
    for (let i = 0; i < fragments.length; i++) {
      const f = fragments[i]!;
      const d = fragmentDuration(f);
      out.push({ fragment: f, index: i, outputStart: acc, outputEnd: acc + d });
      acc += d;
    }
    return out;
  }, [fragments]);

  const xToOutputTime = useCallback(
    (clientX: number) => {
      const r = trackRef.current!.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return ratio * duration;
    },
    [duration],
  );

  const xDeltaToSeconds = useCallback(
    (dx: number) => {
      const r = trackRef.current!.getBoundingClientRect();
      return (dx / r.width) * duration;
    },
    [duration],
  );

  useEffect(() => {
    if (!drag) return;
    let armed = drag.kind === 'fragMove' ? drag.armed : false;
    const move = (e: MouseEvent): void => {
      if (drag.kind === 'playhead') {
        onSeek(xToOutputTime(e.clientX));
        return;
      }
      if (drag.kind === 'fragMove') {
        if (!armed) {
          if (Math.abs(e.clientX - drag.startX) < FRAG_DRAG_THRESHOLD_PX) return;
          armed = true;
          onBeginEdit?.();
        }
        const t = xToOutputTime(e.clientX);
        let target = fragments.length;
        for (let i = 0; i < layouts.length; i++) {
          const l = layouts[i]!;
          const mid = l.outputStart + (l.outputEnd - l.outputStart) / 2;
          if (t < mid) { target = i; break; }
        }
        if (target > drag.index) target -= 1;
        setDropIndex(target);
        return;
      }
      if (drag.kind === 'fragEdge') {
        const dt = xDeltaToSeconds(e.clientX - drag.startX);
        const ns = Math.max(0, Math.min(sourceDuration, drag.origSrc + dt));
        onFragmentEdge(drag.index, drag.edge, ns);
        return;
      }
      const tMs = xToOutputTime(e.clientX) * 1000;
      if (drag.kind === 'seg') {
        const dx = e.clientX - drag.startX;
        const dMs = (dx / trackRef.current!.getBoundingClientRect().width) * duration * 1000;
        const len = drag.origEnd - drag.origStart;
        let ns = drag.origStart + dMs;
        ns = Math.max(0, Math.min(duration * 1000 - len, ns));
        onUpdateSegment(drag.id, { tStart: ns, tEnd: ns + len });
      } else if (drag.kind === 'segStart') {
        let ns = tMs;
        ns = Math.max(0, Math.min(drag.origEnd - MIN_SEG_MS, ns));
        onUpdateSegment(drag.id, { tStart: ns });
      } else if (drag.kind === 'segEnd') {
        let ne = tMs;
        ne = Math.max(drag.origStart + MIN_SEG_MS, Math.min(duration * 1000, ne));
        onUpdateSegment(drag.id, { tEnd: ne });
      }
    };
    const up = (): void => {
      if (drag.kind === 'fragMove' && armed && dropIndex != null) {
        const next = reorderFragment(fragments, drag.index, dropIndex);
        if (next !== fragments) onUpdateFragments(next);
      }
      setDropIndex(null);
      setDrag(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [
    drag, onSeek, onUpdateSegment, onUpdateFragments, onFragmentEdge, onBeginEdit,
    xToOutputTime, xDeltaToSeconds, duration, sourceDuration,
    fragments, layouts, dropIndex,
  ]);

  const onTrackMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    if (target.dataset['handle']) return;
    if (target.closest('.zoom-seg')) return;
    if (target.closest('.fragment')) return;
    onSelectSegment?.(null);
    onSelectFragment(null);
    onSeek(xToOutputTime(e.clientX));
    setDrag({ kind: 'playhead' });
  };

  const onSegMouseDown = (e: ReactMouseEvent<HTMLDivElement>, seg: ZoomSegment): void => {
    e.stopPropagation();
    onSelectSegment?.(seg.id);
    onSelectFragment(null);
    onBeginEdit?.();
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
    onSelectFragment(null);
    onBeginEdit?.();
    setDrag({
      kind: edge === 'start' ? 'segStart' : 'segEnd',
      id: seg.id,
      startX: e.clientX,
      origStart: seg.tStart,
      origEnd: seg.tEnd,
    });
  };

  const onFragmentMouseDown = (e: ReactMouseEvent<HTMLDivElement>, l: FragmentLayout): void => {
    e.stopPropagation();
    onSelectFragment(l.fragment.id);
    onSelectSegment?.(null);
    onSeek(xToOutputTime(e.clientX));
    setDrag({
      kind: 'fragMove',
      id: l.fragment.id,
      index: l.index,
      startX: e.clientX,
      armed: false,
    });
    setDropIndex(null);
  };

  const onFragmentEdgeMouseDown = (
    e: ReactMouseEvent<HTMLDivElement>,
    l: FragmentLayout,
    edge: 'start' | 'end',
  ): void => {
    e.stopPropagation();
    onSelectFragment(l.fragment.id);
    onSelectSegment?.(null);
    onBeginEdit?.();
    setDrag({
      kind: 'fragEdge',
      index: l.index,
      edge,
      startX: e.clientX,
      origSrc: edge === 'start' ? l.fragment.srcStart : l.fragment.srcEnd,
    });
  };

  const tickEvery = duration > 60 ? 10 : duration > 20 ? 5 : 1;
  const ticks: number[] = [];
  for (let s = 0; s <= duration; s += tickEvery) {
    ticks.push(s);
  }

  const pct = (t: number): string => `${(t / Math.max(0.001, duration)) * 100}%`;
  const wPct = (a: number, b: number): string => `${((b - a) / Math.max(0.001, duration)) * 100}%`;

  // Map a source time → output time via the first fragment containing it.
  const sourceToOutputTime = useCallback(
    (srcSec: number): number | null => {
      for (const l of layouts) {
        if (srcSec >= l.fragment.srcStart - 1e-4 && srcSec <= l.fragment.srcEnd + 1e-4) {
          return l.outputStart + Math.max(0, srcSec - l.fragment.srcStart);
        }
      }
      return null;
    },
    [layouts],
  );

  // Render zoom segments, splitting them across fragments where they overlap.
  const zoomBlocks = useMemo(() => {
    const blocks: Array<{
      seg: ZoomSegment;
      key: string;
      outStart: number;
      outEnd: number;
    }> = [];
    for (const seg of segments) {
      const a = seg.tStart / 1000;
      const b = seg.tEnd / 1000;
      for (const l of layouts) {
        const s = Math.max(a, l.fragment.srcStart);
        const e = Math.min(b, l.fragment.srcEnd);
        if (e > s) {
          blocks.push({
            seg,
            key: `${seg.id}_${l.fragment.id}`,
            outStart: l.outputStart + (s - l.fragment.srcStart),
            outEnd: l.outputStart + (e - l.fragment.srcStart),
          });
        }
      }
    }
    return blocks;
  }, [segments, layouts]);

  const dropMarkerOutput = useMemo(() => {
    if (drag?.kind !== 'fragMove' || dropIndex == null) return null;
    if (dropIndex >= layouts.length) return duration;
    return layouts[dropIndex]!.outputStart;
  }, [drag, dropIndex, layouts, duration]);

  return (
    <div className="timeline pro">
      <div className="ruler">
        {ticks.map((s) => (
          <div key={s} className="tick" style={{ left: pct(s) }}>
            {fmt(s)}
          </div>
        ))}
      </div>

      <div className="track-stack">
        <div className="track main-clip" ref={trackRef} onMouseDown={onTrackMouseDown}>
          <span className="clip-label">
            Clip <span className="clip-sub">{`${duration.toFixed(1)}s · ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}`}</span>
          </span>

          {layouts.map((l) => {
            const isSel = l.fragment.id === selectedFragmentId;
            const isDragging = drag?.kind === 'fragMove' && drag.id === l.fragment.id;
            return (
              <div
                key={l.fragment.id}
                className={`fragment ${isSel ? 'selected' : ''} ${isDragging ? 'dragging' : ''}`}
                style={{
                  left: pct(l.outputStart),
                  width: wPct(l.outputStart, l.outputEnd),
                }}
                title={`Fragment ${l.index + 1} · src ${l.fragment.srcStart.toFixed(2)}s → ${l.fragment.srcEnd.toFixed(2)}s`}
                onMouseDown={(e) => onFragmentMouseDown(e, l)}
              >
                <div
                  className="fragment-handle left"
                  data-handle="frag-start"
                  onMouseDown={(e) => onFragmentEdgeMouseDown(e, l, 'start')}
                />
                <div
                  className="fragment-handle right"
                  data-handle="frag-end"
                  onMouseDown={(e) => onFragmentEdgeMouseDown(e, l, 'end')}
                />
              </div>
            );
          })}

          {clicks.map((c, i) => {
            const ot = sourceToOutputTime(c.t / 1000);
            if (ot == null) return null;
            return (
              <div
                key={i}
                className="marker"
                style={{ left: pct(ot) }}
                title={`Click @ ${(c.t / 1000).toFixed(2)}s (source)`}
              />
            );
          })}

          {dropMarkerOutput != null && (
            <div className="fragment-drop-indicator" style={{ left: pct(dropMarkerOutput) }} />
          )}

          <div className="playhead" style={{ left: pct(currentTime) }} />
        </div>

        <div className="track zoom-track">
          {zoomBlocks.map((b) => {
            const isSel = b.seg.id === selectedId;
            return (
              <div
                key={b.key}
                className={`zoom-seg ${isSel ? 'selected' : ''} ${b.seg.source === 'manual' ? 'manual' : 'auto'}`}
                style={{
                  left: pct(b.outStart),
                  width: wPct(b.outStart, b.outEnd),
                }}
                title={`Zoom ${b.seg.scale.toFixed(2)}x · ${b.seg.source}`}
                onMouseDown={(e) => onSegMouseDown(e, b.seg)}
              >
                <span className="zoom-seg-label">{`${b.seg.scale.toFixed(1)}×`}</span>
                <div
                  className="zoom-seg-handle left"
                  data-handle="seg-start"
                  onMouseDown={(e) => onSegEdgeMouseDown(e, b.seg, 'start')}
                />
                <div
                  className="zoom-seg-handle right"
                  data-handle="seg-end"
                  onMouseDown={(e) => onSegEdgeMouseDown(e, b.seg, 'end')}
                />
              </div>
            );
          })}
          <div className="playhead ghost" style={{ left: pct(currentTime) }} />
        </div>
      </div>
    </div>
  );
}
