import { useEffect, useState } from 'react';
import {
  loadGlobalShortcuts,
  applyGlobalShortcuts,
  eventToAccelerator,
  formatAccelerator,
  type GlobalShortcutsConfig,
} from '../../lib/global-shortcuts';

const EDITOR_SHORTCUTS: ReadonlyArray<{ keys: string[]; label: string }> = [
  { keys: ['Space'], label: 'Play / pause' },
  { keys: ['←', '→'], label: 'Step one frame' },
  { keys: ['Shift', '←/→'], label: 'Jump 1 second' },
  { keys: ['Home'], label: 'Go to start' },
  { keys: ['End'], label: 'Go to end' },
  { keys: ['C'], label: 'Cut at playhead' },
  { keys: ['Delete'], label: 'Remove selected zoom / blur / overlay / clip' },
  { keys: ['Ctrl', 'Z'], label: 'Undo' },
  { keys: ['Ctrl', 'Shift', 'Z'], label: 'Redo' },
];

const GLOBAL_ROWS: ReadonlyArray<{ id: keyof GlobalShortcutsConfig; label: string }> = [
  { id: 'toggleRecord', label: 'Start / stop recording' },
  { id: 'toggleHud', label: 'Show / hide toolbar' },
];

export default function ShortcutsPanel(): JSX.Element {
  const [config, setConfig] = useState<GlobalShortcutsConfig>(() => loadGlobalShortcuts());
  const [capturing, setCapturing] = useState<keyof GlobalShortcutsConfig | null>(null);
  // accelerator -> false when the OS rejected it (taken by another app, etc.).
  const [failed, setFailed] = useState<Record<string, boolean>>({});

  // Re-register on mount so the panel reflects which bindings the OS accepted.
  useEffect(() => {
    void applyGlobalShortcuts(loadGlobalShortcuts()).then((map) => setFailed(map));
  }, []);

  // While capturing, the next real key combo becomes the new accelerator.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(null); return; }
      const accel = eventToAccelerator(e);
      if (!accel) return; // modifier-only — keep waiting
      const next = { ...config, [capturing]: accel };
      setConfig(next);
      setCapturing(null);
      void applyGlobalShortcuts(next).then((map) => setFailed(map));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, config]);

  return (
    <div className="panel-pro">
      <div className="section-card">
        <div className="section-head">
          <span className="section-title">Recording (global)</span>
        </div>
        <div className="section-body">
          {GLOBAL_ROWS.map((row) => {
            const accel = config[row.id];
            const isFailed = failed[accel] === false;
            return (
              <div key={row.id} className="shortcut-row">
                <span className="shortcut-label">{row.label}</span>
                <button
                  type="button"
                  className={`shortcut-rebind ${capturing === row.id ? 'is-capturing' : ''} ${isFailed ? 'is-failed' : ''}`}
                  onClick={() => setCapturing((c) => (c === row.id ? null : row.id))}
                  title={isFailed ? 'This combination is unavailable (already used by Windows or another app). Pick another.' : 'Click, then press the new keys'}
                >
                  {capturing === row.id ? 'Press keys…' : formatAccelerator(accel)}
                </button>
              </div>
            );
          })}
          {Object.values(failed).some((ok) => ok === false) ? (
            <div className="audio-meta" style={{ color: 'var(--danger, #e5484d)' }}>
              ⚠ A binding in red is already taken by Windows or another app — pick a different combination (e.g. Ctrl+Shift+R).
            </div>
          ) : (
            <div className="audio-meta dim">
              Work anywhere, even while another app is focused. Click a binding, then press the keys (Esc to cancel).
            </div>
          )}
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">
          <span className="section-title">Editor</span>
        </div>
        <div className="section-body">
          {EDITOR_SHORTCUTS.map((s) => (
            <div key={s.label} className="shortcut-row">
              <span className="shortcut-label">{s.label}</span>
              <span className="shortcut-keys">
                {s.keys.map((k, i) => (
                  <kbd key={i} className="shortcut-kbd">{k}</kbd>
                ))}
              </span>
            </div>
          ))}
          <div className="audio-meta dim">Editor shortcuts work while the editor is focused (not while typing in a field).</div>
        </div>
      </div>
    </div>
  );
}
