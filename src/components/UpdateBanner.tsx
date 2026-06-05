import { useEffect, useState } from 'react';

// In-app auto-update banner. Subscribes to the main process's updater lifecycle
// (electron-updater, wired in electron/main.ts) and surfaces it inside the big
// window: a quiet "downloading…" line while the new version pulls in the
// background, then a "new version ready" banner with a one-click Restart button
// that installs immediately instead of waiting for the next app quit. Renders
// nothing in dev or when there's no update (the bridge stays silent), so it adds
// zero layout when idle.
export default function UpdateBanner(): JSX.Element | null {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const off = window.klipeUpdater?.onStatus?.((s) => setStatus(s));
    return () => { off?.(); };
  }, []);

  // Only the download/ready phases get a banner — checking/up-to-date/error stay
  // silent so the app never nags about a check that found nothing.
  if (status?.state !== 'downloading' && status?.state !== 'downloaded') return null;

  const ready = status.state === 'downloaded';

  return (
    <div className={`update-banner ${ready ? 'is-ready' : ''}`} role="status" aria-live="polite">
      <span className="update-banner-dot" aria-hidden />
      <span className="update-banner-text">
        {ready
          ? `Nueva versión${status.version ? ` ${status.version}` : ''} lista para instalar`
          : `Descargando actualización… ${status.percent ?? 0}%`}
      </span>
      {ready && (
        <button
          className="primary update-banner-btn"
          disabled={installing}
          onClick={() => {
            setInstalling(true);
            void window.klipeUpdater?.quitAndInstall?.();
          }}
        >
          {installing ? 'Reiniciando…' : 'Reiniciar e instalar'}
        </button>
      )}
    </div>
  );
}
