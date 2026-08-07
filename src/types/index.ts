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

export type CursorType =
  | 'arrow'
  | 'text'
  | 'pointer'
  | 'crosshair'
  | 'open-hand'
  | 'closed-hand'
  | 'resize-ew'
  | 'resize-ns'
  | 'move'
  | 'not-allowed';

export interface CursorTypeEvent {
  type: 'cursorType';
  t: number;
  cursorType: CursorType;
}

export type KlipeMouseEvent =
  | MouseMoveEvent
  | MouseClickEvent
  | KeyDownEvent
  | CursorTypeEvent;

export interface MouseTrack {
  startTime: number;
  events: KlipeMouseEvent[];
}

export interface Vec2 {
  x: number;
  y: number;
}

export type ZoomSource = 'auto' | 'manual';

/**
 * Easing curve applied to a zoom segment's ease-in/ease-out windows.
 *   - `spring`     — closed-form damped spring (the original/default look)
 *   - `ease`       — easeInOutCubic, clean with no overshoot (keynote feel)
 *   - `snap`       — easeOutBack, brief overshoot then settle (energetic)
 *   - `linear`     — constant rate (mechanical/technical)
 *   - `anticipate` — easeInBack, slight pull-back before moving (dramatic)
 * Absent → treated as `spring` so legacy segments keep their look.
 */
export type ZoomEasing = 'spring' | 'ease' | 'snap' | 'linear' | 'anticipate';

/**
 * Cursor-follow camera behaviour during an active zoom.
 *   - `static`   — camera holds the configured focus, never pans
 *   - `follow`   — safe-zone follow (the original/default behaviour)
 *   - `cinematic`— floatier springs, stronger look-ahead + rest-zoom
 */
export type CameraFollowStyle = 'static' | 'follow' | 'cinematic';

export interface ZoomSegment {
  id: string;
  source: ZoomSource;
  center: Vec2;
  scale: number;
  tStart: number;
  tEnd: number;
  easeIn: number;
  easeOut: number;
  /** Easing curve for this segment's transitions. Absent → `spring`. */
  easing?: ZoomEasing;
}

export interface ZoomDefaults {
  scale: number;
  duration: number;
  easeIn: number;
  easeOut: number;
  /** Default easing for newly created segments. Absent → `spring`. */
  easing?: ZoomEasing;
  /** Camera-follow behaviour during zoom. Absent → `follow`. */
  cameraStyle?: CameraFollowStyle;
  /** Zoom-transition motion blur intensity, 0..1. Absent/0 → off. */
  zoomBlur?: number;
}

export interface ZoomSample {
  scale: number;
  cx: number | null;
  cy: number | null;
  p: number;
}

export interface RecordingCamera {
  blob: Blob;
  url: string;
  mimeType: string;
}

export interface RecordingMobile {
  blob: Blob;
  url: string;
  mimeType: string;
}

/** A standalone recorded audio track (microphone or system/desktop audio). */
export interface RecordingAudio {
  blob: Blob;
  url: string;
  mimeType: string;
}

