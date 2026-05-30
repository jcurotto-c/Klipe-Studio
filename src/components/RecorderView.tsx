import { useEffect, useState, useCallback, useRef } from 'react';
import {
  buildScreenStream,
  createRecorder,
  type RecorderController,
} from '../lib/capture';
import type { Display, HudEvent, Recording } from '../types';
import type { RecentProject } from '../lib/recents';

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

/**
 * Quick MP4 atom-walker: returns true if the buffer contains a top-level
 * `moov` atom (the metadata box without which a player can't decode the
 * file). Used as a defensive check on scrcpy's output, which can be
 * truncated if the muxer fails to flush on Windows.
 */
function hasMp4Moov(buf: ArrayBuffer): boolean {
  const view = new DataView(buf);
  let off = 0;
  while (off + 8 <= view.byteLength) {
    const size = view.getUint32(off);
    const t1 = String.fromCharCode(view.getUint8(off + 4));
    const t2 = String.fromCharCode(view.getUint8(off + 5));
    const t3 = String.fromCharCode(view.getUint8(off + 6));
    const t4 = String.fromCharCode(view.getUint8(off + 7));
    const type = t1 + t2 + t3 + t4;
    if (type === 'moov') return true;
    if (size === 0) break;            // atom extends to EOF
    if (size === 1) {                 // 64-bit size follows
      if (off + 16 > view.byteLength) break;
      const high = view.getUint32(off + 8);
      const low = view.getUint32(off + 12);
      off += high * 0x100000000 + low;
    } else {
      off += size;
    }
  }
  return false;
}

interface RecorderViewProps {
  onRecordingDone: (rec: Recording) => void;
  recents: RecentProject[];
  onOpenRecent: (path: string) => void;
}

interface ActiveRecorder {
  rec: RecorderController;
  display: Display;
  autoZoom: boolean;
  /** Set when scrcpy is recording the phone screen in parallel. */
  scrcpy: { filePath: string; serial: string } | null;
}

