import { app, BrowserWindow, Menu, crashReporter, desktopCapturer, globalShortcut, ipcMain, dialog, screen, session, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { hideCursor, showCursor, isCursorHidden, setCursorSentinelPath, recoverCursorIfStranded } from './cursorHider';
import {
  listAdbDevices,
  spawnScrcpy,
  stopScrcpy,
  readScrcpyFile,
  cleanupAllScrcpy,
  makeTempMobilePath,
  onScrcpyDisconnect,
  binariesAvailable,
  killStrayScrcpyFromPreviousSession,
} from './scrcpy-bridge';

const isDev = process.env['NODE_ENV'] === 'development';

// Collect native crash minidumps locally (no upload). Without this a GPU/native
// crash leaves no trace; with it the dumps land under userData/Crashpad so a
// "the cursor was stranded again" report is actually diagnosable. Must be
// called as early as possible, before any window exists.
crashReporter.start({ uploadToServer: false });

// Window + taskbar icon. In dev this resolves to <root>/build/icon.ico (one
// level above electron-dist/). In the packaged app the .exe already carries the
// icon embedded by electron-builder, so a missing file here is harmless and we
// fall back to the exe's icon.
const APP_ICON = path.join(__dirname, '..', 'build', 'icon.ico');
const appIcon = fs.existsSync(APP_ICON) ? APP_ICON : undefined;

Menu.setApplicationMenu(null);

// ---------------------------------------------------------------------------
// Renderer hardening. The app loads from file:// in production with
// sandbox:false, so a renderer compromise would otherwise reach every Node-
// backed IPC handler. Two cheap, high-value guards close that off:
//   1. A Content-Security-Policy (applied in production via response headers).
//   2. Deny all window.open popups and block top-level navigation away from
//      the app origin — the app is a SPA and never navigates legitimately.
// The CSP must allow the external hosts the LOCAL Whisper captions feature
// genuinely needs: transformers.js (@huggingface/transformers 4.x) downloads
// the model from huggingface.co (redirecting to *.hf.co / cdn-lfs) and the
// onnxruntime-web WASM runtime from cdn.jsdelivr.net. 'wasm-unsafe-eval' is
// required to instantiate that WASM. If captions stop working in a packaged
// build, this policy is the first place to check.
const DEV_ORIGIN = 'http://localhost:5173';

const CSP_PRODUCTION = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob: https://huggingface.co https://*.huggingface.co https://*.hf.co https://cdn.jsdelivr.net",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

function isAllowedNavigation(targetUrl: string): boolean {
  try {
    const u = new URL(targetUrl);
    // Dev runs against the Vite server; production is served from file://.
    return isDev ? u.origin === DEV_ORIGIN : u.protocol === 'file:';
  } catch {
    return false;
  }
}

// Defense-in-depth for IPC: confirm a privileged (FS / process-spawning)
// handler is being called by one of our own frames, not an injected foreign
// origin. CSP + the navigation guards are the primary control; this rejects a
// *positively* foreign origin while staying permissive when the frame URL can't
// be read, so a transient frame state never breaks a legitimate call.
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url;
  if (!url) return true;
  return isAllowedNavigation(url);
}

function hardenWebContents(contents: Electron.WebContents): void {
  // Deny all popups / new windows — nothing in the app opens one.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const blockNav = (e: Electron.Event, url: string): void => {
    if (!isAllowedNavigation(url)) {
      e.preventDefault();
      console.warn('[security] blocked navigation to', url);
    }
  };
  contents.on('will-navigate', blockNav);
  contents.on('will-redirect', blockNav);
}

// Registered at module load (before whenReady fires) so it covers every
// window: main, hud, cursor-preview and camera-preview.
app.on('web-contents-created', (_e, contents) => hardenWebContents(contents));

// Single-instance lock. Two running copies would race over genuinely global
// OS state with no cross-process guard: the blanked system cursor
// (SetSystemCursor) and scrcpy's single-session invariant. If we don't get the
// lock, a copy is already running — quit and let the primary instance focus.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

let mainWindow: BrowserWindow | null = null;
let hudWindow: BrowserWindow | null = null;
let cursorPreviewWindow: BrowserWindow | null = null;
let cursorPreviewOrigin: { x: number; y: number } = { x: 0, y: 0 };
let cursorPreviewInterval: NodeJS.Timeout | null = null;
let cameraPreviewWindow: BrowserWindow | null = null;
let cameraPreviewReady = false;
let cameraPreviewQueue: CameraPreviewCommand[] = [];

interface CameraPreviewCommand {
  type: 'activate' | 'deactivate' | 'set-device';
  deviceId?: string;
}

interface MouseTrackerHandle {
  startTime: number;
  proc?: ChildProcessWithoutNullStreams | null;
  fallbackInterval?: NodeJS.Timeout | null;
}

let mouseTracker: MouseTrackerHandle | null = null;

const HUD_WIDTH = 720;
const HUD_BAR_HEIGHT = 140;
const HUD_HEIGHT = HUD_BAR_HEIGHT;
const HUD_TOP_OFFSET = 12;

// Set true the instant a real quit begins, so the panel's close handler stops
// hiding-to-toggle and lets the window actually be destroyed.
let isQuitting = false;

/** Bring the floating toolbar (toggle) back. */
function showHud(): void {
  if (hudWindow && !hudWindow.isDestroyed()) {
    if (!hudWindow.isVisible()) { hudWindow.show(); hudWindow.focus(); }
  } else {
    createHudWindow();
  }
}

/** Hide the floating toolbar (toggle). */
function hideHud(): void {
  if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) hudWindow.hide();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    title: 'Klipe Studio',
    icon: appIcon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // The floating toolbar (toggle) and the main window (panel) are mutually
  // exclusive: showing the panel hides the toggle; hiding/minimizing/closing the
  // panel brings the toggle back. Closing the panel (its X) returns to the
  // toggle instead of quitting — the app fully quits only via the toggle's close
  // button (app:quit → app.exit, which bypasses this handler).
  mainWindow.on('show', hideHud);
  mainWindow.on('restore', hideHud);
  mainWindow.on('hide', showHud);
  mainWindow.on('minimize', showHud);

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide(); // fires 'hide' → the toggle reappears; app keeps running
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopMouseTracking();
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
  });
}

