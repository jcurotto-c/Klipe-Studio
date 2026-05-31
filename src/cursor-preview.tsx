import pointerSvgUrl from './assets/pointer-cursor.svg';
import boneSvgUrl from './assets/cartoon-bone.svg';
import handSvgUrl from './assets/pointinghand_2.svg';
import resizeEwSvgUrl from './assets/resizeeastwest.svg';
import resizeNsSvgUrl from './assets/resizenorthsouth.svg';
import moveSvgUrl from './assets/resizeleftright.svg';

// Per-shape SVG metadata. Hotspot ratios match cursor-sprites.ts so the live
// preview lines up with the rendered cursor in the final video.
interface CursorShapeMeta {
  url: string;
  width: number;
  height: number;
  hotspotXRatio: number;
  hotspotYRatio: number;
}

const SHAPE_META: Record<'pointer' | 'bone' | 'hand' | 'resize-ew' | 'resize-ns' | 'move', CursorShapeMeta> = {
  pointer:     { url: pointerSvgUrl,  width: 618,        height: 958,  hotspotXRatio: 53 / 618,         hotspotYRatio: 37 / 958 },
  bone:        { url: boneSvgUrl,     width: 618,        height: 1350, hotspotXRatio: 309 / 618,        hotspotYRatio: 675 / 1350 },
  hand:        { url: handSvgUrl,     width: 618,        height: 767,  hotspotXRatio: 264 / 618,        hotspotYRatio: 24 / 767 },
  'resize-ew': { url: resizeEwSvgUrl, width: 400,        height: 400,  hotspotXRatio: 0.5,              hotspotYRatio: 0.5 },
  'resize-ns': { url: resizeNsSvgUrl, width: 400,        height: 400,  hotspotXRatio: 0.5,              hotspotYRatio: 0.5 },
  move:        { url: moveSvgUrl,     width: 618,        height: 618,  hotspotXRatio: 0.5,              hotspotYRatio: 0.5 },
};

type ShapeKey = keyof typeof SHAPE_META;

interface CursorPreviewBridge {
  onPos: (cb: (payload: { x: number; y: number; originX: number; originY: number }) => void) => () => void;
  onType: (cb: (payload: { cursorType: string }) => void) => () => void;
}

declare global {
  interface Window {
    klipeCursorPreview?: CursorPreviewBridge;
  }
}

const container = document.getElementById('cursor');
if (!container) throw new Error('#cursor element not found');

// Maintain three preloaded <img> elements layered in the same anchor div;
// only one is visible at a time. Swapping is a CSS class change — no
// flicker from re-decoding the SVG.
const images: Record<ShapeKey, HTMLImageElement> = {
  pointer:     document.createElement('img'),
  bone:        document.createElement('img'),
  hand:        document.createElement('img'),
  'resize-ew': document.createElement('img'),
  'resize-ns': document.createElement('img'),
  move:        document.createElement('img'),
};
let currentShape: ShapeKey = 'pointer';

(Object.keys(images) as ShapeKey[]).forEach((key) => {
  const meta = SHAPE_META[key];
  const img = images[key];
  img.src = meta.url;
  img.draggable = false;
  img.alt = '';
  img.className = `cursor-img ${key === 'pointer' ? 'active' : ''}`;
  img.dataset['shape'] = key;
  // Match the existing #cursor img CSS: width 28px, height auto. For non-
  // pointer shapes we override to keep the visual scale comparable to the
  // editor cursor — hand is wider than pointer, bone is taller.
  switch (key) {
    case 'bone': img.style.width = '20px'; break;  // I-beam looks better narrower
    // pointinghand_2 is a tight vector (little transparent margin), so a
    // smaller container than the old PNG hand keeps the fingertip near the
    // 28px pointer's scale.
    case 'hand': img.style.width = '34px'; break;
    // Resize/move glyphs fill most of their (tightly-cropped) canvas, so a
    // container a bit larger than the pointer reads at a comparable scale.
    case 'resize-ew':
    case 'resize-ns':
    case 'move': img.style.width = '40px'; break;
    default: break;
  }
  container.appendChild(img);
});

// Style the layered images so only the active one shows. We append a small
// stylesheet here to avoid touching cursor-preview.html for this detail.
const style = document.createElement('style');
style.textContent = `
  #cursor .cursor-img { display: none; }
  #cursor .cursor-img.active { display: block; }
`;
document.head.appendChild(style);

function activateShape(next: ShapeKey): void {
  if (next === currentShape) return;
  images[currentShape].classList.remove('active');
  images[next].classList.add('active');
  currentShape = next;
  // Hotspot offset depends on the active sprite's rendered size, which is
  // controlled by the rendered img width in CSS pixels (height auto). We
  // recompute on the next frame so getBoundingClientRect() reflects the
  // post-display-swap layout.
  requestAnimationFrame(recomputeHotspot);
}

let hotspotOffsetX = 0;
let hotspotOffsetY = 0;
function recomputeHotspot(): void {
  const active = images[currentShape];
  const rect = active.getBoundingClientRect();
  const meta = SHAPE_META[currentShape];
  hotspotOffsetX = rect.width * meta.hotspotXRatio;
  hotspotOffsetY = rect.height * meta.hotspotYRatio;
}

function onImagesLoaded(): void {
  recomputeHotspot();
  if (container) container.classList.add('ready');
}

let pendingLoads = (Object.keys(images) as ShapeKey[]).length;
(Object.keys(images) as ShapeKey[]).forEach((key) => {
  const img = images[key];
  const onDone = (): void => {
    pendingLoads -= 1;
    if (pendingLoads <= 0) onImagesLoaded();
  };
  if (img.complete) onDone();
  else img.addEventListener('load', onDone, { once: true });
});

// Map the OS-detected cursor type to one of our SVG slots. This mirrors
// renderer.ts:resolveCursorShape so the live preview matches the exported
// video. Anything without a dedicated glyph (crosshair, not-allowed, …)
// falls back to the pointer SVG (the editor's default when no override
// applies).
function resolveShape(cursorType: string): ShapeKey {
  if (cursorType === 'text') return 'bone';
  if (cursorType === 'pointer') return 'hand';
  if (cursorType === 'resize-ew') return 'resize-ew';
  if (cursorType === 'resize-ns') return 'resize-ns';
  if (cursorType === 'move') return 'move';
  return 'pointer';
}

const bridge = window.klipeCursorPreview;
if (!bridge) {
  console.warn('[cursor-preview] window.klipeCursorPreview missing; cursor will not move');
} else {
  bridge.onPos(({ x, y, originX, originY }) => {
    // Coordinates from main are in DIP relative to the global virtual screen.
    // The overlay window is positioned at (originX, originY), so subtract to
    // get window-local CSS pixels.
    const localX = x - originX - hotspotOffsetX;
    const localY = y - originY - hotspotOffsetY;
    container.style.transform = `translate(${localX}px, ${localY}px)`;
  });
  bridge.onType(({ cursorType }) => {
    activateShape(resolveShape(cursorType));
  });
}
