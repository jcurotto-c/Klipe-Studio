import React, { useState } from 'react';
import BackgroundPanel from './panels/BackgroundPanel.jsx';
import CameraPanel from './panels/CameraPanel.jsx';
import PlaceholderPanel from './panels/PlaceholderPanel.jsx';

const CATEGORIES = [
  { id: 'background', label: 'Background', icon: BackgroundIcon },
  { id: 'cursor', label: 'Cursor', icon: CursorIcon },
  { id: 'camera', label: 'Camera', icon: CameraIcon },
  { id: 'captions', label: 'Captions', icon: CaptionIcon },
  { id: 'audio', label: 'Audio', icon: AudioIcon },
  { id: 'shortcuts', label: 'Shortcuts', icon: ShortcutIcon },
  { id: 'connections', label: 'Connections', icon: LinkIcon }
];

export default function SidebarPanel({
  background,
  onBackgroundChange,
  cameraOptions,
  onCameraOptionsChange,
  cameraAvailable
}) {
  const [activeId, setActiveId] = useState('background');

  const togglePanel = (id) => setActiveId((prev) => (prev === id ? null : id));

  const renderPanel = () => {
    switch (activeId) {
      case 'background':
        return <BackgroundPanel value={background} onChange={onBackgroundChange} />;
      case 'cursor':
        return <PlaceholderPanel title="Cursor" description="Cursor size, smoothing and click effects." />;
      case 'camera':
        return (
          <CameraPanel
            value={cameraOptions}
            onChange={onCameraOptionsChange}
            available={cameraAvailable}
          />
        );
      case 'captions':
        return <PlaceholderPanel title="Captions" description="Auto-generated subtitles and styling." />;
      case 'audio':
        return <PlaceholderPanel title="Audio" description="Volume levels and noise suppression." />;
      case 'shortcuts':
        return <PlaceholderPanel title="Shortcuts" description="Keyboard shortcut overlay during recording." />;
      case 'connections':
        return <PlaceholderPanel title="Connections" description="External integrations and webhooks." />;
      default:
        return null;
    }
  };

  return (
    <div className={`sidebar ${activeId ? 'open' : ''}`}>
      {activeId && <div className="sidebar-content">{renderPanel()}</div>}
      <div className="sidebar-rail">
        {CATEGORIES.map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.id}
              type="button"
              className={`rail-icon ${activeId === c.id ? 'active' : ''}`}
              onClick={() => togglePanel(c.id)}
              title={c.label}
              aria-label={c.label}
              aria-pressed={activeId === c.id}
            >
              <Icon />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BackgroundIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 16l5-5 4 4 3-3 6 6" />
      <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
function CursorIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3l6 16 2-7 7-2z" />
    </svg>
  );
}
function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M22 8l-6 4 6 4V8z" />
    </svg>
  );
}
function CaptionIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a8 8 0 1 1-3-6.2L21 4v6h-6" />
      <path d="M8 13h3M13 13h3" />
    </svg>
  );
}
function AudioIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}
function ShortcutIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6V4a2 2 0 1 0-2 2h2zM15 6V4a2 2 0 1 1 2 2h-2zM9 18v2a2 2 0 1 1-2-2h2zM15 18v2a2 2 0 1 0 2-2h-2z" />
      <rect x="9" y="6" width="6" height="12" />
    </svg>
  );
}
function LinkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}