function createHudWindow(): BrowserWindow {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.show();
    hudWindow.focus();
    return hudWindow;
  }

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay();
  const { workArea } = display;
  const x = Math.round(workArea.x + (workArea.width - HUD_WIDTH) / 2);
  const y = workArea.y + HUD_TOP_OFFSET;

  hudWindow = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  hudWindow.setAlwaysOnTop(true, 'screen-saver');
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  try { hudWindow.setContentProtection(true); } catch { /* ignore */ }

  if (isDev) {
    hudWindow.loadURL('http://localhost:5173/hud.html');
  } else {
    hudWindow.loadFile(path.join(__dirname, '..', 'dist', 'hud.html'));
  }

  hudWindow.once('ready-to-show', () => hudWindow?.show());

  hudWindow.on('closed', () => {
    hudWindow = null;
    destroyCameraPreviewWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hud:closed');
    }
  });

  return hudWindow;
}

// Compute the union bounding rect of every connected display, in DIP. The
// cursor-preview overlay spans this rect so the rendered cursor follows the
// mouse across monitors.
function computeVirtualScreenBounds(): { x: number; y: number; width: number; height: number } {
  const all = screen.getAllDisplays();
  if (all.length === 0) {
    const p = screen.getPrimaryDisplay();
    return { x: 0, y: 0, width: p.size.width, height: p.size.height };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of all) {
    const b = d.bounds;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function createCursorPreviewWindow(): BrowserWindow | null {
  if (cursorPreviewWindow && !cursorPreviewWindow.isDestroyed()) return cursorPreviewWindow;

  const bounds = computeVirtualScreenBounds();
  cursorPreviewOrigin = { x: bounds.x, y: bounds.y };

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through: the user interacts with whatever is BEHIND the overlay.
  win.setIgnoreMouseEvents(true, { forward: false });
  // Critical: exclude this window from capture so the live preview cursor
  // does NOT end up in the recorded video. Same trick as the HUD.
  try { win.setContentProtection(true); } catch { /* ignore */ }

  if (isDev) {
    win.loadURL('http://localhost:5173/cursor-preview.html');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'cursor-preview.html'));
  }

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive();
  });

  win.on('closed', () => {
    if (cursorPreviewWindow === win) cursorPreviewWindow = null;
  });

  cursorPreviewWindow = win;
  return win;
}

function startCursorPreview(): void {
  const win = createCursorPreviewWindow();
  if (!win) return;
  if (cursorPreviewInterval) clearInterval(cursorPreviewInterval);
  // Poll the OS cursor at ~60Hz and push to the overlay. screen.getCursorScreenPoint()
  // returns DIP coordinates relative to the global virtual screen — exactly what
  // the overlay renderer expects (it subtracts cursorPreviewOrigin to map into
  // window-local CSS pixels).
  cursorPreviewInterval = setInterval(() => {
    if (!cursorPreviewWindow || cursorPreviewWindow.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    cursorPreviewWindow.webContents.send('cursor-preview:pos', {
      x: p.x,
      y: p.y,
      originX: cursorPreviewOrigin.x,
      originY: cursorPreviewOrigin.y,
    });
  }, 16);
}

function stopCursorPreview(): void {
  if (cursorPreviewInterval) {
    clearInterval(cursorPreviewInterval);
    cursorPreviewInterval = null;
  }
  if (cursorPreviewWindow && !cursorPreviewWindow.isDestroyed()) {
    cursorPreviewWindow.close();
  }
  cursorPreviewWindow = null;
}

function sendCursorPreviewType(cursorType: string): void {
  if (!cursorPreviewWindow || cursorPreviewWindow.isDestroyed()) return;
  cursorPreviewWindow.webContents.send('cursor-preview:type', { cursorType });
}

// Camera preview is a small, transparent, always-on-top window pinned to the
// bottom-left of the primary display. It hosts the floating circular webcam
// preview (see src/camera-preview.tsx). The window is created lazily on first
// activate, then kept alive across toggles — show/hide flicker is avoided by
// fading the disc *inside* the renderer rather than at the window level.
const CAMERA_PREVIEW_SIZE = 220;
const CAMERA_PREVIEW_MARGIN = 24;

function createCameraPreviewWindow(): BrowserWindow {
  if (cameraPreviewWindow && !cameraPreviewWindow.isDestroyed()) {
    return cameraPreviewWindow;
  }

  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const x = workArea.x + CAMERA_PREVIEW_MARGIN;
  const y = workArea.y + workArea.height - CAMERA_PREVIEW_SIZE - CAMERA_PREVIEW_MARGIN;

  const win = new BrowserWindow({
    width: CAMERA_PREVIEW_SIZE,
    height: CAMERA_PREVIEW_SIZE,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through for now — the disc is purely visual. Future drag/resize
  // work will toggle this dynamically when the cursor is over the disc.
  win.setIgnoreMouseEvents(true, { forward: true });
  // Exclude from desktopCapturer so the preview never bleeds into the
  // recorded video.
  try { win.setContentProtection(true); } catch { /* ignore */ }

  if (isDev) {
    win.loadURL('http://localhost:5173/camera-preview.html');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'camera-preview.html'));
  }

  cameraPreviewReady = false;
  cameraPreviewQueue = [];

  win.webContents.on('did-finish-load', () => {
    cameraPreviewReady = true;
    const queued = cameraPreviewQueue;
    cameraPreviewQueue = [];
    for (const cmd of queued) win.webContents.send('camera-preview:command', cmd);
  });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive();
  });

  win.on('closed', () => {
    if (cameraPreviewWindow === win) cameraPreviewWindow = null;
    cameraPreviewReady = false;
    cameraPreviewQueue = [];
  });

  cameraPreviewWindow = win;
  return win;
}

function sendCameraPreviewCommand(cmd: CameraPreviewCommand): void {
  const win = createCameraPreviewWindow();
  if (!cameraPreviewReady) {
    // Coalesce repeated set-device + collapse activate/deactivate pairs so
    // fast toggling doesn't queue contradictory commands.
    if (cmd.type === 'set-device') {
      cameraPreviewQueue = cameraPreviewQueue.filter((c) => c.type !== 'set-device');
    } else if (cmd.type === 'activate' || cmd.type === 'deactivate') {
      cameraPreviewQueue = cameraPreviewQueue.filter(
        (c) => c.type !== 'activate' && c.type !== 'deactivate',
      );
    }
    cameraPreviewQueue.push(cmd);
    return;
  }
  win.webContents.send('camera-preview:command', cmd);
}

