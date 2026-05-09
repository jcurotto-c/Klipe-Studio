declare module 'virtual:wallpapers' {
  export interface WallpaperManifestEntry {
    key: string;
    src: string;
    label: string;
  }
  const presets: WallpaperManifestEntry[];
  export default presets;
}
