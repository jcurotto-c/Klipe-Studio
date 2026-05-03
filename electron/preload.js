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

contextBridge.exposeInMainWorld('klipeHud', {
  // Window control
  open: () => ipcRenderer.invoke('hud:open'),
  close: () => ipcRenderer.invoke('hud:close'),
  isOpen: () => ipcRenderer.invoke('hud:is-open'),

  // HUD → main app: emit a state-change/action event
  emit: (payload) => ipcRenderer.send('hud:event', payload),

  // Toggle whether the HUD window forwards mouse events through its
  // transparent area (true = pass-through, false = capture clicks).
  setIgnoreMouse: (ignore) => ipcRenderer.send('hud:set-ignore-mouse', ignore),

  // Resize the HUD window to fit its current content (bar + open menu).
  setSize: (width, height) => ipcRenderer.send('hud:set-size', { width, height }),

  // Main app → HUD: push state down to the HUD
  pushState: (payload) => ipcRenderer.send('hud:push-state', payload),

  // HUD subscribes to state pushed from the main app
  onState: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('hud:state', listener);
    return () => ipcRenderer.removeListener('hud:state', listener);
  },

  // Main app subscribes to events from the HUD
  onEvent: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('hud:event', listener);
    return () => ipcRenderer.removeListener('hud:event', listener);
  },

  onClosed: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('hud:closed', listener);
    return () => ipcRenderer.removeListener('hud:closed', listener);
  }
});
