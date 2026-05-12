/**
 * Mobile session backend that bridges the existing modal flow to the
 * bundled scrcpy + adb binaries. Devices are real Android phones over
 * USB; selecting one stashes its serial (prefixed `adb:`) in the HUD
 * state and the actual screen recording is spawned in the main process
 * at record time by RecorderView.
 *
 * `start()` returns an empty MediaStream because the modal's flow
 * expects a stream-like value (it stops the tracks immediately and
 * proceeds to call `onConnect(deviceId)`). The scrcpy backend never
 * produces a live MediaStream — the phone's screen lands as an MP4
 * file at the end of the recording.
 */

import type {
  MobileDevice,
  MobileSessionBackend,
} from './mobile-session';

type DisconnectListener = (deviceId: string) => void;
const disconnectListeners = new Set<DisconnectListener>();

export function onMobileDisconnect(cb: DisconnectListener): () => void {
  disconnectListeners.add(cb);
  return () => { disconnectListeners.delete(cb); };
}

function emitDisconnect(deviceId: string): void {
  for (const cb of disconnectListeners) {
    try { cb(deviceId); } catch { /* never break the fanout */ }
  }
}

// Wire the main-process disconnect event to our renderer-side bus once,
// at module load. The IPC bridge is on `window.klipe.scrcpy.onDisconnect`.
let _wired = false;
function wireDisconnect(): void {
  if (_wired) return;
  _wired = true;
  try {
    window.klipe?.scrcpy?.onDisconnect?.((serial: string) => {
      emitDisconnect(`adb:${serial}`);
    });
  } catch { /* preload not ready yet — try again on first listDevices */ }
}

function labelForState(state: AdbDevice['state'], model: string): {
  sub: string;
  selectable: boolean;
} {
  switch (state) {
    case 'device':       return { sub: `${model} · Connected`, selectable: true };
    case 'unauthorized': return { sub: 'Tap "Allow" on the phone to enable USB debugging', selectable: false };
    case 'offline':      return { sub: 'Device offline — reconnect USB', selectable: false };
    case 'recovery':     return { sub: 'Device is in recovery mode', selectable: false };
    case 'unknown':
    default:             return { sub: `${model} · Unknown state`, selectable: false };
  }
}

export class ScrcpyBackend implements MobileSessionBackend {
  readonly id = 'scrcpy-android';
  readonly label = 'Phone via USB';
  readonly description =
    'Connect an Android phone over USB. Enable Developer options → USB debugging, then tap Allow on the first prompt.';

  async listDevices(): Promise<MobileDevice[]> {
    wireDisconnect();
    if (!window.klipe?.adb?.listDevices) return [];
    let raw: AdbDevice[];
    try {
      raw = await window.klipe.adb.listDevices();
    } catch (err) {
      console.warn('[scrcpy-backend] listDevices failed:', err);
      return [];
    }
    return raw.map((d) => {
      const { sub, selectable } = labelForState(d.state, d.model);
      return {
        id: `adb:${d.serial}`,
        label: d.model || d.serial,
        likelyPhone: true,
        /** scrcpy-specific: the sub-label rendered in the modal row. */
        sub,
        selectable,
        state: d.state,
      } as MobileDevice;
    });
  }

  async start(_deviceId: string): Promise<MediaStream> {
    // The modal's existing flow expects `start()` to return a stream-like
    // value, then stops the tracks and proceeds to `onConnect`. The actual
    // scrcpy session is spawned by RecorderView at record time, not here.
    return new MediaStream();
  }
}
