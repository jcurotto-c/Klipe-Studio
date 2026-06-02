# Contributing to Klipe Studio

Thanks for your interest in improving Klipe Studio! This is an open-source
project under **GPL-3.0-or-later** — contributions are very welcome.

## Prerequisites

- **Windows 10/11 (x64)** — Klipe Studio is currently Windows-only (the input
  tracker and cursor hider use Win32 via PowerShell).
- **Node.js 18+** and npm.
- **PowerShell** (built-in). If script execution is restricted, the app spawns
  PowerShell with `-ExecutionPolicy Bypass` for its helpers, so no machine-wide
  policy change is needed.
- *(Optional, for phone mirroring)* an Android device with **USB debugging**
  enabled. `scrcpy` and `adb` are downloaded and integrity-checked automatically
  by the `postinstall` step.

## Setup

This project uses **pnpm** (11+). `corepack enable` will provide the pinned
version automatically.

```bash
git clone https://github.com/<your-fork>/Klipe-Studio.git
cd Klipe-Studio
pnpm install     # postinstall downloads + verifies scrcpy/adb (Windows only)
pnpm dev         # Vite + Electron with hot reload
```

## Useful scripts

| Command              | What it does                                |
| -------------------- | ------------------------------------------- |
| `pnpm dev`           | Run the app (Vite + Electron) with HMR      |
| `pnpm typecheck`     | Type-check the whole project                |
| `pnpm build`         | Full production build → NSIS installer      |
| `pnpm setup:scrcpy`  | Re-download/verify the scrcpy + adb binaries |

Please run `pnpm typecheck` before opening a PR — it must pass.

## Where things live

- **`electron/`** — main process: window/IPC orchestration, the PowerShell input
  tracker, the scrcpy bridge, the cursor hider.
- **`src/components/`** — React UI. `EditorView.tsx` is the central editor,
  `Timeline.tsx` the timeline, `components/panels/` the sidebar inspectors.
- **`src/lib/`** — the engines. Highlights:
  - `renderer.ts` — the single frame-drawing module used by **both** preview and
    export (keep them in sync — see below).
  - `exporter.ts` / `mp4-encoder.ts` — the WebCodecs + mediabunny export pipeline.
  - `zoom-engine.ts`, `cursor-engine.ts`, `cursor-follow-camera.ts` — the
    "cinematic" math.
- **`src/overlays/`** — the PixiJS text/image overlay system.
- **`src/types/`** — shared types and the `window.klipe` IPC typings.

> Heads-up: `EditorView.tsx` and `renderer.ts` are large and hold a lot of logic.
> When adding features, prefer extracting focused modules/hooks over growing them.

### Preview ↔ export parity

The preview ([VideoCanvas.tsx](src/components/VideoCanvas.tsx)) and the exporter
both call the same `renderFrame()`. If you change rendering math, verify the
exported file matches the preview — a mismatch here is the most common regression.

## Code style

- **TypeScript strict mode** is on. Avoid `any`; prefer precise types and runtime
  validation at the IPC boundary.
- Match the style of the surrounding code (naming, comments, structure).
- Clean up resources: cancel `requestAnimationFrame` loops, dispose PixiJS
  objects, stop media tracks, revoke object URLs, and remove listeners on unmount.

## Commit messages & pull requests

- Write **commit messages in English**, in the imperative mood
  (e.g. `fix(zoom): clamp segment merge window`). Conventional-commit prefixes
  (`feat`, `fix`, `perf`, `refactor`, `docs`, `chore`) are appreciated.
- Keep PRs focused; describe what changed and how you tested it.
- Branch off `dev`; open PRs against `dev`.
- By submitting a contribution you agree it is licensed under
  **GPL-3.0-or-later**, the project's license.

## Reporting bugs

Open an issue with: your Windows version, steps to reproduce, what you expected,
and what happened. For recording/export issues, include the source resolution,
fps, and whether phone mirroring was involved.
