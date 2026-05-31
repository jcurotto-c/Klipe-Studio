import {
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';
import { renderFrame, computeFramePaddingScale, type CursorPlacement } from '../lib/renderer';
import { createCursorState, resetCursorState } from '../lib/cursor-engine';
import {
  createCursorFollowState,
  resetCursorFollowState,
  resolveCameraFollow,
} from '../lib/cursor-follow-camera';
import { PixiCursorOverlay } from '../lib/cursor-overlay';
import CropOverlay from './CropOverlay';
import BlurOverlay from './BlurOverlay';
import OverlayCanvas from '../overlays/OverlayCanvas';
import PlatformGuides from './PlatformGuides';
import type { SafeZones } from '../lib/platforms';
import type {
  Background,
  BlurRegion,
  BlurSampleRect,
  CameraFollowStyle,
  CameraOptions,
  Crop,
  CursorOptions,
  Display,
  FrameOptions,
  MobileOptions,
  MouseTrack,
  ZoomSegment,
} from '../types';
import type { Overlay } from '../overlays/types';

interface VideoCanvasProps {
  videoRef: RefObject<HTMLVideoElement>;
  segments: ZoomSegment[];
  mouse: MouseTrack;
  display: Display;
  background?: Background | string;
  width?: number;
  height?: number;
  crop?: Crop | null;
  cropMode?: boolean;
  onCropChange?: (next: Crop) => void;
  cameraVideoRef?: RefObject<HTMLVideoElement> | null;
  cameraOptions?: CameraOptions | null;
  mobileVideoRef?: RefObject<HTMLVideoElement> | null;
  mobileOptions?: MobileOptions | null;
  /**
   * When true, the phone is the recording's primary subject — the renderer
   * skips the screen source and draws the phone centered + large.
   */
  mobilePrimary?: boolean;
  cursorOptions?: CursorOptions | null;
  /** Camera-follow behaviour during zoom. Absent → `follow`. */
  cameraStyle?: CameraFollowStyle | null;
  /** Zoom-transition motion blur intensity 0..1. Absent/0 → off. */
  zoomBlur?: number | null;
  /**
   * Whether playback is running. While playing we hide the real OS cursor
   * over the preview so only the rendered (smoothed) cursor is visible —
   * otherwise you'd see two cursors (your mouse + the rendered one).
   */
  playing?: boolean;
  /**
   * When true, the preview render loop is suspended — no requestAnimationFrame,
   * no per-frame renderFrame. Set while exporting so the on-screen preview stops
   * competing with the export pipeline for the main thread + GPU. Without this
   * the export crawls and stutters whenever the window is focused (the rAF loop
   * only ticks while the window is visible) and only runs at full speed when the
   * window is backgrounded — exactly the "freezes when I watch it" symptom.
   */
  suspended?: boolean;
  frameOptions?: FrameOptions | null;
  /** Output aspect ratio (w/h). When null/undefined, falls back to source display ratio. */
  aspectRatio?: number | null;
  /** Platform safe-zone guides to draw over the preview (editing aid only). */
  safeZones?: SafeZones | null;
  /** Blur regions to bake into the preview AND the export. */
  blurRegions?: BlurRegion[];
  /** When true, the blur overlay is interactive (draw/move/resize). */
  blurMode?: boolean;
  selectedBlurId?: string | null;
  /** Current playhead position in source-time milliseconds, for overlay sampling. */
  currentSrcMs?: number;
  onSelectBlur?: (id: string | null) => void;
  onDragBlurRect?: (id: string, rect: BlurSampleRect) => void;
  onCommitBlurRect?: (id: string) => void;
  onCreateBlur?: (rect: BlurSampleRect) => void;
  /** Text/image overlay layers drawn on top of the video composition. */
  overlays?: Overlay[];
  /** Current output-time in ms; drives overlay keyframe sampling. */
  overlayTimeMs?: number;
  /** Currently-selected overlay id. */
  selectedOverlayId?: string | null;
  onSelectOverlay?: (id: string | null) => void;
  /** Called while an overlay is being dragged. Coordinates are fractional. */
  onMoveOverlay?: (id: string, base: { x: number; y: number }) => void;
}

export default function VideoCanvas({
  videoRef,
  segments,
  mouse,
  display,
  background = 'default',
  crop = null,
  cropMode = false,
  onCropChange,
  cameraVideoRef = null,
  cameraOptions = null,
  mobileVideoRef = null,
  mobileOptions = null,
  mobilePrimary = false,
  cursorOptions = null,
  cameraStyle = null,
  zoomBlur = null,
  playing = false,
  suspended = false,
  frameOptions = null,
  aspectRatio = null,
  safeZones = null,
  blurRegions,
  blurMode = false,
  selectedBlurId = null,
  currentSrcMs = 0,
  onSelectBlur,
  onDragBlurRect,
  onCommitBlurRect,
  onCreateBlur,
  overlays,
  overlayTimeMs = 0,
  selectedOverlayId = null,
  onSelectOverlay,
  onMoveOverlay,
}: VideoCanvasProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const cursorStateRef = useRef(createCursorState());
  const followStateRef = useRef(createCursorFollowState());
  const overlayRef = useRef<PixiCursorOverlay | null>(null);
  const cursorOutputRef = useRef<CursorPlacement>({
    visible: false, px: 0, py: 0, r: 0, rotation: 0, motionAngle: 0, motionStrength: 0,
    shape: 'arrow', contentTargetHeight: 0,
  });
  const propsRef = useRef({
    segments, mouse, display, background, crop, cropMode, cameraOptions, mobileOptions, mobilePrimary, cursorOptions, cameraStyle, zoomBlur, frameOptions, blurRegions,
  });
  propsRef.current = {
    segments, mouse, display, background, crop, cropMode, cameraOptions, mobileOptions, mobilePrimary, cursorOptions, cameraStyle, zoomBlur, frameOptions, blurRegions,
  };

  useEffect(() => {
    resetCursorState(cursorStateRef.current);
    resetCursorFollowState(followStateRef.current);
  }, [mouse]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const parent = wrap.parentElement;
    if (!parent) return;

    const apply = (): void => {
      const sourceW = display?.width || 1920;
      const sourceH = display?.height || 1080;
      const ratio =
        aspectRatio && isFinite(aspectRatio) && aspectRatio > 0
          ? aspectRatio
          : sourceW / sourceH;
      const parentRect = parent.getBoundingClientRect();
      const pw = parentRect.width;
      const ph = parentRect.height;
      if (pw <= 0 || ph <= 0) return;

      let w = pw;
      let h = pw / ratio;
      if (h > ph) {
        h = ph;
        w = ph * ratio;
      }
      wrap.style.width = `${w}px`;
      wrap.style.height = `${h}px`;

      const dpr = window.devicePixelRatio || 1;
      const cw = Math.max(1, Math.round(w * dpr));
      const ch = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;
      overlayRef.current?.resize(cw, ch);
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(parent);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [display?.width, display?.height, aspectRatio]);

  // Attach the PixiJS cursor overlay once, after the overlay canvas exists.
  useEffect(() => {
    const overlayCanvas = overlayCanvasRef.current;
    const baseCanvas = canvasRef.current;
    if (!overlayCanvas || !baseCanvas) return;
    let cancelled = false;
    const overlay = new PixiCursorOverlay({ motionBlurEnabled: true });
    overlay
      .attach(overlayCanvas, baseCanvas.width, baseCanvas.height)
      .then(() => {
        if (cancelled) {
          overlay.destroy();
          return;
        }
        overlayRef.current = overlay;
      })
      .catch((err) => console.warn('[cursor-overlay] attach failed:', err));
    return () => {
      cancelled = true;
      overlayRef.current?.destroy();
      overlayRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Suspended (e.g. while the export modal is open): don't run the preview
    // loop at all. A live preview behind the blurred modal is invisible anyway,
    // and keeping it running starves the export pipeline on the main thread.
    if (suspended) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let last = performance.now();
    const minDelta = 1000 / 30;

    const tick = (now: number): void => {
      rafRef.current = requestAnimationFrame(tick);
      if (now - last < minDelta) return;
      last = now;
      const video = videoRef.current;
      if (!video) return;
      const p = propsRef.current;
      const tMs = video.currentTime * 1000;
      const lastSample = cursorStateRef.current.lastTms;
      if (lastSample != null && Math.abs(tMs - lastSample) > 150) {
        resetCursorState(cursorStateRef.current);
        resetCursorFollowState(followStateRef.current);
      }
      const overlayActive = overlayRef.current !== null;
      const camera = resolveCameraFollow(p.cameraStyle ?? undefined);
      renderFrame(ctx, video, {
        tMs,
        segments: p.segments,
        mouse: p.mouse,
        displayWidth: p.display?.width,
        displayHeight: p.display?.height,
        background: p.background,
        crop: p.cropMode ? null : p.crop,
        cameraSource: cameraVideoRef?.current ?? null,
        cameraOptions: p.cameraOptions,
        mobileSource: mobileVideoRef?.current ?? null,
        mobileOptions: p.mobileOptions,
        mobilePrimary: p.mobilePrimary,
        cursorState: cursorStateRef.current,
        cursorOptions: p.cursorOptions,
        frame: p.frameOptions,
        skipCursorDraw: overlayActive,
        cursorOutput: cursorOutputRef.current,
        cursorFollowState: followStateRef.current,
        cursorFollowEnabled: camera.enabled,
        cursorFollowConfig: camera.config,
        zoomBlur: p.zoomBlur ?? 0,
        blurRegions: p.blurRegions,
      });
      if (overlayActive) {
        overlayRef.current!.render(cursorOutputRef.current);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [videoRef, cameraVideoRef, mobileVideoRef, suspended]);

  const sourceW = display?.width || 1920;
  const sourceH = display?.height || 1080;
  const wrapAspect =
    aspectRatio && isFinite(aspectRatio) && aspectRatio > 0
      ? `${aspectRatio}`
      : `${sourceW} / ${sourceH}`;
  // Match the renderer's effective padding so overlay handles land exactly
  // where the source pixels do (otherwise a region drawn on the overlay
  // applies to the canvas at a slightly offset y/x).
  const overlayPaddingScale = computeFramePaddingScale(frameOptions);

  // While playing (and not actively editing crop/blur), hide the real OS
  // cursor over the preview so only the rendered cursor shows.
  const hideRealCursor = playing && !cropMode && !blurMode;

  return (
    <div
      ref={wrapRef}
      className="canvas-wrap"
      style={{
        aspectRatio: wrapAspect,
        position: 'relative',
        cursor: hideRealCursor ? 'none' : undefined,
      }}
    >
      <canvas ref={canvasRef} width={sourceW} height={sourceH} />
      <canvas
        ref={overlayCanvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      />
      {overlays && (
        <OverlayCanvas
          hostRef={wrapRef}
          overlays={overlays}
          timeMs={overlayTimeMs}
          interactive={overlays.length > 0 && !cropMode && !blurMode}
          selectedId={selectedOverlayId}
          onSelect={onSelectOverlay}
          onMove={onMoveOverlay}
        />
      )}
      {safeZones && <PlatformGuides safe={safeZones} />}
      {cropMode && onCropChange && (
        <CropOverlay
          canvasWidth={sourceW}
          canvasHeight={sourceH}
          sourceWidth={sourceW}
          sourceHeight={sourceH}
          crop={crop}
          onChange={onCropChange}
          paddingScale={overlayPaddingScale}
        />
      )}
      {blurMode && blurRegions && onSelectBlur && onDragBlurRect && onCreateBlur && (
        <BlurOverlay
          canvasWidth={sourceW}
          canvasHeight={sourceH}
          sourceWidth={sourceW}
          sourceHeight={sourceH}
          aspectRatio={aspectRatio}
          crop={crop}
          paddingScale={overlayPaddingScale}
          regions={blurRegions}
          currentSrcMs={currentSrcMs}
          selectedId={selectedBlurId}
          enabled={blurMode}
          onSelect={onSelectBlur}
          onDragRect={onDragBlurRect}
          onCommitRect={onCommitBlurRect}
          onCreate={onCreateBlur}
        />
      )}
    </div>
  );
}