function destroyCameraPreviewWindow(): void {
  if (cameraPreviewWindow && !cameraPreviewWindow.isDestroyed()) {
    cameraPreviewWindow.close();
  }
  cameraPreviewWindow = null;
  cameraPreviewReady = false;
  cameraPreviewQueue = [];
}

// Renderer sets this via `prepare-display-media` right before calling
// getDisplayMedia(). The handler below resolves it to a real desktopCapturer
// source so we can ask for cursor: 'never' without showing Chromium's picker.
let pendingDisplayMediaSourceId: string | null = null;
// Set alongside the source id when the renderer wants the PC's system audio;
// the display-media handler then answers with `audio: 'loopback'` (WASAPI).
let pendingSystemAudio = false;

// ---------------------------------------------------------------------------
// Global (system-wide) shortcuts. These fire even when Klipe doesn't have
// focus — essential during recording, since the user is in another app. The
// accelerators are configurable from the renderer (persisted there) via the
// `shortcuts:set` IPC; defaults below are used until the renderer overrides.
// ---------------------------------------------------------------------------
interface GlobalShortcuts {
  toggleRecord: string;
  toggleHud: string;
}
const DEFAULT_GLOBAL_SHORTCUTS: GlobalShortcuts = {
  toggleRecord: 'CommandOrControl+Shift+R',
  toggleHud: 'CommandOrControl+Shift+H',
};
let currentShortcuts: GlobalShortcuts = { ...DEFAULT_GLOBAL_SHORTCUTS };

function toggleHudVisibility(): void {
  if (hudWindow && !hudWindow.isDestroyed()) {
    if (hudWindow.isVisible()) hudWindow.hide();
    else { hudWindow.show(); hudWindow.focus(); }
  } else {
    createHudWindow();
  }
}

function triggerRecordToggle(): void {
  const win = (hudWindow && !hudWindow.isDestroyed()) ? hudWindow : createHudWindow();
  if (!win.isVisible()) win.show();
  win.webContents.send('hud:trigger', { action: 'toggle-record' });
}

interface ShortcutRegResult { accel: string; ok: boolean }

function applyGlobalShortcuts(s: GlobalShortcuts): ShortcutRegResult[] {
  globalShortcut.unregisterAll();
  const results: ShortcutRegResult[] = [];
  const reg = (accel: string, fn: () => void): void => {
    if (!accel) return;
    let ok = false;
    try {
      // register() returns false when the OS/another app already owns the
      // accelerator (e.g. Ctrl+X is commonly grabbed). Verify with isRegistered.
      ok = globalShortcut.register(accel, fn) && globalShortcut.isRegistered(accel);
    } catch (err) {
      console.warn(`[shortcuts] error registering "${accel}":`, err);
    }
    results.push({ accel, ok });
  };
  reg(s.toggleRecord, triggerRecordToggle);
  reg(s.toggleHud, toggleHudVisibility);
  return results;
}

app.whenReady().then(() => {
  // A second instance that lost the lock above is quitting — never create
  // windows for it.
  if (!app.hasSingleInstanceLock()) return;

  // Group the taskbar entry under our own AppUserModelID so Windows shows the
  // Klipe icon (not electron.exe's) and attributes notifications correctly.
  if (process.platform === 'win32') app.setAppUserModelId('com.klipe.studio');

  // Crash recovery: undo any global OS state a previous run left stranded —
  // a blanked system cursor and/or an orphaned scrcpy child — before doing
  // anything else.
  setCursorSentinelPath(path.join(app.getPath('userData'), 'cursor-hidden.flag'));
  recoverCursorIfStranded();
  killStrayScrcpyFromPreviousSession();

  // Grant the capture permissions a local recorder needs (mic, camera, screen).
  // Electron shows no browser-style prompt; without this the renderer's
  // getUserMedia / getDisplayMedia can be denied silently on some setups.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture'];
    callback(allowed.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture'];
    return allowed.includes(permission);
  });

  // Apply the Content-Security-Policy in production only. In dev the Vite
  // server needs inline scripts, eval and a websocket for HMR, so a strict CSP
  // there would just break the dev loop without adding real protection (dev
  // isn't shipped). Electron's webRequest does intercept file:// responses, so
  // this reaches the packaged app's document loads.
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP_PRODUCTION],
        },
      });
    });
  }

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const targetId = pendingDisplayMediaSourceId;
    const wantSystemAudio = pendingSystemAudio;
    pendingDisplayMediaSourceId = null;
    pendingSystemAudio = false;
    if (!targetId) {
      console.warn('[displayMediaRequestHandler] no pending source — rejecting');
      callback({});
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const source = sources.find((s) => s.id === targetId);
      if (source) {
        callback(wantSystemAudio ? { video: source, audio: 'loopback' } : { video: source });
      } else {
        console.warn('[displayMediaRequestHandler] source not found:', targetId);
        callback({});
      }
    } catch (err) {
      console.error('[displayMediaRequestHandler]', err);
      callback({});
    }
  });

  createWindow();
  createHudWindow();
  applyGlobalShortcuts(currentShortcuts);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      createHudWindow();
    }
  });
});

ipcMain.handle('prepare-display-media', (_evt: IpcMainInvokeEvent, sourceId: unknown, systemAudio: unknown) => {
  if (typeof sourceId !== 'string' || !sourceId) return { ok: false as const };
  pendingDisplayMediaSourceId = sourceId;
  pendingSystemAudio = systemAudio === true;
  return { ok: true as const };
});

// Android phone screen recording via bundled scrcpy + adb. The renderer
// calls these IPCs to enumerate phones and to start/stop the actual
// scrcpy child process that writes the phone's screen to a temp MP4
// during a recording.
ipcMain.handle('adb:list-devices', () => listAdbDevices());
ipcMain.handle('scrcpy:temp-path', () => makeTempMobilePath());
ipcMain.handle('scrcpy:start', (_e: IpcMainInvokeEvent, args: { serial: string; filePath: string }) => {
  if (!isTrustedSender(_e)) return Promise.resolve({ ok: false, error: 'untrusted sender' });
  return spawnScrcpy(args);
});
ipcMain.handle('scrcpy:stop', () => stopScrcpy());
ipcMain.handle('scrcpy:read', (_e: IpcMainInvokeEvent, p: unknown) => {
  if (!isTrustedSender(_e)) throw new Error('untrusted sender');
  if (typeof p !== 'string') throw new Error('invalid path');
  return readScrcpyFile(p);
});
ipcMain.handle('scrcpy:available', () => binariesAvailable());

