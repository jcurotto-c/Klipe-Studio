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
  CanvasTextMetrics,
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
} from 'pixi.js';
import type { ImageOverlay, LineOverlay, Overlay, TextOverlay } from '../types';
import { fontStack, snapWeight } from '../fonts';
import { sampleNumber, sampleVec } from './sample';

interface OverlayNode {
  overlay: Overlay;
  container: Container;
  text: Text | null;        // text overlays only — for size + content updates
  sprite: Sprite | null;    // image overlays only — for size updates
  /** The stroke for line overlays (callout leader lines); null otherwise. */
  line: Graphics | null;
  /** Background pill behind text overlays (captions); null when not requested. */
  box: Graphics | null;
  blur: BlurFilter;
  typewriterFullText: string | null;
  /** Current text drop-shadow state, so patchNode only restyles on change. */
  shadowOn: boolean;
}

/** The legibility drop-shadow for text. Spread fresh per Text so Pixi can't
 * mutate a shared object. */
const TEXT_SHADOW = { alpha: 0.55, angle: Math.PI / 4, blur: 6, distance: 2, color: 0x000000 };

/** Text as displayed (honours the uppercase option). */
function displayText(overlay: TextOverlay): string {
  return overlay.uppercase ? overlay.text.toUpperCase() : overlay.text;
}

/** Horizontal text anchor for an alignment: left edge / centre / right edge sit
 * at the item's x. This is what actually MOVES the block (Pixi's `align` style
 * only justifies multi-line text). */
