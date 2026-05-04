import {
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';
import { renderFrame } from '../lib/renderer';
import { createCursorState, resetCursorState } from '../lib/cursor-engine';
import CropOverlay from './CropOverlay';
import type {
  Background,
  CameraOptions,
  Crop,
  CursorOptions,
  Display,
  MouseTrack,
  Trim,
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
  trim?: Trim;
  crop?: Crop | null;
  cropMode?: boolean;
  onCropChange?: (next: Crop) => void;
  cameraVideoRef?: RefObject<HTMLVideoElement> | null;
  cameraOptions?: CameraOptions | null;
  cursorOptions?: CursorOptions | null;
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
}: VideoCanvasProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const cursorStateRef = useRef(createCursorState());
  const propsRef = useRef({
    segments, mouse, display, background, crop, cropMode, cameraOptions, cursorOptions,
  });
  propsRef.current = {
    segments, mouse, display, background, crop, cropMode, cameraOptions, cursorOptions,
  };

  useEffect(() => {
    resetCursorState(cursorStateRef.current);
  }, [mouse]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const apply = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const rect = wrap.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
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
      }
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
      });
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [videoRef, cameraVideoRef]);

  const sourceW = display?.width || 1920;
  const sourceH = display?.height || 1080;

  return (
    <div
      ref={wrapRef}
      className="canvas-wrap"
      style={{ aspectRatio: `${sourceW} / ${sourceH}` }}
    >
      <canvas ref={canvasRef} width={sourceW} height={sourceH} />
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
