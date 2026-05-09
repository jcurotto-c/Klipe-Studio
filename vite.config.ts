import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WALLPAPERS_DIR = path.resolve(__dirname, 'public/ffmpeg/wallpapers');
const WALLPAPER_IMAGE_RE = /\.(jpe?g|png|webp|gif|avif)$/i;
const WALLPAPERS_VIRTUAL_ID = 'virtual:wallpapers';
const WALLPAPERS_RESOLVED_ID = '\0' + WALLPAPERS_VIRTUAL_ID;

function scanWallpapers(): string[] {
  if (!fs.existsSync(WALLPAPERS_DIR)) return [];
  return fs
    .readdirSync(WALLPAPERS_DIR)
    .filter((f) => WALLPAPER_IMAGE_RE.test(f))
    .sort();
}

function wallpapersManifestPlugin(): Plugin {
  return {
    name: 'klipe:wallpapers-manifest',
    resolveId(id) {
      if (id === WALLPAPERS_VIRTUAL_ID) return WALLPAPERS_RESOLVED_ID;
      return null;
    },
    load(id) {
      if (id !== WALLPAPERS_RESOLVED_ID) return null;
      const files = scanWallpapers();
      return `const files = ${JSON.stringify(files)};
const PREFIX = './ffmpeg/wallpapers/';
export default files.map(function (f) {
  const key = f.replace(/\\.[^.]+$/, '');
  const label = key
    .replace(/[-_]+/g, ' ')
    .replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
  return { key: key, src: PREFIX + f, label: label };
});
`;
    },
    configureServer(server) {
      server.watcher.add(WALLPAPERS_DIR);
      const reload = (filePath: string): void => {
        if (!filePath.startsWith(WALLPAPERS_DIR)) return;
        if (!WALLPAPER_IMAGE_RE.test(filePath)) return;
        const mod = server.moduleGraph.getModuleById(WALLPAPERS_RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', reload);
      server.watcher.on('unlink', reload);
      server.watcher.on('change', reload);
    },
  };
}

export default defineConfig({
  plugins: [react(), wallpapersManifestPlugin()],
  root: path.resolve(__dirname, 'src'),
  base: './',
  publicDir: path.resolve(__dirname, 'public'),
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src/index.html'),
        hud: path.resolve(__dirname, 'src/hud.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {},
});
