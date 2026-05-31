/**
 * Social-platform export presets.
 *
 * Picking a platform is a one-click shortcut that fills in the export's
 * aspect ratio, resolution and format, and — for platforms whose UI overlaps
 * the video (TikTok caption/actions, Reels, Shorts) — drives the on-canvas
 * "safe zone" guides so the user keeps important content clear of the
 * platform chrome.
 *
 * The `aspectId` values intentionally reuse the editor's existing
 * `ASPECT_OPTIONS` ids (see EditorView) so a platform simply selects an
 * aspect the editor already understands — no new ratios are invented.
 */

import youtubeIcon from '../assets/social-media/youtube.svg';
import tiktokIcon from '../assets/social-media/TikTok_light.svg';
import instagramIcon from '../assets/social-media/instagram-icon.svg';
import linkedinIcon from '../assets/social-media/linkedin.svg';
import facebookIcon from '../assets/social-media/facebook-icon.svg';
import type { ExportFormat, ResolutionName } from './exporter';

export type PlatformId =
  | 'none'
  | 'youtube'
  | 'youtube-short'
  | 'tiktok'
  | 'instagram'
  | 'linkedin'
  | 'facebook';

/**
 * Fractions (0..1) of each edge that the platform's own UI typically covers.
 * Used only to draw editing guides — never baked into the exported file.
 */
export interface SafeZones {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Platform {
  id: PlatformId;
  label: string;
  /** URL of the brand SVG. Absent for the "Custom" (none) entry. */
  icon?: string;
  /** Must match an id in EditorView's ASPECT_OPTIONS. */
  aspectId: string;
  /** w/h ratio; null follows the source recording. */
  aspect: number | null;
  resolution: ResolutionName;
  format: ExportFormat;
  /** Present only for platforms with relevant overlapping UI. */
  safe?: SafeZones;
}

export const PLATFORMS: readonly Platform[] = [
  { id: 'none', label: 'Custom', aspectId: 'auto', aspect: null, resolution: '1080p', format: 'mp4' },
  {
    id: 'youtube',
    label: 'YouTube',
    icon: youtubeIcon,
    aspectId: '16:9',
    aspect: 16 / 9,
    resolution: '1080p',
    format: 'mp4',
    // Title card / end-screen elements + progress bar.
    safe: { top: 0.04, bottom: 0.08, left: 0.04, right: 0.04 },
  },
  {
    id: 'youtube-short',
    label: 'YouTube Short',
    icon: youtubeIcon,
    aspectId: '9:16',
    aspect: 9 / 16,
    resolution: '1080p',
    format: 'mp4',
    safe: { top: 0.05, bottom: 0.16, left: 0.03, right: 0.12 },
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    icon: tiktokIcon,
    aspectId: '9:16',
    aspect: 9 / 16,
    resolution: '1080p',
    format: 'mp4',
    safe: { top: 0.07, bottom: 0.18, left: 0.03, right: 0.12 },
  },
  {
    id: 'instagram',
    label: 'Instagram Reels',
    icon: instagramIcon,
    aspectId: '9:16',
    aspect: 9 / 16,
    resolution: '1080p',
    format: 'mp4',
    safe: { top: 0.06, bottom: 0.20, left: 0.03, right: 0.13 },
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    icon: linkedinIcon,
    aspectId: '16:9',
    aspect: 16 / 9,
    resolution: '1080p',
    format: 'mp4',
    safe: { top: 0.04, bottom: 0.05, left: 0.04, right: 0.04 },
  },
  {
    id: 'facebook',
    label: 'Facebook',
    icon: facebookIcon,
    aspectId: '16:9',
    aspect: 16 / 9,
    resolution: '1080p',
    format: 'mp4',
    safe: { top: 0.04, bottom: 0.08, left: 0.04, right: 0.04 },
  },
];

/** Resolve a platform by id, falling back to the "Custom" (none) entry. */
export function getPlatform(id: string | null | undefined): Platform {
  return PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[0]!;
}