export interface Recording {
  blob: Blob;
  url: string;
  mimeType: string;
  mouse: MouseTrack;
  display: Display;
  /**
   * Normalized region crop {x,y,w,h} captured via "Area" mode — the editor
   * pre-applies this crop. Null/absent = full frame (normal Display/Window).
   */
  areaCrop?: Crop | null;
  autoZoom?: boolean;
  name?: string;
  /** Whether the recording captured any audio track (mic and/or system). */
  hasAudio?: boolean;
  /**
   * Whether the mic / system audio were REQUESTED at record time (their toggles
   * were on). The editor warns only when a requested source failed to capture,
   * so an intentionally-silent recording never raises a false alarm. Absent on
   * recordings loaded from disk — a re-opened project shows no audio warning.
   */
  micRequested?: boolean;
  systemAudioRequested?: boolean;
  /**
   * Microphone and system audio recorded as SEPARATE tracks so the editor can
   * balance them independently. Absent on legacy recordings, where the audio is
   * baked into the screen blob and controlled only by the master volume.
   */
  micAudio?: RecordingAudio | null;
  systemAudio?: RecordingAudio | null;
  /**
   * Recorded camera footage captured alongside the screen. The editor plays
   * this back through cameraVideoRef instead of opening a live stream, so
   * the in-editor camera matches what was actually recorded — and the user
   * can still move/resize/restyle it via cameraOptions.
   */
  camera?: RecordingCamera | null;
  /**
   * Recorded mobile (phone) footage captured alongside the screen. Same
   * pattern as `camera`, but rendered inside a virtual iPhone frame at
   * draw time. The phone source is acquired through the MobileSessionBackend
   * abstraction so future QR/WebRTC pairing can replace the v1 local-device
   * picker without touching the recording pipeline.
   */
  mobile?: RecordingMobile | null;
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

/**
 * Result of an "Area" selection: the screen source to record plus the
 * normalized crop within that display. Returned by window.klipe.startAreaSelect().
 */
export interface AreaSelectResult {
  sourceId: string;
  displayId: string;
  crop: Crop;
  display: Display;
}

/**
 * How a recording is fitted into a chosen output aspect that differs from the
 * source aspect:
 *   - 'fit'  → the WHOLE frame is shown (contain), centered and inset, with the
 *              user's chosen background filling the surrounding space.
 *   - 'fill' → the source is cover-cropped to fill the frame; the long axis is
 *              center-cropped.
 * Has no effect when the output aspect matches the source aspect.
 */
export type FitMode = 'fit' | 'fill';

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
/**
 * Looping video background. `src` is a volatile object URL (a `blob:` ref to the
 * picked file in-session, or rebuilt from disk bytes on reopen) — NOT inlined.
 * The clip's bytes persist as a separate project media file (`bgvideo.<ext>`)
 * and `src` is stripped on save, mirroring `BackgroundMusic`, so a multi-MB clip
 * never bloats project.json or its re-serialization on every autosave.
 *
 * The clip is drawn cover-fit behind the recording, muted and looped. In the
 * live preview a single shared <video> element (renderer-owned) drives it; the
 * export decodes the same source via Mediabunny and samples the frame for each
 * output time so the bake is deterministic.
 */
export interface BackgroundVideo {
  type: 'video';
  src: string | null;
  blur?: number;
}
export type Background =
  | BackgroundWallpaper
  | BackgroundGradient
  | BackgroundColor
  | BackgroundImage
  | BackgroundVideo;

/**
 * Fake OS window drawn around the recording.
 *   - `none`    — no chrome (default)
 *   - `macos`   — title bar with the red/yellow/green traffic lights
 *   - `browser` — Safari-like toolbar with a centred address field
 *   - `windows` — Windows 11 title bar, caption glyphs on the right
 */
export type WindowChromeStyle = 'none' | 'macos' | 'browser' | 'windows';

export type WindowChromeTheme = 'dark' | 'light';

export interface WindowChromeOptions {
  style: WindowChromeStyle;
  theme: WindowChromeTheme;
  /** Centred in the title bar. Empty ⇒ buttons only. Unused by `browser`. */
  title: string;
  /** Address-bar text, `browser` only. Empty ⇒ an empty address bar. */
  url?: string;
}

export interface FrameOptions {
  shadow: number;
  radius: number;
  padding: number;
  removeBackground: boolean;
  /**
   * Window chrome around the video. Absent ⇒ no chrome, so projects and
   * localStorage blobs written before this feature load unchanged.
   *
   * Never read its members directly: the `{ ...DEFAULT_FRAME_OPTIONS, ...frame }`
   * merges in the renderer and in EditorView are SHALLOW, so a partially written
   * object survives them intact. Always normalize through `resolveWindowChrome()`
   * (lib/window-chrome), and always WRITE a complete object.
   */
  window?: WindowChromeOptions;
}

export type CameraPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

/**
 * Footprint of the camera overlay.
 *   - `circle` — square footprint (1:1); at full roundness, a perfect circle
 *   - `card`   — landscape rounded rectangle (3:2)
 *   - `pill`   — wide capsule (5:2)
 * `roundness` still controls the corner radius; `shape` only sets the
 * width:height aspect. Absent → `circle` (the legacy square footprint), so
 * existing recordings render unchanged.
 */
export type CameraShape = 'circle' | 'card' | 'pill';

/**
 * Replaced background for the webcam disc. Editor-only (preview + export): the
 * camera is always recorded raw, so this is non-destructive — switch or clear
 * it any time without touching the recording. The floating disc shown *during*
 * capture is unaffected.
 *   - `none`  — the raw camera, real background (default; absent ⇒ none)
 *   - `blur`  — the person's real background, blurred; `amount` 0..100
 *   - `image` — a cover-fit image behind the person; `src` is a preset path
 *               (`./wallpapers/x.png`) or a downscaled data URL (user upload)
 */
export type CameraBackground =
  | { type: 'none' }
  | { type: 'blur'; amount: number }
  | { type: 'image'; src: string | null };

export interface CameraOptions {
  hide: boolean;
  position: CameraPosition;
  mirror: boolean;
  roundness: number;
  size: number;
  /** Footprint shape. Absent → `circle` (back-compat). */
  shape?: CameraShape;
  zoomDifferent: boolean;
  sizeDuringZoom: number;
  /** Background replacement. Absent → `none` (back-compat with saved projects). */
  background?: CameraBackground;
}

/**
 * Phone placement. Same 8 edge/corner anchors as the camera, plus `middle-center`
 * — the phone, unlike the webcam disc, is usually the recording's subject and so
 * sits dead-center by default.
 */
export type MobilePosition = CameraPosition | 'middle-center';

export type MobileFinish = 'graphite' | 'silver' | 'gold' | 'black';

/**
 * Phone chassis design. Drives body aspect, corner radius, bezel, camera cutout
 * and side-button layout — see the device specs in lib/mobile-frame.
 */
export type MobileDeviceId = 'iphone-island' | 'iphone-notch' | 'samsung-galaxy';

export interface MobileOptions {
  hide: boolean;
  position: MobilePosition;
  /** Phone height as % of canvas height (40..100). Width follows the device aspect. */
  size: number;
  /** Legacy overlay field — kept for back-compat; primary mode zooms via segments. */
  sizeDuringZoom: number;
  /** Legacy overlay field — kept for back-compat. */
  zoomDifferent: boolean;
  /** Tilt in degrees (-10..+10). Side buttons are skipped when tilt !== 0. */
  tilt: number;
  /**
   * Legacy: when false, drew a classic notch instead of a dynamic island. The
   * cutout is now derived from `device`; kept only to migrate old recordings.
   */
  showIsland: boolean;
  /** Phone chassis design (iPhone Dynamic Island / iPhone notch / Samsung). */
  device: MobileDeviceId;
  /** Bezel color treatment. */
  finish: MobileFinish;
  /**
   * Settings schema version. Older/absent versions had different (or no-op)
   * position/size semantics, so those fields get reset to defaults on load.
   */
  v?: number;
}

export type AudioFxMode = 'auto' | 'on' | 'off';

export interface AudioFxOptions {
  clickEnabled: boolean;
  clickVolume: number;
  keyEnabled: boolean;
  keyVolume: number;
  mode: AudioFxMode;
}

// Session-only: src is an in-memory object URL (not persisted across reloads).
// startMs/endMs delimit the OUTPUT-time window the music plays in;
// outside that window the music is silent. durationMs is the source's
// natural length, populated when audio metadata loads (0 until then).
// sourceStartMs is the position WITHIN the source file the block plays
// from — lets the user pick a chorus or outro instead of always starting
// from 0:00. The source loops if the window outlasts (durationMs - sourceStartMs).
export interface BackgroundMusic {
  name: string;
  src: string;
  volume: number;
  fadeMs: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  sourceStartMs: number;
  /**
   * Play the music continuously across intro/outro/mid-roll cards (a soundtrack
   * for the whole video) instead of going silent during them. The body-time
   * window still trims it; reaching the body start/end extends it over the
   * intro/outro. Absent → treated as true. The recording's own audio always
   * pauses during cards.
   */
  overCards?: boolean;
}

export type BlurStyle = 'gaussian' | 'pixelate';
export type BlurShape = 'rect' | 'ellipse';

/**
 * One blur keyframe. Position/size are normalized to the FULL source frame
 * ([0,1] of source width/height), so regions survive crop and aspect-ratio
 * changes — the renderer maps them through the active crop at draw time.
 * `tMs` is source time (same convention as ZoomSegment.tStart/tEnd).
 */
export interface BlurKeyframe {
  tMs: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlurRegion {
  id: string;
  /** Active time window in source time (ms). */
  tStart: number;
  tEnd: number;
  style: BlurStyle;
  shape: BlurShape;
  /** 0..100 — controls Gaussian blur radius or pixelation block size. */
  strength: number;
  /**
   * Position/size over time. Always non-empty. One keyframe = static; two or
   * more = linear interpolation by source time, clamped at the endpoints.
   */
  keyframes: BlurKeyframe[];
}

export interface BlurSampleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BuiltInCursorStyle = 'arrow' | 'arrow-outline' | 'arrow-mini' | 'dot' | 'figma';

/** The user-selectable cursor style. */
export type CursorStyle = BuiltInCursorStyle;

/**
 * Movement "personality" of the cursor — selects the spring family the
 * smoothing slider then tunes within.
 *   - `raw`      — 1:1 with telemetry, no lag
 *   - `smooth`   — balanced spring (the original/default feel)
 *   - `glide`    — soft, floaty spring with a longer trail
 *   - `snappy`   — stiff, lightly under-damped spring (brief overshoot)
 *   - `magnetic` — eases & settles as it approaches click points
 * Absent → treated as `smooth` so legacy cursor options keep their look.
 */
export type CursorMovement = 'raw' | 'smooth' | 'glide' | 'snappy' | 'magnetic';

export interface CursorOptions {
  show: boolean;
  loop: boolean;
  style: CursorStyle;
  /** Movement personality. Absent → `smooth` (back-compat). */
  movement?: CursorMovement;
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
      mobileId: string | null;
      autoZoom: boolean;
      systemAudio: boolean;
      display: Display;
      /** Normalized region crop when recording was started in "Area" mode. */
      areaCrop?: Crop | null;
    }
  | { type: 'stop-recording' }
  | { type: 'source-change'; sourceId: string }
  | { type: 'mic-change'; deviceId: string }
  | { type: 'camera-change'; deviceId: string }
  | { type: 'mobile-change'; deviceId: string | null }
  | { type: 'auto-zoom-change'; enabled: boolean };
