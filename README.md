# Klipe Studio

A Windows desktop screen recorder with **automatic zoom on clicks**, in the spirit of Screen Studio. Records your screen + microphone, captures global mouse activity, and lets you trim, preview with cinematic zoom, and export to MP4 — all locally, with no backend.

> Stack: Electron + React + Vite + FFmpeg (WebAssembly).

---

## Features

- **Screen recording** via Electron `desktopCapturer` + `MediaRecorder` (VP9/Opus → WebM).
- **Global mouse tracking** (positions + clicks with timestamps) via a Win32-backed PowerShell helper — no native modules to compile.
- **Timeline editor** with click markers, drag-to-trim handles, and a scrubbable playhead.
- **Automatic zoom engine** — every click becomes a 1.8× zoom segment with `smoothstep` ease-in/out (~2 s); overlapping segments under 1.5 s apart are merged.
- **Canvas renderer** with gradient backgrounds, an enhanced cursor halo, and click ripple effect.
- **MP4 export** via `@ffmpeg/ffmpeg` (H.264 CRF 18 + AAC), at 720p / 1080p / 4K, 30 or 60 fps.

---

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` boots Vite (renderer) and Electron together. The first launch lets Vite warm up before Electron opens; if Electron exits before Vite is ready, just rerun.

To produce a Windows installer:

```bash
npm run build
```

Output is written to `release/` as an NSIS installer (`.exe`).

---

## Project layout

```
klipe-studio/
├── electron/
│   ├── main.js          # window, IPC, mouse tracker (PowerShell + Win32)
│   └── preload.js       # contextBridge → window.klipe
├── src/
│   ├── index.html
│   ├── main.jsx
│   ├── App.jsx          # view router (Recorder ↔ Editor)
│   ├── styles.css
│   ├── components/
│   │   ├── RecorderView.jsx   # source picker, mic toggle, 3-2-1 countdown
│   │   ├── EditorView.jsx     # preview + controls + timeline + export
│   │   ├── Timeline.jsx       # click markers, zoom segments, trim handles
│   │   ├── VideoCanvas.jsx    # rAF preview at 30fps
│   │   └── ExportPanel.jsx    # resolution, fps, progress, FFmpeg log
│   └── lib/
│       ├── capture.js         # MediaRecorder wrapper + mouse event sink
│       ├── zoom-engine.js     # smoothstep, segment generation + merging
│       ├── renderer.js        # frame rendering: bg, zoom, cursor, ripple
│       └── exporter.js        # PNG-sequence + audio → mp4 via ffmpeg.wasm
├── vite.config.js
└── package.json
```

---

## How it works

### Mouse capture (Windows)

`electron/main.js` spawns a hidden PowerShell process that uses Win32 P/Invoke (`GetAsyncKeyState`, `GetCursorPos`) to detect clicks and cursor moves at ~80 Hz. Events are streamed back to the renderer via IPC. No native compilation, no extra binaries.

If you ever port this off Windows, the main process falls back to polling `screen.getCursorScreenPoint()` for moves only (clicks won't be detected).

### Mouse event payload

```js
{
  startTime: 1714512345678,         // wall-clock ms (informational)
  events: [
    { type: 'move',  x, y, t },     // t = ms since recording start
    { type: 'click', x, y, t, button: 'left' | 'right' | 'middle' }
  ]
}
```

### Zoom segments

```js
{ center: { x, y }, scale: 1.8, tStart, tEnd, easeIn: 400, easeOut: 600 }
```

Generated from clicks, then merged when two consecutive segments are within `1500 ms` of each other. Easing is `smoothstep(t) = t*t*(3 - 2*t)`.

### Rendering

- **Preview**: hidden `<video>`, `requestAnimationFrame` loop capped at 30 fps, frame painted to a 1280×720 canvas with `ctx.drawImage`.
- **Export**: same renderer at the chosen resolution, advancing `video.currentTime` step by step at `1/fps`, capturing each frame as PNG, written to ffmpeg's virtual FS, then muxed with the trimmed AAC audio extracted from the source WebM.

---

## Notes & caveats

- The recording itself is WebM (VP9/Opus); the MP4 is produced only at export.
- 4K @ 60 fps export is heavy in WebAssembly — give it time, and prefer 1080p for everyday use.
- Click capture requires PowerShell (Windows). The first time you record, you may see the window flash briefly while the helper starts.
- All processing is local — no telemetry, no upload.

---

## Scripts

| Command           | What it does                                            |
| ----------------- | ------------------------------------------------------- |
| `npm run dev`     | Vite + Electron together, with HMR                      |
| `npm run build`   | Build the renderer and package a Windows NSIS installer |
| `npm run preview` | Vite preview (without Electron)                         |

---

## License

MIT.
