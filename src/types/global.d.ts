import type {
  Display,
  HudEvent,
  HudState,
  KlipeMouseEvent,
  MouseTrackingStartResult,
  MouseTrackingStopResult,
  SaveVideoBlobResult,
  ScreenSource,
} from './index';

declare global {
  interface Window {
    klipe?: KlipeBridge;
    klipeHud?: KlipeHudBridge;
    klipeCameraPreview?: KlipeCameraPreviewBridge;
    webkitAudioContext?: typeof AudioContext;
  }

  interface KlipeCameraPreviewBridge {
    onCommand: (cb: (payload: unknown) => void) => () => void;
  }

  interface AdbDevice {
    serial: string;
    model: string;
    state: 'device' | 'unauthorized' | 'offline' | 'recovery' | 'unknown';
  }

  interface KlipeBridge {
    getScreenSources: () => Promise<ScreenSource[]>;
    prepareDisplayMedia?: (sourceId: string, systemAudio?: boolean) => Promise<{ ok: boolean }>;
    saveVideoBlob: (params: {
      buffer: ArrayBuffer;
      suggestedName: string;
      mimeType: string;
    }) => Promise<SaveVideoBlobResult>;
    startMouseTracking: () => Promise<MouseTrackingStartResult>;
    stopMouseTracking: () => Promise<MouseTrackingStopResult>;
    getPrimaryDisplaySize: () => Promise<Display>;
    focusWindowSource: (sourceId: string) => Promise<{ ok: boolean }>;
    openImageFile: () => Promise<
      | { dataUrl: string; name: string }
      | { error: string }
      | null
    >;
    onMouseEvent: (cb: (evt: KlipeMouseEvent) => void) => () => void;
    /** ADB device enumeration via the bundled adb.exe. */
    adb: {
      listDevices: () => Promise<AdbDevice[]>;
    };
    /** Bundled scrcpy lifecycle for Android phone screen recording. */
    scrcpy: {
      available: () => Promise<boolean>;
      tempPath: () => Promise<string>;
      start: (args: { serial: string; filePath: string }) => Promise<{ ok: boolean; error?: string }>;
      stop: () => Promise<{ filePath: string | null; exitCode: number | null; alreadyExited?: boolean }>;
      read: (filePath: string) => Promise<ArrayBuffer>;
      onDisconnect: (cb: (serial: string) => void) => () => void;
    };
    /** Project (.klipestudio) save/open. */
    project: {
      save: (params: {
        manifestJson: string;
        media: Array<{ name: string; bytes: Uint8Array }>;
        suggestedName: string;
      }) => Promise<{ canceled: boolean; projectPath?: string; error?: string }>;
      saveDoc: (params: {
        projectPath: string;
        manifestJson: string;
        media: Array<{ name: string; bytes: Uint8Array }>;
      }) => Promise<{ ok: boolean; error?: string }>;
      open: () => Promise<
        | { canceled: boolean; manifestJson?: string; media?: Record<string, Uint8Array>; projectPath?: string }
        | null
      >;
      openPath: (projectPath: string) => Promise<
        | { canceled: boolean; manifestJson?: string; media?: Record<string, Uint8Array>; projectPath?: string }
        | null
      >;
    };
    /** Managed recording library under <Videos>/KlipeStudio. */
    library: {
      /** Auto-save a recording into the library (no dialog). */
      save: (params: {
        manifestJson: string;
        media: Array<{ name: string; bytes: Uint8Array }>;
        suggestedName: string;
      }) => Promise<{ ok: boolean; projectPath?: string; error?: string }>;
      /** List every saved recording, newest first. */
      list: () => Promise<LibraryItem[]>;
      /** Permanently delete a project folder (must live inside the library). */
      delete: (projectPath: string) => Promise<{ ok: boolean; error?: string }>;
      /** Reveal a project (or the library root) in the OS file manager. */
      reveal: (projectPath?: string) => Promise<{ ok: boolean }>;
      /** Absolute path of the library root folder. */
      root: () => Promise<string>;
    };
    /** Configurable system-wide shortcuts (re)registered in the main process. */
    shortcuts?: {
      set: (s: GlobalShortcuts) => Promise<{
        ok: boolean;
        shortcuts: GlobalShortcuts;
        results: Array<{ accel: string; ok: boolean }>;
      }>;
      getDefaults: () => Promise<GlobalShortcuts>;
    };
  }

  interface GlobalShortcuts {
    toggleRecord: string;
    toggleHud: string;
  }

  /** One saved recording in the library gallery (lightweight — no video bytes). */
  interface LibraryItem {
    /** Absolute path of the `<name>.klipestudio` folder. */
    projectPath: string;
    name: string;
    /** Epoch ms the project was created/auto-saved. */
    createdAt: number;
    /** Source duration in ms, if it was recorded into the manifest. */
    durationMs: number | null;
    /** Inline JPEG poster (`data:image/jpeg;base64,…`) or null if none. */
    thumbnailDataUrl: string | null;
  }

  interface HudTrigger {
    action: 'toggle-record';
  }

  interface KlipeHudBridge {
    open: () => Promise<{ ok: boolean }>;
    close: () => Promise<{ ok: boolean }>;
    isOpen: () => Promise<boolean>;
    minimize: () => Promise<{ ok: boolean }>;
    show: () => Promise<{ ok: boolean }>;
    quitApp: () => Promise<void>;
    showMain: () => Promise<{ ok: boolean }>;
    hideMain: () => Promise<{ ok: boolean }>;
    moveToDisplay: (displayId: string | number | null) => Promise<{ ok: boolean }>;
    emit: (payload: HudEvent) => void;
    setIgnoreMouse: (ignore: boolean) => void;
    setSize: (width: number, height: number, dy?: number) => void;
    dragBy: (dx: number, dy: number) => void;
    pushState: (payload: HudState) => void;
    onState: (cb: (state: HudState) => void) => () => void;
    onEvent: (cb: (evt: HudEvent) => void) => () => void;
    onClosed: (cb: () => void) => () => void;
    /** Fired by a global shortcut (e.g. toggle recording) from the main process. */
    onTrigger: (cb: (payload: HudTrigger) => void) => () => void;

    cameraPreviewActivate: (deviceId: string) => void;
    cameraPreviewDeactivate: () => void;
    cameraPreviewSetDevice: (deviceId: string) => void;
  }
}

export {};
