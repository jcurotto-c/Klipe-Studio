import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

interface SaveVideoBlobArgs {
  buffer: ArrayBuffer;
  suggestedName: string;
  mimeType: string;
}

contextBridge.exposeInMainWorld('klipe', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  saveVideoBlob: ({ buffer, suggestedName, mimeType }: SaveVideoBlobArgs) =>
    ipcRenderer.invoke('save-video-blob', { buffer, suggestedName, mimeType }),
  startMouseTracking: () => ipcRenderer.invoke('start-mouse-tracking'),
  stopMouseTracking: () => ipcRenderer.invoke('stop-mouse-tracking'),
  getPrimaryDisplaySize: () => ipcRenderer.invoke('get-primary-display-size'),
  onMouseEvent: (cb: (payload: unknown) => void) => {
    const listener = (_evt: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('mouse-event', listener);
    return () => ipcRenderer.removeListener('mouse-event', listener);
  },
});

contextBridge.exposeInMainWorld('klipeHud', {
  open: () => ipcRenderer.invoke('hud:open'),
  close: () => ipcRenderer.invoke('hud:close'),
  isOpen: () => ipcRenderer.invoke('hud:is-open'),

  emit: (payload: unknown) => ipcRenderer.send('hud:event', payload),

  setIgnoreMouse: (ignore: boolean) => ipcRenderer.send('hud:set-ignore-mouse', ignore),

  setSize: (width: number, height: number) =>
    ipcRenderer.send('hud:set-size', { width, height }),

  pushState: (payload: unknown) => ipcRenderer.send('hud:push-state', payload),

  onState: (cb: (payload: unknown) => void) => {
    const listener = (_evt: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('hud:state', listener);
    return () => ipcRenderer.removeListener('hud:state', listener);
  },

  onEvent: (cb: (payload: unknown) => void) => {
    const listener = (_evt: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('hud:event', listener);
    return () => ipcRenderer.removeListener('hud:event', listener);
  },

  onClosed: (cb: () => void) => {
    const listener = (): void => cb();
    ipcRenderer.on('hud:closed', listener);
    return () => ipcRenderer.removeListener('hud:closed', listener);
  },
});