export default function RecorderView({ onRecordingDone, recents, onOpenRecent }: RecorderViewProps): JSX.Element {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<ActiveRecorder | null>(null);
  const autoZoomRef = useRef<boolean>(loadAutoZoom());

  // Tracks whether a recording is currently being set up. The Electron
  // HUD can in rare cases emit the start-recording event twice (a
  // user double-click during countdown, an HMR-induced effect re-run);
  // without this guard, the second call races into spawnScrcpy and gets
  // the dreaded `already-recording` error while the first call is still
  // mid-setup. Plain `recording` state isn't enough — it only flips to
  // true *after* `await rec.start()`, which is many ms in.
  const settingUpRef = useRef(false);

  const beginRecording = useCallback(async (
    sourceId: string,
    withMic: boolean,
    camDeviceId: string | null,
    mobileDeviceId: string | null,
    autoZoom: boolean,
    display: Display,
    systemAudio: boolean,
  ) => {
    if (settingUpRef.current || recorderRef.current) {
      // A previous beginRecording is already in flight or completed —
      // drop this re-entry quietly.
      return;
    }
    settingUpRef.current = true;
    setError(null);
    try {
      // If the user picked a phone via the scrcpy backend, spawn scrcpy
      // BEFORE we kick off the screen/camera MediaRecorders so the streams
      // start as close to simultaneous as possible. scrcpy writes the
      // phone's screen straight to a temp MP4; we ingest the file at stop.
      let scrcpy: ActiveRecorder['scrcpy'] = null;
      if (mobileDeviceId?.startsWith('adb:') && window.klipe?.scrcpy?.start) {
        const serial = mobileDeviceId.slice('adb:'.length);
        const filePath = await window.klipe.scrcpy.tempPath();
        const result = await window.klipe.scrcpy.start({ serial, filePath });
        if (result.ok) {
          scrcpy = { filePath, serial };
        } else {
          // Don't block the rest of the recording — surface a warning and
          // continue without phone capture.
          console.warn('[recorder] scrcpy start failed:', result.error);
          setError(`Phone recording failed: ${result.error ?? 'unknown error'}`);
        }
      }

      const capture = await buildScreenStream(sourceId, { withMic, camDeviceId, mobileDeviceId, systemAudio });
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
      recorderRef.current = { rec, display: realDisplay, autoZoom, scrcpy };
      await rec.start();
      setRecording(true);
      window.klipeHud?.pushState?.({ recording: true });
    } catch (e) {
      console.error(e);
      setError(String(e));
      window.klipeHud?.show?.();
      // Best-effort: if we started scrcpy before the error, stop it.
      if (recorderRef.current?.scrcpy && window.klipe?.scrcpy?.stop) {
        try { await window.klipe.scrcpy.stop(); } catch { /* ignore */ }
      }
      // If setup failed mid-way the OS cursor may have been blanked and the
      // tracker left running — restore everything so the user isn't stranded
      // with an invisible cursor and a half-open recording.
      try { await window.klipe?.stopMouseTracking?.(); } catch { /* ignore */ }
      recorderRef.current = null;
      setRecording(false);
      window.klipeHud?.pushState?.({ recording: false });
    } finally {
      settingUpRef.current = false;
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (!recorderRef.current) return;
    const { rec, display, autoZoom, scrcpy } = recorderRef.current;
    // Stop the screen+camera MediaRecorders and the scrcpy child in
    // parallel so the resulting MP4 is finalized while we're already
    // awaiting the MediaRecorder blobs.
    const [result, scrcpyStop] = await Promise.all([
      rec.stop(),
      scrcpy && window.klipe?.scrcpy?.stop
        ? window.klipe.scrcpy.stop()
        : Promise.resolve(null),
    ]);
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

    // Mobile: either from the legacy MediaRecorder path (LocalDeviceBackend
    // virtual cam) or from the scrcpy temp file. Both produce a Blob.
    let mobile: Recording['mobile'] = null;
    if (result.mobileBlob) {
      mobile = {
        blob: result.mobileBlob,
        url: URL.createObjectURL(result.mobileBlob),
        mimeType: result.mobileMimeType ?? 'video/webm',
      };
    } else if (scrcpy && scrcpyStop?.filePath && window.klipe?.scrcpy?.read) {
      try {
        const buf = await window.klipe.scrcpy.read(scrcpyStop.filePath);
        // Validate before trusting the file. scrcpy on Windows occasionally
        // fails to flush its libavformat MP4 muxer when killed mid-record;
        // the file ends up with header bytes but no `moov` atom and the
        // editor would show an empty Phone placeholder. If we can't find a
        // moov atom, treat the recording as failed.
        if (buf.byteLength > 1024 && hasMp4Moov(buf)) {
          const blob = new Blob([buf], { type: 'video/mp4' });
          mobile = {
            blob,
            url: URL.createObjectURL(blob),
            mimeType: 'video/mp4',
          };
        } else {
          console.warn(
            `[recorder] phone recording invalid (${buf.byteLength} bytes, ` +
            `moov=${hasMp4Moov(buf)}); editor will skip phone-primary mode.`,
          );
          setError('Phone recording was not finalized correctly — opening editor with screen recording only.');
        }
      } catch (err) {
        console.warn('[recorder] failed to read scrcpy output:', err);
      }
    }

    const micAudio = result.micAudioBlob
      ? {
          blob: result.micAudioBlob,
          url: URL.createObjectURL(result.micAudioBlob),
          mimeType: result.micAudioMimeType ?? 'audio/webm',
        }
      : null;
    const systemAudio = result.systemAudioBlob
      ? {
          blob: result.systemAudioBlob,
          url: URL.createObjectURL(result.systemAudioBlob),
          mimeType: result.systemAudioMimeType ?? 'audio/webm',
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
      mobile,
      hasAudio: result.hasAudio,
      micAudio,
      systemAudio,
    });
  }, [onRecordingDone]);

  useEffect(() => {
    if (!window.klipeHud?.onEvent) return;
    const offEvent = window.klipeHud.onEvent((evt: HudEvent) => {
      if (!evt) return;
      switch (evt.type) {
        case 'start-recording':
          autoZoomRef.current = evt.autoZoom;
          beginRecording(
            evt.sourceId,
            !!evt.micId,
            evt.camId,
            evt.mobileId,
            evt.autoZoom,
            evt.display,
            evt.systemAudio,
          );
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

      {recents.length > 0 && (
        <div style={{ marginTop: 28, width: '100%', maxWidth: 520 }}>
          <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 8 }}>Recent projects</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recents.map((r) => (
              <button
                key={r.path}
                className="ghost"
                onClick={() => onOpenRecent(r.path)}
                title={r.path}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                  textAlign: 'left',
                  padding: '8px 12px',
                }}
              >
                <span style={{ fontWeight: 600 }}>{r.name}</span>
                <span
                  style={{
                    fontSize: 11,
                    opacity: 0.5,
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.path}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
