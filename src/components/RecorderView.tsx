import { useEffect, useState, useCallback, useRef } from 'react';
import {
  buildScreenStream,
  createRecorder,
  type RecorderController,
} from '../lib/capture';
import type { Display, HudEvent, Recording } from '../types';

const AUTO_ZOOM_KEY = 'klipe.autoZoom';

function loadAutoZoom(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_ZOOM_KEY);
    if (raw == null) return true;
    return raw === 'true';
  } catch {
    return true;
  }
}

function generateRecordingName(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `Klipe ${datePart} ${timePart}`;
}

interface RecorderViewProps {
  onRecordingDone: (rec: Recording) => void;
}

interface ActiveRecorder {
  rec: RecorderController;
  display: Display;
  autoZoom: boolean;
}

export default function RecorderView({ onRecordingDone }: RecorderViewProps): JSX.Element {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<ActiveRecorder | null>(null);
  const autoZoomRef = useRef<boolean>(loadAutoZoom());

  const beginRecording = useCallback(async (
    sourceId: string,
    withMic: boolean,
    camDeviceId: string | null,
    autoZoom: boolean,
    display: Display,
  ) => {
    setError(null);
    try {
      const capture = await buildScreenStream(sourceId, { withMic, camDeviceId });
      const track = capture.screen.getVideoTracks()[0];
      const settings = track?.getSettings?.() ?? {};
      const realW = typeof settings.width === 'number' && settings.width > 0
        ? settings.width
        : display.width;
      const realH = typeof settings.height === 'number' && settings.height > 0
        ? settings.height
        : display.height;
      const realDisplay: Display = {
        width: realW,
        height: realH,
        scaleFactor: display.scaleFactor,
      };
      const rec = createRecorder(capture);
      recorderRef.current = { rec, display: realDisplay, autoZoom };
      await rec.start();
      setRecording(true);
      window.klipeHud?.pushState?.({ recording: true });
    } catch (e) {
      console.error(e);
      setError(String(e));
      window.klipeHud?.show?.();
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (!recorderRef.current) return;
    const { rec, display, autoZoom } = recorderRef.current;
    const result = await rec.stop();
    setRecording(false);
    window.klipeHud?.pushState?.({ recording: false });
    recorderRef.current = null;
    const url = URL.createObjectURL(result.blob);
    const camera = result.cameraBlob
      ? {
          blob: result.cameraBlob,
          url: URL.createObjectURL(result.cameraBlob),
          mimeType: result.cameraMimeType ?? 'video/webm',
        }
      : null;
    onRecordingDone({
      blob: result.blob,
      url,
      mimeType: result.mimeType,
      mouse: result.mouse,
      display,
      autoZoom,
      name: generateRecordingName(),
      camera,
    });
  }, [onRecordingDone]);

  useEffect(() => {
    if (!window.klipeHud?.onEvent) return;
    const offEvent = window.klipeHud.onEvent((evt: HudEvent) => {
      if (!evt) return;
      switch (evt.type) {
        case 'start-recording':
          autoZoomRef.current = evt.autoZoom;
          beginRecording(evt.sourceId, !!evt.micId, evt.camId, evt.autoZoom, evt.display);
          break;
        case 'stop-recording':
          stopRecording();
          break;
        case 'auto-zoom-change':
          autoZoomRef.current = evt.enabled;
          break;
        default:
          break;
      }
    });
    return () => {
      offEvent?.();
    };
  }, [beginRecording, stopRecording]);

  return (
    <div className="recorder recorder-headless">
      <div>
        <h2>Klipe Studio is running in the floating toolbar.</h2>
        <div className="sub">
          Use the floating toolbar at the top of your screen to choose a source and record.
        </div>
      </div>

      {error && (
        <div style={{ color: 'var(--danger)', padding: 10, border: '1px solid var(--danger)', borderRadius: 8 }}>
          {error}
        </div>
      )}

      <div className="options">
        <button
          className="ghost"
          onClick={() => window.klipeHud?.show?.()}
        >
          Show floating toolbar
        </button>
        {recording && (
          <button className="danger" onClick={stopRecording} style={{ marginLeft: 'auto' }}>
            ■ Stop
          </button>
        )}
      </div>
    </div>
  );
}
