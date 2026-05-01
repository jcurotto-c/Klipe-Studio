const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('klipe', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  saveVideoBlob: ({ buffer, suggestedName, mimeType }) =>
    ipcRenderer.invoke('save-video-blob', { buffer, suggestedName, mimeType }),
  startMouseTracking: () => ipcRenderer.invoke('start-mouse-tracking'),
  stopMouseTracking: () => ipcRenderer.invoke('stop-mouse-tracking'),
  getPrimaryDisplaySize: () => ipcRenderer.invoke('get-primary-display-size'),
  onMouseEvent: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('mouse-event', listener);
    return () => ipcRenderer.removeListener('mouse-event', listener);
  }
});
