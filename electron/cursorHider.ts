import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

// On-disk sentinel marking "the system cursor is currently blanked". Because
// SetSystemCursor persists until the next reboot, a hard crash (GPU crash,
// SIGKILL, power loss) while recording would otherwise strand the user with an
// invisible cursor and no running process to restore it. We write this file
// when hiding and delete it when restoring; on the next launch the main process
// calls recoverCursorIfStranded() to detect and undo a stranded state.
let sentinelPath: string | null = null;

export function setCursorSentinelPath(p: string): void {
  sentinelPath = p;
}

function writeSentinel(): void {
  if (!sentinelPath) return;
  try { fs.writeFileSync(sentinelPath, String(Date.now())); } catch { /* best-effort */ }
}

function clearSentinel(): void {
  if (!sentinelPath) return;
  try { fs.rmSync(sentinelPath, { force: true }); } catch { /* best-effort */ }
}

// Standard Win32 OCR_* cursor IDs we replace while recording. Covers the
// cursors most apps load via LoadCursor/IDC_*.
const SYSTEM_CURSOR_IDS = [
  32512, // OCR_NORMAL       (IDC_ARROW)
  32513, // OCR_IBEAM        (IDC_IBEAM / text)
  32514, // OCR_WAIT         (IDC_WAIT)
  32515, // OCR_CROSS        (IDC_CROSS)
  32516, // OCR_UP           (IDC_UPARROW)
  32642, // OCR_SIZENWSE     (IDC_SIZENWSE)
  32643, // OCR_SIZENESW     (IDC_SIZENESW)
  32644, // OCR_SIZEWE       (IDC_SIZEWE)
  32645, // OCR_SIZENS       (IDC_SIZENS)
  32646, // OCR_SIZEALL      (IDC_SIZEALL)
  32648, // OCR_NO           (IDC_NO)
  32649, // OCR_HAND         (IDC_HAND / pointer)
  32650, // OCR_APPSTARTING  (IDC_APPSTARTING)
  32651, // OCR_HELP         (IDC_HELP)
];

const HIDE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CH {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr CreateCursor(IntPtr hInst, int xHotSpot, int yHotSpot,
    int nWidth, int nHeight, byte[] pvANDPlane, byte[] pvXORPlane);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetSystemCursor(IntPtr hcur, uint id);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool DestroyCursor(IntPtr hCursor);
}
"@

# 32x32 fully-transparent cursor:
#   AND mask = all 1s   (transparent → screen pixel passes through)
#   XOR mask = all 0s   (no inversion)
# Per-row stride is 32 bits = 4 bytes; 32 rows = 128 bytes.
$andMask = New-Object byte[] 128
for ($i = 0; $i -lt 128; $i++) { $andMask[$i] = 0xFF }
$xorMask = New-Object byte[] 128

$ids = @(${SYSTEM_CURSOR_IDS.join(', ')})

# Create a UNIQUE blank cursor per ID. SetSystemCursor takes ownership and
# destroys the supplied hcur, so we cannot reuse a single handle for all IDs.
# Distinct destination IDs end up backed by distinct kernel cursor objects,
# which preserves cursor-type discrimination for the mouse tracker (started
# AFTER hideCursor()) when it reads GetCursorInfo.hCursor.
foreach ($id in $ids) {
  $blank = [CH]::CreateCursor([IntPtr]::Zero, 0, 0, 32, 32, $andMask, $xorMask)
  if ($blank -ne [IntPtr]::Zero) {
    [void][CH]::SetSystemCursor($blank, $id)
  }
}
exit 0
`;

const SHOW_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CR {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SystemParametersInfo(uint uiAction, uint uiParam,
    IntPtr pvParam, uint fWinIni);
}
"@
# SPI_SETCURSORS = 0x57, SPIF_SENDCHANGE = 0x02 → reload all default cursors
# from the registry and broadcast WM_SETTINGCHANGE.
[void][CR]::SystemParametersInfo(0x57, 0, [IntPtr]::Zero, 0x02)
exit 0
`;

function runPowerShell(command: string): boolean {
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: 8000, windowsHide: true },
    );
    return !result.error && result.status === 0;
  } catch (err) {
    console.error('[cursorHider] powershell failed:', err);
    return false;
  }
}

let cursorHidden = false;

export function hideCursor(): boolean {
  if (process.platform !== 'win32') return false;
  if (cursorHidden) return true;
  const ok = runPowerShell(HIDE_SCRIPT);
  if (ok) {
    cursorHidden = true;
    // Mark the stranded-cursor sentinel BEFORE the recording starts so a crash
    // mid-take is always recoverable on next launch.
    writeSentinel();
  }
  return ok;
}

export function showCursor(): boolean {
  if (process.platform !== 'win32') return false;
  if (!cursorHidden) return true;
  const ok = runPowerShell(SHOW_SCRIPT);
  // Restore the in-memory flag even if the script returned non-zero, so we
  // don't get stuck unable to retry. The next hideCursor() can reapply.
  cursorHidden = false;
  clearSentinel();
  return ok;
}

export function isCursorHidden(): boolean {
  return cursorHidden;
}

/**
 * Restore the system cursor if a previous run blanked it and crashed before
 * restoring (detected via the on-disk sentinel). Safe to call once at startup;
 * a no-op when the sentinel is absent. Returns true if a stranded cursor was
 * recovered.
 */
export function recoverCursorIfStranded(): boolean {
  if (process.platform !== 'win32') return false;
  if (!sentinelPath) return false;
  let stranded = false;
  try { stranded = fs.existsSync(sentinelPath); } catch { stranded = false; }
  if (!stranded) return false;
  console.warn('[cursorHider] recovering system cursor stranded by a previous crash');
  const ok = runPowerShell(SHOW_SCRIPT);
  cursorHidden = false;
  clearSentinel();
  return ok;
}
