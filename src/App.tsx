import { useCallback, useEffect, useRef, useState } from 'react';
import RecorderView from './components/RecorderView';
import EditorView from './components/EditorView';
import type { Recording } from './types';
import { openProject, openProjectPath, type EditDocument } from './lib/project';
import { loadRecents, addRecent, removeRecent, type RecentProject } from './lib/recents';
import { loadGlobalShortcuts, applyGlobalShortcuts } from './lib/global-shortcuts';
import logoIcon from './assets/branding/klipe-icon.svg';

type View = 'recorder' | 'editor';

export default function App(): JSX.Element {
  const [view, setView] = useState<View>('recorder');
  const [recording, setRecording] = useState<Recording | null>(null);
  const [loadedDoc, setLoadedDoc] = useState<EditDocument | null>(null);
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentProject[]>(() => loadRecents());
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
    if (recording?.url) URL.revokeObjectURL(recording.url);
    setLoadedDoc(null);
    setCurrentProjectPath(null);
    setRecording(null);
    setView('recorder');
    window.klipeHud?.hideMain?.();
  }, [recording]);

  const applyOpened = useCallback((opened: { recording: Recording; doc: EditDocument; projectPath: string }) => {
    if (recording?.url) URL.revokeObjectURL(recording.url);
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

  const handleOpenRecent = useCallback(async (path: string) => {
    try {
      const opened = await openProjectPath(path);
      if (opened) applyOpened(opened);
      else setRecents(removeRecent(path));
    } catch (e) {
      console.error('[project] open recent failed:', e);
      setRecents(removeRecent(path));
    }
  }, [applyOpened]);

  const handleProjectSaved = useCallback((path: string, name: string) => {
    setCurrentProjectPath(path);
    setRecents(addRecent({ path, name }));
  }, []);

  useEffect(() => {
    if (view === 'editor') {
      window.klipeHud?.minimize?.();
    } else {
      window.klipeHud?.show?.();
    }
  }, [view]);

  // Register the user's saved global recording shortcuts on launch. (The main
  // process already registers defaults; this overrides them if customized.)
  useEffect(() => {
    void applyGlobalShortcuts(loadGlobalShortcuts());
  }, []);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <img className="brand-logo" src={logoIcon} alt="Klipe Studio" />
          <span className="brand-text">
            <span className="brand-name">klipe</span>
            <span className="brand-sub">studio</span>
          </span>
        </div>
        {recording?.name && (
          <div className="titlebar-center">
            <span className="recording-title">{recording.name}</span>
            <span className="recording-ext">.klipestudio</span>
          </div>
        )}
        <nav className="nav">
          <button
            className={view === 'recorder' ? 'active' : ''}
            onClick={handleNewRecording}
          >
            Recorder
          </button>
          <button
            className={view === 'editor' ? 'active' : ''}
            onClick={() => recording && setView('editor')}
            disabled={!recording}
          >
            Editor
          </button>
          <button onClick={handleOpenProject} title="Open a .klipestudio project">
            Open
          </button>
          <div className="nav-extra" ref={setNavExtra} />
        </nav>
      </header>

      <main className="view">
        {view === 'recorder' && (
          <RecorderView
            onRecordingDone={handleRecordingDone}
            recents={recents}
            onOpenRecent={handleOpenRecent}
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
          />
        )}
      </main>
    </div>
  );
}
