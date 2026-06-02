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
import type { BackgroundMusic, Fragment, KlipeMouseEvent, ZoomSegment } from '../types';
import type { Overlay } from '../overlays/types';
import type { CardTimeline } from '../cards/timeline';
import { bodyToGlobalMs, globalToBodySec } from '../cards/timeline';
import { FragmentFilmstrip } from './FragmentFilmstrip';

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
  | { kind: 'seg' | 'segStart' | 'segEnd'; id: string; startX: number; origStart: number; origEnd: number }
  | { kind: 'audioMove' | 'audioStart' | 'audioEnd'; startX: number; origStart: number; origEnd: number }
  | { kind: 'ovMove' | 'ovStart' | 'ovEnd'; id: string; startX: number; origStart: number; origEnd: number }
  | { kind: 'midMove'; id: string; startX: number; origAt: number; gStartSec: number; armed: boolean };

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
  recordingUrl?: string;
  selectedFragmentId: string | null;
  onSelectFragment: (id: string | null) => void;
  onUpdateFragments: (next: Fragment[]) => void;
  onFragmentEdge: (index: number, edge: 'start' | 'end', srcTime: number) => void;
  onBeginEdit?: () => void;
  backgroundMusic?: BackgroundMusic | null;
  onUpdateBackgroundMusic?: (patch: Partial<BackgroundMusic>) => void;
  overlays?: Overlay[];
  selectedOverlayId?: string | null;
  onSelectOverlay?: (id: string | null) => void;
  onUpdateOverlay?: (id: string, patch: Partial<Overlay>) => void;
  /** Segmented card timeline. Body content is positioned on the global clock via
   * its body chunks; coloured caps mark intro / mid-roll / outro cards. */
  cardTimeline?: CardTimeline;
  /** Seek into a card (cap click) by its global start time, in seconds. */
  onSelectCard?: (globalSec: number) => void;
  /** Drag a mid-roll card to a new body-output-time (ms). */
  onMoveMidCard?: (id: string, atBodyMs: number) => void;
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
  recordingUrl,
  selectedFragmentId,
  onSelectFragment,
  onUpdateFragments,
  onFragmentEdge,
  onBeginEdit,
  backgroundMusic,
  onUpdateBackgroundMusic,
  overlays,
  selectedOverlayId = null,
  onSelectOverlay,
  onUpdateOverlay,
  cardTimeline,
  onSelectCard,
  onMoveMidCard,
}: TimelineProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Live left (% of track) of a mid-roll cap while it's dragged, so it tracks
  // the cursor smoothly even when crossing another card reorders the segments.
  const [dragMidLeftPct, setDragMidLeftPct] = useState<number | null>(null);

  // Body content (fragments, zoom, overlays, music) lives in body-output-time;
  // on the GLOBAL timeline it is spliced around the cards. `bodyLeft` maps a
  // body-second to a global percentage (accounting for every card before it);
  // `toBodySec` maps a global pointer second back into body-time; `bodyMs`
  // bounds drag clamps.
  const cardSegs = cardTimeline?.segments ?? null;
  const bodyMs = cardTimeline ? cardTimeline.bodyMs : duration * 1000;
  const bodySec = bodyMs / 1000;
  const toBodySec = useCallback(
    (globalSec: number): number => (cardTimeline ? globalToBodySec(cardTimeline, globalSec) : globalSec),
    [cardTimeline],
  );

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
    let armed = drag.kind === 'fragMove' || drag.kind === 'midMove' ? drag.armed : false;
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
        const t = toBodySec(xToOutputTime(e.clientX)); // body-relative
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
      if (drag.kind === 'midMove') {
        if (!armed) {
          if (Math.abs(e.clientX - drag.startX) < FRAG_DRAG_THRESHOLD_PX) return;
          armed = true;
          onBeginEdit?.();
        }
        const w = trackRef.current!.getBoundingClientRect().width;
        const dx = e.clientX - drag.startX;
        const dMs = (dx / w) * duration * 1000;
        const at = Math.max(0, Math.min(bodyMs, drag.origAt + dMs));
        // Position the cap from the cursor (not the rebuilt gStart) so it doesn't
        // jump by another card's duration when their order swaps.
        setDragMidLeftPct((drag.gStartSec / Math.max(0.001, duration)) * 100 + (dx / w) * 100);
        onMoveMidCard?.(drag.id, at);
        return;
      }
      // Body content is authored in body-output-time, so map the pointer into
      // that space (accounting for every card before it) and clamp to the body.
      const tMs = toBodySec(xToOutputTime(e.clientX)) * 1000;
      if (drag.kind === 'seg') {
        const dx = e.clientX - drag.startX;
        const dMs = (dx / trackRef.current!.getBoundingClientRect().width) * duration * 1000;
        const len = drag.origEnd - drag.origStart;
        let ns = drag.origStart + dMs;
        ns = Math.max(0, Math.min(bodyMs - len, ns));
        onUpdateSegment(drag.id, { tStart: ns, tEnd: ns + len });
      } else if (drag.kind === 'segStart') {
        let ns = tMs;
        ns = Math.max(0, Math.min(drag.origEnd - MIN_SEG_MS, ns));
        onUpdateSegment(drag.id, { tStart: ns });
      } else if (drag.kind === 'segEnd') {
        let ne = tMs;
        ne = Math.max(drag.origStart + MIN_SEG_MS, Math.min(bodyMs, ne));
        onUpdateSegment(drag.id, { tEnd: ne });
      } else if (drag.kind === 'audioMove' && onUpdateBackgroundMusic) {
        const dx = e.clientX - drag.startX;
        const dMs = (dx / trackRef.current!.getBoundingClientRect().width) * duration * 1000;
        const len = drag.origEnd - drag.origStart;
        let ns = drag.origStart + dMs;
        ns = Math.max(0, Math.min(bodyMs - len, ns));
        onUpdateBackgroundMusic({ startMs: ns, endMs: ns + len });
      } else if (drag.kind === 'audioStart' && onUpdateBackgroundMusic) {
        let ns = tMs;
        ns = Math.max(0, Math.min(drag.origEnd - MIN_SEG_MS, ns));
        onUpdateBackgroundMusic({ startMs: ns });
      } else if (drag.kind === 'audioEnd' && onUpdateBackgroundMusic) {
        let ne = tMs;
        ne = Math.max(drag.origStart + MIN_SEG_MS, Math.min(bodyMs, ne));
        onUpdateBackgroundMusic({ endMs: ne });
      } else if (drag.kind === 'ovMove' && onUpdateOverlay) {
        const dx = e.clientX - drag.startX;
        const dMs = (dx / trackRef.current!.getBoundingClientRect().width) * duration * 1000;
        const len = drag.origEnd - drag.origStart;
        let ns = drag.origStart + dMs;
        ns = Math.max(0, Math.min(bodyMs - len, ns));
        onUpdateOverlay(drag.id, { visibleFrom: ns, visibleTo: ns + len });
      } else if (drag.kind === 'ovStart' && onUpdateOverlay) {
        let ns = tMs;
        ns = Math.max(0, Math.min(drag.origEnd - MIN_SEG_MS, ns));
        onUpdateOverlay(drag.id, { visibleFrom: ns });
      } else if (drag.kind === 'ovEnd' && onUpdateOverlay) {
        let ne = tMs;
        ne = Math.max(drag.origStart + MIN_SEG_MS, Math.min(bodyMs, ne));
        onUpdateOverlay(drag.id, { visibleTo: ne });
      }
    };
    const up = (): void => {
      if (drag.kind === 'fragMove' && armed && dropIndex != null) {
        const next = reorderFragment(fragments, drag.index, dropIndex);
        if (next !== fragments) onUpdateFragments(next);
      }
      // A mid-card cap pressed without dragging is a click → seek into it.
      if (drag.kind === 'midMove' && !armed) onSelectCard?.(drag.gStartSec);
      setDropIndex(null);
      setDragMidLeftPct(null);
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
    onUpdateBackgroundMusic, onUpdateOverlay, onMoveMidCard, onSelectCard,
    xToOutputTime, xDeltaToSeconds, duration, sourceDuration,
    fragments, layouts, dropIndex, toBodySec, bodyMs,
  ]);

  const onTrackMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    if (target.dataset['handle']) return;
    if (target.closest('.zoom-seg')) return;
    if (target.closest('.fragment')) return;
    if (target.closest('.overlay-seg')) return;
    onSelectSegment?.(null);
    onSelectFragment(null);
    onSelectOverlay?.(null);
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

  const onAudioMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (!backgroundMusic) return;
    e.stopPropagation();
    onSelectSegment?.(null);
    onSelectFragment(null);
    onBeginEdit?.();
    setDrag({
      kind: 'audioMove',
      startX: e.clientX,
      origStart: backgroundMusic.startMs,
      origEnd: backgroundMusic.endMs,
    });
  };

  const onAudioEdgeMouseDown = (
    e: ReactMouseEvent<HTMLDivElement>,
    edge: 'start' | 'end',
  ): void => {
    if (!backgroundMusic) return;
    e.stopPropagation();
    onSelectSegment?.(null);
    onSelectFragment(null);
    onBeginEdit?.();
    setDrag({
      kind: edge === 'start' ? 'audioStart' : 'audioEnd',
      startX: e.clientX,
      origStart: backgroundMusic.startMs,
      origEnd: backgroundMusic.endMs,
    });
  };

  const onOverlayMouseDown = (e: ReactMouseEvent<HTMLDivElement>, ov: Overlay): void => {
    e.stopPropagation();
    onSelectOverlay?.(ov.id);
    onSelectSegment?.(null);
    onSelectFragment(null);
    onBeginEdit?.();
    const start = ov.visibleFrom ?? 0;
    const end = ov.visibleTo ?? duration * 1000;
    setDrag({
      kind: 'ovMove',
      id: ov.id,
      startX: e.clientX,
      origStart: start,
      origEnd: end,
    });
  };

  const onOverlayEdgeMouseDown = (
    e: ReactMouseEvent<HTMLDivElement>,
    ov: Overlay,
    edge: 'start' | 'end',
  ): void => {
    e.stopPropagation();
    onSelectOverlay?.(ov.id);
    onSelectSegment?.(null);
    onSelectFragment(null);
    onBeginEdit?.();
    const start = ov.visibleFrom ?? 0;
    const end = ov.visibleTo ?? duration * 1000;
    setDrag({
      kind: edge === 'start' ? 'ovStart' : 'ovEnd',
      id: ov.id,
      startX: e.clientX,
      origStart: start,
      origEnd: end,
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
  // Body content positions on the GLOBAL timeline: map a body-second up through
  // the segmented clock (accounts for the intro + every mid-roll card before it).
  const bodyLeft = (bodySecVal: number): string =>
    pct(cardTimeline ? bodyToGlobalMs(cardTimeline, bodySecVal * 1000) / 1000 : bodySecVal);
  // Width of a body span in GLOBAL space — a block straddling a mid card must
  // grow by the card's duration, so measure end−start on the global clock.
  const bodyWidth = (aSec: number, bSec: number): string => {
    if (!cardTimeline) return wPct(aSec, bSec);
    const gw = (bodyToGlobalMs(cardTimeline, bSec * 1000) - bodyToGlobalMs(cardTimeline, aSec * 1000)) / 1000;
    return `${(gw / Math.max(0.001, duration)) * 100}%`;
  };

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
    if (dropIndex >= layouts.length) return bodySec; // body end (body-relative)
    return layouts[dropIndex]!.outputStart;
  }, [drag, dropIndex, layouts, bodySec]);

  return (
    <div className="timeline pro">
      <div className="ruler">
        {ticks.map((s, i) => {
          const isLast = i === ticks.length - 1;
          const pos = (s / Math.max(0.001, duration)) * 100;
          const rightAnchor = isLast && pos >= 95;
          return (
            <div
              key={s}
              className={`tick ${rightAnchor ? 'right-anchor' : ''}`}
              style={rightAnchor ? { right: 0 } : { left: pct(s) }}
            >
              {fmt(s)}
            </div>
          );
        })}
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
                  left: bodyLeft(l.outputStart),
                  width: bodyWidth(l.outputStart, l.outputEnd),
                }}
                title={`Fragment ${l.index + 1} · src ${l.fragment.srcStart.toFixed(2)}s → ${l.fragment.srcEnd.toFixed(2)}s`}
                onMouseDown={(e) => onFragmentMouseDown(e, l)}
              >
                <FragmentFilmstrip
                  recordingUrl={recordingUrl ?? null}
                  fragment={l.fragment}
                  durationHint={sourceDuration}
                />
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
                style={{ left: bodyLeft(ot) }}
                title={`Click @ ${(c.t / 1000).toFixed(2)}s (source)`}
              />
            );
          })}

          {dropMarkerOutput != null && (
            <div className="fragment-drop-indicator" style={{ left: bodyLeft(dropMarkerOutput) }} />
          )}

          {cardSegs?.map((s) => {
            if (s.kind !== 'card') return null;
            const isMid = s.slot === 'mid';
            const gStartSec = s.gStartMs / 1000;
            const label = s.slot === 'intro' ? 'Intro' : s.slot === 'outro' ? 'Outro' : 'Card';
            const dragging = isMid && drag?.kind === 'midMove' && drag.id === s.card.id;
            const leftStyle = dragging && dragMidLeftPct != null ? `${dragMidLeftPct}%` : pct(gStartSec);
            return (
              <div
                key={`card-${s.card.id}`}
                className={`card-cap ${s.slot} ${dragging ? 'dragging' : ''}`}
                style={{ left: leftStyle, width: pct(s.card.durationMs / 1000) }}
                title={isMid ? 'Mid-roll card — drag to move, click to edit' : `${label} card — click to edit`}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  if (isMid) {
                    setDrag({ kind: 'midMove', id: s.card.id, startX: e.clientX, origAt: s.atBodyMs, gStartSec, armed: false });
                  } else {
                    onSelectCard?.(gStartSec);
                  }
                }}
              >
                <span className="card-cap-label">{label}</span>
              </div>
            );
          })}

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
                  left: bodyLeft(b.outStart),
                  width: bodyWidth(b.outStart, b.outEnd),
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

        {overlays && overlays.length > 0 && (
          <div className="track overlay-track">
            {overlays.map((ov) => {
              const start = ov.visibleFrom ?? 0;
              const end = ov.visibleTo ?? duration * 1000;
              const isSel = ov.id === selectedOverlayId;
              const label = ov.name || (ov.type === 'text' ? 'Text' : 'Image');
              const isDragging = drag?.kind?.startsWith('ov') && 'id' in drag && drag.id === ov.id;
              return (
                <div
                  key={ov.id}
                  className={`overlay-seg ${ov.type} ${isSel ? 'selected' : ''} ${isDragging ? 'dragging' : ''}`}
                  style={{
                    left: bodyLeft(start / 1000),
                    width: bodyWidth(start / 1000, end / 1000),
                  }}
                  title={`${label} · ${(start / 1000).toFixed(2)}s → ${(end / 1000).toFixed(2)}s`}
                  onMouseDown={(e) => onOverlayMouseDown(e, ov)}
                >
                  <span className="overlay-seg-label">{label}</span>
                  <div
                    className="overlay-seg-handle left"
                    data-handle="overlay-start"
                    onMouseDown={(e) => onOverlayEdgeMouseDown(e, ov, 'start')}
                  />
                  <div
                    className="overlay-seg-handle right"
                    data-handle="overlay-end"
                    onMouseDown={(e) => onOverlayEdgeMouseDown(e, ov, 'end')}
                  />
                </div>
              );
            })}
            <div className="playhead ghost" style={{ left: pct(currentTime) }} />
          </div>
        )}

        <div className="track audio-track">
          {backgroundMusic && backgroundMusic.endMs > backgroundMusic.startMs && (
            <div
              className={`audio-block ${drag?.kind?.startsWith('audio') ? 'dragging' : ''}`}
              style={{
                left: bodyLeft(backgroundMusic.startMs / 1000),
                width: bodyWidth(backgroundMusic.startMs / 1000, backgroundMusic.endMs / 1000),
              }}
              title={`${backgroundMusic.name} · ${(backgroundMusic.startMs / 1000).toFixed(2)}s → ${(backgroundMusic.endMs / 1000).toFixed(2)}s`}
              onMouseDown={onAudioMouseDown}
            >
              <span className="audio-block-label">{backgroundMusic.name}</span>
              <div
                className="audio-block-handle left"
                data-handle="audio-start"
                onMouseDown={(e) => onAudioEdgeMouseDown(e, 'start')}
              />
              <div
                className="audio-block-handle right"
                data-handle="audio-end"
                onMouseDown={(e) => onAudioEdgeMouseDown(e, 'end')}
              />
            </div>
          )}
          <div className="playhead ghost" style={{ left: pct(currentTime) }} />
        </div>
      </div>
    </div>
  );
}
