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
// Geist Sans — neo-grotesque, tight and even on the diagonals, built for UI
// screenshots. Only the four cuts that get used: 400/500 for body, 600/700 for
// titles. Every bundled weight is warmed on boot, so shipping 100–900 would
// cost load time and installer size for faces nothing selects.
import '@fontsource/geist-sans/400.css';
import '@fontsource/geist-sans/500.css';
import '@fontsource/geist-sans/600.css';
import '@fontsource/geist-sans/700.css';
import '@fontsource/schibsted-grotesk/400.css';
import '@fontsource/schibsted-grotesk/500.css';
import '@fontsource/schibsted-grotesk/700.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/archivo/400.css';
import '@fontsource/archivo/500.css';
import '@fontsource/archivo/700.css';
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/700.css';
import '@fontsource/onest/400.css';
import '@fontsource/onest/500.css';
import '@fontsource/onest/700.css';
import '@fontsource/work-sans/400.css';
import '@fontsource/work-sans/500.css';
import '@fontsource/work-sans/600.css';
import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/700.css';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/rubik/400.css';
import '@fontsource/rubik/500.css';
import '@fontsource/rubik/700.css';
import '@fontsource/lexend/400.css';
import '@fontsource/lexend/500.css';
import '@fontsource/lexend/600.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/manrope/800.css';
// Display
import '@fontsource/outfit/400.css';
import '@fontsource/outfit/500.css';
import '@fontsource/outfit/600.css';
import '@fontsource/syne/600.css';
import '@fontsource/syne/700.css';
import '@fontsource/syne/800.css';
import '@fontsource/unbounded/400.css';
import '@fontsource/unbounded/600.css';
import '@fontsource/unbounded/800.css';
// Anton and Bebas Neue ship a single cut by design — they are display faces,
// not families. snapWeight resolves any request to that one weight.
import '@fontsource/anton/400.css';
import '@fontsource/bebas-neue/400.css';
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
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
// Serif
import '@fontsource/instrument-serif/400.css';
import '@fontsource/fraunces/600.css';
import '@fontsource/fraunces/700.css';
import '@fontsource/playfair-display/400.css';
import '@fontsource/playfair-display/600.css';
import '@fontsource/playfair-display/800.css';
import '@fontsource/newsreader/400.css';
import '@fontsource/newsreader/500.css';
import '@fontsource/newsreader/600.css';

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
  /**
   * Default letter-spacing for TITLE-sized text, as a fraction of the font size
   * (negative = tighter). Display type wants less tracking than the body cut a
   * face is spaced for, and how much is a property of the typeface.
   *
   * Only read where there is NO user-facing letter-spacing control — the brand
   * header. Text overlays carry their own `letterSpacing`, and defaulting it
   * here would silently re-space every existing project.
   */
  tracking?: number;
  /**
   * Weight that reads as a title in this face. Absent ⇒ 700. Geist's 600 already
   * has the stroke weight Inter needs 700 for; using one number for both makes
   * one of them wrong.
   */
  titleWeight?: number;
}

