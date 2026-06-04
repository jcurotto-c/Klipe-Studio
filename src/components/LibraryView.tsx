import { useCallback, useEffect, useState } from 'react';
import { listLibrary, deleteLibraryItem, revealLibraryItem } from '../lib/library';

interface LibraryViewProps {
  /** Open a saved recording (by its `.klipestudio` folder path) in the editor.
   *  Resolves false if it could not be opened (missing/corrupt on disk). */
  onOpenProject: (projectPath: string) => Promise<boolean>;
  /** Bring the floating toolbar forward so the user can start a recording. */
  onShowToolbar: () => void;
}

function formatDate(ms: number): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatDuration(ms: number | null): string | null {
  if (!ms || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function LibraryView({ onOpenProject, onShowToolbar }: LibraryViewProps): JSX.Element {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingPath, setOpeningPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const list = await listLibrary();
    setItems(list);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Re-list when the window regains focus, so a recording that finished
  // auto-saving while the gallery was already open shows up without a manual
  // Refresh. (Cheap — reads only metadata + thumbnails, never video bytes.)
  useEffect(() => {
    const onFocus = (): void => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const handleOpen = useCallback(async (projectPath: string) => {
    if (openingPath) return;
    setOpeningPath(projectPath);
    // On success applyOpened switches to the editor and unmounts this view; on
    // failure we must release the lock (and re-list, since the broken folder may
    // have been pruned) so the gallery isn't stranded showing "Opening…" forever.
    const ok = await onOpenProject(projectPath);
    if (!ok) {
      setOpeningPath(null);
      void refresh();
    }
  }, [openingPath, onOpenProject, refresh]);

  const handleDelete = useCallback(async (item: LibraryItem) => {
    const ok = window.confirm(`Delete “${item.name}”? This permanently removes the recording from your library.`);
    if (!ok) return;
    // Optimistic removal — re-add on failure.
    setItems((prev) => prev.filter((i) => i.projectPath !== item.projectPath));
    const deleted = await deleteLibraryItem(item.projectPath);
    if (!deleted) void refresh();
  }, [refresh]);

  return (
    <div className="library">
      <div className="library-head">
        <div>
          <h2 className="library-title">My videos</h2>
          <div className="library-sub">
            {loading
              ? 'Loading…'
              : items.length === 0
                ? 'Your saved recordings live here'
                : `${items.length} recording${items.length === 1 ? '' : 's'}`}
          </div>
        </div>
        <div className="library-head-actions">
          <button className="ghost" onClick={() => void revealLibraryItem()} title="Open the library folder">
            Open folder
          </button>
          <button className="ghost" onClick={() => void refresh()} title="Refresh">
            Refresh
          </button>
        </div>
      </div>

      {!loading && items.length === 0 && (
        <div className="library-empty">
          <div className="library-empty-glyph" aria-hidden>🎬</div>
          <div className="library-empty-title">No recordings yet</div>
          <div className="library-empty-text">
            Recordings are auto-saved here so you can keep editing them later.
            Use the floating toolbar to capture your screen.
          </div>
          <button className="primary" onClick={onShowToolbar}>Show recording toolbar</button>
        </div>
      )}

      {items.length > 0 && (
        <div className="library-grid">
          {items.map((item) => {
            const duration = formatDuration(item.durationMs);
            const isOpening = openingPath === item.projectPath;
            return (
              <div
                key={item.projectPath}
                className={`library-card ${isOpening ? 'is-opening' : ''}`}
                onClick={() => void handleOpen(item.projectPath)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleOpen(item.projectPath); }}
                title={item.projectPath}
              >
                <div className="library-thumb">
                  {item.thumbnailDataUrl
                    ? <img src={item.thumbnailDataUrl} alt="" draggable={false} />
                    : <div className="library-thumb-empty" aria-hidden>🎞️</div>}
                  {duration && <span className="library-duration">{duration}</span>}
                  {isOpening && <div className="library-card-loading">Opening…</div>}
                  <div className="library-card-hover">
                    <button
                      className="library-card-action"
                      onClick={(e) => { e.stopPropagation(); void revealLibraryItem(item.projectPath); }}
                      title="Reveal in folder"
                      aria-label="Reveal in folder"
                    >
                      📁
                    </button>
                    <button
                      className="library-card-action danger"
                      onClick={(e) => { e.stopPropagation(); void handleDelete(item); }}
                      title="Delete"
                      aria-label="Delete"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
                <div className="library-card-meta">
                  <span className="library-card-name">{item.name}</span>
                  <span className="library-card-date">{formatDate(item.createdAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
