/**
 * Self-hosted fonts for card / overlay text. Bundled via @fontsource so they
 * render IDENTICALLY in the live preview and the one-shot MP4 export, and work
 * offline in Electron (no external font requests). System fonts can't be relied
 * on — "Inter" isn't installed on stock Windows, so a bare reference silently
 * fell back to Segoe UI.
 *
 * Pixi rasterises text to canvas with whatever the browser has loaded at that
 * instant, so a definitive render (the export, especially) MUST first
 * `await ensureFontsReady()` — otherwise a not-yet-loaded face bakes in as a
 * fallback and the file won't match the editor.
 */

// Clean sans
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/inter/900.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/manrope/800.css';
// Display
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/sora/600.css';
import '@fontsource/sora/700.css';
import '@fontsource/sora/800.css';
import '@fontsource/bricolage-grotesque/600.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/bricolage-grotesque/800.css';
// Mono
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
// Serif
import '@fontsource/instrument-serif/400.css';
import '@fontsource/fraunces/600.css';
import '@fontsource/fraunces/700.css';

export interface FontDef {
  id: string;
  label: string;
  category: 'sans' | 'display' | 'mono' | 'serif';
  /** Primary family name as registered by @fontsource (for document.fonts.load). */
  family: string;
  /** Full CSS font-family stack, with fallbacks. */
  stack: string;
  /** Exact weights bundled (must match the @fontsource imports above). Used to
   * warm every shipped weight and to snap requested weights to a real cut. */
  weights: number[];
}

export const FONT_OPTIONS: ReadonlyArray<FontDef> = [
  { id: 'inter', label: 'Inter', category: 'sans', family: 'Inter', stack: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", weights: [400, 500, 600, 700, 800, 900] },
  { id: 'manrope', label: 'Manrope', category: 'sans', family: 'Manrope', stack: "'Manrope', 'Inter', system-ui, sans-serif", weights: [600, 700, 800] },
  { id: 'space-grotesk', label: 'Space Grotesk', category: 'display', family: 'Space Grotesk', stack: "'Space Grotesk', 'Inter', sans-serif", weights: [500, 600, 700] },
  { id: 'sora', label: 'Sora', category: 'display', family: 'Sora', stack: "'Sora', 'Inter', sans-serif", weights: [600, 700, 800] },
  { id: 'bricolage', label: 'Bricolage Grotesque', category: 'display', family: 'Bricolage Grotesque', stack: "'Bricolage Grotesque', 'Inter', sans-serif", weights: [600, 700, 800] },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', category: 'mono', family: 'JetBrains Mono', stack: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace", weights: [400, 500, 600, 700] },
  { id: 'instrument-serif', label: 'Instrument Serif', category: 'serif', family: 'Instrument Serif', stack: "'Instrument Serif', Georgia, 'Times New Roman', serif", weights: [400] },
  { id: 'fraunces', label: 'Fraunces', category: 'serif', family: 'Fraunces', stack: "'Fraunces', Georgia, serif", weights: [600, 700] },
];

export const DEFAULT_FONT_ID = 'inter';
const MONO_FONT_ID = 'jetbrains-mono';

const byId = new Map(FONT_OPTIONS.map((f) => [f.id, f]));

/** The CSS stack for a font id, falling back to the default. */
export function fontStackById(fontId: string | undefined): string {
  return (fontId && byId.get(fontId)?.stack) || byId.get(DEFAULT_FONT_ID)!.stack;
}

/**
 * Resolve a text overlay's font → CSS stack. An explicit `fontFamily` id wins;
 * otherwise the legacy `mono` boolean (pre-picker) maps to JetBrains Mono.
 */
export function fontStack(fontId: string | undefined, mono?: boolean): string {
  if (fontId && byId.has(fontId)) return byId.get(fontId)!.stack;
  return byId.get(mono ? MONO_FONT_ID : DEFAULT_FONT_ID)!.stack;
}

/** The font id a text overlay is effectively using (for the picker's value). */
export function resolveFontId(fontId: string | undefined, mono?: boolean): string {
  if (fontId && byId.has(fontId)) return fontId;
  return mono ? MONO_FONT_ID : DEFAULT_FONT_ID;
}

/**
 * Snap a requested weight to the nearest weight the resolved font actually
 * ships, so a single-weight face (e.g. Instrument Serif = 400 only) renders its
 * real cut instead of a synthesised faux-bold — and identically in preview and
 * export.
 */
export function snapWeight(fontId: string | undefined, mono: boolean | undefined, weight: number | undefined): number {
  const def = byId.get(resolveFontId(fontId, mono));
  const w = weight ?? 700;
  if (!def || def.weights.length === 0) return w;
  return def.weights.reduce((best, cur) => (Math.abs(cur - w) < Math.abs(best - w) ? cur : best), def.weights[0]!);
}

let readyPromise: Promise<void> | null = null;
/**
 * Resolve once every bundled face has loaded. Idempotent + cached. Best-effort
 * (never rejects) so a font hiccup can't abort an export.
 */
export function ensureFontsReady(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    try {
      const fonts = (globalThis as { document?: Document }).document?.fonts;
      if (!fonts) return;
      // Warm EVERY bundled weight — @fontsource faces load lazily (font-display:
      // swap), so a weight that's never requested stays undecoded and would bake
      // a fallback into the one-shot export. Templates use 600/800/900, etc.
      await Promise.all(
        FONT_OPTIONS.flatMap((f) => f.weights.map((w) => fonts.load(`${w} 32px "${f.family}"`)))
          .map((p) => Promise.resolve(p).catch(() => undefined)),
      );
      await fonts.ready;
    } catch { /* fonts are best-effort */ }
  })();
  return readyPromise;
}
