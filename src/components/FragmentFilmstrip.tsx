import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { Fragment } from '../types';
import {
  subscribeFilmstrip,
  getFilmstripSnapshot,
  nearestThumb,
  type FilmstripData,
} from '../lib/filmstrip';

const EMPTY: FilmstripData = { status: 'loading', thumbs: [], aspect: 16 / 9, duration: 0 };

function useFilmstrip(url: string | null, hint: number): FilmstripData {
  const subscribe = useCallback(
    (cb: () => void) => (url ? subscribeFilmstrip(url, hint, cb) : () => {}),
    [url, hint],
  );
  const getSnapshot = useCallback(() => (url ? getFilmstripSnapshot(url) : EMPTY), [url]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

interface Props {
  recordingUrl: string | null;
  fragment: Fragment;
  /** Best-effort source duration, used when the video reports no duration. */
  durationHint: number;
}

/**
 * Renders a CapCut-style filmstrip across one timeline fragment. Each tile is a
 * frame drawn at the video's native aspect ratio (height = row height,
 * width = height × aspect) and tiled left-to-right — so frames are never
 * stretched, only repeated/sampled to fill the fragment's width.
 */
export function FragmentFilmstrip({ recordingUrl, fragment, durationHint }: Props): JSX.Element | null {
  const data = useFilmstrip(recordingUrl, durationHint);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { srcStart, srcEnd } = fragment;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;
    if (cssW < 1 || cssH < 1) return;

    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;

    ctx.clearRect(0, 0, pxW, pxH);

    const thumbs = data.thumbs;
    if (thumbs.length === 0) return;

    const aspect = data.aspect || 16 / 9;
    const tileCssW = Math.max(1, cssH * aspect);
    const tileW = tileCssW * dpr;
    const nTiles = Math.ceil(cssW / tileCssW);
    const span = Math.max(0.0001, srcEnd - srcStart);

    for (let i = 0; i < nTiles; i++) {
      const xCss = i * tileCssW;
      const centerFrac = (xCss + tileCssW / 2) / cssW;
      const srcT = srcStart + centerFrac * span;
      const thumb = nearestThumb(thumbs, srcT);
      if (!thumb) continue;
      ctx.drawImage(thumb.bitmap, Math.round(i * tileW), 0, Math.ceil(tileW), pxH);
    }
  }, [data, srcStart, srcEnd]);

  // Redraw whenever thumbnails arrive or the fragment range changes.
  useEffect(() => {
    draw();
  }, [draw]);

  // Redraw on size changes (window resize, sidebar toggle, trim/zoom).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  if (!recordingUrl) return null;
  return <canvas ref={canvasRef} className="fragment-filmstrip" aria-hidden="true" />;
}
