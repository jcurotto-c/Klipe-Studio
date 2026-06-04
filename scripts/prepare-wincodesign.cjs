#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Seeds electron-builder's `winCodeSign` vendor cache so `pnpm build` can
 * produce the NSIS installer on a vanilla Windows machine — no Administrator
 * shell and no "Developer Mode" toggle required.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every Windows build needs the `winCodeSign` package: it carries `rcedit.exe`
 * (which stamps the app icon + version into the .exe) and `signtool.exe`. It is
 * downloaded even for UNSIGNED builds. The archive ships two macOS symlinks
 * (darwin/10.12/lib/libcrypto.dylib, libssl.dylib). Creating a symbolic link on
 * Windows needs SeCreateSymbolicLinkPrivilege, which a standard user lacks, so
 * 7-Zip aborts with "Cannot create symbolic link / a required privilege is not
 * held by the client" and electron-builder dies *before* the NSIS step — you
 * get `release/win-unpacked` but never `Setup.exe`.
 *
 * WHAT WE DO
 * ----------
 * Run the bundled `app-builder download-artifact --name winCodeSign` exactly as
 * electron-builder would, but with a tiny `7za` shim ahead of it on PATH. The
 * shim excludes the macOS *.dylib symlinks (useless on Windows) so extraction
 * succeeds and app-builder can finish its own cache rename. The Windows tools
 * (rcedit, signtool) land intact.
 *
 * Idempotent — exits immediately if the vendor folder is already seeded.
 * Windows-only (no-op elsewhere). Runs from the `build` script before
 * electron-builder; also exposed as `pnpm setup:wincodesign`.
 *
 * The "real" alternative fixes are: enable Windows Developer Mode, or run the
 * build from an elevated terminal. This script just makes them unnecessary.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ARTIFACT = 'winCodeSign';

function main() {
  if (process.platform !== 'win32') {
    console.log(`[wincodesign] Skipped — Windows-only build step (platform=${process.platform}).`);
    return;
  }

  const vendorParent = path.join(cacheRoot(), ARTIFACT);

  if (isSeeded(vendorParent)) {
    console.log('[wincodesign] winCodeSign vendor tools already present — nothing to do.');
    return;
  }

  console.log('[wincodesign] Seeding winCodeSign (rcedit + signtool) so the NSIS installer can be built...');

  const appBuilder = resolvePnpmBinary('app-builder-bin', ['win/x64/app-builder.exe', 'win/ia32/app-builder.exe']);
  const real7za = resolvePnpmBinary('7zip-bin', ['win/x64/7za.exe', 'win/ia32/7za.exe']);
  if (!appBuilder) throw new Error('Could not locate app-builder.exe under node_modules.');
  if (!real7za) throw new Error('Could not locate 7za.exe under node_modules.');

  // A 7za shim that drops the macOS *.dylib symlinks (Windows can't create them
  // without symlink privilege) and always reports success, so app-builder can
  // complete its cache rename. We verify the real outcome below regardless.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klipe-7zwrap-'));
  const shim = path.join(shimDir, '7za.cmd');
  fs.writeFileSync(
    shim,
    ['@echo off', `"${real7za}" %* -xr!*.dylib`, 'exit /b 0', ''].join('\r\n'),
    'utf8',
  );

  try {
    const env = { ...process.env, PATH: shimDir + path.delimiter + process.env.PATH };
    const res = spawnSync(appBuilder, ['download-artifact', '--name', ARTIFACT], { env, stdio: 'inherit' });
    if (res.error) throw res.error;
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }

  if (!isSeeded(vendorParent)) {
    throw new Error(
      'winCodeSign seeding did not produce rcedit/signtool. ' +
        'Fallback: enable Windows Developer Mode (Settings > System > For developers) ' +
        'or run the build from an elevated terminal, then re-run `pnpm build`.',
    );
  }

  console.log('[wincodesign] Done — vendor tools cached.');
}

/** electron-builder's binary cache root (honours ELECTRON_BUILDER_CACHE). */
function cacheRoot() {
  const override = process.env.ELECTRON_BUILDER_CACHE;
  if (override && override.trim()) return path.resolve(override.trim());
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'electron-builder', 'Cache');
}

/** True if any winCodeSign-<version> folder already has the Windows tools. */
function isSeeded(vendorParent) {
  if (!fs.existsSync(vendorParent)) return false;
  for (const entry of fs.readdirSync(vendorParent)) {
    if (!entry.startsWith(`${ARTIFACT}-`)) continue;
    const dir = path.join(vendorParent, entry);
    const hasRcedit = fs.existsSync(path.join(dir, 'rcedit-x64.exe'));
    const hasSigntool = fs.existsSync(path.join(dir, 'windows-10', 'x64', 'signtool.exe'));
    if (hasRcedit && hasSigntool) return true;
  }
  return false;
}

/**
 * Locate a packaged binary. Works on hoisted/npm layouts via require.resolve and
 * on pnpm's default "isolated" layout by scanning node_modules/.pnpm/<pkg>@*.
 * `candidates` are tried in order (e.g. prefer win/x64 over win/ia32).
 */
function resolvePnpmBinary(pkgName, candidates) {
  const tryRoots = [];

  try {
    tryRoots.push(path.dirname(require.resolve(`${pkgName}/package.json`)));
  } catch {
    /* not resolvable from here — fall back to the pnpm store scan below */
  }

  const pnpmStore = path.join(PROJECT_ROOT, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmStore)) {
    const versioned = fs
      .readdirSync(pnpmStore)
      .filter((d) => d.startsWith(`${pkgName}@`))
      .sort()
      .reverse(); // prefer the highest version if several are present
    for (const v of versioned) {
      tryRoots.push(path.join(pnpmStore, v, 'node_modules', pkgName));
    }
  }

  for (const root of tryRoots) {
    for (const rel of candidates) {
      const p = path.join(root, ...rel.split('/'));
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

try {
  main();
} catch (err) {
  console.error('[wincodesign] ERROR:', err && err.message ? err.message : err);
  process.exit(1);
}
