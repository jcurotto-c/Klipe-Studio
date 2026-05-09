import { useCallback, useEffect, useRef, useState } from 'react';
import RecorderView from './components/RecorderView';
import EditorView from './components/EditorView';
import type { Recording } from './types';

type View = 'recorder' | 'editor';

export default function App(): JSX.Element {
  const [view, setView] = useState<View>('recorder');
  const [recording, setRecording] = useState<Recording | null>(null);
  const navExtraRef = useRef<HTMLDivElement | null>(null);
  const [navExtraEl, setNavExtraEl] = useState<HTMLDivElement | null>(null);
  const setNavExtra = useCallback((el: HTMLDivElement | null) => {
    navExtraRef.current = el;
    setNavExtraEl(el);
  }, []);

  const handleRecordingDone = useCallback((rec: Recording) => {
    setRecording(rec);
    setView('editor');
    window.klipeHud?.showMain?.();
  }, []);

  const handleNewRecording = useCallback(() => {
    if (recording?.url) URL.revokeObjectURL(recording.url);
    setRecording(null);
    setView('recorder');
    window.klipeHud?.hideMain?.();
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
          <span>Klipe Studio</span>
        </div>
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
          />
        )}
      </main>
    </div>
  );
}
