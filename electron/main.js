const { app, BrowserWindow, desktopCapturer, ipcMain, dialog, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const isDev = process.env.NODE_ENV === 'development';

let mainWindow = null;
let hudWindow = null;
let mouseTracker = null;

const HUD_WIDTH = 560;
// Window is exactly bar-sized at rest. It grows on demand when a dropdown
// menu opens, then shrinks back. Avoids any empty transparent region that
// Windows occasionally fails to composite as transparent.
const HUD_BAR_HEIGHT = 64;
const HUD_HEIGHT = HUD_BAR_HEIGHT;
const HUD_TOP_OFFSET = 18;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    title: 'Klipe Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopMouseTracking();
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
  });
}

function createHudWindow() {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.show();
    hudWindow.focus();
    return hudWindow;
  }

  const display = screen.getPrimaryDisplay();
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
      sandbox: false
    }
  });

  // Float above fullscreen apps + don't show in capture
  hudWindow.setAlwaysOnTop(true, 'screen-saver');
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Excludes the window from screen capture (Win: WDA_EXCLUDEFROMCAPTURE, macOS: NSWindowSharingNone)
  try { hudWindow.setContentProtection(true); } catch (_) {}

  if (isDev) {
    hudWindow.loadURL('http://localhost:5173/hud.html');
  } else {
    hudWindow.loadFile(path.join(__dirname, '..', 'dist', 'hud.html'));
  }

  hudWindow.once('ready-to-show', () => hudWindow.show());

  hudWindow.on('closed', () => {
    hudWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hud:closed');
    }
  });

  return hudWindow;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 }
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    display_id: s.display_id,
    thumbnail: s.thumbnail.toDataURL()
  }));
});

ipcMain.handle('save-video-blob', async (_evt, { buffer, suggestedName, mimeType }) => {
  const ext = mimeType && mimeType.includes('mp4') ? 'mp4' : 'webm';
  const defaultPath = path.join(
    app.getPath('videos'),
    suggestedName || `klipe-${Date.now()}.${ext}`
  );
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save recording',
    defaultPath,
    filters: [
      { name: 'Video', extensions: [ext] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, Buffer.from(buffer));
  return { canceled: false, filePath: result.filePath };
});

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
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
$start = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$lastL = $false; $lastR = $false; $lastM = $false
$lastX = -9999; $lastY = -9999
while ($true) {
  $p = New-Object W+POINT
  [void][W]::GetCursorPos([ref]$p)
  $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $t = $now - $start
  if ($p.X -ne $lastX -or $p.Y -ne $lastY) {
    $lastX = $p.X; $lastY = $p.Y
    Write-Host ("MOVE|{0}|{1}|{2}" -f $t, $p.X, $p.Y)
  }
  $l = ([W]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0
  $r = ([W]::GetAsyncKeyState(0x02) -band 0x8000) -ne 0
  $m = ([W]::GetAsyncKeyState(0x04) -band 0x8000) -ne 0
  if ($l -and -not $lastL) { Write-Host ("CLICK|{0}|{1}|{2}|left"   -f $t, $p.X, $p.Y) }
  if ($r -and -not $lastR) { Write-Host ("CLICK|{0}|{1}|{2}|right"  -f $t, $p.X, $p.Y) }
  if ($m -and -not $lastM) { Write-Host ("CLICK|{0}|{1}|{2}|middle" -f $t, $p.X, $p.Y) }
  $lastL = $l; $lastR = $r; $lastM = $m
  Start-Sleep -Milliseconds 12
}
`;

function startMouseTracking() {
  if (mouseTracker) return { ok: true, alreadyRunning: true, startTime: mouseTracker.startTime };

  const startTime = Date.now();

  if (process.platform !== 'win32') {
    mouseTracker = { startTime, fallbackInterval: null, proc: null };
    mouseTracker.fallbackInterval = setInterval(() => {
      if (!mainWindow) return;
      const p = screen.getCursorScreenPoint();
      mainWindow.webContents.send('mouse-event', {
        type: 'move',
        x: p.x,
        y: p.y,
        t: Date.now() - startTime
      });
    }, 16);
    return { ok: true, startTime };
  }

  const proc = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_TRACKER_SCRIPT],
    { windowsHide: true }
  );

  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line || !mainWindow) continue;
      const parts = line.split('|');
      if (parts[0] === 'MOVE') {
        mainWindow.webContents.send('mouse-event', {
          type: 'move',
          t: Number(parts[1]),
          x: Number(parts[2]),
          y: Number(parts[3])
        });
      } else if (parts[0] === 'CLICK') {
        mainWindow.webContents.send('mouse-event', {
          type: 'click',
          t: Number(parts[1]),
          x: Number(parts[2]),
          y: Number(parts[3]),
          button: parts[4]
        });
      }
    }
  });

  proc.stderr.on('data', (d) => console.error('[mouse-tracker]', d.toString()));
  proc.on('exit', (code) => {
    if (mouseTracker && mouseTracker.proc === proc) mouseTracker = null;
  });

  mouseTracker = { startTime, proc };
  return { ok: true, startTime };
}

function stopMouseTracking() {
  if (!mouseTracker) return { ok: true, notRunning: true };
  if (mouseTracker.fallbackInterval) clearInterval(mouseTracker.fallbackInterval);
  if (mouseTracker.proc) {
    try { mouseTracker.proc.kill(); } catch (_) {}
  }
  const startTime = mouseTracker.startTime;
  mouseTracker = null;
  return { ok: true, startTime };
}

ipcMain.handle('start-mouse-tracking', () => startMouseTracking());
ipcMain.handle('stop-mouse-tracking', () => stopMouseTracking());

// ─── Floating HUD ────────────────────────────────────────────────────────────

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

// HUD → main: forward state changes / actions to the main app window
ipcMain.on('hud:event', (_evt, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hud:event', payload);
  }
});

// Main app → HUD: push state (e.g. recording flag, available sources)
ipcMain.on('hud:push-state', (_evt, payload) => {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.webContents.send('hud:state', payload);
  }
});

// Renderer toggles ignore-mouse so the transparent area around the bar
// doesn't intercept clicks meant for apps below the HUD.
ipcMain.on('hud:set-ignore-mouse', (_evt, ignore) => {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
  }
});

// Renderer requests a content size to fit the bar + any open dropdown.
// Width is fixed; only height varies. The window stays anchored at the
// top of the primary display.
ipcMain.on('hud:set-size', (_evt, payload) => {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  const w = Math.max(320, Math.round(payload?.width || HUD_WIDTH));
  const h = Math.max(HUD_BAR_HEIGHT, Math.round(payload?.height || HUD_BAR_HEIGHT));
  const [curX] = hudWindow.getPosition();
  const display = screen.getPrimaryDisplay();
  // Re-center horizontally if width changed; keep top y stable.
  const newX = Math.round(display.workArea.x + (display.workArea.width - w) / 2);
  hudWindow.setBounds({
    x: newX,
    y: display.workArea.y + HUD_TOP_OFFSET,
    width: w,
    height: h
  }, false);
});
