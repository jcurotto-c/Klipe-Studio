import {
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';
import { renderFrame, type CursorPlacement } from '../lib/renderer';
import { createCursorState, resetCursorState } from '../lib/cursor-engine';
import { createCursorFollowState, resetCursorFollowState } from '../lib/cursor-follow-camera';
import { PixiCursorOverlay } from '../lib/cursor-overlay';
import CropOverlay from './CropOverlay';
import type {
  Background,
  CameraOptions,
  Crop,
  CursorOptions,
  Display,
  FrameOptions,
  MouseTrack,
  ZoomSegment,
} from '../types';

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
  cursorOptions?: CursorOptions | null;
  frameOptions?: FrameOptions | null;
  /** Output aspect ratio (w/h). When null/undefined, falls back to source display ratio. */
  aspectRatio?: number | null;
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
  cursorOptions = null,
  frameOptions = null,
  aspectRatio = null,
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
  });
  const propsRef = useRef({
    segments, mouse, display, background, crop, cropMode, cameraOptions, cursorOptions, frameOptions,
  });
  propsRef.current = {
    segments, mouse, display, background, crop, cropMode, cameraOptions, cursorOptions, frameOptions,
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
    const overlay = new PixiCursorOverlay({ shape: 'arrow', motionBlurEnabled: true });
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
        cursorState: cursorStateRef.current,
        cursorOptions: p.cursorOptions,
        frame: p.frameOptions,
        skipCursorDraw: overlayActive,
        cursorOutput: cursorOutputRef.current,
        cursorFollowState: followStateRef.current,
        cursorFollowEnabled: true,
      });
      if (overlayActive) {
        overlayRef.current!.render(cursorOutputRef.current);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [videoRef, cameraVideoRef]);

  const sourceW = display?.width || 1920;
  const sourceH = display?.height || 1080;
  const wrapAspect =
    aspectRatio && isFinite(aspectRatio) && aspectRatio > 0
      ? `${aspectRatio}`
      : `${sourceW} / ${sourceH}`;

  return (
    <div
      ref={wrapRef}
      className="canvas-wrap"
      style={{ aspectRatio: wrapAspect, position: 'relative' }}
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
      {cropMode && onCropChange && (
        <CropOverlay
          canvasWidth={sourceW}
          canvasHeight={sourceH}
          sourceWidth={sourceW}
          sourceHeight={sourceH}
          crop={crop}
          onChange={onCropChange}
        />
      )}
    </div>
  );
}
