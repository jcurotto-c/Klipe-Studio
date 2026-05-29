# Third-Party Notices

Klipe Studio is licensed under the **GNU General Public License v3.0 or later**
(see [LICENSE](./LICENSE)). It also distributes the third-party components listed
below.

These binaries are **not** part of Klipe Studio's source code. They are
downloaded at install time from the official **scrcpy** Windows release by
[`scripts/download-scrcpy.cjs`](./scripts/download-scrcpy.cjs) (and verified by
SHA-256), then bundled into the Windows installer via electron-builder
`extraResources`. They live in `binaries/` and are only required for the
optional **Android phone-mirroring** feature.

GPL-3.0 is compatible with every license listed here, so the combined
distribution is compliant.

---

## scrcpy 2.7

- **Files:** `scrcpy.exe`, `scrcpy-server`, `scrcpy-console.bat`, `scrcpy-noconsole.vbs`
- **License:** Apache License 2.0
- **Copyright:** © Genymobile / Romain Vimont and contributors
- **Project:** https://github.com/Genymobile/scrcpy
- **License text:** https://github.com/Genymobile/scrcpy/blob/master/LICENSE

## FFmpeg (shared libraries bundled inside the scrcpy release)

- **Files:** `avcodec-61.dll`, `avformat-61.dll`, `avutil-59.dll`, `swresample-5.dll`
- **License:** GNU LGPL v2.1+ — and/or GNU GPL v2+ depending on the upstream build configuration
- **Copyright:** © The FFmpeg developers
- **Project:** https://ffmpeg.org — Legal: https://www.ffmpeg.org/legal.html
- **Written offer of source (GPL/LGPL requirement):** The complete corresponding
  source for the FFmpeg version shipped with scrcpy 2.7 is available from
  https://ffmpeg.org/download.html and via scrcpy's documented build process at
  https://github.com/Genymobile/scrcpy/blob/master/doc/build.md . These FFmpeg
  libraries are dynamically linked.

> Note: Klipe Studio's own screen recording and video export do **not** use
> FFmpeg — they use the operating system's hardware encoder via the browser
> **WebCodecs** API (`VideoEncoder`/`VideoDecoder`) plus
> [mediabunny](https://www.npmjs.com/package/mediabunny) for demux/mux. FFmpeg is
> present solely as a runtime dependency of scrcpy.

## SDL (SDL2)

- **File:** `SDL2.dll`
- **License:** zlib license
- **Copyright:** © Sam Lantinga and the SDL contributors
- **Project:** https://www.libsdl.org
- **License text:** https://github.com/libsdl-org/SDL/blob/main/LICENSE.txt

## libusb

- **File:** `libusb-1.0.dll`
- **License:** GNU LGPL v2.1 or later
- **Copyright:** © The libusb contributors
- **Project:** https://libusb.info
- **License text:** https://github.com/libusb/libusb/blob/master/COPYING

## Android SDK Platform-Tools (adb)

- **Files:** `adb.exe`, `AdbWinApi.dll`, `AdbWinUsbApi.dll`
- **License:** Apache License 2.0 (Android Open Source Project)
- **Copyright:** © The Android Open Source Project
- **Project:** https://developer.android.com/tools/releases/platform-tools

---

## Bundled npm packages

The application bundles its JavaScript dependencies (React, PixiJS, mediabunny,
Zustand, Framer Motion, and their transitive dependencies). These are released
under permissive licenses (mostly MIT, ISC and Apache-2.0). A full machine-readable
inventory can be generated with a tool such as `license-checker`:

```bash
npx license-checker --production --summary
```

---

## Removing the bundled binaries

If you build a distribution **without** Android phone-mirroring, none of the
binaries above are needed: skip the `postinstall` download step and omit the
`binaries/` `extraResources` entry in `package.json`. Klipe Studio's core
recording/editing/export features have no FFmpeg, scrcpy, SDL2, libusb or adb
dependency.

See [`scripts/download-scrcpy.cjs`](./scripts/download-scrcpy.cjs) for the exact
pinned versions and integrity hashes.
