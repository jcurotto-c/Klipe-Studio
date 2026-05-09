import { Application, Container, Sprite } from 'pixi.js';
import { MotionBlurFilter } from 'pixi-filters/motion-blur';
import {
  getCursorSprite,
  loadCursorSprite,
  preloadSvgShapes,
  type CursorShape,
  type CursorSprite,
} from './cursor-sprites';
import type { CursorPlacement } from './renderer';

export interface PixiCursorOverlayOptions {
  motionBlurEnabled: boolean;
}

const DEFAULT_OPTIONS: PixiCursorOverlayOptions = {
  motionBlurEnabled: true,
};

/**
 * Lightweight PixiJS overlay that paints a single cursor sprite over the
 * existing 2D canvas. Position, scale, and motion data are computed by the
 * existing renderer (`CursorPlacement`) and handed in each frame; the shape
 * is whatever `placement.shape` resolves to (style + cursor-type override).
 */
export class PixiCursorOverlay {
  private app: Application | null = null;
  private container: Container | null = null;
  private sprite: Sprite | null = null;
  private spriteMeta: CursorSprite | null = null;
  private currentShape: CursorShape | null = null;
  private pendingShape: CursorShape | null = null;
  private motionBlur: MotionBlurFilter | null = null;
  private options: PixiCursorOverlayOptions;
  private ready = false;

  constructor(options: Partial<PixiCursorOverlayOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async attach(canvas: HTMLCanvasElement, width: number, height: number): Promise<void> {
    if (this.app) return;
    const app = new Application();
    await app.init({
      canvas,
      width,
      height,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    this.app = app;
    this.container = new Container();
    this.container.sortableChildren = false;
    this.motionBlur = new MotionBlurFilter({ velocity: { x: 0, y: 0 }, kernelSize: 9, offset: 0 });
    app.stage.addChild(this.container);
    this.ready = true;

    // Kick off SVG rasterization in the background so the first text/pointer
    // hover doesn't see a one-frame procedural fallback.
    void preloadSvgShapes();
  }

  resize(width: number, height: number): void {
    if (!this.app) return;
    this.app.renderer.resize(width, height);
  }

  setOptions(options: Partial<PixiCursorOverlayOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Paint the cursor for this frame. Pass the placement object that
   * `renderer.renderFrame` populated.
   */
  render(placement: CursorPlacement): void {
    if (!this.ready || !this.container) return;
    if (!placement.visible) {
      this.container.visible = false;
      return;
    }
    this.container.visible = true;
    this.ensureSprite(placement.shape);
    if (!this.sprite || !this.spriteMeta) return;

    // Scale so the visible cursor content matches `contentTargetHeight`,
    // not the full texture. This is the parity fix: procedural arrows have
    // ~13% empty margin at the bottom, but SVG bone/hand fill their texture
    // 100% — using texture height as the reference made them look different
    // sizes. With contentHeight per sprite, every shape ends up at exactly
    // the same on-screen height for the same `contentTargetHeight`.
    const targetH = placement.contentTargetHeight;
    const scale = targetH / this.spriteMeta.contentHeight;
    this.sprite.scale.set(scale);
    this.sprite.position.set(placement.px, placement.py);
    this.sprite.rotation = placement.rotation;

    if (this.options.motionBlurEnabled && this.motionBlur) {
      const strength = Math.min(1.5, placement.motionStrength);
      // Magnitude scales the directional blur smear length (in px).
      const magnitude = strength * 64;
      const vx = Math.cos(placement.motionAngle) * magnitude;
      const vy = Math.sin(placement.motionAngle) * magnitude;
      this.motionBlur.velocity = { x: vx, y: vy };
      // Wider kernel for stronger blur — gives a real smear instead of a
      // jaggy comb effect at high speeds.
      this.motionBlur.kernelSize = magnitude > 24 ? 13 : magnitude > 8 ? 9 : 7;
      this.motionBlur.offset = magnitude > 4 ? -magnitude / 28 : 0;
      this.sprite.filters = magnitude > 1 ? [this.motionBlur] : [];
    } else {
      this.sprite.filters = [];
    }
  }

  private ensureSprite(shape: CursorShape): void {
    if (this.sprite && this.currentShape === shape) return;

    // For SVG shapes that haven't loaded yet, keep showing whatever sprite
    // we already have and trigger a load — the next frame after the load
    // completes will pick up the new texture via this same method.
    if ((shape === 'svg-bone' || shape === 'svg-hand') && this.pendingShape !== shape) {
      this.pendingShape = shape;
      void loadCursorSprite(shape).then(() => {
        // No-op: the next render call's `getCursorSprite(shape)` will now
        // return the cached SVG.
        if (this.pendingShape === shape) this.pendingShape = null;
      }).catch((err) => {
        console.warn('[cursor-overlay] failed to load shape', shape, err);
      });
    }

    const meta = getCursorSprite(shape);
    if (this.sprite && this.container) {
      this.container.removeChild(this.sprite);
      this.sprite.destroy();
    }
    const sprite = new Sprite(meta.texture);
    sprite.anchor.set(meta.hotspotX, meta.hotspotY);
    this.container?.addChild(sprite);
    this.sprite = sprite;
    this.spriteMeta = meta;
    this.currentShape = shape;
  }

  destroy(): void {
    if (this.sprite) this.sprite.destroy();
    if (this.container) this.container.destroy({ children: true });
    if (this.motionBlur) this.motionBlur.destroy();
    if (this.app) this.app.destroy(true);
    this.app = null;
    this.container = null;
    this.sprite = null;
    this.motionBlur = null;
    this.ready = false;
  }
}
