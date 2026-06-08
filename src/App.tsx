import { useCallback, useEffect, useRef, useState } from 'react';
import RecorderView from './components/RecorderView';
import EditorView from './components/EditorView';
import LibraryView from './components/LibraryView';
import UpdateBanner from './components/UpdateBanner';
import AboutModal from './components/AboutModal';
import type { Recording } from './types';
import { openProject, openProjectPath, type EditDocument } from './lib/project';
import { loadRecents, addRecent, removeRecent, type RecentProject } from './lib/recents';
import { loadGlobalShortcuts, applyGlobalShortcuts } from './lib/global-shortcuts';
import { releaseFilmstrip } from './lib/filmstrip';
import logoIcon from './assets/branding/klipe-icon.svg';

type View = 'library' | 'recorder' | 'editor';

export default function App(): JSX.Element {
  // The big window lands on the library gallery ("My videos") so saved
  // recordings are one click away whenever it's brought forward.
  const [view, setView] = useState<View>('library');
  const [recording, setRecording] = useState<Recording | null>(null);
  const [loadedDoc, setLoadedDoc] = useState<EditDocument | null>(null);
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentProject[]>(() => loadRecents());
  const [aboutOpen, setAboutOpen] = useState(false);

  // Refs that mirror the current recording + its project path, read by the
  // fire-and-forget library auto-save when it completes (possibly after the
  // editor has unmounted) so a stale save can't bind a path to the wrong take or
  // clobber a path the user explicitly chose.
  const recordingUrlRef = useRef<string | null>(null);
  const currentProjectPathRef = useRef<string | null>(null);
  useEffect(() => { recordingUrlRef.current = recording?.url ?? null; }, [recording]);
  useEffect(() => { currentProjectPathRef.current = currentProjectPath; }, [currentProjectPath]);
  // Recording URLs whose library auto-save has already been kicked off. Lives in
  // App (not the unmountable EditorView) so navigating out and back can't trigger
  // a second full-media write of the same take.
  const libraryAutoSaveStarted = useRef<Set<string>>(new Set());

  const navExtraRef = useRef<HTMLDivElement | null>(null);
  const [navExtraEl, setNavExtraEl] = useState<HTMLDivElement | null>(null);
  const setNavExtra = useCallback((el: HTMLDivElement | null) => {
    navExtraRef.current = el;
    setNavExtraEl(el);
  }, []);

  const handleRecordingDone = useCallback((rec: Recording) => {
    setLoadedDoc(null);
    setCurrentProjectPath(null);
    setRecording(rec);
    setView('editor');
    window.klipeHud?.showMain?.();
  }, []);

  const handleNewRecording = useCallback(() => {
    if (recording?.url) { releaseFilmstrip(recording.url); URL.revokeObjectURL(recording.url); }
    setLoadedDoc(null);
    setCurrentProjectPath(null);
    setRecording(null);
    setView('recorder');
    window.klipeHud?.hideMain?.();
  }, [recording]);

  const applyOpened = useCallback((opened: { recording: Recording; doc: EditDocument; projectPath: string }) => {
    if (recording?.url) { releaseFilmstrip(recording.url); URL.revokeObjectURL(recording.url); }
    setLoadedDoc(opened.doc);
    setRecording(opened.recording);
    setCurrentProjectPath(opened.projectPath || null);
    if (opened.projectPath) {
      setRecents(addRecent({ path: opened.projectPath, name: opened.recording.name || 'Untitled' }));
    }
    setView('editor');
    window.klipeHud?.showMain?.();
  }, [recording]);

  const handleOpenProject = useCallback(async () => {
    try {
      const opened = await openProject();
      if (opened) applyOpened(opened);
    } catch (e) {
      console.error('[project] open failed:', e);
    }
  }, [applyOpened]);

  // Open a saved project by path. Returns whether it opened, so callers (the
  // library gallery) can clear their "opening…" state instead of hanging when a
  // project is missing/corrupt on disk.
  const handleOpenRecent = useCallback(async (path: string): Promise<boolean> => {
    try {
      const opened = await openProjectPath(path);
      if (opened) { applyOpened(opened); return true; }
      setRecents(removeRecent(path));
      return false;
    } catch (e) {
      console.error('[project] open recent failed:', e);
      setRecents(removeRecent(path));
      return false;
    }
  }, [applyOpened]);

  // Explicit "Save" (user-chosen path) — always adopt the path.
  const handleProjectSaved = useCallback((path: string, name: string) => {
    setCurrentProjectPath(path);
    setRecents(addRecent({ path, name }));
  }, []);

  // True the first time a recording's library auto-save is requested; false
  // afterwards, so a remount during the in-flight save can't write a duplicate.
  const beginLibraryAutoSave = useCallback((url: string): boolean => {
    if (libraryAutoSaveStarted.current.has(url)) return false;
    libraryAutoSaveStarted.current.add(url);
    return true;
  }, []);

  // The library auto-save finished (it runs decoupled from the editor's lifecycle,
  // so this may land after the editor unmounted). Always remember it in recents,
  // but only adopt its path as the active project when it still belongs to the
  // current recording AND the user hasn't already saved it somewhere explicit.
  const handleLibraryAutoSaved = useCallback((url: string, path: string, name: string) => {
    setRecents(addRecent({ path, name }));
    if (recordingUrlRef.current === url && currentProjectPathRef.current == null) {
      setCurrentProjectPath(path);
    }
  }, []);

  // Note: the toggle (floating toolbar) ↔ panel (this window) visibility is
  // mutually exclusive and driven entirely by the main process from the window's
  // own show/hide/minimize events — NOT from the React view. Toggling the HUD
  // here per-view would make it reappear over the panel when switching tabs.

  // Register the user's saved global recording shortcuts on launch. (The main
  // process already registers defaults; this overrides them if customized.)
  useEffect(() => {
    void applyGlobalShortcuts(loadGlobalShortcuts());
  }, []);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-left">
          <button
            type="button"
            className="brand brand-button"
            onClick={() => setAboutOpen(true)}
            title="About Klipe Studio"
          >
            <img className="brand-logo" src={logoIcon} alt="Klipe Studio" />
            <span className="brand-text">
              <span className="brand-name">klipe</span>
              <span className="brand-sub">studio</span>
            </span>
          </button>

          {view === 'editor' ? (
            // Editor "workbench" header: a single Back exit + the project name.
            <div className="titlebar-crumb">
              <button
                className="nav-back"
                onClick={() => setView('library')}
                title="Back to My videos"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M15 6l-6 6 6 6" />
                </svg>
                Back
              </button>
              {recording?.name && (
                <span className="titlebar-project" title={recording.name}>
                  <span className="recording-title">{recording.name}</span>
                  <span className="recording-ext">.klipestudio</span>
                </span>
              )}
            </div>
          ) : (
            // Library header: a small 2-segment switch + a quiet Open.
            <div className="view-switch" role="tablist" aria-label="Mode">
              <button
                className={`view-switch-seg ${view === 'library' ? 'is-active' : ''}`}
                onClick={() => setView('library')}
                role="tab"
                aria-selected={view === 'library'}
              >
                My videos
              </button>
              <span className="view-switch-div" aria-hidden />
              <button
                className="view-switch-seg view-switch-rec"
                onClick={handleNewRecording}
                title="Start a new recording from the floating toolbar"
              >
                <span className="rec-dot" aria-hidden />
                Record
              </button>
            </div>
          )}
        </div>

        <div className="titlebar-right">
          {/* Open belongs to the library state; the editor is already in a
              project, so it only carries Save + Export (injected via portal). */}
          {view !== 'editor' && (
            <button className="ghost" onClick={handleOpenProject} title="Open a .klipestudio project">
              Open
            </button>
          )}
          <div className="nav-extra" ref={setNavExtra} />
        </div>
      </header>

      <UpdateBanner />

      <main className="view">
        {/* Always mounted: the recording engine (HUD listeners + begin/stop)
            lives here and must stay alive so a recording can be started from the
            floating toolbar regardless of which view the big window shows. It
            renders its visible UI only when it's the active view. */}
        <RecorderView
          active={view === 'recorder'}
          onRecordingDone={handleRecordingDone}
          recents={recents}
          onOpenRecent={handleOpenRecent}
        />
        {view === 'library' && (
          <LibraryView
            onOpenProject={handleOpenRecent}
            onShowToolbar={() => window.klipeHud?.hideMain?.()}
          />
        )}
        {view === 'editor' && recording && (
          <EditorView
            key={recording.url}
            recording={recording}
            navExtraEl={navExtraEl}
            initialDoc={loadedDoc}
            projectPath={currentProjectPath}
            onProjectSaved={handleProjectSaved}
            beginLibraryAutoSave={beginLibraryAutoSave}
            onLibraryAutoSaved={handleLibraryAutoSaved}
          />
        )}
      </main>

      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
    </div>
  );
}