// When scrcpy exits without us asking (phone unplugged, scrcpy crashed),
// notify the HUD window so its mobile button can return to idle.
onScrcpyDisconnect((serial) => {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.webContents.send('scrcpy:disconnect', serial);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

// Belt-and-braces cursor restore: SetSystemCursor changes are persistent until
// the next reboot, so if Klipe ever exits with the cursor blanked the user is
// stranded. Hook every plausible exit path.
function ensureCursorRestored(): void {
  try {
    stopCursorPreview();
    if (isCursorHidden()) showCursor();
  } catch {
    /* never throw from a teardown handler */
  }
}
app.on('before-quit', () => { isQuitting = true; });
app.on('before-quit', ensureCursorRestored);
app.on('before-quit', () => { try { cleanupAllScrcpy(); } catch { /* never throw from teardown */ } });
app.on('will-quit', ensureCursorRestored);
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch { /* ignore */ } });
process.on('exit', ensureCursorRestored);
process.on('SIGINT', () => { ensureCursorRestored(); process.exit(0); });
process.on('SIGTERM', () => { ensureCursorRestored(); process.exit(0); });
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught:', err);
  ensureCursorRestored();
});

// A renderer or child (GPU/utility) process dying is exactly the scenario that
// strands the system cursor — the dead renderer can't run its own teardown, so
// the main process restores it. Logged so the failure is visible alongside the
// crashReporter minidumps.
app.on('render-process-gone', (_e, _wc, details) => {
  console.error('[main] render-process-gone:', details.reason, 'exitCode', details.exitCode);
  ensureCursorRestored();
});
app.on('child-process-gone', (_e, details) => {
  console.error('[main] child-process-gone:', details.type, details.reason, 'exitCode', details.exitCode);
});

ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const ownIds = new Set(
    BrowserWindow.getAllWindows()
      .map((w) => {
        try { return w.getMediaSourceId(); } catch { return ''; }
      })
      .filter(Boolean),
  );
  console.log(
    `[desktopCapturer] sources=${sources.length}`,
    sources.map((s) => `${s.id}::${s.name}`),
  );

  let screenIndex = 0;
  return sources
    .filter((s) => !ownIds.has(s.id))
    .map((s) => {
      const isScreen = s.id.startsWith('screen:');
      let width = 0;
      let height = 0;
      let scaleFactor = 1;
      let displayId: string | null = null;
      let primary = false;
      let name = s.name;

      if (isScreen) {
        let matched = displays.find((d) => String(d.id) === String(s.display_id));
        if (!matched) matched = displays[screenIndex] || displays[0];
        const idx = matched ? displays.indexOf(matched) : screenIndex;
        screenIndex += 1;
        if (matched) {
          width = Math.round(matched.size.width);
          height = Math.round(matched.size.height);
          scaleFactor = matched.scaleFactor;
          displayId = String(matched.id);
          primary = matched.id === primaryId;
          name = `Display ${idx + 1}${primary ? ' (Primary)' : ''}`;
        }
      } else {
        const tsize = s.thumbnail.getSize();
        width = tsize.width;
        height = tsize.height;
      }
      return {
        id: s.id,
        name,
        display_id: s.display_id,
        thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        kind: isScreen ? ('screen' as const) : ('window' as const),
        width,
        height,
        scaleFactor,
        displayId,
        primary,
      };
    });
});

interface SaveVideoBlobArgs {
  buffer: ArrayBuffer | Uint8Array;
  suggestedName?: string;
  mimeType?: string;
}

ipcMain.handle(
  'save-video-blob',
  async (_evt: IpcMainInvokeEvent, { buffer, suggestedName, mimeType }: SaveVideoBlobArgs) => {
    if (!isTrustedSender(_evt)) return { canceled: true as const };
    const ext = mimeType && mimeType.includes('mp4') ? 'mp4' : 'webm';
    const defaultPath = path.join(
      app.getPath('videos'),
      suggestedName || `klipe-${Date.now()}.${ext}`,
    );
    if (!mainWindow) return { canceled: true as const };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save recording',
      defaultPath,
      filters: [
        { name: 'Video', extensions: [ext] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { canceled: true as const };
    // Async write: a 4K export can be hundreds of MB — fs.writeFileSync would
    // block the main process (frozen UI, unresponsive HUD) for the whole flush.
    await fs.promises.writeFile(result.filePath, Buffer.from(buffer as ArrayBuffer));
    return { canceled: false as const, filePath: result.filePath };
  },
);

ipcMain.handle('open-image-file', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add Image Overlay',
    filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }],
    properties: ['openFile'],
  });
  if (result.canceled) return null;
  const filePath = result.filePaths[0];
  if (!filePath) return null;
  // Read the file and return as a data URL so the renderer doesn't need
  // file:// access. Smaller than blob IPC since images are usually < 10MB.
  try {
    const buf = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
    return { dataUrl: `data:image/${mime};base64,${buf.toString('base64')}`, name: path.basename(filePath) };
  } catch (err) {
    return { error: String(err) };
  }
});

ipcMain.handle('get-primary-display-size', () => {
  const d = screen.getPrimaryDisplay();
  return { width: d.size.width, height: d.size.height, scaleFactor: d.scaleFactor };
});

// Renderer-driven (re)registration of the configurable global shortcuts.
ipcMain.handle('shortcuts:set', (_evt: IpcMainInvokeEvent, s: Partial<GlobalShortcuts> | undefined) => {
  currentShortcuts = {
    toggleRecord: typeof s?.toggleRecord === 'string' ? s.toggleRecord : DEFAULT_GLOBAL_SHORTCUTS.toggleRecord,
    toggleHud: typeof s?.toggleHud === 'string' ? s.toggleHud : DEFAULT_GLOBAL_SHORTCUTS.toggleHud,
  };
  const results = applyGlobalShortcuts(currentShortcuts);
  return { ok: true as const, shortcuts: currentShortcuts, results };
});

ipcMain.handle('shortcuts:get-defaults', () => DEFAULT_GLOBAL_SHORTCUTS);

interface ProjectSaveArgs {
  manifestJson: string;
  media: Array<{ name: string; bytes: Uint8Array }>;
  suggestedName: string;
}

