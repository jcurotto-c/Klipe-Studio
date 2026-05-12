declare module 'virtual:wallpapers' {
  export interface WallpaperManifestEntry {
    key: string;
    src: string;
    label: string;
  }
  const presets: WallpaperManifestEntry[];
  export default presets;
}

// Allow `import './foo.css'` side-effect imports from components without
// needing vite/client types loaded (the project sets `types: []`).
declare module '*.css';
