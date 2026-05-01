import React, { useEffect, useMemo, useRef, useState } from 'react';
import VideoCanvas from './VideoCanvas.jsx';
import Timeline from './Timeline.jsx';
import ExportPanel from './ExportPanel.jsx';
import { generateZoomSegments } from '../lib/zoom-engine.js';

export default function EditorView({ recording, onNew }) {
  const videoRef = useRef(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [trim, setTrim] = useState({ start: 0, end: 0 });
  const [background, setBackground] = useState('default');

  const segments = useMemo(
    () => generateZoomSegments(recording.mouse),
    [recording.mouse]
  );

  const clicks = useMemo(
    () => recording.mouse.events.filter((e) => e.type === 'click'),
    [recording.mouse]
  );

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onLoaded = () => {
      const d = isFinite(v.duration) && v.duration > 0
        ? v.duration
        : (recording.mouse.events.at(-1)?.t || 0) / 1000;
      setDuration(d);
      setTrim({ start: 0, end: d });
    };
    const onTime = () => setCurrentTime(v.currentTime);
    const onEnd = () => setPlaying(false);
    v.addEventListener('loadedmetadata', onLoaded);
    v.addEventListener('durationchange', onLoaded);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('ended', onEnd);
    return () => {
      v.removeEventListener('loadedmetadata', onLoaded);
      v.removeEventListener('durationchange', onLoaded);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('ended', onEnd);
    };
  }, [recording]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (currentTime < trim.start) v.currentTime = trim.start;
    if (currentTime > trim.end && trim.end > 0) {
      v.pause();
      setPlaying(false);
    }
  }, [currentTime, trim]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < trim.start || v.currentTime >= trim.end) v.currentTime = trim.start;
      v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const seek = (t) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration, t));
  };

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const r = (s % 60).toFixed(2).padStart(5, '0');
    return `${String(m).padStart(2, '0')}:${r}`;
  };

  return (
    <div className="editor">
      <div className="preview">
        <video
          ref={videoRef}
          src={recording.url}
          style={{ display: 'none' }}
          muted
          playsInline
        />
        <VideoCanvas
          videoRef={videoRef}
          segments={segments}
          mouse={recording.mouse}
          display={recording.display}
          background={background}
          width={1280}
          height={720}
          trim={trim}
        />
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <div className="controls">
          <button onClick={togglePlay} className="primary">
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <button onClick={() => seek(trim.start)}>⏮ Start</button>
          <span className="time">
            {fmt(currentTime)} / {fmt(duration)}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ color: 'var(--text-1)' }}>Background</label>
            <select value={background} onChange={(e) => setBackground(e.target.value)}>
              <option value="default">Dark</option>
              <option value="sunset">Sunset</option>
              <option value="ocean">Ocean</option>
              <option value="mint">Mint</option>
            </select>
            <button onClick={onNew}>+ New recording</button>
          </span>
        </div>

        {duration > 0 ? (
          <Timeline
            duration={duration}
            currentTime={currentTime}
            onSeek={seek}
            clicks={clicks}
            segments={segments}
            trim={trim}
            onTrimChange={setTrim}
          />
        ) : (
          <div className="empty">Loading clip…</div>
        )}

        <ExportPanel
          videoRef={videoRef}
          duration={duration}
          trim={trim}
          segments={segments}
          mouse={recording.mouse}
          display={recording.display}
          background={background}
          sourceBlob={recording.blob}
        />
      </div>
    </div>
  );
}
