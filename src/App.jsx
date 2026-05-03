import React, { useCallback, useRef, useState } from 'react';
import RecorderView from './components/RecorderView.jsx';
import EditorView from './components/EditorView.jsx';

export default function App() {
  const [view, setView] = useState('recorder');
  const [recording, setRecording] = useState(null);
  const navExtraRef = useRef(null);
  const [navExtraEl, setNavExtraEl] = useState(null);
  const setNavExtra = useCallback((el) => {
    navExtraRef.current = el;
    setNavExtraEl(el);
  }, []);

  const handleRecordingDone = useCallback((rec) => {
    setRecording(rec);
    setView('editor');
  }, []);

  const handleNewRecording = useCallback(() => {
    if (recording?.url) URL.revokeObjectURL(recording.url);
    setRecording(null);
    setView('recorder');
  }, [recording]);

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
