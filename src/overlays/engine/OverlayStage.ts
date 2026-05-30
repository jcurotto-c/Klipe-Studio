/**
 * OverlayStage — Pixi renderer for text/image overlays.
 *
 * Mounted on a transparent canvas stacked over the Editor's main canvas.
 * Receives raw `overlays` + `tMs` per render; no internal state machine.
 *
 * Coordinate model:
 *   - Overlay positions/sizes are stored as fractions of canvas dims.
 *   - At render time we convert to canvas pixels using the renderer's current
 *     width/height. This lets a single overlay set work across any aspect ratio.
 *
 * The stage is rebuilt only when the **layer set** changes (add/remove or
 * type-changing edit); per-frame animation just samples keyframes and updates
 * existing display-object transforms.
 */

import {
  Application,
  Assets,
  BlurFilter,
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
} from 'pixi.js';
import type { ImageOverlay, Overlay, TextOverlay } from '../types';
import { sampleNumber, sampleVec } from './sample';

interface OverlayNode {
  overlay: Overlay;
  container: Container;
  text: Text | null;        // text overlays only — for size + content updates
  sprite: Sprite | null;    // image overlays only — for size updates
  blur: BlurFilter;
  typewriterFullText: string | null;
}

export class OverlayStage {
  private app: Application;
  private overlayRoot: Container;
  private selectionOverlay: Graphics;
  private selectedId: string | null = null;
  private nodes = new Map<string, OverlayNode>();
  private overlays: Overlay[] = [];
  private mounted = false;
  private destroyed = false;
  /** Bumped whenever rebuildIfStale() detects a structural diff. */
  private builtKey = '';

  constructor() {
    this.app = new Application();
    this.overlayRoot = new Container();
    this.selectionOverlay = new Graphics();
  }

  async mount(canvas: HTMLCanvasElement, width: number, height: number): Promise<void> {
    if (this.mounted) return;
    await this.app.init({
      canvas,
      width,
      height,
      antialias: true,
      backgroundAlpha: 0, // transparent — stacked over video
      resolution: 1,
      autoDensity: false,
      autoStart: false,
      sharedTicker: false,
    });
    if (this.destroyed) {
      this.app.destroy(true, { children: true });
      return;
    }
    this.app.stage.addChild(this.overlayRoot);
    this.app.stage.addChild(this.selectionOverlay);
    this.mounted = true;
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
  }

  resize(width: number, height: number): void {
    if (!this.mounted) return;
    this.app.renderer.resize(width, height);
  }

  get width(): number { return this.app.renderer.width; }
  get height(): number { return this.app.renderer.height; }

  /**
   * Hit-test an overlay at canvas pixel coords. Iterates back-to-front (top z
   * first) so the visually-on-top overlay wins. Returns the topmost id or null.
   */
  hitTest(canvasX: number, canvasY: number, tMs: number): string | null {
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;
    const sorted = [...this.overlays].sort((a, b) => b.z - a.z);
    for (const overlay of sorted) {
      if (overlay.hidden) continue;
      const tx = overlay.transform;
      const pos = sampleVec(tx.position, tMs, overlay.base.x, overlay.base.y);
      const scl = sampleNumber(tx.scale, tMs, overlay.base.scale);
      const op = sampleNumber(tx.opacity, tMs, overlay.base.opacity);
      if (op < 0.01) continue;
      const vFrom = overlay.visibleFrom ?? -Infinity;
      const vTo = overlay.visibleTo ?? Infinity;
      if (tMs < vFrom || tMs > vTo) continue;

      let wobbleX = 0, wobbleY = 0;
      if (overlay.idle) {
        wobbleX = Math.sin((tMs / overlay.idle.periodX) * Math.PI * 2 + overlay.idle.phase) * overlay.idle.ampX;
        wobbleY = Math.sin((tMs / overlay.idle.periodY) * Math.PI * 2 + overlay.idle.phase + Math.PI / 2) * overlay.idle.ampY;
      }

      const cx = (pos.x + wobbleX) * w;
      const cy = (pos.y + wobbleY) * h;
      const { w: lw, h: lh } = this.logicalSize(overlay, h);
      const sw = lw * scl;
      const sh = lh * scl;

      if (
        canvasX >= cx - sw / 2 &&
        canvasX <= cx + sw / 2 &&
        canvasY >= cy - sh / 2 &&
        canvasY <= cy + sh / 2
      ) {
        return overlay.id;
      }
    }
    return null;
  }

  private logicalSize(overlay: Overlay, canvasH: number): { w: number; h: number } {
    if (overlay.type === 'text') {
      const fontPx = Math.max(2, overlay.sizeRel * canvasH);
      const charW = fontPx * 0.55;
      const longest = overlay.text.split('\n').reduce((a, l) => Math.max(a, l.length), 1);
      return { w: Math.max(40, longest * charW), h: fontPx * 1.3 };
    }
    return this.imagePixelSize(overlay, canvasH);
  }

