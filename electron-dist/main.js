"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_child_process_1 = require("node:child_process");
const isDev = process.env['NODE_ENV'] === 'development';
let mainWindow = null;
let hudWindow = null;
let mouseTracker = null;
const HUD_WIDTH = 680;
const HUD_BAR_HEIGHT = 88;
const HUD_HEIGHT = HUD_BAR_HEIGHT;
const HUD_TOP_OFFSET = 18;
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 960,
        minHeight: 640,
        backgroundColor: '#0b0d12',
        title: 'Klipe Studio',
        show: false,
        webPreferences: {
            preload: node_path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
    }
    else {
        mainWindow.loadFile(node_path_1.default.join(__dirname, '..', 'dist', 'index.html'));
    }
    mainWindow.on('close', (e) => {
        if (hudWindow && !hudWindow.isDestroyed() && mainWindow && !mainWindow.isVisible()) {
            e.preventDefault();
        }
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
        stopMouseTracking();
        if (hudWindow && !hudWindow.isDestroyed())
            hudWindow.close();
    });
}
function createHudWindow() {
    if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.show();
        hudWindow.focus();
        return hudWindow;
    }
    const cursor = electron_1.screen.getCursorScreenPoint();
    const display = electron_1.screen.getDisplayNearestPoint(cursor) || electron_1.screen.getPrimaryDisplay();
    const { workArea } = display;
    const x = Math.round(workArea.x + (workArea.width - HUD_WIDTH) / 2);
    const y = workArea.y + HUD_TOP_OFFSET;
    hudWindow = new electron_1.BrowserWindow({
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
            preload: node_path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    hudWindow.setAlwaysOnTop(true, 'screen-saver');
    hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    try {
        hudWindow.setContentProtection(true);
    }
    catch { /* ignore */ }
    if (isDev) {
        hudWindow.loadURL('http://localhost:5173/hud.html');
    }
    else {
        hudWindow.loadFile(node_path_1.default.join(__dirname, '..', 'dist', 'hud.html'));
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
electron_1.app.whenReady().then(() => {
    createWindow();
    createHudWindow();
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
            createHudWindow();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    electron_1.app.quit();
});
electron_1.ipcMain.handle('get-screen-sources', async () => {
    const sources = await electron_1.desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
    });
    const displays = electron_1.screen.getAllDisplays();
    const primaryId = electron_1.screen.getPrimaryDisplay().id;
    const ownIds = new Set(electron_1.BrowserWindow.getAllWindows()
        .map((w) => {
        try {
            return w.getMediaSourceId();
        }
        catch {
            return '';
        }
    })
        .filter(Boolean));
    console.log(`[desktopCapturer] sources=${sources.length}`, sources.map((s) => `${s.id}::${s.name}`));
    let screenIndex = 0;
    return sources
        .filter((s) => !ownIds.has(s.id))
        .map((s) => {
        const isScreen = s.id.startsWith('screen:');
        let width = 0;
        let height = 0;
        let scaleFactor = 1;
        let displayId = null;
        let primary = false;
        let name = s.name;
        if (isScreen) {
            let matched = displays.find((d) => String(d.id) === String(s.display_id));
            if (!matched)
                matched = displays[screenIndex] || displays[0];
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
        }
        else {
            const tsize = s.thumbnail.getSize();
            width = tsize.width;
            height = tsize.height;
        }
        return {
            id: s.id,
            name,
            display_id: s.display_id,
            thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
            kind: isScreen ? 'screen' : 'window',
            width,
            height,
            scaleFactor,
            displayId,
            primary,
        };
    });
});
electron_1.ipcMain.handle('save-video-blob', async (_evt, { buffer, suggestedName, mimeType }) => {
    const ext = mimeType && mimeType.includes('mp4') ? 'mp4' : 'webm';
    const defaultPath = node_path_1.default.join(electron_1.app.getPath('videos'), suggestedName || `klipe-${Date.now()}.${ext}`);
    if (!mainWindow)
        return { canceled: true };
    const result = await electron_1.dialog.showSaveDialog(mainWindow, {
        title: 'Save recording',
        defaultPath,
        filters: [
            { name: 'Video', extensions: [ext] },
            { name: 'All Files', extensions: ['*'] },
        ],
    });
    if (result.canceled || !result.filePath)
        return { canceled: true };
    node_fs_1.default.writeFileSync(result.filePath, Buffer.from(buffer));
    return { canceled: false, filePath: result.filePath };
});
electron_1.ipcMain.handle('get-primary-display-size', () => {
    const d = electron_1.screen.getPrimaryDisplay();
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
    if (mouseTracker) {
        return { ok: true, alreadyRunning: true, startTime: mouseTracker.startTime };
    }
    const startTime = Date.now();
    if (process.platform !== 'win32') {
        const handle = { startTime, fallbackInterval: null, proc: null };
        handle.fallbackInterval = setInterval(() => {
            if (!mainWindow)
                return;
            const p = electron_1.screen.getCursorScreenPoint();
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
    const proc = (0, node_child_process_1.spawn)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_TRACKER_SCRIPT], { windowsHide: true });
    let buffer = '';
    proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line || !mainWindow)
                continue;
            const parts = line.split('|');
            if (parts[0] === 'MOVE') {
                mainWindow.webContents.send('mouse-event', {
                    type: 'move',
                    t: Number(parts[1]),
                    x: Number(parts[2]),
                    y: Number(parts[3]),
                });
            }
            else if (parts[0] === 'CLICK') {
                mainWindow.webContents.send('mouse-event', {
                    type: 'click',
                    t: Number(parts[1]),
                    x: Number(parts[2]),
                    y: Number(parts[3]),
                    button: parts[4],
                });
            }
        }
    });
    proc.stderr.on('data', (d) => console.error('[mouse-tracker]', d.toString()));
    proc.on('exit', () => {
        if (mouseTracker && mouseTracker.proc === proc)
            mouseTracker = null;
    });
    mouseTracker = { startTime, proc };
    return { ok: true, startTime };
}
function stopMouseTracking() {
    if (!mouseTracker)
        return { ok: true, notRunning: true, startTime: 0 };
    if (mouseTracker.fallbackInterval)
        clearInterval(mouseTracker.fallbackInterval);
    if (mouseTracker.proc) {
        try {
            mouseTracker.proc.kill();
        }
        catch { /* ignore */ }
    }
    const startTime = mouseTracker.startTime;
    mouseTracker = null;
    return { ok: true, startTime };
}
electron_1.ipcMain.handle('start-mouse-tracking', () => startMouseTracking());
electron_1.ipcMain.handle('stop-mouse-tracking', () => stopMouseTracking());
const FOCUS_WINDOW_SCRIPT = (hwnd) => `
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
electron_1.ipcMain.handle('focus-window-source', async (_evt, sourceId) => {
    if (process.platform !== 'win32')
        return { ok: false };
    if (typeof sourceId !== 'string')
        return { ok: false };
    const parts = sourceId.split(':');
    if (parts[0] !== 'window' || !parts[1] || !/^\d+$/.test(parts[1])) {
        return { ok: false };
    }
    const hwnd = parts[1];
    return new Promise((resolve) => {
        const proc = (0, node_child_process_1.spawn)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', FOCUS_WINDOW_SCRIPT(hwnd)], { windowsHide: true });
        proc.on('exit', () => resolve({ ok: true }));
        proc.on('error', (err) => {
            console.error('[focus-window-source]', err);
            resolve({ ok: false });
        });
    });
});
electron_1.ipcMain.handle('hud:open', () => {
    createHudWindow();
    return { ok: true };
});
electron_1.ipcMain.handle('hud:close', () => {
    if (hudWindow && !hudWindow.isDestroyed())
        hudWindow.close();
    return { ok: true };
});
electron_1.ipcMain.handle('hud:is-open', () => {
    return !!(hudWindow && !hudWindow.isDestroyed());
});
electron_1.ipcMain.on('hud:event', (_evt, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hud:event', payload);
    }
});
electron_1.ipcMain.on('hud:push-state', (_evt, payload) => {
    if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.webContents.send('hud:state', payload);
    }
});
electron_1.ipcMain.on('hud:set-ignore-mouse', (_evt, ignore) => {
    if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
    }
});
electron_1.ipcMain.handle('hud:minimize', () => {
    if (hudWindow && !hudWindow.isDestroyed())
        hudWindow.hide();
    return { ok: true };
});
electron_1.ipcMain.handle('hud:show', () => {
    if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.show();
        hudWindow.focus();
    }
    else {
        createHudWindow();
    }
    return { ok: true };
});
electron_1.ipcMain.handle('app:quit', () => {
    electron_1.app.exit(0);
});
electron_1.ipcMain.handle('main:show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        if (isDev) {
            try {
                mainWindow.webContents.openDevTools({ mode: 'detach' });
            }
            catch { /* ignore */ }
        }
    }
    return { ok: true };
});
electron_1.ipcMain.handle('main:hide', () => {
    if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.hide();
    return { ok: true };
});
electron_1.ipcMain.on('hud:set-size', (_evt, payload) => {
    if (!hudWindow || hudWindow.isDestroyed())
        return;
    const w = Math.max(420, Math.round(payload?.width || HUD_WIDTH));
    const h = Math.max(HUD_BAR_HEIGHT, Math.round(payload?.height || HUD_BAR_HEIGHT));
    const current = hudWindow.getBounds();
    const center = {
        x: Math.round(current.x + current.width / 2),
        y: Math.round(current.y + current.height / 2),
    };
    const display = electron_1.screen.getDisplayNearestPoint(center) || electron_1.screen.getPrimaryDisplay();
    const newX = Math.round(display.workArea.x + (display.workArea.width - w) / 2);
    hudWindow.setBounds({
        x: newX,
        y: display.workArea.y + HUD_TOP_OFFSET,
        width: w,
        height: h,
    }, false);
});
electron_1.ipcMain.handle('hud:move-to-display', (_evt, displayId) => {
    if (!hudWindow || hudWindow.isDestroyed())
        return { ok: false };
    if (displayId == null || displayId === '')
        return { ok: false };
    const target = electron_1.screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
    if (!target)
        return { ok: false };
    const bounds = hudWindow.getBounds();
    const x = Math.round(target.workArea.x + (target.workArea.width - bounds.width) / 2);
    const y = target.workArea.y + HUD_TOP_OFFSET;
    hudWindow.setBounds({ x, y, width: bounds.width, height: bounds.height }, false);
    return { ok: true };
});
//# sourceMappingURL=main.js.map