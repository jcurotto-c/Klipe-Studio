import { useCallback, useEffect, useRef, useState } from 'react';
import RecorderView from './components/RecorderView';
import EditorView from './components/EditorView';
import type { Recording } from './types';
import { openProject, type EditDocument } from './lib/project';

type View = 'recorder' | 'editor';

export default function App(): JSX.Element {
  const [view, setView] = useState<View>('recorder');
  const [recording, setRecording] = useState<Recording | null>(null);
  const [loadedDoc, setLoadedDoc] = useState<EditDocument | null>(null);
  const navExtraRef = useRef<HTMLDivElement | null>(null);
  const [navExtraEl, setNavExtraEl] = useState<HTMLDivElement | null>(null);
  const setNavExtra = useCallback((el: HTMLDivElement | null) => {
    navExtraRef.current = el;
    setNavExtraEl(el);
  }, []);

  const handleRecordingDone = useCallback((rec: Recording) => {
    setLoadedDoc(null);
    setRecording(rec);
    setView('editor');
    window.klipeHud?.showMain?.();
  }, []);

  const handleNewRecording = useCallback(() => {
    if (recording?.url) URL.revokeObjectURL(recording.url);
    setLoadedDoc(null);
    setRecording(null);
    setView('recorder');
    window.klipeHud?.hideMain?.();
  }, [recording]);

  const handleOpenProject = useCallback(async () => {
    try {
      const opened = await openProject();
      if (!opened) return;
      if (recording?.url) URL.revokeObjectURL(recording.url);
      setLoadedDoc(opened.doc);
      setRecording(opened.recording);
      setView('editor');
      window.klipeHud?.showMain?.();
    } catch (e) {
      console.error('[project] open failed:', e);
    }
  }, [recording]);

  useEffect(() => {
    if (view === 'editor') {
      window.klipeHud?.minimize?.();
    } else {
      window.klipeHud?.show?.();
    }
  }, [view]);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <div className="logo" />
          <span>klipestudio</span>
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
          <RecorderView onRecordingDone={handleRecordingDone} />
        )}
        {view === 'editor' && recording && (
          <EditorView
            recording={recording}
            onNew={handleNewRecording}
            navExtraEl={navExtraEl}
            initialDoc={loadedDoc}
          />
        )}
      </main>
    </div>
  );
}
