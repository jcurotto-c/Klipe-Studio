import { app, BrowserWindow, Menu, desktopCapturer, ipcMain, dialog, screen, session, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { hideCursor, showCursor, isCursorHidden } from './cursorHider';

const isDev = process.env['NODE_ENV'] === 'development';

Menu.setApplicationMenu(null);

let mainWindow: BrowserWindow | null = null;
let hudWindow: BrowserWindow | null = null;
let cursorPreviewWindow: BrowserWindow | null = null;
let cursorPreviewOrigin: { x: number; y: number } = { x: 0, y: 0 };
let cursorPreviewInterval: NodeJS.Timeout | null = null;

interface MouseTrackerHandle {
  startTime: number;
  proc?: ChildProcessWithoutNullStreams | null;
  fallbackInterval?: NodeJS.Timeout | null;
}

let mouseTracker: MouseTrackerHandle | null = null;

const HUD_WIDTH = 680;
const HUD_BAR_HEIGHT = 88;
const HUD_HEIGHT = HUD_BAR_HEIGHT;
const HUD_TOP_OFFSET = 18;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    title: 'Klipe Studio',
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

  mainWindow.on('close', (e) => {
    if (hudWindow && !hudWindow.isDestroyed() && mainWindow && !mainWindow.isVisible()) {
      e.preventDefault();
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
    hasShadow: true,
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

// Renderer sets this via `prepare-display-media` right before calling
// getDisplayMedia(). The handler below resolves it to a real desktopCapturer
// source so we can ask for cursor: 'never' without showing Chromium's picker.
let pendingDisplayMediaSourceId: string | null = null;

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const targetId = pendingDisplayMediaSourceId;
    pendingDisplayMediaSourceId = null;
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
        callback({ video: source });
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      createHudWindow();
    }
  });
});

ipcMain.handle('prepare-display-media', (_evt: IpcMainInvokeEvent, sourceId: unknown) => {
  if (typeof sourceId !== 'string' || !sourceId) return { ok: false as const };
  pendingDisplayMediaSourceId = sourceId;
  return { ok: true as const };
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
app.on('before-quit', ensureCursorRestored);
app.on('will-quit', ensureCursorRestored);
process.on('exit', ensureCursorRestored);
process.on('SIGINT', () => { ensureCursorRestored(); process.exit(0); });
process.on('SIGTERM', () => { ensureCursorRestored(); process.exit(0); });
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught:', err);
  ensureCursorRestored();
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
    fs.writeFileSync(result.filePath, Buffer.from(buffer as ArrayBuffer));
    return { canceled: false as const, filePath: result.filePath };
  },
);

ipcMain.handle('get-primary-display-size', () => {
  const d = screen.getPrimaryDisplay();
  return { width: d.size.width, height: d.size.height, scaleFactor: d.scaleFactor };
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
  const current = hudWindow.getBounds();
  const center = {
    x: Math.round(current.x + current.width / 2),
    y: Math.round(current.y + current.height / 2),
  };
  const display = screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay();
  const newX = Math.round(display.workArea.x + (display.workArea.width - w) / 2);
  hudWindow.setBounds({
    x: newX,
    y: display.workArea.y + HUD_TOP_OFFSET,
    width: w,
    height: h,
  }, false);
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
