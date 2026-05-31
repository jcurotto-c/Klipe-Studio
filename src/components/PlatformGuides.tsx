import type { SafeZones } from '../lib/platforms';

interface PlatformGuidesProps {
  safe: SafeZones;
}

const pct = (n: number): string => `${(n * 100).toFixed(3)}%`;

/**
 * Editing-only overlay that marks where a social platform's own UI (caption,
 * action buttons, progress bar) will cover the video. Drawn as absolutely
 * positioned, non-interactive elements over the canvas — never baked into the
 * export. The dashed box is the "safe area"; the shaded bands are covered.
 */
export default function PlatformGuides({ safe }: PlatformGuidesProps): JSX.Element {
  return (
    <div className="platform-guides" aria-hidden="true">
      {safe.top > 0 && <div className="pg-zone" style={{ top: 0, left: 0, right: 0, height: pct(safe.top) }} />}
      {safe.bottom > 0 && (
        <div className="pg-zone" style={{ bottom: 0, left: 0, right: 0, height: pct(safe.bottom) }}>
          <span className="pg-label">Caption</span>
        </div>
      )}
      {safe.left > 0 && (
        <div className="pg-zone" style={{ left: 0, width: pct(safe.left), top: pct(safe.top), bottom: pct(safe.bottom) }} />
      )}
      {safe.right > 0 && (
        <div className="pg-zone" style={{ right: 0, width: pct(safe.right), top: pct(safe.top), bottom: pct(safe.bottom) }}>
          {safe.right >= 0.08 && <span className="pg-label pg-label-rot">Actions</span>}
        </div>
      )}
      <div
        className="pg-safe"
        style={{ top: pct(safe.top), bottom: pct(safe.bottom), left: pct(safe.left), right: pct(safe.right) }}
      />
    </div>
  );
}
