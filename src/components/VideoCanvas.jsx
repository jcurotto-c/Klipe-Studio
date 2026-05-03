import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { renderFrame } from '../lib/renderer.js';
import CropOverlay from './CropOverlay.jsx';

/**
 * Plays the source <video> hidden, drives a canvas at ~30fps via rAF,
 * and renders each frame with zoom + cursor overlays. When crop mode is
 * active, the full source is rendered and the overlay is shown for editing.
 */
export default function VideoCanvas({
  videoRef,
  segments,
  mouse,
  display,
  background = 'default',
  width = 1280,
  height = 720,
  trim,
  crop = null,
  cropMode = false,
  onCropChange,
  cameraVideoRef = null,
  cameraOptions = null
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  // Renderer reads these via ref so the rAF loop doesn't need to restart on
  // every crop tweak (which would jitter the preview during a drag).
  const propsRef = useRef({ segments, mouse, display, background, crop, cropMode, cameraOptions });
  propsRef.current = { segments, mouse, display, background, crop, cropMode, cameraOptions };

  // Match the backing buffer to the CSS box × devicePixelRatio. Otherwise the
  // canvas is rendered at a fixed low resolution and the browser bilinear-
  // stretches it to fill the preview pane — visible as a soft, blurry zoom.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const apply = () => {
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
    const ctx = canvas.getContext('2d');
    let last = performance.now();
    const minDelta = 1000 / 30;

    const tick = (now) => {
      rafRef.current = requestAnimationFrame(tick);
      if (now - last < minDelta) return;
      last = now;
      const video = videoRef.current;
      if (!video) return;
      const p = propsRef.current;
      renderFrame(ctx, video, {
        tMs: video.currentTime * 1000,
        segments: p.segments,
        mouse: p.mouse,
        displayWidth: p.display?.width,
        displayHeight: p.display?.height,
        background: p.background,
        crop: p.cropMode ? null : p.crop,
        cameraSource: cameraVideoRef?.current || null,
        cameraOptions: p.cameraOptions
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
      {cropMode && (
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