  get isMounted(): boolean { return this.mounted; }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  dispose(): void {
    this.destroyed = true;
    if (!this.mounted) return;
    for (const node of this.nodes.values()) {
      node.container.destroy({ children: true });
    }
    this.nodes.clear();
    // First arg `false` keeps the <canvas> in the DOM — React owns its
    // lifecycle. Destroying the canvas (true) yanks it from the DOM and can
    // glitch Electron's GPU compositor, which was the trigger for a
    // full-window black flash when the last overlay was deleted.
    this.app.destroy(false, { children: true, texture: false });
    this.mounted = false;
  }

  /**
   * Rebuild Pixi display objects whenever the overlay *set* changes
   * (add/remove or a type-changing edit). Per-property edits don't rebuild —
   * `renderAt` picks them up via direct property reads.
   */
  async setOverlays(overlays: Overlay[]): Promise<void> {
    this.overlays = overlays;
    const key = overlays.map((o) => `${o.id}:${o.type}:${o.z}`).join('|');
    if (key === this.builtKey) return;
    this.builtKey = key;

    for (const node of this.nodes.values()) {
      node.container.destroy({ children: true });
    }
    this.nodes.clear();
    this.overlayRoot.removeChildren();

    const sorted = [...overlays].sort((a, b) => a.z - b.z);
    for (const overlay of sorted) {
      const node = await this.buildNode(overlay);
      if (this.destroyed) return;
      this.nodes.set(overlay.id, node);
      this.overlayRoot.addChild(node.container);
    }
  }

  /**
   * Render the current overlay set at output-time `tMs`. Synchronous; callers
   * (preview RAF + export loop) drive cadence externally.
   */
  renderAt(tMs: number): void {
    if (!this.mounted) return;
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;

    // Keep node map in sync with `this.overlays` so refs stay stable across renders.
    for (const overlay of this.overlays) {
      const node = this.nodes.get(overlay.id);
      if (!node) continue;
      // Detect simple in-place mutations (text content, color, sizeRel) and
      // patch the node so the user sees edits without a full rebuild.
      this.patchNode(node, overlay, h);

      const tx = overlay.transform;
      const pos = sampleVec(tx.position, tMs, overlay.base.x, overlay.base.y);
      const scl = sampleNumber(tx.scale, tMs, overlay.base.scale);
      const rot = sampleNumber(tx.rotation, tMs, overlay.base.rotation);
      const op = sampleNumber(tx.opacity, tMs, overlay.base.opacity);
      const blurStrength = sampleNumber(tx.blur, tMs, overlay.base.blur);

      const vFrom = overlay.visibleFrom ?? -Infinity;
      const vTo = overlay.visibleTo ?? Infinity;
      const inWindow = tMs >= vFrom && tMs <= vTo;
      node.container.visible = !overlay.hidden && inWindow && op > 0.001;

      let wobbleX = 0, wobbleY = 0;
      if (overlay.idle && inWindow) {
        const idle = overlay.idle;
        wobbleX = Math.sin((tMs / idle.periodX) * Math.PI * 2 + idle.phase) * idle.ampX;
        wobbleY = Math.sin((tMs / idle.periodY) * Math.PI * 2 + idle.phase + Math.PI / 2) * idle.ampY;
      }

      node.container.position.set((pos.x + wobbleX) * w, (pos.y + wobbleY) * h);
      node.container.scale.set(scl);
      node.container.rotation = rot;
      node.container.alpha = op;

      node.blur.strength = blurStrength;
      node.blur.enabled = blurStrength > 0.1;

      if (node.text && node.typewriterFullText && overlay.type === 'text' && overlay.typewriter) {
        const elapsed = Math.max(0, tMs - overlay.typewriter.startMs) / 1000;
        const chars = Math.floor(elapsed * overlay.typewriter.charsPerSecond);
        const next = node.typewriterFullText.slice(0, chars);
        if (node.text.text !== next) node.text.text = next;
      }
    }

    // Selection outline — drawn in canvas-space above all overlay nodes.
    this.selectionOverlay.clear();
    if (this.selectedId) {
      const selOverlay = this.overlays.find((o) => o.id === this.selectedId);
      const selNode = this.nodes.get(this.selectedId);
      if (selOverlay && selNode && selNode.container.visible) {
        const tx = selOverlay.transform;
        const pos = sampleVec(tx.position, tMs, selOverlay.base.x, selOverlay.base.y);
        const scl = sampleNumber(tx.scale, tMs, selOverlay.base.scale);
        let wobbleX = 0, wobbleY = 0;
        if (selOverlay.idle) {
          wobbleX = Math.sin((tMs / selOverlay.idle.periodX) * Math.PI * 2 + selOverlay.idle.phase) * selOverlay.idle.ampX;
          wobbleY = Math.sin((tMs / selOverlay.idle.periodY) * Math.PI * 2 + selOverlay.idle.phase + Math.PI / 2) * selOverlay.idle.ampY;
        }
        const cx = (pos.x + wobbleX) * this.app.renderer.width;
        const cy = (pos.y + wobbleY) * this.app.renderer.height;
        const { w: lw, h: lh } = this.logicalSize(selOverlay, this.app.renderer.height);
        const sw = lw * scl;
        const sh = lh * scl;
        const pad = 10;
        this.selectionOverlay
          .rect(cx - sw / 2 - pad, cy - sh / 2 - pad, sw + pad * 2, sh + pad * 2)
          .stroke({ width: 2, color: 0xffffff, alpha: 0.95, alignment: 0.5 });
      }
    }

    this.app.renderer.render(this.app.stage);
  }

