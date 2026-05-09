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
    webkitAudioContext?: typeof AudioContext;
  }

  interface KlipeBridge {
    getScreenSources: () => Promise<ScreenSource[]>;
    prepareDisplayMedia?: (sourceId: string) => Promise<{ ok: boolean }>;
    saveVideoBlob: (params: {
      buffer: ArrayBuffer;
      suggestedName: string;
      mimeType: string;
    }) => Promise<SaveVideoBlobResult>;
    startMouseTracking: () => Promise<MouseTrackingStartResult>;
    stopMouseTracking: () => Promise<MouseTrackingStopResult>;
    getPrimaryDisplaySize: () => Promise<Display>;
    focusWindowSource: (sourceId: string) => Promise<{ ok: boolean }>;
    onMouseEvent: (cb: (evt: KlipeMouseEvent) => void) => () => void;
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
    setSize: (width: number, height: number) => void;
    pushState: (payload: HudState) => void;
    onState: (cb: (state: HudState) => void) => () => void;
    onEvent: (cb: (evt: HudEvent) => void) => () => void;
    onClosed: (cb: () => void) => () => void;
  }
}

export {};
