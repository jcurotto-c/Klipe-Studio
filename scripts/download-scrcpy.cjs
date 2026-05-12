#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Downloads the pinned scrcpy Windows release and extracts it (flat) into
 * `binaries/` at the project root. Runs as part of `npm install` via the
 * `postinstall` script.
 *
 * Idempotent — if `binaries/scrcpy.exe` already exists, exits immediately.
 * Network failure → prints a warning, exits 0 so `npm install` itself
 * succeeds. The user can re-run `npm run setup:scrcpy` to retry.
 *
 * To upgrade scrcpy: bump SCRCPY_VERSION below and delete `binaries/`.
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const extract = require('extract-zip');

const SCRCPY_VERSION = 'v2.7';
const SCRCPY_WIN64_URL = `https://github.com/Genymobile/scrcpy/releases/download/${SCRCPY_VERSION}/scrcpy-win64-${SCRCPY_VERSION}.zip`;

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BINARIES_DIR = path.join(PROJECT_ROOT, 'binaries');
const ZIP_PATH = path.join(BINARIES_DIR, '.scrcpy.zip');
const MARKER = path.join(BINARIES_DIR, 'scrcpy.exe');
const VERSION_FILE = path.join(BINARIES_DIR, '.version');

async function main() {
  if (process.platform !== 'win32') {
    console.log(
      `[scrcpy-setup] Skipped — Klipe Studio currently ships Windows-only (platform=${process.platform}).`,
    );
    console.log('   Phone-recording features will be unavailable on this OS.');
    return;
  }

  if (fs.existsSync(MARKER) && readVersion() === SCRCPY_VERSION) {
    console.log(`[scrcpy-setup] scrcpy ${SCRCPY_VERSION} already installed.`);
    return;
  }

  console.log(`[scrcpy-setup] Downloading scrcpy ${SCRCPY_VERSION}...`);
  console.log(`   ${SCRCPY_WIN64_URL}`);

  fs.mkdirSync(BINARIES_DIR, { recursive: true });

  try {
    await downloadWithRedirects(SCRCPY_WIN64_URL, ZIP_PATH);
    console.log('[scrcpy-setup] Extracting...');

    // Wipe the binaries dir contents (keep our own directory) so a version
    // bump cleanly replaces the old install. We only delete files we
    // recognize: scrcpy.exe, adb.exe, AdbWinApi*.dll, *.jar, LICENSE.txt, etc.
    // Safer: nuke and recreate.
    for (const entry of fs.readdirSync(BINARIES_DIR)) {
      if (entry === '.scrcpy.zip') continue; // currently downloading
      const p = path.join(BINARIES_DIR, entry);
      fs.rmSync(p, { recursive: true, force: true });
    }

    const extractTmp = path.join(BINARIES_DIR, '.extract');
    fs.mkdirSync(extractTmp, { recursive: true });
    await extract(ZIP_PATH, { dir: extractTmp });

    // scrcpy's zip is a single inner directory like `scrcpy-win64-v2.7/`.
    // Flatten that directory's contents directly into `binaries/`.
    const inner = fs.readdirSync(extractTmp)
      .filter((n) => fs.statSync(path.join(extractTmp, n)).isDirectory());
    const sourceDir = inner.length === 1
      ? path.join(extractTmp, inner[0])
      : extractTmp;
    for (const entry of fs.readdirSync(sourceDir)) {
      fs.renameSync(path.join(sourceDir, entry), path.join(BINARIES_DIR, entry));
    }

    fs.rmSync(extractTmp, { recursive: true, force: true });
    fs.unlinkSync(ZIP_PATH);
    fs.writeFileSync(VERSION_FILE, SCRCPY_VERSION + '\n', 'utf8');

    console.log(`[scrcpy-setup] Installed scrcpy + adb in ${BINARIES_DIR}`);
  } catch (err) {
    console.warn('[scrcpy-setup] WARNING: failed to install scrcpy.');
    console.warn('   Reason:', err && err.message ? err.message : err);
    console.warn('   Phone recording will be disabled until you run `npm run setup:scrcpy` again.');
    // Exit 0 — don't fail `npm install` on a network hiccup.
  }
}

function readVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch { return null; }
}

function downloadWithRedirects(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) { reject(new Error('Too many redirects')); return; }
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode != null && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        downloadWithRedirects(res.headers.location, dest, depth + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      let nextReportPct = 10;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const pct = Math.floor((downloaded / total) * 100);
          if (pct >= nextReportPct) {
            console.log(`   ${pct}% (${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)`);
            nextReportPct = pct + 10;
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => reject(err));
    });
    req.on('error', (err) => {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      reject(err);
    });
    req.setTimeout(60_000, () => {
      req.destroy(new Error('Download timed out after 60s'));
    });
  });
}

main().catch((err) => {
  console.warn('[scrcpy-setup] Unexpected error:', err);
  // Still exit 0.
});
