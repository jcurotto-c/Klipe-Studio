export interface Display {
  width: number;
  height: number;
  scaleFactor?: number;
}

export interface MouseMoveEvent {
  type: 'move';
  x: number;
  y: number;
  t: number;
}

export interface MouseClickEvent {
  type: 'click';
  x: number;
  y: number;
  t: number;
  button: 'left' | 'right' | 'middle';
}

export interface KeyDownEvent {
  type: 'key';
  t: number;
  code: number;
}

export type KlipeMouseEvent = MouseMoveEvent | MouseClickEvent | KeyDownEvent;

export interface MouseTrack {
  startTime: number;
  events: KlipeMouseEvent[];
}

export interface Vec2 {
  x: number;
  y: number;
}

export type ZoomSource = 'auto' | 'manual';

export interface ZoomSegment {
  id: string;
  source: ZoomSource;
  center: Vec2;
  scale: number;
  tStart: number;
  tEnd: number;
  easeIn: number;
  easeOut: number;
}

export interface ZoomDefaults {
  scale: number;
  duration: number;
  easeIn: number;
  easeOut: number;
}

export interface ZoomSample {
  scale: number;
  cx: number | null;
  cy: number | null;
  p: number;
}

export interface Recording {
  blob: Blob;
  url: string;
  mimeType: string;
  mouse: MouseTrack;
  display: Display;
  autoZoom?: boolean;
  name?: string;
}

export interface Fragment {
  id: string;
  srcStart: number;
  srcEnd: number;
}

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BackgroundWallpaper {
  type: 'wallpaper';
  value: string;
  blur?: number;
}
export interface BackgroundGradient {
  type: 'gradient';
  from: string;
  to: string;
  angle?: number;
  blur?: number;
}
export interface BackgroundColor {
  type: 'color';
  value: string;
  blur?: number;
}
export interface BackgroundImage {
  type: 'image';
  src: string | null;
  blur?: number;
}
export type Background =
  | BackgroundWallpaper
  | BackgroundGradient
  | BackgroundColor
  | BackgroundImage;

export interface FrameOptions {
  shadow: number;
  radius: number;
  padding: number;
  removeBackground: boolean;
}

export type CameraPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface CameraOptions {
  hide: boolean;
  position: CameraPosition;
  mirror: boolean;
  roundness: number;
  size: number;
  zoomDifferent: boolean;
  sizeDuringZoom: number;
}

export type AudioFxMode = 'auto' | 'on' | 'off';

export interface AudioFxOptions {
  clickEnabled: boolean;
  clickVolume: number;
  keyEnabled: boolean;
  keyVolume: number;
  mode: AudioFxMode;
}

export type CursorStyle = 'arrow' | 'arrow-outline' | 'arrow-mini' | 'dot' | 'figma';

export interface CursorOptions {
  show: boolean;
  loop: boolean;
  style: CursorStyle;
  size: number;
  smoothing: number;
  motionBlur: number;
  clickBounce: number;
  bounceSpeed: number;
  sway: number;
}

export interface SpringScalarState {
  value: number;
  velocity: number;
  init: boolean;
}

export interface CursorState {
  sx: SpringScalarState;
  sy: SpringScalarState;
  rot: SpringScalarState;
  lastTms: number | null;
}

export interface CursorSampleVisible {
  visible: true;
  x: number;
  y: number;
  rotation: number;
  scaleMul: number;
  motionAngle: number;
  motionStrength: number;
  sample?: KlipeMouseEvent;
}

export interface CursorSampleHidden {
  visible: false;
}

export type CursorSample = CursorSampleVisible | CursorSampleHidden;

export type ScreenSourceKind = 'screen' | 'window';

export interface ScreenSource {
  id: string;
  name: string;
  display_id: string;
  thumbnail: string;
  kind: ScreenSourceKind;
  width: number;
  height: number;
  scaleFactor: number;
  displayId: string | null;
  primary: boolean;
}

export interface SaveVideoBlobResult {
  canceled: boolean;
  filePath?: string;
}

export interface MouseTrackingStartResult {
  ok: boolean;
  startTime: number;
  alreadyRunning?: boolean;
}

export interface MouseTrackingStopResult {
  ok: boolean;
  startTime?: number;
  notRunning?: boolean;
}

export interface HudState {
  recording?: boolean;
  mode?: string;
}

export type HudEvent =
  | {
      type: 'start-recording';
      sourceId: string;
      micId: string;
      camId: string | null;
      systemAudio: boolean;
      autoZoom: boolean;
      display: Display;
    }
  | { type: 'stop-recording' }
  | { type: 'source-change'; sourceId: string }
  | { type: 'mic-change'; deviceId: string }
  | { type: 'camera-change'; deviceId: string }
  | { type: 'system-audio-change'; enabled: boolean }
  | { type: 'auto-zoom-change'; enabled: boolean };
