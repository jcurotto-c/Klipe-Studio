import { useEffect, useRef, useState } from 'react';

interface CameraPreviewProps {
  /** Drives the entrance/exit animation. */
  active: boolean;
  /** Preferred camera deviceId; falls back to any available camera. */
  deviceId: string;
}

interface CameraStreamState {
  stream: MediaStream | null;
  error: string | null;
}

// Keep the stream alive briefly after deactivation so the fade-out plays
// over a live frame instead of an instant black/empty disc. Lined up with
// the CSS exit transition.
const STREAM_HOLD_MS = 460;

/**
 * Floating circular webcam preview.
 *
 * Owns its own MediaStream lifecycle and is intentionally self-contained so
 * it can be reused as either a child of the HUD bar or the entire content
 * of a dedicated preview window — only the props change, never the internals.
 */
export default function CameraPreview({ active, deviceId }: CameraPreviewProps): JSX.Element {
  const [enter, setEnter] = useState(false);
  const [streamActive, setStreamActive] = useState(active);
  const [{ stream, error }, setState] = useState<CameraStreamState>({ stream: null, error: null });
  const [ready, setReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Entrance/exit class is set on the next animation frame so the initial
  // mount renders with the "off" styles before transitioning to "on".
  useEffect(() => {
    if (!active) {
      setEnter(false);
      return;
    }
    const raf = requestAnimationFrame(() => setEnter(true));
    return () => cancelAnimationFrame(raf);
  }, [active]);

  // Stream lifecycle decoupled from the animation: we go inactive only after
  // the exit transition has had time to play. Toggling back on within the
  // window cancels the pending teardown so the stream survives a fast tap.
  useEffect(() => {
    if (active) {
      setStreamActive(true);
      return;
    }
    const t = setTimeout(() => setStreamActive(false), STREAM_HOLD_MS);
    return () => clearTimeout(t);
  }, [active]);

  useEffect(() => {
    if (!streamActive) {
      setReady(false);
      setState({ stream: null, error: null });
      return;
    }

    let cancelled = false;
    let acquired: MediaStream | null = null;

    const tryGet = async (constraints: MediaStreamConstraints): Promise<MediaStream | null> => {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch {
        return null;
      }
    };

    setReady(false);
    setState({ stream: null, error: null });

    (async () => {
      let s: MediaStream | null = null;
      if (deviceId) {
        s = await tryGet({
          video: {
            deviceId: { exact: deviceId },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30 },
          },
          audio: false,
        });
      }
      if (!s) {
        s = await tryGet({
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
      }
      if (cancelled) {
        s?.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!s) {
        setState({ stream: null, error: 'Camera unavailable' });
        return;
      }
      acquired = s;
      setState({ stream: s, error: null });
    })();

    return () => {
      cancelled = true;
      if (acquired) acquired.getTracks().forEach((t) => t.stop());
    };
  }, [streamActive, deviceId]);

  // Wait for the first frame before flagging ready — prevents the disc from
  // fading in over a black frame.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!stream) {
      v.srcObject = null;
      return;
    }
    v.srcObject = stream;
    const onLoaded = (): void => setReady(true);
    v.addEventListener('loadeddata', onLoaded);
    v.play().catch(() => { /* autoplay blocked — frame still renders once playable */ });
    return () => {
      v.removeEventListener('loadeddata', onLoaded);
    };
  }, [stream]);

  const cls = [
    'hud-camera-preview',
    enter ? 'is-visible' : '',
    ready ? 'is-ready' : '',
    error ? 'is-error' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} aria-hidden={!enter}>
      <div className="hud-camera-disc">
        <span className="hud-camera-rim" aria-hidden />
        <video
          ref={videoRef}
          className="hud-camera-video"
          playsInline
          muted
          autoPlay
        />
        {!ready && !error && (
          <div className="hud-camera-loading" aria-hidden>
            <span className="hud-camera-spinner" />
          </div>
        )}
        {error && (
          <div className="hud-camera-error" role="status">
            <CameraOffIcon />
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CameraOffIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 3l18 18" />
      <path d="M16.5 13V8a2 2 0 0 0-2-2H9" />
      <path d="M5.5 6.5A2 2 0 0 0 4.5 8v9a2 2 0 0 0 2 2h9" />
      <circle cx="11" cy="12" r="3" />
    </svg>
  );
}