/** Sanitize a project name into a filesystem-safe folder name. */
function safeProjectName(name: string | undefined): string {
  return (name || 'Untitled').replace(/[\\/:*?"<>|]/g, '_').trim() || 'Untitled';
}

/** Write project.json plus the supplied media files into a project folder.
 * Async (fs.promises) on purpose: the media blobs are routinely hundreds of MB,
 * and a synchronous write would block the single main-process event loop —
 * freezing the big window AND the always-on-top HUD toolbar for the whole flush
 * (the same trap save-video-blob and project:save-doc already avoid). This runs
 * automatically on every recording (library auto-save), so it must never stall. */
async function writeProjectBundle(
  projectDir: string,
  manifestJson: string,
  media: Array<{ name: string; bytes: Uint8Array }>,
): Promise<void> {
  await fs.promises.mkdir(projectDir, { recursive: true });
  await fs.promises.writeFile(path.join(projectDir, 'project.json'), manifestJson, 'utf8');
  for (const m of media) {
    if (!m || typeof m.name !== 'string' || !m.bytes) continue;
    // Only a bare filename is allowed inside the bundle — block traversal.
    const safe = path.basename(m.name);
    await fs.promises.writeFile(path.join(projectDir, safe), Buffer.from(m.bytes));
  }
}

/** The managed library folder where recordings auto-save: <Videos>/KlipeStudio. */
function libraryRoot(): string {
  return path.join(app.getPath('videos'), 'KlipeStudio');
}

/** Resolve a non-colliding `<name>.klipestudio` folder path inside `dir`. */
function uniqueProjectDir(dir: string, safeName: string): string {
  let candidate = path.join(dir, `${safeName}.klipestudio`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${safeName} (${n}).klipestudio`);
    n += 1;
  }
  return candidate;
}

// Persist a .klipestudio project as a folder bundle: project.json plus the
// source media (screen/camera/mobile/music). The renderer supplies the JSON
// and the raw bytes; we only do the file IO here.
ipcMain.handle('project:save', async (_evt: IpcMainInvokeEvent, args: ProjectSaveArgs) => {
  if (!isTrustedSender(_evt)) return { canceled: true as const };
  if (!mainWindow) return { canceled: true as const };
  const { manifestJson, media, suggestedName } = args || ({} as ProjectSaveArgs);
  if (typeof manifestJson !== 'string' || !Array.isArray(media)) {
    return { canceled: true as const, error: 'Invalid project payload' };
  }
  const safeName = safeProjectName(suggestedName);
  const defaultPath = path.join(app.getPath('videos'), `${safeName}.klipestudio`);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Klipe project',
    defaultPath,
    filters: [{ name: 'Klipe Project', extensions: ['klipestudio'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true as const };
  const projectDir = result.filePath;
  try {
    await writeProjectBundle(projectDir, manifestJson, media);
    return { canceled: false as const, projectPath: projectDir };
  } catch (err) {
    return { canceled: false as const, error: String(err) };
  }
});

// Auto-save a recording into the managed library (<Videos>/KlipeStudio) with no
// dialog. Used right after a recording opens in the editor so nothing is ever
// lost — every take becomes a real, reopenable project. De-dupes the folder
// name so two recordings made in the same second don't clobber each other.
ipcMain.handle('library:save', async (_evt: IpcMainInvokeEvent, args: ProjectSaveArgs) => {
  if (!isTrustedSender(_evt)) return { ok: false as const, error: 'untrusted sender' };
  const { manifestJson, media, suggestedName } = args || ({} as ProjectSaveArgs);
  if (typeof manifestJson !== 'string' || !Array.isArray(media)) {
    return { ok: false as const, error: 'Invalid project payload' };
  }
  try {
    const root = libraryRoot();
    await fs.promises.mkdir(root, { recursive: true });
    const projectDir = uniqueProjectDir(root, safeProjectName(suggestedName));
    await writeProjectBundle(projectDir, manifestJson, media);
    return { ok: true as const, projectPath: projectDir };
  } catch (err) {
    return { ok: false as const, error: String(err) };
  }
});

interface LibraryItem {
  projectPath: string;
  name: string;
  createdAt: number;
  durationMs: number | null;
  thumbnailDataUrl: string | null;
}

// Enumerate the managed library: every `*.klipestudio` folder, newest first.
// Reads only the cheap metadata (project.json's name/createdAt/durationMs) plus
// the small thumbnail — never the multi-MB video blobs — so the gallery stays
// snappy even with many recordings.
ipcMain.handle('library:list', async (_evt: IpcMainInvokeEvent) => {
  if (!isTrustedSender(_evt)) return [] as LibraryItem[];
  const root = libraryRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    const items: LibraryItem[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.endsWith('.klipestudio')) continue;
      const projectDir = path.join(root, e.name);
      try {
        const raw = await fs.promises.readFile(path.join(projectDir, 'project.json'), 'utf8');
        const manifest = JSON.parse(raw) as {
          klipeProject?: boolean;
          name?: string;
          createdAt?: number;
          durationMs?: number;
        };
        if (manifest.klipeProject !== true) continue;
        let thumbnailDataUrl: string | null = null;
        try {
          const buf = await fs.promises.readFile(path.join(projectDir, 'thumbnail.jpg'));
          thumbnailDataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
        } catch {
          /* no thumbnail — gallery shows a placeholder */
        }
        items.push({
          projectPath: projectDir,
          name: typeof manifest.name === 'string' ? manifest.name : e.name.replace(/\.klipestudio$/, ''),
          createdAt: typeof manifest.createdAt === 'number' ? manifest.createdAt : 0,
          durationMs: typeof manifest.durationMs === 'number' ? manifest.durationMs : null,
          thumbnailDataUrl,
        });
      } catch {
        /* unreadable/!project folder — skip */
      }
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items;
  } catch (err) {
    console.error('[library] list failed:', err);
    return [] as LibraryItem[];
  }
});

// Permanently delete a library project folder. Guarded: the path must live
// inside the library root and carry the .klipestudio suffix, so a compromised
// renderer can't aim this at arbitrary directories.
ipcMain.handle('library:delete', async (_evt: IpcMainInvokeEvent, projectPath: unknown) => {
  if (!isTrustedSender(_evt)) return { ok: false as const, error: 'untrusted sender' };
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
    return { ok: false as const, error: 'Invalid path' };
  }
  if (!isWithinLibrary(projectPath)) {
    return { ok: false as const, error: 'Refusing to delete outside the library' };
  }
  try {
    await fs.promises.rm(path.resolve(projectPath), { recursive: true, force: true });
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: String(err) };
  }
});

/** True if `target` is the library root or a `.klipestudio` folder inside it. */
function isWithinLibrary(target: string): boolean {
  const root = libraryRoot();
  const resolved = path.resolve(target);
  const within = resolved === root || resolved.startsWith(root + path.sep);
  return within && resolved.endsWith('.klipestudio');
}

// Reveal a project in the OS file manager (selected), or — with no path — open
// the library root folder itself. The path is validated against the library
// root (same guard as library:delete) so a compromised renderer can't point an
// Explorer window at arbitrary locations.
ipcMain.handle('library:reveal', async (_evt: IpcMainInvokeEvent, projectPath: unknown) => {
  if (!isTrustedSender(_evt)) return { ok: false as const };
  try {
    const root = libraryRoot();
    await fs.promises.mkdir(root, { recursive: true });
    if (typeof projectPath === 'string' && projectPath && path.isAbsolute(projectPath) && isWithinLibrary(projectPath)) {
      shell.showItemInFolder(projectPath);
    } else {
      await shell.openPath(root);
    }
    return { ok: true as const };
  } catch {
    return { ok: false as const };
  }
});

// The library root path, for display / "open folder" affordances.
ipcMain.handle('library:root', () => libraryRoot());

async function readProjectDir(projectDir: string): Promise<
  | { canceled: false; manifestJson: string; media: Record<string, Uint8Array>; projectPath: string }
  | { canceled: true; error?: string }
> {
  try {
    const manifestJson = await fs.promises.readFile(path.join(projectDir, 'project.json'), 'utf8');
    const manifest = JSON.parse(manifestJson) as { media?: Record<string, { file?: string } | null> };
    const media: Record<string, Uint8Array> = {};
    const refs = manifest.media ? Object.values(manifest.media) : [];
    for (const ref of refs) {
      if (!ref || typeof ref.file !== 'string') continue;
      const safe = path.basename(ref.file);
      try {
        const buf = await fs.promises.readFile(path.join(projectDir, safe));
        media[safe] = new Uint8Array(buf);
      } catch {
        /* missing media file — skip, the renderer handles absence */
      }
    }
    return { canceled: false, manifestJson, media, projectPath: projectDir };
  } catch (err) {
    return { canceled: true, error: String(err) };
  }
}

ipcMain.handle('project:open', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Klipe project',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
  return readProjectDir(result.filePaths[0]);
});

// Open a known project folder without a dialog — used by the recents list.
ipcMain.handle('project:open-path', async (_evt: IpcMainInvokeEvent, projectPath: unknown) => {
  if (!isTrustedSender(_evt)) return { canceled: true as const };
  if (typeof projectPath !== 'string' || !projectPath || !path.isAbsolute(projectPath)) {
    return { canceled: true as const };
  }
  return readProjectDir(projectPath);
});

interface ProjectSaveDocArgs {
  projectPath: string;
  manifestJson: string;
  media: Array<{ name: string; bytes: Uint8Array }>;
}

// Fast re-save / autosave: rewrite project.json (and any supplied media, e.g.
// background music) in an existing project folder. The large video blobs are
// immutable in the editor, so they are never rewritten here.
ipcMain.handle('project:save-doc', async (_evt: IpcMainInvokeEvent, args: ProjectSaveDocArgs) => {
  if (!isTrustedSender(_evt)) return { ok: false as const, error: 'untrusted sender' };
  const { projectPath, manifestJson, media } = args || ({} as ProjectSaveDocArgs);
  if (typeof projectPath !== 'string' || typeof manifestJson !== 'string' || !path.isAbsolute(projectPath)) {
    return { ok: false as const, error: 'Invalid args' };
  }
  try {
    if (!fs.existsSync(projectPath)) return { ok: false as const, error: 'Project folder not found' };
    // Carry forward manifest fields the editor's buildManifest doesn't preserve
    // across a re-save, so autosave / explicit Save never corrupts them:
    //  - durationMs: written once by the library auto-save; the editor has no
    //    notion of it, so without this it'd be dropped and the gallery duration
    //    badge would vanish on the first debounced autosave.
    //  - createdAt: buildManifest stamps Date.now() on every save; preserving the
    //    original keeps the gallery's date stable and stops an edited project from
    //    jumping to the top of the newest-first sort.
    let finalJson = manifestJson;
    try {
      const incoming = JSON.parse(manifestJson) as { createdAt?: number; durationMs?: number };
      const existingRaw = await fs.promises.readFile(path.join(projectPath, 'project.json'), 'utf8');
      const existing = JSON.parse(existingRaw) as { createdAt?: number; durationMs?: number };
      const merged = { ...incoming };
      let changed = false;
      if (typeof existing.createdAt === 'number' && existing.createdAt > 0 && existing.createdAt !== incoming.createdAt) {
        merged.createdAt = existing.createdAt;
        changed = true;
      }
      if ((typeof incoming.durationMs !== 'number' || incoming.durationMs <= 0)
        && typeof existing.durationMs === 'number' && existing.durationMs > 0) {
        merged.durationMs = existing.durationMs;
        changed = true;
      }
      if (changed) finalJson = JSON.stringify(merged);
    } catch {
      /* malformed JSON on either side — write the incoming manifest as-is */
    }
    await fs.promises.writeFile(path.join(projectPath, 'project.json'), finalJson, 'utf8');
    if (Array.isArray(media)) {
      for (const m of media) {
        if (!m || typeof m.name !== 'string' || !m.bytes) continue;
        const safe = path.basename(m.name);
        await fs.promises.writeFile(path.join(projectPath, safe), Buffer.from(m.bytes));
      }
    }
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: String(err) };
  }
});

const POWERSHELL_TRACKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class W {
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO ci);
    [DllImport("user32.dll")] public static extern IntPtr LoadCursor(IntPtr hInstance, int lpCursorName);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO {
        public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos;
    }
}
"@
$start = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$lastL = $false; $lastR = $false; $lastM = $false
$lastX = -9999; $lastY = -9999

# Cache standard cursor handles → friendly names. Anything unmatched is reported as 'arrow'.
$cursorMap = @{}
$cursorMap[[long][W]::LoadCursor([IntPtr]::Zero, 32512).ToInt64()] = 'arrow'
$cursorMap[[long][W]::LoadCursor([IntPtr]::Zero, 32513).ToInt64()] = 'text'
$cursorMap[[long][W]::LoadCursor([IntPtr]::Zero, 32515).ToInt64()] = 'crosshair'
$cursorMap[[long][W]::LoadCursor([IntPtr]::Zero, 32644).ToInt64()] = 'resize-ew'
$cursorMap[[long][W]::LoadCursor([IntPtr]::Zero, 32645).ToInt64()] = 'resize-ns'
$cursorMap[[long][W]::LoadCursor([IntPtr]::Zero, 32646).ToInt64()] = 'move'
$cursorMap[[long][W]::LoadCursor([IntPtr]::Zero, 32648).ToInt64()] = 'not-allowed'
$cursorMap[[long][W]::LoadCursor([IntPtr]::Zero, 32649).ToInt64()] = 'pointer'
$lastCursorType = ''

# Virtual-key codes we emit as 'KEY' events (typing-relevant keys).
# 0x08 BACKSPACE, 0x09 TAB, 0x0D ENTER, 0x20 SPACE,
# 0x30-0x39 digits, 0x41-0x5A letters, 0xBA-0xC0 / 0xDB-0xDF punctuation,
# 0x6A-0x6F numpad operators (*, +, -, ., /), 0x60-0x69 numpad digits.
$keyCodes = @(0x08, 0x09, 0x0D, 0x20)
$keyCodes += 0x30..0x39
$keyCodes += 0x41..0x5A
$keyCodes += 0x60..0x69
$keyCodes += 0x6A..0x6F
$keyCodes += 0xBA..0xC0
$keyCodes += 0xDB..0xDF
$keyState = @{}
foreach ($c in $keyCodes) { $keyState[$c] = $false }

while ($true) {
  $p = New-Object W+POINT
  [void][W]::GetCursorPos([ref]$p)
  $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $t = $now - $start
  if ($p.X -ne $lastX -or $p.Y -ne $lastY) {
    $lastX = $p.X; $lastY = $p.Y
    Write-Host ("MOVE|{0}|{1}|{2}" -f $t, $p.X, $p.Y)
  }

  $ci = New-Object W+CURSORINFO
  $ci.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'W+CURSORINFO')
  if ([W]::GetCursorInfo([ref]$ci)) {
    $key = [long]$ci.hCursor.ToInt64()
    $type = if ($cursorMap.ContainsKey($key)) { $cursorMap[$key] } else { 'arrow' }
    if ($type -ne $lastCursorType) {
      $lastCursorType = $type
      Write-Host ("CTYPE|{0}|{1}" -f $t, $type)
    }
  }
  $l = ([W]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0
  $r = ([W]::GetAsyncKeyState(0x02) -band 0x8000) -ne 0
  $m = ([W]::GetAsyncKeyState(0x04) -band 0x8000) -ne 0
  if ($l -and -not $lastL) { Write-Host ("CLICK|{0}|{1}|{2}|left"   -f $t, $p.X, $p.Y) }
  if ($r -and -not $lastR) { Write-Host ("CLICK|{0}|{1}|{2}|right"  -f $t, $p.X, $p.Y) }
  if ($m -and -not $lastM) { Write-Host ("CLICK|{0}|{1}|{2}|middle" -f $t, $p.X, $p.Y) }
  $lastL = $l; $lastR = $r; $lastM = $m

  foreach ($c in $keyCodes) {
    $down = ([W]::GetAsyncKeyState($c) -band 0x8000) -ne 0
    if ($down -and -not $keyState[$c]) {
      Write-Host ("KEY|{0}|{1}" -f $t, $c)
    }
    $keyState[$c] = $down
  }

  Start-Sleep -Milliseconds 12
}
`;

interface MouseTrackingResult {
  ok: true;
  startTime: number;
  alreadyRunning?: boolean;
  notRunning?: boolean;
}

function startMouseTracking(): MouseTrackingResult {
  if (mouseTracker) {
    return { ok: true, alreadyRunning: true, startTime: mouseTracker.startTime };
  }

  const startTime = Date.now();

  if (process.platform !== 'win32') {
    const handle: MouseTrackerHandle = { startTime, fallbackInterval: null, proc: null };
    handle.fallbackInterval = setInterval(() => {
      if (!mainWindow) return;
      const p = screen.getCursorScreenPoint();
      mainWindow.webContents.send('mouse-event', {
        type: 'move',
        x: p.x,
        y: p.y,
        t: Date.now() - startTime,
      });
    }, 16);
    mouseTracker = handle;
    return { ok: true, startTime };
  }

  // Hide the OS cursor BEFORE the tracker spawns. Electron's
  // setDisplayMediaRequestHandler ignores `cursor: 'never'` from getDisplayMedia
  // when a desktopCapturer source is provided, so the only reliable way to keep
  // the system cursor out of captured frames is to actually blank it via
  // SetSystemCursor. Hiding before the tracker starts means LoadCursor inside
  // the tracker resolves to the new blank handles, preserving cursor-type
  // discrimination (arrow/pointer/text) for apps that re-load cursors at runtime.
  hideCursor();

  // Show the live preview overlay so the user can still see where they're
  // pointing. It's content-protected, so it does NOT appear in the captured
  // stream — only the rendered video gets the custom cursor in post.
  startCursorPreview();

  const proc = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_TRACKER_SCRIPT],
    { windowsHide: true },
  );

  let buffer = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const parts = line.split('|');
      if (parts[0] === 'CTYPE') {
        // Forward cursor-type changes to the live preview overlay so it can
        // swap between bone (text), hand (pointer), and the user's chosen
        // style. Click events are no longer fanned out — the ripple effect
        // they drove has been removed.
        sendCursorPreviewType(parts[2] || 'arrow');
      }
      if (!mainWindow) continue;
      if (parts[0] === 'MOVE') {
        mainWindow.webContents.send('mouse-event', {
          type: 'move',
          t: Number(parts[1]),
          x: Number(parts[2]),
          y: Number(parts[3]),
        });
      } else if (parts[0] === 'CLICK') {
        mainWindow.webContents.send('mouse-event', {
          type: 'click',
          t: Number(parts[1]),
          x: Number(parts[2]),
          y: Number(parts[3]),
          button: parts[4],
        });
      } else if (parts[0] === 'KEY') {
        mainWindow.webContents.send('mouse-event', {
          type: 'key',
          t: Number(parts[1]),
          code: Number(parts[2]),
        });
      } else if (parts[0] === 'CTYPE') {
        mainWindow.webContents.send('mouse-event', {
          type: 'cursorType',
          t: Number(parts[1]),
          cursorType: parts[2],
        });
      }
    }
  });

  proc.stderr.on('data', (d: Buffer) => console.error('[mouse-tracker]', d.toString()));
  proc.on('exit', () => {
    if (mouseTracker && mouseTracker.proc === proc) mouseTracker = null;
  });

  mouseTracker = { startTime, proc };
  return { ok: true, startTime };
}

