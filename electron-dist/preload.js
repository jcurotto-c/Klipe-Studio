"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('klipe', {
    getScreenSources: () => electron_1.ipcRenderer.invoke('get-screen-sources'),
    prepareDisplayMedia: (sourceId) => electron_1.ipcRenderer.invoke('prepare-display-media', sourceId),
    saveVideoBlob: ({ buffer, suggestedName, mimeType }) => electron_1.ipcRenderer.invoke('save-video-blob', { buffer, suggestedName, mimeType }),
    openImageFile: () => electron_1.ipcRenderer.invoke('open-image-file'),
    startMouseTracking: () => electron_1.ipcRenderer.invoke('start-mouse-tracking'),
    stopMouseTracking: () => electron_1.ipcRenderer.invoke('stop-mouse-tracking'),
    getPrimaryDisplaySize: () => electron_1.ipcRenderer.invoke('get-primary-display-size'),
    focusWindowSource: (sourceId) => electron_1.ipcRenderer.invoke('focus-window-source', sourceId),
    onMouseEvent: (cb) => {
        const listener = (_evt, payload) => cb(payload);
        electron_1.ipcRenderer.on('mouse-event', listener);
        return () => electron_1.ipcRenderer.removeListener('mouse-event', listener);
    },
    adb: {
        listDevices: () => electron_1.ipcRenderer.invoke('adb:list-devices'),
    },
    scrcpy: {
        available: () => electron_1.ipcRenderer.invoke('scrcpy:available'),
        tempPath: () => electron_1.ipcRenderer.invoke('scrcpy:temp-path'),
        start: (args) => electron_1.ipcRenderer.invoke('scrcpy:start', args),
        stop: () => electron_1.ipcRenderer.invoke('scrcpy:stop'),
        read: (filePath) => electron_1.ipcRenderer.invoke('scrcpy:read', filePath),
        onDisconnect: (cb) => {
            const listener = (_evt, serial) => cb(serial);
            electron_1.ipcRenderer.on('scrcpy:disconnect', listener);
            return () => electron_1.ipcRenderer.removeListener('scrcpy:disconnect', listener);
        },
    },
});
electron_1.contextBridge.exposeInMainWorld('klipeCursorPreview', {
    onPos: (cb) => {
        const listener = (_evt, payload) => cb(payload);
        electron_1.ipcRenderer.on('cursor-preview:pos', listener);
        return () => electron_1.ipcRenderer.removeListener('cursor-preview:pos', listener);
    },
    onType: (cb) => {
        const listener = (_evt, payload) => cb(payload);
        electron_1.ipcRenderer.on('cursor-preview:type', listener);
        return () => electron_1.ipcRenderer.removeListener('cursor-preview:type', listener);
    },
});
electron_1.contextBridge.exposeInMainWorld('klipeCameraPreview', {
    onCommand: (cb) => {
        const listener = (_evt, payload) => cb(payload);
        electron_1.ipcRenderer.on('camera-preview:command', listener);
        return () => electron_1.ipcRenderer.removeListener('camera-preview:command', listener);
    },
});
electron_1.contextBridge.exposeInMainWorld('klipeHud', {
    open: () => electron_1.ipcRenderer.invoke('hud:open'),
    close: () => electron_1.ipcRenderer.invoke('hud:close'),
    isOpen: () => electron_1.ipcRenderer.invoke('hud:is-open'),
    minimize: () => electron_1.ipcRenderer.invoke('hud:minimize'),
    show: () => electron_1.ipcRenderer.invoke('hud:show'),
    quitApp: () => electron_1.ipcRenderer.invoke('app:quit'),
    showMain: () => electron_1.ipcRenderer.invoke('main:show'),
    hideMain: () => electron_1.ipcRenderer.invoke('main:hide'),
    moveToDisplay: (displayId) => electron_1.ipcRenderer.invoke('hud:move-to-display', displayId),
    emit: (payload) => electron_1.ipcRenderer.send('hud:event', payload),
    setIgnoreMouse: (ignore) => electron_1.ipcRenderer.send('hud:set-ignore-mouse', ignore),
    setSize: (width, height, dy) => electron_1.ipcRenderer.send('hud:set-size', { width, height, dy }),
    dragBy: (dx, dy) => electron_1.ipcRenderer.send('hud:drag-by', { dx, dy }),
    pushState: (payload) => electron_1.ipcRenderer.send('hud:push-state', payload),
    onState: (cb) => {
        const listener = (_evt, payload) => cb(payload);
        electron_1.ipcRenderer.on('hud:state', listener);
        return () => electron_1.ipcRenderer.removeListener('hud:state', listener);
    },
    onEvent: (cb) => {
        const listener = (_evt, payload) => cb(payload);
        electron_1.ipcRenderer.on('hud:event', listener);
        return () => electron_1.ipcRenderer.removeListener('hud:event', listener);
    },
    onClosed: (cb) => {
        const listener = () => cb();
        electron_1.ipcRenderer.on('hud:closed', listener);
        return () => electron_1.ipcRenderer.removeListener('hud:closed', listener);
    },
    cameraPreviewActivate: (deviceId) => electron_1.ipcRenderer.send('camera-preview:activate', { deviceId }),
    cameraPreviewDeactivate: () => electron_1.ipcRenderer.send('camera-preview:deactivate'),
    cameraPreviewSetDevice: (deviceId) => electron_1.ipcRenderer.send('camera-preview:set-device', { deviceId }),
});
//# sourceMappingURL=preload.js.map