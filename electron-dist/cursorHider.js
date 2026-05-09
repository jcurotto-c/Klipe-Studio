"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hideCursor = hideCursor;
exports.showCursor = showCursor;
exports.isCursorHidden = isCursorHidden;
const node_child_process_1 = require("node:child_process");
function buildPowerShellCommand(show) {
    const desiredFlag = show ? 1 : 0;
    const showLiteral = show ? '$true' : '$false';
    return [
        '$signature = @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public struct POINT { public int X; public int Y; }',
        'public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }',
        'public static class CursorNative {',
        '  [DllImport("user32.dll")] public static extern int ShowCursor(bool show);',
        '  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);',
        '}',
        '"@;',
        'Add-Type -TypeDefinition $signature -Language CSharp -ErrorAction SilentlyContinue | Out-Null;',
        '$info = New-Object CURSORINFO;',
        '$info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]CURSORINFO);',
        'for ($i = 0; $i -lt 32; $i++) {',
        '  if ([CursorNative]::GetCursorInfo([ref]$info) -and (($info.flags -band 1) -eq ' +
            desiredFlag +
            ')) { exit 0 }',
        '  [CursorNative]::ShowCursor(' + showLiteral + ') | Out-Null;',
        '}',
        'exit 0',
    ].join(' ');
}
function runPowerShell(command) {
    const result = (0, node_child_process_1.spawnSync)('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], { timeout: 8000, windowsHide: true });
    return !result.error && result.status === 0;
}
let cursorHidden = false;
function hideCursor() {
    if (process.platform !== 'win32' || cursorHidden)
        return false;
    try {
        const ok = runPowerShell(buildPowerShellCommand(false));
        if (ok)
            cursorHidden = true;
        return ok;
    }
    catch (err) {
        console.error('[cursorHider] hide failed:', err);
        return false;
    }
}
function showCursor() {
    if (process.platform !== 'win32' || !cursorHidden)
        return false;
    try {
        const ok = runPowerShell(buildPowerShellCommand(true));
        if (ok)
            cursorHidden = false;
        return ok;
    }
    catch (err) {
        console.error('[cursorHider] show failed:', err);
        return false;
    }
}
function isCursorHidden() {
    return cursorHidden;
}
//# sourceMappingURL=cursorHider.js.map