function stopMouseTracking(): MouseTrackingResult {
  if (!mouseTracker) {
    // Defensive: if the cursor was somehow left hidden without a live tracker,
    // restore it so we never strand the user with an invisible cursor.
    if (isCursorHidden()) showCursor();
    stopCursorPreview();
    return { ok: true, notRunning: true, startTime: 0 };
  }
  if (mouseTracker.fallbackInterval) clearInterval(mouseTracker.fallbackInterval);
  if (mouseTracker.proc) {
    try { mouseTracker.proc.kill(); } catch { /* ignore */ }
  }
  const startTime = mouseTracker.startTime;
  mouseTracker = null;
  // Tear down the preview overlay first so it stops polling for cursor
  // positions before we restore the visible OS cursor underneath.
  stopCursorPreview();
  // Restore the system cursor AFTER the tracker is gone so its final
  // GetCursorInfo reads still see consistent (blanked) handles.
  showCursor();
  return { ok: true, startTime };
}

ipcMain.handle('start-mouse-tracking', () => startMouseTracking());
ipcMain.handle('stop-mouse-tracking', () => stopMouseTracking());

const FOCUS_WINDOW_SCRIPT = (hwnd: string): string => `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class FW {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
"@
$h = [IntPtr]::new([Int64]${hwnd})
if ([FW]::IsIconic($h)) { [void][FW]::ShowWindow($h, 9) }
[FW]::SwitchToThisWindow($h, $true)
[void][FW]::BringWindowToTop($h)
[void][FW]::SetForegroundWindow($h)
`;

