/**
 * Shared image downscaler for user uploads that end up INLINE in the project
 * document as data URLs (camera backgrounds, the brand-header logo).
 *
 * A 4K photo or a screenshot-sized PNG is multi-MB as base64; dropped straight
 * into `frameOptions` or a card config it bloats every project save, and in
 * EditorView's case it would be re-serialized to localStorage on every keystroke.
 * Capping the long edge and re-encoding to WebP takes it to ~100-200 KB.
 */

/** Long-edge cap for a brand-header logo. It never draws larger than ~1/5 of the canvas. */
export const LOGO_MAX_UPLOAD_W = 512;

/**
 * Cap a data URL's width and re-encode it to WebP. Lossy WebP keeps the alpha
 * channel, so a transparent PNG logo survives.
 *
 * SVG is passed through untouched: rasterising it here would throw away the one
 * thing it's good for — staying sharp in a 4K export — and it's already tiny.
 * Falls back to the input if decode or canvas encode fails.
 */
export function downscaleDataUrl(
  dataUrl: string,
  maxW: number,
  /** Logos carry hard edges that lossy WebP smears — they pass a higher value. */
  quality = 0.85,
): Promise<string> {
  if (dataUrl.startsWith('data:image/svg')) return Promise.resolve(dataUrl);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        // Re-encode even when no resize is needed: a lossless PNG is often the
        // bulk of the payload regardless of its pixel dimensions.
        const scale = Math.min(1, maxW / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(dataUrl); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/webp', quality));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/** `downscaleDataUrl` for a browser `File` (drag-drop / `<input type=file>`). */
export function downscaleFile(file: File, maxW: number, quality?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const raw = reader.result;
      if (typeof raw !== 'string') { reject(new Error('not a data url')); return; }
      resolve(downscaleDataUrl(raw, maxW, quality));
    };
    reader.readAsDataURL(file);
  });
}
