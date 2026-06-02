# Klipe Studio

A Windows desktop **screen recorder and cinematic editor** with automatic
zoom-on-click, smooth cursor, beautiful backgrounds, a webcam bubble, and
Android phone mirroring — in the spirit of Screen Studio, but for Windows and
fully **open source**. Everything runs locally: no backend, no telemetry, no
uploads.

> **Stack:** Electron · React · Vite · TypeScript · PixiJS · WebCodecs + [mediabunny](https://www.npmjs.com/package/mediabunny) · scrcpy (phone capture)

---

## Features

- **Screen & window recording** via Electron `desktopCapturer` / `getDisplayMedia`
  (Windows.Graphics.Capture under the hood) with microphone audio.
- **Global input tracking** — mouse moves, clicks and keystrokes captured at the
  OS level by a Win32-backed PowerShell helper (`GetCursorPos` /
  `GetAsyncKeyState` / `GetCursorInfo`). No native modules to compile.
- **Automatic zoom** that reacts to clicks, typing bursts and cursor-type changes,
  plus **manual zoom segments** with per-segment scale, easing and a cinematic
  **camera-follow** that tracks the cursor.
- **Cursor styling** — smoothing, size, multiple styles, motion blur, click bounce
  and sway. The live preview cursor is rendered on a content-protected overlay so
  the real OS cursor never bleeds into the capture.
- **Backgrounds & framing** — wallpaper presets, gradients, solid colors, custom
  images and blur, plus frame shadow, corner radius and padding.
- **Webcam camera bubble** — position grid, mirror, roundness and size.
- **Android phone mirroring** (optional) via bundled **scrcpy + adb**, recorded
  inside an on-screen phone frame.
- **Overlays** — text and image layers with animations (PixiJS).
- **Audio** — generated click/keystroke sound effects and looping background music
  with fades.
- **Blur / redaction** regions with keyframes.
- **Timeline editing** — multi-fragment trim, cut/split, reorder, click markers, a
  scrubbable playhead, and undo/redo.
- **Export** to **MP4 (H.264)** or **WebM (VP9)** via the OS hardware encoder
  (WebCodecs), at 720p / 1080p / 4K, 30 or 60 fps, with quality presets.

---

## How export works

Klipe Studio uses a modern, hardware-accelerated pipeline — **not** FFmpeg.wasm:

1. The source recording is demuxed by **mediabunny** and decoded by a WebCodecs
   `VideoDecoder` (hardware-accelerated where the OS/GPU allows).
2. Each decoded frame is composited on a canvas with all effects baked in —
   cinematic zoom, cursor, blur regions, overlays.
3. Frames are fed to a WebCodecs `VideoEncoder` (H.264 / VP9) and muxed by
   mediabunny with faststart, so the output is streamable.
4. Audio (source track + sound FX + background music) is mixed offline via an
   `OfflineAudioContext`.

On Windows this maps to **Media Foundation** for encode/decode — the same
"use the OS codec" approach Screen Studio takes with VideoToolbox on macOS.

---

## Getting started

**Requirements:** Windows 10/11 (x64), [Node.js](https://nodejs.org) 18+,
[pnpm](https://pnpm.io) 11+ (`corepack enable` will provide the pinned version),
PowerShell (built-in). For phone mirroring you also need an Android device with
**USB debugging** enabled — scrcpy/adb are downloaded automatically on install.

```bash
pnpm install    # also runs postinstall → downloads + verifies scrcpy/adb
pnpm dev        # boots Vite (renderer) and Electron together with HMR
```

If Electron exits before Vite is ready on the first launch, just rerun `pnpm dev`.

To produce a Windows installer:

```bash
pnpm build      # typecheck → vite build → electron build → NSIS installer
```

Output is written to `release/` as an NSIS installer (`.exe`).

---

## Project layout

```
klipe-studio/
├── electron/              # Electron main process
│   ├── main.ts            # windows, IPC, PowerShell mouse/key tracker, file save
│   ├── preload.ts         # contextBridge → window.klipe / klipeHud / previews
│   ├── scrcpy-bridge.ts   # Android mirroring via scrcpy + adb
│   └── cursorHider.ts     # blanks the OS cursor during capture (Win32)
├── src/                   # Renderer (React + Vite)
│   ├── App.tsx            # Recorder ↔ Editor router
│   ├── components/        # RecorderView, EditorView, Timeline, panels/, modals
│   ├── lib/               # Engines: renderer, exporter, zoom-engine, cursor-engine, capture, …
│   ├── overlays/          # PixiJS text/image overlay system
│   └── types/             # Shared TypeScript types + window.klipe typings
├── scripts/               # download-scrcpy.cjs (postinstall), scrcpy-stop.ps1
├── public/                # wallpapers, sound effects
└── binaries/              # scrcpy / adb / FFmpeg DLLs (auto-downloaded; not in git)
```

---

## Privacy

All processing is local. Klipe Studio has no telemetry, makes no network calls
during recording or export, and uploads nothing.

---

## Scripts

| Command              | What it does                                            |
| -------------------- | ------------------------------------------------------- |
| `pnpm dev`           | Vite + Electron together, with HMR                      |
| `pnpm build`         | Typecheck, build the renderer, package a Windows installer |
| `pnpm preview`       | Vite preview (renderer only, no Electron)               |
| `pnpm typecheck`     | `tsc --build` across all tsconfigs                      |
| `pnpm setup:scrcpy`  | Re-download and verify the scrcpy/adb binaries          |
| `pnpm audit:check`   | `pnpm audit --audit-level=high`                         |

---

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). By
contributing you agree your changes are licensed under the project's GPL-3.0-or-later
license.

---

## License

Klipe Studio is free software licensed under the **GNU General Public License
v3.0 or later** — see [LICENSE](./LICENSE). You may use, study, share and improve
it; any distributed version (including forks and modifications) must remain open
source under the same license.

Bundled third-party binaries (scrcpy, FFmpeg, SDL2, libusb, adb) are distributed
under their own licenses — see [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