ipcMain.handle('focus-window-source', async (_evt: IpcMainInvokeEvent, sourceId: unknown) => {
  if (!isTrustedSender(_evt)) return { ok: false as const };
  if (process.platform !== 'win32') return { ok: false as const };
  if (typeof sourceId !== 'string') return { ok: false as const };
  const parts = sourceId.split(':');
  if (parts[0] !== 'window' || !parts[1] || !/^\d+$/.test(parts[1])) {
    return { ok: false as const };
  }
  const hwnd = parts[1];
  return new Promise<{ ok: boolean }>((resolve) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', FOCUS_WINDOW_SCRIPT(hwnd)],
      { windowsHide: true },
    );
    proc.on('exit', () => resolve({ ok: true }));
    proc.on('error', (err) => {
      console.error('[focus-window-source]', err);
      resolve({ ok: false });
    });
  });
});

ipcMain.handle('hud:open', () => {
  createHudWindow();
  return { ok: true };
});

ipcMain.handle('hud:close', () => {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
  return { ok: true };
});

ipcMain.handle('hud:is-open', () => {
  return !!(hudWindow && !hudWindow.isDestroyed());
});

ipcMain.on('hud:event', (_evt, payload: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hud:event', payload);
  }
});

ipcMain.on('hud:push-state', (_evt, payload: unknown) => {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.webContents.send('hud:state', payload);
  }
});


