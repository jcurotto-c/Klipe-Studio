import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

interface SaveVideoBlobArgs {
  buffer: ArrayBuffer;
  suggestedName: string;
  mimeType: string;
}

contextBridge.exposeInMainWorld('klipe', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  prepareDisplayMedia: (sourceId: string) => ipcRenderer.invoke('prepare-display-media', sourceId),
  saveVideoBlob: ({ buffer, suggestedName, mimeType }: SaveVideoBlobArgs) =>
    ipcRenderer.invoke('save-video-blob', { buffer, suggestedName, mimeType }),
  openImageFile: () => ipcRenderer.invoke('open-image-file'),
  startMouseTracking: () => ipcRenderer.invoke('start-mouse-tracking'),
  stopMouseTracking: () => ipcRenderer.invoke('stop-mouse-tracking'),
  getPrimaryDisplaySize: () => ipcRenderer.invoke('get-primary-display-size'),
  focusWindowSource: (sourceId: string) => ipcRenderer.invoke('focus-window-source', sourceId),
  onMouseEvent: (cb: (payload: unknown) => void) => {
    const listener = (_evt: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('mouse-event', listener);
    return () => ipcRenderer.removeListener('mouse-event', listener);
  },
  adb: {
    listDevices: () => ipcRenderer.invoke('adb:list-devices'),
  },
  scrcpy: {
    available: () => ipcRenderer.invoke('scrcpy:available'),
    tempPath: () => ipcRenderer.invoke('scrcpy:temp-path'),
    start: (args: { serial: string; filePath: string }) => ipcRenderer.invoke('scrcpy:start', args),
    stop: () => ipcRenderer.invoke('scrcpy:stop'),
    read: (filePath: string) => ipcRenderer.invoke('scrcpy:read', filePath),
    onDisconnect: (cb: (serial: string) => void) => {
      const listener = (_evt: IpcRendererEvent, serial: string): void => cb(serial);
      ipcRenderer.on('scrcpy:disconnect', listener);
      return () => ipcRenderer.removeListener('scrcpy:disconnect', listener);
    },
  },
  project: {
    save: (params: {
      manifestJson: string;
      media: Array<{ name: string; bytes: Uint8Array }>;
      suggestedName: string;
    }) => ipcRenderer.invoke('project:save', params),
    open: () => ipcRenderer.invoke('project:open'),
  },
});

contextBridge.exposeInMainWorld('klipeCursorPreview', {
  onPos: (cb: (payload: unknown) => void) => {
    const listener = (_evt: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('cursor-preview:pos', listener);
    return () => ipcRenderer.removeListener('cursor-preview:pos', listener);
  },
  onType: (cb: (payload: unknown) => void) => {
    const listener = (_evt: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('cursor-preview:type', listener);
    return () => ipcRenderer.removeListener('cursor-preview:type', listener);
  },
});

contextBridge.exposeInMainWorld('klipeCameraPreview', {
  onCommand: (cb: (payload: unknown) => void) => {
    const listener = (_evt: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('camera-preview:command', listener);
    return () => ipcRenderer.removeListener('camera-preview:command', listener);
  },
});

contextBridge.exposeInMainWorld('klipeHud', {
  open: () => ipcRenderer.invoke('hud:open'),
  close: () => ipcRenderer.invoke('hud:close'),
  isOpen: () => ipcRenderer.invoke('hud:is-open'),
  minimize: () => ipcRenderer.invoke('hud:minimize'),
  show: () => ipcRenderer.invoke('hud:show'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  showMain: () => ipcRenderer.invoke('main:show'),
  hideMain: () => ipcRenderer.invoke('main:hide'),
  moveToDisplay: (displayId: string | number | null) =>
    ipcRenderer.invoke('hud:move-to-display', displayId),

  emit: (payload: unknown) => ipcRenderer.send('hud:event', payload),

  setIgnoreMouse: (ignore: boolean) => ipcRenderer.send('hud:set-ignore-mouse', ignore),

  setSize: (width: number, height: number, dy?: number) =>
    ipcRenderer.send('hud:set-size', { width, height, dy }),

  dragBy: (dx: number, dy: number) =>
    ipcRenderer.send('hud:drag-by', { dx, dy }),

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

  cameraPreviewActivate: (deviceId: string) =>
    ipcRenderer.send('camera-preview:activate', { deviceId }),
  cameraPreviewDeactivate: () => ipcRenderer.send('camera-preview:deactivate'),
  cameraPreviewSetDevice: (deviceId: string) =>
    ipcRenderer.send('camera-preview:set-device', { deviceId }),
});
