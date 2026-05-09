import { Application, Container, Sprite } from 'pixi.js';
import { MotionBlurFilter } from 'pixi-filters/motion-blur';
import {
  getCursorSprite,
  loadSvgPointerSprite,
  type CursorShape,
  type CursorSprite,
} from './cursor-sprites';
import type { CursorPlacement } from './renderer';

export interface PixiCursorOverlayOptions {
  shape: CursorShape;
  motionBlurEnabled: boolean;
  /** Use the SVG pointer at src/assets/pointer-cursor.svg instead of the
   *  procedural shape. Loads asynchronously; until ready, falls back to
   *  the procedural sprite for `shape`. */
  useSvgPointer: boolean;
}

const DEFAULT_OPTIONS: PixiCursorOverlayOptions = {
  shape: 'arrow',
  motionBlurEnabled: true,
  useSvgPointer: true,
};

/**
 * Lightweight PixiJS overlay that paints a single cursor sprite over the
 * existing 2D canvas. Position, scale, and motion data are computed by the
 * existing renderer (`CursorPlacement`) and handed in each frame.
 */
export class PixiCursorOverlay {
  private app: Application | null = null;
  private container: Container | null = null;
  private sprite: Sprite | null = null;
  private spriteMeta: CursorSprite | null = null;
  /** Tracks whether the active sprite is the SVG (vs a procedural fallback). */
  private spriteSource: 'svg' | 'procedural' = 'procedural';
  private currentShape: CursorShape | null = null;
  private svgSprite: CursorSprite | null = null;
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

    if (this.options.useSvgPointer) {
      loadSvgPointerSprite()
        .then((meta) => {
          this.svgSprite = meta;
          // Force re-creation on next render so the SVG swaps in.
          this.currentShape = null;
        })
        .catch((err) => console.warn('[cursor-overlay] svg pointer load failed:', err));
    }
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
    this.ensureSprite();
    if (!this.sprite || !this.spriteMeta) return;

    // Scale uniformly so the sprite preserves its native aspect ratio. The
    // placement.r value (radius) drives the cursor's height; width follows
    // from the texture's natural aspect.
    const targetH = placement.r * 2;
    const scale = targetH / this.spriteMeta.height;
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

  private ensureSprite(): void {
    // Prefer the SVG once it's loaded; fall back to the procedural shape
    // until then. We re-create the sprite when the source switches OR when
    // the procedural shape changes.
    const wantSvg = this.options.useSvgPointer && this.svgSprite !== null;
    const wantSource: 'svg' | 'procedural' = wantSvg ? 'svg' : 'procedural';
    const sourceMatches = this.spriteSource === wantSource;
    const shapeMatches = wantSource === 'svg' || this.currentShape === this.options.shape;
    if (this.sprite && sourceMatches && shapeMatches) return;

    if (this.sprite && this.container) {
      this.container.removeChild(this.sprite);
      this.sprite.destroy();
    }

    const meta = wantSvg ? this.svgSprite! : getCursorSprite(this.options.shape);
    const sprite = new Sprite(meta.texture);
    sprite.anchor.set(meta.hotspotX, meta.hotspotY);
    this.container?.addChild(sprite);
    this.sprite = sprite;
    this.spriteMeta = meta;
    this.spriteSource = wantSource;
    this.currentShape = this.options.shape;
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
