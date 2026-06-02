// One-off generator: rasterize the brand SVG into a multi-size Windows .ico
// (plus a 256px PNG) using Electron's bundled Chromium — no extra dependencies.
//
//   pnpm make:icon      (or: npx electron scripts/make-icon.cjs)
//
// Re-run whenever src/assets/branding/klipe-icon.svg changes.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'src', 'assets', 'branding', 'klipe-icon.svg');
const OUT_DIR = path.join(ROOT, 'build');
const ICO_PATH = path.join(OUT_DIR, 'icon.ico');
const PNG_PATH = path.join(OUT_DIR, 'icon.png');
// Windows shell uses 16/32/48/256 most; the rest cover odd DPI scales.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// Pack an array of PNG buffers into a Vista-style PNG-compressed .ico.
function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(count, 4); // image count

  const dir = [];
  let offset = 6 + count * 16;
  for (const { size, buf } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width  (0 => 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 => 256)
    e.writeUInt8(0, 2); // palette colors
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(buf.length, 8); // PNG byte length
    e.writeUInt32LE(offset, 12); // offset to PNG data
    dir.push(e);
    offset += buf.length;
  }
  return Buffer.concat([header, ...dir, ...images.map((i) => i.buf)]);
}

// Avoid GPU init when running headless/hidden.
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(SVG_PATH, 'utf8');

    const win = new BrowserWindow({ show: false, width: 320, height: 320 });
    await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8"><body></body>');

    // Rasterize inside Chromium. For each size we force the SVG's intrinsic
    // width/height to the target so the vector is rendered crisply at that
    // resolution (rather than rasterized once and bilinearly upscaled).
    const dataUrls = await win.webContents.executeJavaScript(`(async () => {
      const sizes = ${JSON.stringify(SIZES)};
      const rawSvg = ${JSON.stringify(svg)};
      const svgAt = (size) => {
        const sized = rawSvg.replace(/<svg([^>]*?)>/, (_m, attrs) => {
          const a = attrs.replace(/\\swidth="[^"]*"/, '').replace(/\\sheight="[^"]*"/, '');
          return '<svg' + a + ' width="' + size + '" height="' + size + '">';
        });
        return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(sized)));
      };
      const rasterize = (size) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = size; c.height = size;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.clearRect(0, 0, size, size);
          ctx.drawImage(img, 0, 0, size, size);
          resolve(c.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = () => reject(new Error('SVG failed to load at size ' + size));
        img.src = svgAt(size);
      });
      const out = {};
      for (const s of sizes) out[s] = await rasterize(s);
      return out;
    })()`);

    const images = SIZES.map((size) => ({
      size,
      buf: Buffer.from(dataUrls[String(size)], 'base64'),
    }));

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(ICO_PATH, buildIco(images));
    const png256 = images.find((i) => i.size === 256);
    if (png256) fs.writeFileSync(PNG_PATH, png256.buf);

    console.log('[make-icon] wrote ' + ICO_PATH + ' (sizes: ' + SIZES.join(', ') + ')');
    console.log('[make-icon] wrote ' + PNG_PATH);
    win.destroy();
    app.exit(0);
  } catch (err) {
    console.error('[make-icon] FAILED:', err);
    app.exit(1);
  }
});
