/**
 * Configurable system-wide (global) shortcuts for recording control. The
 * accelerator strings use Electron's format (e.g. "CommandOrControl+Shift+R")
 * and are registered in the main process; this module just persists the user's
 * choice and pushes it to main via the `window.klipe.shortcuts` bridge.
 */

const KEY = 'klipe.globalShortcuts';

export interface GlobalShortcutsConfig {
  /** Start / stop recording. */
  toggleRecord: string;
  /** Show / hide the floating toolbar. */
  toggleHud: string;
}

export const DEFAULT_GLOBAL_SHORTCUTS: GlobalShortcutsConfig = {
  toggleRecord: 'CommandOrControl+Shift+R',
  toggleHud: 'CommandOrControl+Shift+H',
};

export function loadGlobalShortcuts(): GlobalShortcutsConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_GLOBAL_SHORTCUTS };
    const parsed = JSON.parse(raw) as Partial<GlobalShortcutsConfig>;
    return { ...DEFAULT_GLOBAL_SHORTCUTS, ...parsed };
  } catch {
    return { ...DEFAULT_GLOBAL_SHORTCUTS };
  }
}

/**
 * Persist the config and (re)register it in the main process. Returns a map of
 * accelerator -> whether the OS accepted it (false = taken by another app, or
 * the main process is stale and the IPC handler is missing).
 */
export async function applyGlobalShortcuts(
  config: GlobalShortcutsConfig,
): Promise<Record<string, boolean>> {
  try {
    localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
  try {
    const res = await window.klipe?.shortcuts?.set(config);
    const map: Record<string, boolean> = {};
    for (const r of res?.results ?? []) map[r.accel] = r.ok;
    return map;
  } catch {
    // main not ready / bridge missing (e.g. dev process not restarted)
    return {};
  }
}

/**
 * Convert a browser KeyboardEvent into an Electron accelerator string, or null
 * if the key is only a modifier (so the capture UI keeps waiting for a real key).
 */
export function eventToAccelerator(e: KeyboardEvent): string | null {
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  // Derive the base key from the PHYSICAL key (e.code), not e.key. With Shift
  // held, e.key for "1" is "!", which produces an invalid accelerator — e.code
  // stays "Digit1". Same for letters (case) and other printable keys.
  const code = e.code;
  let main: string | null = null;
  if (/^Digit[0-9]$/.test(code)) main = code.slice(5);          // Digit1 -> 1
  else if (/^Key[A-Z]$/.test(code)) main = code.slice(3);       // KeyA -> A
  else if (/^Numpad[0-9]$/.test(code)) main = `num${code.slice(6)}`; // Numpad1 -> num1
  else if (/^F\d{1,2}$/.test(code)) main = code;                // F1..F24
  else if (code === 'Space') main = 'Space';
  else if (code === 'ArrowUp') main = 'Up';
  else if (code === 'ArrowDown') main = 'Down';
  else if (code === 'ArrowLeft') main = 'Left';
  else if (code === 'ArrowRight') main = 'Right';
  else if (code === 'Enter' || code === 'Tab' || code === 'Backspace' || code === 'Delete') main = code;
  else if (e.key.length === 1) main = e.key.toUpperCase(); // fallback for punctuation
  else return null; // unsupported physical key — keep waiting

  parts.push(main);
  return parts.join('+');
}

/** Pretty label for display (CommandOrControl -> Ctrl). */
export function formatAccelerator(accel: string): string {
  return accel
    .split('+')
    .map((p) => (p === 'CommandOrControl' ? 'Ctrl' : p))
    .join(' + ');
}
