import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

interface SaveVideoBlobArgs {
  buffer: ArrayBuffer;
  suggestedName: string;
  mimeType: string;
}

contextBridge.exposeInMainWorld('klipe', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  startAreaSelect: () => ipcRenderer.invoke('area-select:start'),
  prepareDisplayMedia: (sourceId: string, systemAudio?: boolean) =>
    ipcRenderer.invoke('prepare-display-media', sourceId, systemAudio),
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
    saveDoc: (params: {
      projectPath: string;
      manifestJson: string;
      media: Array<{ name: string; bytes: Uint8Array }>;
    }) => ipcRenderer.invoke('project:save-doc', params),
    open: () => ipcRenderer.invoke('project:open'),
    openPath: (projectPath: string) => ipcRenderer.invoke('project:open-path', projectPath),
  },
  library: {
    save: (params: {
      manifestJson: string;
      media: Array<{ name: string; bytes: Uint8Array }>;
      suggestedName: string;
    }) => ipcRenderer.invoke('library:save', params),
    list: () => ipcRenderer.invoke('library:list'),
    delete: (projectPath: string) => ipcRenderer.invoke('library:delete', projectPath),
    reveal: (projectPath?: string) => ipcRenderer.invoke('library:reveal', projectPath),
    root: () => ipcRenderer.invoke('library:root'),
  },
  shortcuts: {
    set: (s: { toggleRecord: string; toggleHud: string }) => ipcRenderer.invoke('shortcuts:set', s),
    getDefaults: () => ipcRenderer.invoke('shortcuts:get-defaults'),
  },
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  getVersion: () => ipcRenderer.invoke('app:version'),
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

contextBridge.exposeInMainWorld('klipeUpdater', {
  onStatus: (cb: (payload: unknown) => void) => {
    const listener = (_evt: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
  quitAndInstall: () => ipcRenderer.invoke('update:quit-and-install'),
});

contextBridge.exposeInMainWorld('klipeCameraPreview', {
  onCommand: (cb: (payload: unknown) => void) => {
    const listener = (_evt: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('camera-preview:command', listener);
    return () => ipcRenderer.removeListener('camera-preview:command', listener);
  },
});

contextBridge.exposeInMainWorld('klipeAreaSelect', {
  onInit: (cb: (payload: unknown) => void) => {
    const listener = (_evt: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('area-select:init', listener);
    return () => ipcRenderer.removeListener('area-select:init', listener);
  },
  submit: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('area-select:submit', rect),
  cancel: () => ipcRenderer.send('area-select:cancel'),
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

  onTrigger: (cb: (payload: unknown) => void) => {
    const listener = (_evt: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('hud:trigger', listener);
    return () => ipcRenderer.removeListener('hud:trigger', listener);
  },

  cameraPreviewActivate: (deviceId: string) =>
    ipcRenderer.send('camera-preview:activate', { deviceId }),
  cameraPreviewDeactivate: () => ipcRenderer.send('camera-preview:deactivate'),
  cameraPreviewSetDevice: (deviceId: string) =>
    ipcRenderer.send('camera-preview:set-device', { deviceId }),
});
