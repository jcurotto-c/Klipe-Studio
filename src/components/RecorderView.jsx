import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  listScreenSources,
  buildScreenStream,
  createRecorder,
  getPrimaryDisplaySize
} from '../lib/capture.js';

export default function RecorderView({ onRecordingDone }) {
  const [sources, setSources] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [withMic, setWithMic] = useState(true);
  const [countdown, setCountdown] = useState(0);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState(null);
  const recorderRef = useRef(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const s = await listScreenSources();
      setSources(s);
      if (!selectedId && s.length) {
        const screen0 = s.find((x) => x.id.startsWith('screen:')) || s[0];
        setSelectedId(screen0.id);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [selectedId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const beginRecording = useCallback(async () => {
    if (!selectedId) return;
    setError(null);
    try {
      // 3-2-1 countdown
      for (let i = 3; i >= 1; i--) {
        setCountdown(i);
        await new Promise((r) => setTimeout(r, 800));
      }
      setCountdown(0);

      const display = await getPrimaryDisplaySize();
      const stream = await buildScreenStream(selectedId, { withMic });
      const rec = createRecorder(stream, {});
      recorderRef.current = { rec, display };
      await rec.start();
      setRecording(true);
    } catch (e) {
      console.error(e);
      setError(String(e));
      setCountdown(0);
    }
  }, [selectedId, withMic]);

  const stopRecording = useCallback(async () => {
    if (!recorderRef.current) return;
    const { rec, display } = recorderRef.current;
    const result = await rec.stop();
    setRecording(false);
    recorderRef.current = null;
    const url = URL.createObjectURL(result.blob);
    onRecordingDone({
      blob: result.blob,
      url,
      mimeType: result.mimeType,
      mouse: result.mouse,
      display
    });
  }, [onRecordingDone]);

  return (
    <div className="recorder">
      <div>
        <h2>Record your screen</h2>
        <div className="sub">Pick a screen or window to capture, then hit Record.</div>
      </div>

      {error && (
        <div style={{ color: 'var(--danger)', padding: 10, border: '1px solid var(--danger)', borderRadius: 8 }}>
          {error}
        </div>
      )}

      <div className="sources">
        {sources.map((s) => (
          <div
            key={s.id}
            className={`source-card ${selectedId === s.id ? 'selected' : ''}`}
            onClick={() => setSelectedId(s.id)}
          >
            <img src={s.thumbnail} alt={s.name} />
            <div className="name">{s.name}</div>
          </div>
        ))}
        {sources.length === 0 && <div className="empty">Loading sources…</div>}
      </div>

      <div className="options">
        <label className="toggle">
          <input
            type="checkbox"
            checked={withMic}
            onChange={(e) => setWithMic(e.target.checked)}
          />
          Capture microphone
        </label>
        <button className="ghost" onClick={refresh}>Refresh sources</button>
        <div className="actions" style={{ marginLeft: 'auto' }}>
          {!recording ? (
            <button
              className="primary"
              disabled={!selectedId || countdown > 0}
              onClick={beginRecording}
            >
              ● Record
            </button>
          ) : (
            <button className="danger" onClick={stopRecording}>■ Stop</button>
          )}
        </div>
      </div>

      {countdown > 0 && <div className="countdown">{countdown}</div>}
      {recording && (
        <div className="recording-bar">
          <span className="dot" />
          <span>Recording — clicks &amp; cursor are being captured</span>
          <button className="danger" onClick={stopRecording}>■ Stop</button>
        </div>
      )}
    </div>
  );
}
