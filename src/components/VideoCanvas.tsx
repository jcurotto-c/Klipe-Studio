import {
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';
import {
  renderFrame,
  computeFramePaddingScale,
  computeFrameBarRatio,
  drawCardBackground,
  syncPreviewVideoTime,
  type CursorPlacement,
  type RenderFrameOptions,
} from '../lib/renderer';
import {
  createBrandScratch,
  disposeBrandScratch,
  drawBrandReveal,
  type BrandScratch,
} from '../lib/brand-reveal';
import type { BrandCardConfig } from '../cards/types';
import { CROSS_ASPECT_EPSILON } from '../lib/layout';
import { composeCameraFrame } from '../lib/camera-compositor';
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
  FitMode,
  FrameOptions,
  MobileOptions,
  MouseTrack,
  ZoomSegment,
} from '../types';
import type { Overlay } from '../overlays/types';

/** Stable empty array so an idle OverlayCanvas doesn't re-run setOverlays each render. */
const EMPTY_OVERLAYS: Overlay[] = [];

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
  /** How a non-matching output aspect is fitted: 'fit' (whole frame on the
   * chosen background) or 'fill' (cover-crop). Defaults to 'fit'. */
  fitMode?: FitMode;
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
  // --- Intro/outro cards ---------------------------------------------------
  /** Mount a dedicated overlay canvas for card items (kept mounted to avoid
   * re-init flashes when scrubbing across phases). */
  hasCards?: boolean;
  /** True while the playhead is inside an intro/outro card. The base canvas
   * then draws the card background instead of the video, and body overlays +
   * cursor are hidden. */
  cardActive?: boolean;
  /** Background to fill while `cardActive`. */
  cardBackground?: Background | string | null;
  /** Card overlay items (text/logo), authored in card-local time. */
  cardItems?: Overlay[];
  /** Card-local time in ms — drives card item keyframes. */
  cardTimeMs?: number;
  /** True while a card is crossfading with the recording (body phase). The
   * video plays underneath and the card background/items are composited on top
   * at `cardTransitionAlpha`. */
  cardTransition?: boolean;
  /** Card-layer opacity (0..1) during a crossfade. */
  cardTransitionAlpha?: number;
  /** Allow direct manipulation (drag) of card items while parked on a full card. */
  cardEditable?: boolean;
  selectedCardItemId?: string | null;
  onSelectCardItem?: (id: string | null) => void;
  /** Called while dragging a card item; coordinates are fractional. */
  onMoveCardItem?: (id: string, base: { x: number; y: number }) => void;
  /**
   * When the visible card is a brand card, its config. The card layer then
   * paints the dot field and logo card instead of a flat background.
   */
  cardBrandConfig?: BrandCardConfig | null;
  /** Length of the visible card, for the brand card's own timing. */
  cardDurationMs?: number;
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
  fitMode = 'fit',
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
  hasCards = false,
  cardActive = false,
  cardBackground = null,
  cardItems,
  cardTimeMs = 0,
  cardTransition = false,
  cardTransitionAlpha = 0,
  cardEditable = false,
  selectedCardItemId = null,
  onSelectCardItem,
  onMoveCardItem,
  cardBrandConfig = null,
  cardDurationMs = 0,
}: VideoCanvasProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The card (background + items) is one group-opacity layer so it crossfades
  // as a SINGLE composited image — matching the export's pre-baked frame and
  // avoiding double-alpha muddiness on text/logos.
  const cardLayerRef = useRef<HTMLDivElement | null>(null);
  const cardBgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const cursorStateRef = useRef(createCursorState());
  const followStateRef = useRef(createCursorFollowState());
  const overlayRef = useRef<PixiCursorOverlay | null>(null);
  // Held across frames: the dot field is rebuilt into a full-size canvas, and
  // reallocating it every tick would thrash the GC through the whole card.
  // Created lazily — passing createBrandScratch() straight to useRef would
  // allocate a fresh pair of canvases on every render just to discard them.
  const brandScratchRef = useRef<BrandScratch | null>(null);
  if (brandScratchRef.current === null) brandScratchRef.current = createBrandScratch();
  useEffect(() => {
    const s = brandScratchRef.current;
    return () => { if (s) disposeBrandScratch(s); };
  }, []);
  const cursorOutputRef = useRef<CursorPlacement>({
    visible: false, px: 0, py: 0, r: 0, rotation: 0, motionAngle: 0, motionStrength: 0,
    shape: 'arrow', contentTargetHeight: 0,
  });
  const propsRef = useRef({
    segments, mouse, display, background, crop, cropMode, cameraOptions, mobileOptions, mobilePrimary, cursorOptions, cameraStyle, zoomBlur, frameOptions, blurRegions, fitMode, cardActive, cardBackground, cardTransition, cardTransitionAlpha, cardBrandConfig, cardDurationMs, cardTimeMs, playing,
  });
  propsRef.current = {
    segments, mouse, display, background, crop, cropMode, cameraOptions, mobileOptions, mobilePrimary, cursorOptions, cameraStyle, zoomBlur, frameOptions, blurRegions, fitMode, cardActive, cardBackground, cardTransition, cardTransitionAlpha, cardBrandConfig, cardDurationMs, cardTimeMs, playing,
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
    /**
     * rAF timestamps jitter by a fraction of a millisecond, and a frame landing
     * a hair under the budget used to be dropped outright — which pushes the
     * next draw a whole vsync later. That turned a steady 30 fps into an uneven
     * 33/50 ms alternation (22.6 fps effective, 17 ms spread): invisible on a
     * near-static screen recording, obvious stutter on smooth motion.
     */
    const deltaTolerance = 4;
    // Always populated: it's assigned during render, which runs before effects.
    const brandScratch = brandScratchRef.current ?? createBrandScratch();

    /** The renderFrame options for a body frame. */
    const buildRenderOpts = (
      p: typeof propsRef.current,
      tMs: number,
      overlayActive = false,
    ): RenderFrameOptions => {
      const camera = resolveCameraFollow(p.cameraStyle ?? undefined);
      const camRaw = cameraVideoRef?.current ?? null;
      const camComposed = camRaw && p.cameraOptions && !p.cameraOptions.hide
        ? composeCameraFrame(camRaw, p.cameraOptions.background)
        : null;
      return {
        tMs,
        segments: p.segments,
        mouse: p.mouse,
        displayWidth: p.display?.width,
        displayHeight: p.display?.height,
        background: p.background,
        crop: p.cropMode ? null : p.crop,
        fitMode: p.fitMode,
        cameraSource: camComposed ?? camRaw,
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
      };
    };

    /**
     * A card's artwork. Brand cards paint their own dot field and logo card;
     * everything else is a flat background with its items on the OverlayCanvas.
     * Used by both the full-card branch and the crossfade so a card dissolving
     * in looks like the card it's about to become.
     */
    const paintCard = (
      target: CanvasRenderingContext2D,
      cw: number,
      chh: number,
      p: typeof propsRef.current,
      localMs: number,
    ): void => {
      // A card whose background is a clip follows the playhead rather than
      // free-running, so the card can be scrubbed like the rest of the timeline.
      const bg = p.cardBrandConfig ? p.cardBrandConfig.background : p.cardBackground;
      if (bg && typeof bg === 'object' && bg.type === 'video') {
        // Only let the clip run while the card is actually on screen. During a
        // crossfade the card is frozen at local time 0 (the export bakes a
        // still there too), so playing through it would leave the clip ~half a
        // second in by the time the card takes over — skipping its opening.
        syncPreviewVideoTime(bg.src, localMs / 1000, p.playing && p.cardActive);
      }
      if (p.cardBrandConfig) {
        drawBrandReveal(target, cw, chh, p.cardBrandConfig, localMs, p.cardDurationMs, brandScratch);
        return;
      }
      drawCardBackground(target, cw, chh, p.cardBackground);
    };

    const tick = (now: number): void => {
      rafRef.current = requestAnimationFrame(tick);
      const p = propsRef.current;
      // A card whose background is a clip is genuine motion and costs one
      // drawImage to composite, so it runs at the display's rate. The 30 fps
      // budget exists to keep the heavy body compositing off the main thread
      // during an export; it only hurts here.
      const cardBgNow = p.cardBrandConfig ? p.cardBrandConfig.background : p.cardBackground;
      const videoCard = p.cardActive
        && !!cardBgNow && typeof cardBgNow === 'object' && cardBgNow.type === 'video';
      // A video card gets a higher budget than the body's 30 fps — but a
      // budget, not free rein. Displays run well past 60Hz (165Hz is ordinary
      // now), and redrawing a 30 fps clip 165 times a second is pure waste that
      // competes with its own decoding.
      const budget = videoCard ? 1000 / 60 : minDelta;
      if (now - last < budget - deltaTolerance) return;
      last = now;
      const cardBg = cardBgCanvasRef.current;
      const cardBgCtx = cardBg ? cardBg.getContext('2d') : null;
      const cardLayer = cardLayerRef.current;
      // Keep the card buffer at the same resolution/aspect as the body canvas
      // (DPR-scaled OUTPUT dims) so gradient/image card backgrounds match the
      // export pixel-for-pixel instead of stretching the source aspect.
      if (cardBg && (cardBg.width !== canvas.width || cardBg.height !== canvas.height)) {
        cardBg.width = canvas.width;
        cardBg.height = canvas.height;
      }
      // Full intro/outro card phase: the <video> is paused upstream. Paint the
      // card background on the dedicated group-opacity layer (fully opaque,
      // covering video + cursor + body overlays) and keep the OS-cursor sprite
      // hidden. The card's text/logo render on the OverlayCanvas INSIDE the same
      // layer, so it composites background + items as a single image.
      if (p.cardActive) {
        if (cardBg && cardBgCtx) {
          paintCard(cardBgCtx, cardBg.width, cardBg.height, p, p.cardTimeMs);
        }
        if (cardLayer && cardLayer.style.opacity !== '1') cardLayer.style.opacity = '1';
        if (overlayRef.current) {
          overlayRef.current.render({ ...cursorOutputRef.current, visible: false });
        }
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      const tMs = video.currentTime * 1000;
      const lastSample = cursorStateRef.current.lastTms;
      if (lastSample != null && Math.abs(tMs - lastSample) > 150) {
        resetCursorState(cursorStateRef.current);
        resetCursorFollowState(followStateRef.current);
      }
      const overlayActive = overlayRef.current !== null;
      renderFrame(ctx, video, buildRenderOpts(p, tMs, overlayActive));
      if (overlayActive) {
        overlayRef.current!.render(cursorOutputRef.current);
      }
      // Card crossfade: an intro dissolving out over the body start, or an
      // outro dissolving in over the body end. The whole card LAYER (bg + items)
      // fades over the live recording as one composited image. While the
      // boundary seek into the body is still in flight, hold the card fully
      // opaque so a stale decoded frame can't flash through.
      if (cardLayer && cardBg && cardBgCtx) {
        if (p.cardTransition) {
          const a = video.seeking ? 1 : Math.min(1, Math.max(0, p.cardTransitionAlpha));
          const s = String(a);
          if (cardLayer.style.opacity !== s) cardLayer.style.opacity = s;
          paintCard(cardBgCtx, cardBg.width, cardBg.height, p, p.cardTimeMs);
        } else if (cardLayer.style.opacity !== '0') {
          cardLayer.style.opacity = '0';
        }
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
  // The renderer skips window chrome in fill mode (it bleeds past the canvas
  // edges), so the overlays must agree or their handles land a bar-height off.
  const srcAspect = sourceW / sourceH;
  const targetAspect =
    aspectRatio && isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : srcAspect;
  const fillActive =
    Math.abs(targetAspect - srcAspect) > CROSS_ASPECT_EPSILON && fitMode === 'fill';
  const overlayBarRatio = fillActive ? 0 : computeFrameBarRatio(frameOptions);

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
          overlays={cardActive ? EMPTY_OVERLAYS : overlays}
          timeMs={overlayTimeMs}
          interactive={!cardActive && overlays.length > 0 && !cropMode && !blurMode}
          selectedId={selectedOverlayId}
          onSelect={onSelectOverlay}
          onMove={onMoveOverlay}
        />
      )}
      {hasCards && (
        <div
          ref={cardLayerRef}
          style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none' }}
        >
          <canvas
            ref={cardBgCanvasRef}
            width={sourceW}
            height={sourceH}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          />
          <OverlayCanvas
            hostRef={wrapRef}
            overlays={(cardActive || cardTransition) ? (cardItems ?? EMPTY_OVERLAYS) : EMPTY_OVERLAYS}
            timeMs={cardTimeMs}
            interactive={cardEditable && cardActive && !cropMode && !blurMode}
            textShadow={false}
            selectedId={selectedCardItemId}
            onSelect={onSelectCardItem}
            onMove={onMoveCardItem}
          />
        </div>
      )}
      {safeZones && !cardActive && <PlatformGuides safe={safeZones} />}
      {cropMode && onCropChange && (
        <CropOverlay
          canvasWidth={sourceW}
          canvasHeight={sourceH}
          sourceWidth={sourceW}
          sourceHeight={sourceH}
          crop={crop}
          onChange={onCropChange}
          paddingScale={overlayPaddingScale}
          barRatio={overlayBarRatio}
        />
      )}
      {blurMode && blurRegions && onSelectBlur && onDragBlurRect && onCreateBlur && (
        <BlurOverlay
          canvasWidth={sourceW}
          canvasHeight={sourceH}
          sourceWidth={sourceW}
          sourceHeight={sourceH}
          aspectRatio={aspectRatio}
          fitMode={fitMode}
          crop={crop}
          paddingScale={overlayPaddingScale}
          barRatio={overlayBarRatio}
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