function alignAnchorX(align: TextOverlay['align']): number {
  return align === 'left' ? 0 : align === 'right' ? 1 : 0.5;
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
  /** Whether text gets the legibility drop-shadow. On for body overlays (over
   * video); off for card text, which sits on a user-controlled background. */
  private readonly textShadow: boolean;

  constructor(opts: { textShadow?: boolean } = {}) {
    this.app = new Application();
    this.overlayRoot = new Container();
    this.selectionOverlay = new Graphics();
    this.textShadow = opts.textShadow ?? true;
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

  /**
   * Force the next `setOverlays` to rebuild every node. Pixi caches a Text's
   * rasterised texture by style key, so once web fonts finish decoding a plain
   * re-render is a no-op — the nodes must be rebuilt to pick up the real face.
   */
  invalidate(): void {
    this.builtKey = '';
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
      if (overlay.type === 'line') continue; // generated callout lines aren't selectable
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

      const { w: lw, h: lh } = this.measuredSize(overlay);
      const sw = lw * scl;
      const sh = lh * scl;
      // Shift the box for the text anchor so it hugs left/right-aligned text.
      const ax = overlay.type === 'text' ? alignAnchorX(overlay.align) : 0.5;
      const cx = (pos.x + wobbleX) * w + (0.5 - ax) * sw;
      const cy = (pos.y + wobbleY) * h;

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
    if (overlay.type === 'line') {
      const w = Math.abs(overlay.to.x - overlay.from.x) * this.app.renderer.width;
      const h = Math.abs(overlay.to.y - overlay.from.y) * canvasH;
      return { w: Math.max(1, w), h: Math.max(1, h) };
    }
    return this.imagePixelSize(overlay, canvasH);
  }

  /**
   * Real (unscaled) box of a built node — uses Pixi's measured text/sprite size
   * so the hit-test and selection outline (which offset by the text anchor for
   * L/R alignment) hug the true edges incl. font width, letterSpacing, uppercase.
   * Falls back to the estimate before a node exists.
   */
  private measuredSize(overlay: Overlay): { w: number; h: number } {
    const node = this.nodes.get(overlay.id);
    if (node?.text) {
      const w = node.typewriterFullText
        ? CanvasTextMetrics.measureText(node.typewriterFullText, node.text.style).width
        : node.text.width;
      return { w, h: node.text.height };
    }
    if (node?.sprite) return { w: node.sprite.width, h: node.sprite.height };
    return this.logicalSize(overlay, this.app.renderer.height);
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
    // Structural key — a rebuild is forced when the layer set, z-order, OR a
    // text overlay's box/stroke/wrap PRESENCE changes (those add/remove child
    // display objects or initial style that patchNode can't toggle in place).
    // Their VALUES still update live via patchNode without a rebuild.
    const key = overlays.map((o) => {
      if (o.type === 'text') {
        const f = `${o.box ? 'B' : ''}${o.stroke ? 'S' : ''}${(o.wordWrapRel ?? 0) > 0 ? 'W' : ''}`;
        return `${o.id}:text:${o.z}:${f}`;
      }
      return `${o.id}:${o.type}:${o.z}`;
    }).join('|');
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

      // Line overlays are drawn in canvas-space from their endpoints, so they
      // bypass the container position/scale/rotation transform. The `scale`
      // track doubles as a 0..1 draw-on progress (segment grows from `from`).
      if (overlay.type === 'line') {
        const ltx = overlay.transform;
        const op = sampleNumber(ltx.opacity, tMs, overlay.base.opacity);
        const vFrom = overlay.visibleFrom ?? -Infinity;
        const vTo = overlay.visibleTo ?? Infinity;
        const visible = !overlay.hidden && tMs >= vFrom && tMs <= vTo && op > 0.001;
        node.container.visible = visible;
        node.container.position.set(0, 0);
        node.container.scale.set(1, 1);
        node.container.rotation = 0;
        node.container.alpha = op;
        node.blur.enabled = false;
        if (visible && node.line) {
          const progress = Math.max(0, Math.min(1, sampleNumber(ltx.scale, tMs, 1)));
          this.drawLine(node.line, overlay, progress, w, h);
        }
        continue;
      }

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
      // Auto-fit to the frame width: keep the authored size while it fits, and
      // shrink only when it would overflow (e.g. text authored in 16:9 then
      // viewed in 9:16). Measures the FULL text so a typewriter reveal doesn't
      // make the scale jump as characters appear.
      let fit = 1;
      const naturalW = node.text
        ? (node.typewriterFullText
          ? CanvasTextMetrics.measureText(node.typewriterFullText, node.text.style).width
          : node.text.width)
        : (node.sprite ? node.sprite.width : 0);
      const maxW = w * 0.92;
      if (naturalW > maxW && maxW > 0) fit = maxW / naturalW;
      node.container.scale.set(scl * fit);
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
        // Use the scale actually applied to the node (includes the auto-fit
        // shrink) so the outline hugs the rendered item.
        const effScale = selNode.container.scale.x;
        let wobbleX = 0, wobbleY = 0;
        if (selOverlay.idle) {
          wobbleX = Math.sin((tMs / selOverlay.idle.periodX) * Math.PI * 2 + selOverlay.idle.phase) * selOverlay.idle.ampX;
          wobbleY = Math.sin((tMs / selOverlay.idle.periodY) * Math.PI * 2 + selOverlay.idle.phase + Math.PI / 2) * selOverlay.idle.ampY;
        }
        const { w: lw, h: lh } = this.measuredSize(selOverlay);
        const sw = lw * effScale;
        const ax = selOverlay.type === 'text' ? alignAnchorX(selOverlay.align) : 0.5;
        const cx = (pos.x + wobbleX) * this.app.renderer.width + (0.5 - ax) * sw;
        const cy = (pos.y + wobbleY) * this.app.renderer.height;
        const sh = lh * effScale;
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
        const { container, text, box, fullText, shadowOn } = this.buildText(overlay, h);
        container.filters = [blur];
        return { overlay, container, text, sprite: null, line: null, box, blur, typewriterFullText: fullText, shadowOn };
      }
      case 'image': {
        const { container, sprite } = await this.buildImage(overlay, h);
        container.filters = [blur];
        return { overlay, container, text: null, sprite, line: null, box: null, blur, typewriterFullText: null, shadowOn: false };
      }
      case 'line': {
        const { container, line } = this.buildLine(overlay);
        container.filters = [blur];
        return { overlay, container, text: null, sprite: null, line, box: null, blur, typewriterFullText: null, shadowOn: false };
      }
    }
  }

  private buildLine(overlay: LineOverlay): { container: Container; line: Graphics } {
    const c = new Container();
    const g = new Graphics();
    c.addChild(g);
    this.drawLine(g, overlay, 1, this.app.renderer.width, this.app.renderer.height);
    return { container: c, line: g };
  }

  /** (Re)draw a line overlay to a fraction `progress` (0..1) of its length. */
  private drawLine(g: Graphics, overlay: LineOverlay, progress: number, w: number, h: number): void {
    g.clear();
    if (progress <= 0) return;
    const fx = overlay.from.x * w;
    const fy = overlay.from.y * h;
    const ex = fx + (overlay.to.x * w - fx) * progress;
    const ey = fy + (overlay.to.y * h - fy) * progress;
    const width = Math.max(1, overlay.thicknessRel * h);
    g.moveTo(fx, fy).lineTo(ex, ey).stroke({ width, color: overlay.color, cap: 'round' });
  }

  /**
   * Patch text content / color / sizeRel in place. Avoids tearing down sprites
   * for property edits (live preview while typing).
   */
  private patchNode(node: OverlayNode, overlay: Overlay, canvasH: number): void {
    const prevOverlay = node.overlay;
    node.overlay = overlay;
    // The overlay object is reused frame-to-frame while nothing changes (the
    // editor memoises it), so a new reference means the user edited the layer
    // (or its caption style). Used to gate pixel-based restyles (stroke) that
    // don't otherwise depend on per-frame state.
    const overlayChanged = prevOverlay !== overlay;
    if (overlay.type === 'text' && node.text) {
      const t = node.text;
      const desiredSize = Math.max(2, Math.round(overlay.sizeRel * canvasH));
      const style = t.style;
      const sizeChanged = style.fontSize !== desiredSize;
      if (sizeChanged) style.fontSize = desiredSize;
      if (style.fill !== overlay.color) style.fill = overlay.color;
      const desiredFamily = fontStack(overlay.fontFamily, overlay.mono);
      if (style.fontFamily !== desiredFamily) style.fontFamily = desiredFamily;
      const desiredWeight = String(snapWeight(overlay.fontFamily, overlay.mono, overlay.weight)) as
        'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900';
      if (style.fontWeight !== desiredWeight) style.fontWeight = desiredWeight;
      style.letterSpacing = overlay.letterSpacing ?? 0;
      style.align = overlay.align ?? 'center';
      const ax = alignAnchorX(overlay.align);
      if (t.anchor.x !== ax) t.anchor.set(ax, 0.5);
      const full = displayText(overlay);
      if (!overlay.typewriter && t.text !== full) t.text = full;
      node.typewriterFullText = overlay.typewriter ? full : null;
      // Toggle the drop-shadow without a rebuild; only restyle on change so the
      // text texture isn't re-rasterised every frame.
      const wantShadow = overlay.shadow ?? this.textShadow;
      if (node.shadowOn !== wantShadow) {
        style.dropShadow = wantShadow ? { ...TEXT_SHADOW } : false;
        node.shadowOn = wantShadow;
      }
      // Word-wrap width tracks the overlay + canvas width (captions). Presence
      // is fixed by the build key, so only the width can change here.
      let wrapChanged = false;
      if ((overlay.wordWrapRel ?? 0) > 0) {
        const wrapW = overlay.wordWrapRel! * this.app.renderer.width;
        if (!style.wordWrap) style.wordWrap = true;
        if (style.wordWrapWidth !== wrapW) { style.wordWrapWidth = wrapW; wrapChanged = true; }
      }
      // Outline value — only re-apply on a real edit (pixel-based, so resize is
      // irrelevant) to avoid re-rasterising the glyphs every frame.
      if (overlay.stroke && overlayChanged) {
        style.stroke = { color: overlay.stroke.color, width: overlay.stroke.width };
      }
      // Background pill hugs the text bounds — only redraw when those bounds
      // could have moved (edit, font-size or wrap-width change), not every frame.
      if (node.box && (overlayChanged || sizeChanged || wrapChanged)) {
        this.drawTextBox(node.box, t, overlay, desiredSize);
      }
    } else if (overlay.type === 'image' && node.sprite) {
      const target = this.imagePixelSize(overlay, canvasH);
      if (Math.abs(node.sprite.width - target.w) > 0.5) node.sprite.width = target.w;
      if (Math.abs(node.sprite.height - target.h) > 0.5) node.sprite.height = target.h;
    }
  }

  private buildText(overlay: TextOverlay, canvasH: number): {
    container: Container;
    text: Text;
    box: Graphics | null;
    fullText: string | null;
    shadowOn: boolean;
  } {
    const c = new Container();
    const isTypewriter = Boolean(overlay.typewriter);
    const full = displayText(overlay);
    const initial = isTypewriter ? '' : full;
    const fontSize = Math.max(2, Math.round(overlay.sizeRel * canvasH));
    // Per-item override wins; otherwise the stage default (off for card text).
    const shadowOn = overlay.shadow ?? this.textShadow;
    const wrap = overlay.wordWrapRel != null && overlay.wordWrapRel > 0;
    const t = new Text({
      text: initial,
      style: {
        fontFamily: fontStack(overlay.fontFamily, overlay.mono),
        fontSize,
        fontWeight: String(snapWeight(overlay.fontFamily, overlay.mono, overlay.weight)) as
          | 'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900',
        fill: overlay.color,
        letterSpacing: overlay.letterSpacing ?? 0,
        align: overlay.align ?? 'center',
        dropShadow: shadowOn ? { ...TEXT_SHADOW } : false,
        // Only include these when actually used — passing `stroke: undefined`
        // (or other defaults Pixi doesn't expect) can break Text construction,
        // which would silently abort the whole stage build.
        ...(overlay.stroke ? { stroke: { color: overlay.stroke.color, width: overlay.stroke.width } } : {}),
        ...(wrap ? { wordWrap: true, wordWrapWidth: overlay.wordWrapRel! * this.app.renderer.width } : {}),
      },
    });
    t.anchor.set(alignAnchorX(overlay.align), 0.5);
    // Background pill (captions): a rounded rect drawn BEHIND the text, sized to
    // the measured bounds + padding. Added first so it sits under the glyphs.
    let box: Graphics | null = null;
    if (overlay.box) {
      box = new Graphics();
      c.addChild(box);
      this.drawTextBox(box, t, overlay, fontSize);
    }
    c.addChild(t);
    return { container: c, text: t, box, fullText: isTypewriter ? full : null, shadowOn };
  }

  /** (Re)draw a caption's background pill to hug the current text bounds. */
  private drawTextBox(box: Graphics, text: Text, overlay: TextOverlay, fontSize: number): void {
    const spec = overlay.box;
    box.clear();
    if (!spec) return;
    const pad = Math.max(0, spec.padRel) * fontSize;
    const ax = alignAnchorX(overlay.align);
    const tw = text.width;
    const th = text.height;
    const left = -ax * tw - pad;
    const top = -th / 2 - pad;
    const w = tw + pad * 2;
    const hgt = th + pad * 2;
    const radius = Math.min(w, hgt) * 0.28;
    box.roundRect(left, top, w, hgt, radius).fill({ color: spec.color, alpha: spec.opacity });
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
