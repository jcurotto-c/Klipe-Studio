/**
 * Mobile session backend abstraction. Two backends ship today:
 *  - `ScrcpyBackend`: bundled scrcpy + adb capture Android phones over USB.
 *  - `LocalDeviceBackend`: enumerates OS video inputs (Continuity Camera,
 *    OBS Virtual Camera, DroidCam, etc.) and treats the phone as a camera.
 *
 * The recording pipeline is acquisition-agnostic: at recording-start it
 * calls `acquireMobileStream`, which returns a MediaStream for
 * LocalDevice-style ids and null for scrcpy-style (`adb:`) ids. For the
 * scrcpy path, the actual phone screen is captured by an external
 * process (see RecorderView's scrcpy orchestration); only the resulting
 * MP4 blob flows back into the editor as `recording.mobile`.
 */

import { ScrcpyBackend } from './scrcpy-backend';

export interface MobileDevice {
  /** Backend-prefixed id used as the opaque mobile deviceId. */
  id: string;
  /** Human-readable name. May be empty until camera permission is granted. */
  label: string;
  /**
   * True when the device looks phone-like (iPhone/Continuity/Android/scrcpy
   * labels) OR comes from a phone-specific backend (scrcpy/adb).
   */
  likelyPhone: boolean;
  /** Optional sub-label rendered in the modal (e.g. "Tap Allow on the phone"). */
  sub?: string;
  /** When false, the modal renders the row as informational only. */
  selectable?: boolean;
  /** Free-form backend-defined state, surfaced for diagnostics. */
  state?: string;
}

export interface MobileSessionBackend {
  /** Stable id used to disambiguate between backends. */
  id: string;
  /** Short label for the modal's backend tab strip. */
  label: string;
  /** Long-form copy shown under the heading. */
  description: string;
  /** Enumerate devices the backend can produce. */
  listDevices(): Promise<MobileDevice[]>;
  /**
   * Open a preview-time stream. For backends with no live preview (scrcpy),
   * returns an empty MediaStream — the modal stops the tracks immediately
   * and proceeds to `onConnect(deviceId)`.
   */
  start(deviceId: string): Promise<MediaStream>;
}

const PHONE_REGEX = /iphone|continuity|ipad|android|scrcpy|phone|pixel|galaxy/i;

function classifyDevice(info: MediaDeviceInfo): MobileDevice {
  const label = info.label || '';
  return {
    id: info.deviceId,
    label,
    likelyPhone: PHONE_REGEX.test(label),
  };
}

/**
 * Backend for OS-enumerated video inputs (Continuity Camera, scrcpy
 * virtual cam, OBS Virtual Camera, etc.).
 */
export class LocalDeviceBackend implements MobileSessionBackend {
  readonly id = 'local-device';
  readonly label = 'This computer';
  readonly description =
    'Pick a phone connected as a video input — Continuity Camera on Mac, scrcpy or a webcam app on Windows. Your phone shows up as a camera input.';

  async listDevices(): Promise<MobileDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    // Permission is required to see device labels. Pop a brief getUserMedia
    // and release it immediately — same pattern the HUD's refreshDevices uses.
    try {
      const tmp = await navigator.mediaDevices
        .getUserMedia({ video: true })
        .catch(() => null);
      if (tmp) tmp.getTracks().forEach((t) => t.stop());
    } catch {
      /* fall through; ids still work without labels */
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'videoinput')
      .map(classifyDevice)
      .sort((a, b) => {
        if (a.likelyPhone !== b.likelyPhone) return a.likelyPhone ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
  }

  async start(deviceId: string): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 1080 },
        height: { ideal: 1920 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
  }
}

// ─── Backend registry (memoized singletons) ──────────────────────────────

let _backends: MobileSessionBackend[] | null = null;

/**
 * Returns the live backend instances. Memoized — `ScrcpyBackend` keeps
 * subscriber state for the disconnect bus, so we mustn't recreate it
 * on every call.
 *
 * Order: scrcpy first (headline path on Windows) → local-device second.
 */
export function listMobileBackends(): MobileSessionBackend[] {
  if (_backends) return _backends;
  _backends = [new ScrcpyBackend(), new LocalDeviceBackend()];
  return _backends;
}

/**
 * Recording-time stream acquisition. Returns a MediaStream for
 * LocalDevice ids and null for scrcpy-style (`adb:`) ids — the scrcpy
 * path captures the phone's screen as an external MP4, not a live
 * MediaStream, and is orchestrated by RecorderView.
 */
export async function acquireMobileStream(
  deviceId: string,
): Promise<MediaStream | null> {
  if (deviceId.startsWith('adb:')) return null;
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 1080 },
        height: { ideal: 1920 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
  } catch (err) {
    console.warn('[mobile] phone stream unavailable for recording:', err);
    return null;
  }
}
