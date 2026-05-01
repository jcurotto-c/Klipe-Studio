import React, { useEffect, useRef } from 'react';
import { renderFrame } from '../lib/renderer.js';

/**
 * Plays the source <video> hidden, drives a canvas at ~30fps via rAF,
 * and renders each frame with zoom + cursor overlays.
 */
export default function VideoCanvas({
  videoRef,
  segments,
  mouse,
  display,
  background = 'default',
  width = 1280,
  height = 720,
  trim
}) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let last = performance.now();
    const minDelta = 1000 / 30; // 30fps cap

    const tick = (now) => {
      rafRef.current = requestAnimationFrame(tick);
      if (now - last < minDelta) return;
      last = now;
      const video = videoRef.current;
      if (!video) return;
      const tMs = Math.max(0, video.currentTime * 1000 - (trim?.start || 0) * 1000);
      // We pass video.currentTime in ms relative to start of source; the
      // renderer expects ms from recording start, which is the same since
      // playback always starts at 0. We map zoom segments using raw t too.
      renderFrame(ctx, video, {
        tMs: video.currentTime * 1000,
        segments,
        mouse,
        displayWidth: display?.width,
        displayHeight: display?.height,
        background
      });
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [videoRef, segments, mouse, display, background, trim]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ borderRadius: 10 }}
    />
  );
}
