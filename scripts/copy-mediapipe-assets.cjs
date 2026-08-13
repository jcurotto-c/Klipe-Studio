#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Stages the MediaPipe Tasks-Vision assets the camera-background feature needs
 * into `public/mediapipe/` so Vite copies them verbatim into `dist/` at build
 * time. Runs as part of `pnpm install` via `postinstall`.
 *
 * Two sources:
 *   - The SIMD WASM runtime (`vision_wasm_internal.js` + `.wasm`) is COPIED from
 *     the installed `@mediapipe/tasks-vision` package (always present after
 *     `pnpm install`). We ship SIMD only — the app targets chrome120 / Electron,
 *     which guarantees WASM SIMD, so `nosimd` would be dead weight.
 *   - The selfie-segmenter model (`selfie_segmenter_landscape.tflite`, ~250 KB)
 *     is DOWNLOADED from Google's mediapipe-models CDN and integrity-checked
 *     against a pinned SHA-256 (same posture as download-scrcpy.cjs).
 *
 * Why not fetch these at runtime? Production runs from `file://`, where a
 * renderer `fetch()` to a local path fails. The assets must live on disk and be
 * handed to the renderer via the `ml:read-asset` IPC channel (see electron/main.ts).
 *
 * Idempotent — skips work already done. Network failure on the model download
 * prints a warning and exits 0 so `pnpm install` still succeeds; the user can
 * re-run `pnpm setup:mediapipe` to retry.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WASM_SRC_DIR = path.join(PROJECT_ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const DEST_DIR = path.join(PROJECT_ROOT, 'public', 'mediapipe');

// SIMD runtime files copied from the npm package.
const WASM_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];

// Pinned model. To upgrade: bump the URL, download, recompute the hash with
//   node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('public/mediapipe/selfie_segmenter_landscape.tflite')).digest('hex').toUpperCase())"
const MODEL_NAME = 'selfie_segmenter_landscape.tflite';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite';
const MODEL_SHA256 = '490E9EA734313E0DE10FA0CD9E3C6133E36EA4DB2B7A49BDE9EF019F72796B8E';

async function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });

  // 1. Copy the WASM runtime from node_modules (idempotent by size match).
  if (!fs.existsSync(WASM_SRC_DIR)) {
    console.warn('[mediapipe-setup] WARNING: @mediapipe/tasks-vision not installed — skipping WASM copy.');
  } else {
    for (const name of WASM_FILES) {
      const src = path.join(WASM_SRC_DIR, name);
      const dest = path.join(DEST_DIR, name);
      if (!fs.existsSync(src)) {
        console.warn(`[mediapipe-setup] WARNING: missing ${name} in package — camera background may not load.`);
        continue;
      }
      if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) continue;
      fs.copyFileSync(src, dest);
      console.log(`[mediapipe-setup] Copied ${name}`);
    }
  }

  // 2. Download + verify the model (idempotent by hash).
  const modelDest = path.join(DEST_DIR, MODEL_NAME);
  if (fs.existsSync(modelDest) && sha256(modelDest) === MODEL_SHA256) {
    console.log('[mediapipe-setup] Model already present (integrity verified).');
    return;
  }

  console.log(`[mediapipe-setup] Downloading ${MODEL_NAME}...`);
  try {
    await downloadWithRedirects(MODEL_URL, modelDest);
    const actual = sha256(modelDest);
    if (actual !== MODEL_SHA256) {
      try { fs.unlinkSync(modelDest); } catch { /* ignore */ }
      throw new Error(`Model integrity check failed (expected ${MODEL_SHA256}, got ${actual}) — file removed.`);
    }
    console.log('[mediapipe-setup] Model installed (integrity verified).');
  } catch (err) {
    console.warn('[mediapipe-setup] WARNING: failed to install the selfie-segmenter model.');
    console.warn('   Reason:', err && err.message ? err.message : err);
    console.warn('   Camera background replacement will be disabled until you run `pnpm setup:mediapipe` again.');
    // Exit 0 — don't fail `pnpm install` on a network hiccup.
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
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
  console.warn('[mediapipe-setup] Unexpected error:', err);
  // Still exit 0.
});
