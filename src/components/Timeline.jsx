import React, { useRef, useCallback, useState, useEffect } from 'react';

const fmt = (s) => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  const h = Math.floor((s % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}.${String(h).padStart(2, '0')}`;
};

export default function Timeline({
  duration,
  currentTime,
  onSeek,
  clicks,
  segments,
  trim,
  onTrimChange
}) {
  const trackRef = useRef(null);
  const [drag, setDrag] = useState(null); // { kind: 'playhead'|'trimStart'|'trimEnd' }

  const xToTime = useCallback(
    (clientX) => {
      const r = trackRef.current.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return ratio * duration;
    },
    [duration]
  );

  useEffect(() => {
    if (!drag) return;
    const move = (e) => {
      const t = xToTime(e.clientX);
      if (drag.kind === 'playhead') onSeek(t);
      else if (drag.kind === 'trimStart') onTrimChange({ start: Math.min(t, trim.end - 0.1), end: trim.end });
      else if (drag.kind === 'trimEnd') onTrimChange({ start: trim.start, end: Math.max(t, trim.start + 0.1) });
    };
    const up = () => setDrag(null);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [drag, onSeek, onTrimChange, xToTime, trim]);

  const onTrackMouseDown = (e) => {
    if (e.target.dataset.handle) return;
    onSeek(xToTime(e.clientX));
    setDrag({ kind: 'playhead' });
  };

  const tickEvery = duration > 60 ? 10 : duration > 20 ? 5 : 1;
  const ticks = [];
  for (let s = 0; s <= duration; s += tickEvery) {
    ticks.push(s);
  }

  const pct = (t) => `${(t / duration) * 100}%`;
  const w = (a, b) => `${((b - a) / duration) * 100}%`;

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
        {segments.map((seg, i) => (
          <div
            key={i}
            className="zoom-seg"
            style={{ left: pct(seg.tStart / 1000), width: w(seg.tStart / 1000, seg.tEnd / 1000) }}
            title={`Zoom ${seg.scale.toFixed(2)}x`}
          />
        ))}

        {clicks.map((c, i) => (
          <div key={i} className="marker" style={{ left: pct(c.t / 1000) }} title={`Click @ ${(c.t / 1000).toFixed(2)}s`} />
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