export const FONT_OPTIONS: ReadonlyArray<FontDef> = [
  // The fallback chains below run Inter → SF Pro Display → Geist Sans, the
  // house preference order. SF Pro Display can't be bundled (Apple's license
  // covers Apple platforms only), so it resolves on macOS and is inert on
  // Windows — which is why the two faces that CAN ship sit on either side of it.
  { id: 'inter', label: 'Inter', category: 'sans', family: 'Inter', stack: "'Inter', 'SF Pro Display', -apple-system, 'Geist Sans', system-ui, 'Segoe UI', Roboto, sans-serif", weights: [400, 500, 600, 700, 800, 900], tracking: -0.012, titleWeight: 700 },
  { id: 'geist-sans', label: 'Geist Sans', category: 'sans', family: 'Geist Sans', stack: "'Geist Sans', 'SF Pro Display', -apple-system, 'Inter', system-ui, sans-serif", weights: [400, 500, 600, 700], tracking: -0.015, titleWeight: 600 },
  // Squarish neo-grotesque — the closest OFL face to the Akzidenz/Univers
  // lineage that product brands in this space tend to commission.
  { id: 'schibsted-grotesk', label: 'Schibsted Grotesk', category: 'sans', family: 'Schibsted Grotesk', stack: "'Schibsted Grotesk', 'Inter', system-ui, sans-serif", weights: [400, 500, 700], tracking: -0.015, titleWeight: 700 },
  // Slightly condensed grotesque; the companion to the Instrument Serif already
  // bundled, so a card can pair the two without leaving the family.
  { id: 'instrument-sans', label: 'Instrument Sans', category: 'sans', family: 'Instrument Sans', stack: "'Instrument Sans', 'Inter', system-ui, sans-serif", weights: [400, 500, 600], tracking: -0.015, titleWeight: 600 },
  // Low-contrast geometric. Spaced generously for body text, so display sizes
  // need more pulled back than the grotesques above.
  { id: 'dm-sans', label: 'DM Sans', category: 'sans', family: 'DM Sans', stack: "'DM Sans', 'Inter', system-ui, sans-serif", weights: [400, 500, 700], tracking: -0.02, titleWeight: 700 },
  // Grotesque with a real display range — holds up both as a headline and as
  // the UI label text in a screen recording.
  { id: 'archivo', label: 'Archivo', category: 'sans', family: 'Archivo', stack: "'Archivo', 'Inter', system-ui, sans-serif", weights: [400, 500, 700], tracking: -0.015, titleWeight: 700 },
  // Deliberately characterless. The right pick when the product UI should be
  // the thing you look at and the caption should disappear.
  { id: 'public-sans', label: 'Public Sans', category: 'sans', family: 'Public Sans', stack: "'Public Sans', 'Inter', system-ui, sans-serif", weights: [400, 500, 700], tracking: -0.012, titleWeight: 700 },
  { id: 'onest', label: 'Onest', category: 'sans', family: 'Onest', stack: "'Onest', 'Inter', system-ui, sans-serif", weights: [400, 500, 700], tracking: -0.015, titleWeight: 600 },
  { id: 'work-sans', label: 'Work Sans', category: 'sans', family: 'Work Sans', stack: "'Work Sans', 'Inter', system-ui, sans-serif", weights: [400, 500, 600], tracking: -0.012, titleWeight: 600 },
  { id: 'plus-jakarta-sans', label: 'Plus Jakarta Sans', category: 'sans', family: 'Plus Jakarta Sans', stack: "'Plus Jakarta Sans', 'Inter', system-ui, sans-serif", weights: [400, 500, 700], tracking: -0.018, titleWeight: 700 },
  { id: 'figtree', label: 'Figtree', category: 'sans', family: 'Figtree', stack: "'Figtree', 'Inter', system-ui, sans-serif", weights: [400, 500, 700], tracking: -0.018, titleWeight: 700 },
  // Geometrics are spaced wide for body text, so display sizes need the most
  // pulled back of anything here.
  { id: 'poppins', label: 'Poppins', category: 'sans', family: 'Poppins', stack: "'Poppins', 'Inter', system-ui, sans-serif", weights: [400, 500, 600], tracking: -0.02, titleWeight: 600 },
  { id: 'rubik', label: 'Rubik', category: 'sans', family: 'Rubik', stack: "'Rubik', 'Inter', system-ui, sans-serif", weights: [400, 500, 700], tracking: -0.015, titleWeight: 600 },
  { id: 'lexend', label: 'Lexend', category: 'sans', family: 'Lexend', stack: "'Lexend', 'Inter', system-ui, sans-serif", weights: [400, 500, 600], tracking: -0.015, titleWeight: 600 },
  { id: 'manrope', label: 'Manrope', category: 'sans', family: 'Manrope', stack: "'Manrope', 'Inter', system-ui, sans-serif", weights: [600, 700, 800] },
  { id: 'space-grotesk', label: 'Space Grotesk', category: 'display', family: 'Space Grotesk', stack: "'Space Grotesk', 'Inter', sans-serif", weights: [500, 600, 700] },
  { id: 'sora', label: 'Sora', category: 'display', family: 'Sora', stack: "'Sora', 'Inter', sans-serif", weights: [600, 700, 800] },
  { id: 'bricolage', label: 'Bricolage Grotesque', category: 'display', family: 'Bricolage Grotesque', stack: "'Bricolage Grotesque', 'Inter', sans-serif", weights: [600, 700, 800] },
  // Pure geometric — circular bowls, wide. The one shape family the roster was
  // missing; everything else here is grotesque-derived.
  { id: 'outfit', label: 'Outfit', category: 'display', family: 'Outfit', stack: "'Outfit', 'Inter', sans-serif", weights: [400, 500, 600], tracking: -0.02, titleWeight: 600 },
  { id: 'syne', label: 'Syne', category: 'display', family: 'Syne', stack: "'Syne', 'Inter', sans-serif", weights: [600, 700, 800], tracking: -0.01, titleWeight: 700 },
  { id: 'unbounded', label: 'Unbounded', category: 'display', family: 'Unbounded', stack: "'Unbounded', 'Inter', sans-serif", weights: [400, 600, 800], tracking: -0.01, titleWeight: 600 },
  // Heavy condensed — one word across the frame. Already tight, so barely any
  // tracking correction, and its single cut IS the title weight.
  { id: 'anton', label: 'Anton', category: 'display', family: 'Anton', stack: "'Anton', 'Inter', sans-serif", weights: [400], tracking: -0.005, titleWeight: 400 },
  // UPPERCASE ONLY — lowercase codepoints render as caps. That is the face
  // working as designed, not a loading failure. Condensed caps set tight turn
  // muddy, so this is the one entry with POSITIVE tracking.
  { id: 'bebas-neue', label: 'Bebas Neue', category: 'display', family: 'Bebas Neue', stack: "'Bebas Neue', 'Inter', sans-serif", weights: [400], tracking: 0.015, titleWeight: 400 },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', category: 'mono', family: 'JetBrains Mono', stack: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace", weights: [400, 500, 600, 700] },
  // Mono tracking stays 0: tightening a monospace defeats the point of it.
  { id: 'geist-mono', label: 'Geist Mono', category: 'mono', family: 'Geist Mono', stack: "'Geist Mono', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace", weights: [400, 500], titleWeight: 500 },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', category: 'mono', family: 'IBM Plex Mono', stack: "'IBM Plex Mono', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace", weights: [400, 500, 600], titleWeight: 500 },
  { id: 'instrument-serif', label: 'Instrument Serif', category: 'serif', family: 'Instrument Serif', stack: "'Instrument Serif', Georgia, 'Times New Roman', serif", weights: [400] },
  { id: 'fraunces', label: 'Fraunces', category: 'serif', family: 'Fraunces', stack: "'Fraunces', Georgia, serif", weights: [600, 700] },
  { id: 'playfair-display', label: 'Playfair Display', category: 'serif', family: 'Playfair Display', stack: "'Playfair Display', Georgia, serif", weights: [400, 600, 800], tracking: -0.01, titleWeight: 600 },
  { id: 'newsreader', label: 'Newsreader', category: 'serif', family: 'Newsreader', stack: "'Newsreader', Georgia, serif", weights: [400, 500, 600], tracking: -0.005, titleWeight: 600 },
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

/**
 * Title letter-spacing for a font, as a fraction of the font size. 0 when the
 * face declares none. Multiply by the pixel size for `ctx.letterSpacing`.
 *
 * NOTE this can only ever be applied through `ctx.letterSpacing` — canvas 2D
 * has no `fontFeatureSettings`, and the `FontFace` featureSettings descriptor
 * is accepted but ignored by the canvas rasteriser (measured: a face's `tnum`
 * changes DOM metrics by ~20% and canvas output by zero pixels). So typographic
 * polish here has to come from spacing and weight, not OpenType features.
 */
export function fontTracking(fontId: string | undefined): number {
  return byId.get(resolveFontId(fontId))?.tracking ?? 0;
}

/** Weight that reads as a title in this face. 700 when unspecified. */
export function fontTitleWeight(fontId: string | undefined): number {
  return byId.get(resolveFontId(fontId))?.titleWeight ?? 700;
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
