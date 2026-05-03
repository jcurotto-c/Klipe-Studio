import React, { useState, useCallback } from 'react';
import { exportVideo } from '../lib/exporter.js';

export default function ExportPanel({
  sourceBlob,
  mouse,
  segments,
  display,
  background,
  trim,
  duration,
  crop
}) {
  const [resolution, setResolution] = useState('1080p');
  const [fps, setFps] = useState(60);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [error, setError] = useState(null);

  const handleExport = useCallback(async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    setProgress(0);
    setStage('frames');
    setLog('');
    try {
      const { bytes, mimeType, ext } = await exportVideo({
        sourceBlob,
        mouse,
        segments,
        display,
        background,
        crop,
        trim: { start: trim.start, end: trim.end },
        resolution,
        fps,
        onProgress: (s, v) => {
          setStage(s);
          setProgress(v);
        },
        onLog: (line) => setLog((prev) => (prev + '\n' + line).slice(-2000))
      });

      const result = await window.klipe.saveVideoBlob({
        buffer: bytes.buffer,
        suggestedName: `klipe-${Date.now()}.${ext}`,
        mimeType
      });
      if (result.canceled) {
        setStage('canceled');
      } else {
        setStage(`saved → ${result.filePath}`);
      }
    } catch (e) {
      console.error(e);
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [busy, sourceBlob, mouse, segments, display, background, crop, trim, resolution, fps]);

  return (
    <div className="export-panel" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>Resolution
          <select value={resolution} onChange={(e) => setResolution(e.target.value)} style={{ marginLeft: 8 }}>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
            <option value="4K">4K</option>
          </select>
        </label>
        <label>FPS
          <select value={fps} onChange={(e) => setFps(Number(e.target.value))} style={{ marginLeft: 8 }}>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
        </label>
        <div className="progress" title={`${stage}: ${(progress * 100).toFixed(1)}%`}>
          <div style={{ width: `${progress * 100}%` }} />
        </div>
        <span style={{ color: 'var(--text-1)', minWidth: 90, textAlign: 'right' }}>
          {busy ? `${stage} ${(progress * 100).toFixed(0)}%` : stage || 'Idle'}
        </span>
        <button className="primary" disabled={busy || !duration} onClick={handleExport}>
          {busy ? 'Exporting…' : '⤓ Export WebM'}
        </button>
      </div>
      {error && (
        <div style={{ color: 'var(--danger)', marginTop: 8, fontSize: 12 }}>
          {error}
        </div>
      )}
      {log && (
        <details style={{ marginTop: 8, color: 'var(--text-2)' }}>
          <summary>FFmpeg log</summary>
          <pre style={{ maxHeight: 140, overflow: 'auto', fontSize: 11 }}>{log}</pre>
        </details>
      )}
    </div>
  );
}
