import { spawnSync } from 'node:child_process';

function buildPowerShellCommand(show: boolean): string {
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

function runPowerShell(command: string): boolean {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command],
    { timeout: 8000, windowsHide: true },
  );
  return !result.error && result.status === 0;
}

let cursorHidden = false;

export function hideCursor(): boolean {
  if (process.platform !== 'win32' || cursorHidden) return false;
  try {
    const ok = runPowerShell(buildPowerShellCommand(false));
    if (ok) cursorHidden = true;
    return ok;
  } catch (err) {
    console.error('[cursorHider] hide failed:', err);
    return false;
  }
}

export function showCursor(): boolean {
  if (process.platform !== 'win32' || !cursorHidden) return false;
  try {
    const ok = runPowerShell(buildPowerShellCommand(true));
    if (ok) cursorHidden = false;
    return ok;
  } catch (err) {
    console.error('[cursorHider] show failed:', err);
    return false;
  }
}

export function isCursorHidden(): boolean {
  return cursorHidden;
}
