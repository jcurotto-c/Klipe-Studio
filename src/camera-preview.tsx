import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CameraPreview from './components/CameraPreview';
import './components/FloatingHUD.css';

interface CameraPreviewCommand {
  type: 'activate' | 'deactivate' | 'set-device';
  deviceId?: string;
}

/**
 * Window-level controller for the floating camera disc. Translates IPC
 * commands from the HUD into the props CameraPreview consumes, keeping all
 * stream + animation logic inside that component.
 */
function CameraPreviewWindow(): JSX.Element {
  const [active, setActive] = useState(false);
  const [deviceId, setDeviceId] = useState('');

  useEffect(() => {
    const bridge = window.klipeCameraPreview;
    if (!bridge) return;
    return bridge.onCommand((cmd) => {
      if (!cmd || typeof cmd !== 'object') return;
      const c = cmd as CameraPreviewCommand;
      switch (c.type) {
        case 'activate':
          if (typeof c.deviceId === 'string') setDeviceId(c.deviceId);
          setActive(true);
          break;
        case 'deactivate':
          setActive(false);
          break;
        case 'set-device':
          if (typeof c.deviceId === 'string') setDeviceId(c.deviceId);
          break;
      }
    });
  }, []);

  return (
    <div className="camera-preview-host">
      <CameraPreview active={active} deviceId={deviceId} />
    </div>
  );
}

const container = document.getElementById('camera-preview-root');
if (!container) throw new Error('#camera-preview-root element not found');
createRoot(container).render(<CameraPreviewWindow />);