  // ---------------------------------------------------------------------------
  // Node construction & in-place patching
  // ---------------------------------------------------------------------------

  private async buildNode(overlay: Overlay): Promise<OverlayNode> {
    const blur = new BlurFilter({ strength: 0, quality: 3 });
    blur.enabled = false;
    const h = this.app.renderer.height;
    switch (overlay.type) {
      case 'text': {
        const { container, text, fullText } = this.buildText(overlay, h);
        container.filters = [blur];
        return { overlay, container, text, sprite: null, blur, typewriterFullText: fullText };
      }
      case 'image': {
        const { container, sprite } = await this.buildImage(overlay, h);
        container.filters = [blur];
        return { overlay, container, text: null, sprite, blur, typewriterFullText: null };
      }
    }
  }

  /**
   * Patch text content / color / sizeRel in place. Avoids tearing down sprites
   * for property edits (live preview while typing).
   */
  private patchNode(node: OverlayNode, overlay: Overlay, canvasH: number): void {
    node.overlay = overlay;
    if (overlay.type === 'text' && node.text) {
      const t = node.text;
      const desiredSize = Math.max(2, Math.round(overlay.sizeRel * canvasH));
      const style = t.style;
      if (style.fontSize !== desiredSize) style.fontSize = desiredSize;
      if (style.fill !== overlay.color) style.fill = overlay.color;
      const desiredFamily = overlay.mono
        ? 'JetBrains Mono, Menlo, Consolas, monospace'
        : 'Inter, system-ui, -apple-system, sans-serif';
      if (style.fontFamily !== desiredFamily) style.fontFamily = desiredFamily;
      const desiredWeight = String(overlay.weight ?? 700) as
        'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900';
      if (style.fontWeight !== desiredWeight) style.fontWeight = desiredWeight;
      style.letterSpacing = overlay.letterSpacing ?? 0;
      style.align = overlay.align ?? 'center';
      if (!overlay.typewriter && t.text !== overlay.text) t.text = overlay.text;
      node.typewriterFullText = overlay.typewriter ? overlay.text : null;
    } else if (overlay.type === 'image' && node.sprite) {
      const target = this.imagePixelSize(overlay, canvasH);
      if (Math.abs(node.sprite.width - target.w) > 0.5) node.sprite.width = target.w;
      if (Math.abs(node.sprite.height - target.h) > 0.5) node.sprite.height = target.h;
    }
  }

  private buildText(overlay: TextOverlay, canvasH: number): {
    container: Container;
    text: Text;
    fullText: string | null;
  } {
    const c = new Container();
    const isTypewriter = Boolean(overlay.typewriter);
    const initial = isTypewriter ? '' : overlay.text;
    const fontSize = Math.max(2, Math.round(overlay.sizeRel * canvasH));
    const t = new Text({
      text: initial,
      style: {
        fontFamily: overlay.mono
          ? 'JetBrains Mono, Menlo, Consolas, monospace'
          : 'Inter, system-ui, -apple-system, sans-serif',
        fontSize,
        fontWeight: String(overlay.weight ?? 700) as
          | 'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900',
        fill: overlay.color,
        letterSpacing: overlay.letterSpacing ?? 0,
        align: overlay.align ?? 'center',
        dropShadow: {
          alpha: 0.55,
          angle: Math.PI / 4,
          blur: 6,
          distance: 2,
          color: 0x000000,
        },
      },
    });
    t.anchor.set(0.5, 0.5);
    c.addChild(t);
    return { container: c, text: t, fullText: isTypewriter ? overlay.text : null };
  }

  private async buildImage(overlay: ImageOverlay, canvasH: number): Promise<{
    container: Container;
    sprite: Sprite | null;
  }> {
    const c = new Container();
    try {
      const tex = await Assets.load(overlay.src);
      const sprite = new Sprite(tex as Texture);
      sprite.anchor.set(0.5, 0.5);
      const size = this.imagePixelSize(overlay, canvasH);
      sprite.width = size.w;
      sprite.height = size.h;
      c.addChild(sprite);
      return { container: c, sprite };
    } catch (err) {
      const g = new Graphics();
      g.rect(-40, -40, 80, 80).fill(0x222228).stroke({ width: 2, color: 0x444450 });
      c.addChild(g);
      console.warn('[OverlayStage] image load failed', overlay.src, err);
      return { container: c, sprite: null };
    }
  }

  private imagePixelSize(overlay: ImageOverlay, canvasH: number): { w: number; h: number } {
    const aspect = overlay.naturalWidth / Math.max(1, overlay.naturalHeight);
    const longEdge = Math.max(8, overlay.sizeRel * canvasH);
    if (aspect >= 1) return { w: longEdge, h: longEdge / aspect };
    return { w: longEdge * aspect, h: longEdge };
  }
}