ipcMain.on('hud:set-ignore-mouse', (_evt, ignore: unknown) => {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
  }
});

interface HudSizePayload {
  width?: number;
  height?: number;
  // Optional vertical delta — used when a popover needs to expand the
  // window upward (e.g. when the bar is near the screen bottom).
  dy?: number;
}

ipcMain.handle('hud:minimize', () => {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide();
  return { ok: true };
});

ipcMain.handle('hud:show', () => {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.show();
    hudWindow.focus();
  } else {
    createHudWindow();
  }
  return { ok: true };
});

ipcMain.handle('app:quit', () => {
  app.exit(0);
});

ipcMain.handle('main:show', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  return { ok: true };
});

ipcMain.handle('main:hide', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  return { ok: true };
});

ipcMain.on('hud:set-size', (_evt, payload: HudSizePayload | undefined) => {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  const w = Math.max(420, Math.round(payload?.width || HUD_WIDTH));
  const h = Math.max(HUD_BAR_HEIGHT, Math.round(payload?.height || HUD_BAR_HEIGHT));
  const dy = Math.round(payload?.dy || 0);
  const current = hudWindow.getBounds();
  // Anchor on the bar's horizontal center so growing/shrinking doesn't visually
  // jerk the bar — but preserve the user's dragged position otherwise.
  const centerX = current.x + current.width / 2;
  const newX = Math.round(centerX - w / 2);
  hudWindow.setBounds({
    x: newX,
    y: current.y + dy,
    width: w,
    height: h,
  }, false);
});

ipcMain.on('hud:drag-by', (_evt, payload: { dx: number; dy: number } | undefined) => {
  if (!hudWindow || hudWindow.isDestroyed() || !payload) return;
  const dx = Math.round(payload.dx);
  const dy = Math.round(payload.dy);
  if (dx === 0 && dy === 0) return;
  const b = hudWindow.getBounds();
  hudWindow.setBounds({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height }, false);
});

ipcMain.handle('hud:move-to-display', (_evt, displayId: string | number | null | undefined) => {
  if (!hudWindow || hudWindow.isDestroyed()) return { ok: false as const };
  if (displayId == null || displayId === '') return { ok: false as const };
  const target = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
  if (!target) return { ok: false as const };
  const bounds = hudWindow.getBounds();
  const x = Math.round(target.workArea.x + (target.workArea.width - bounds.width) / 2);
  const y = target.workArea.y + HUD_TOP_OFFSET;
  hudWindow.setBounds({ x, y, width: bounds.width, height: bounds.height }, false);
  return { ok: true as const };
});

ipcMain.on('camera-preview:activate', (_evt, payload: { deviceId?: string } | undefined) => {
  sendCameraPreviewCommand({ type: 'activate', deviceId: payload?.deviceId ?? '' });
});

ipcMain.on('camera-preview:deactivate', () => {
  sendCameraPreviewCommand({ type: 'deactivate' });
});

ipcMain.on('camera-preview:set-device', (_evt, payload: { deviceId?: string } | undefined) => {
  sendCameraPreviewCommand({ type: 'set-device', deviceId: payload?.deviceId ?? '' });
});
