# README media assets

This folder holds the images the project README references. The brand logos are
already here; the demo clips and screenshots below are **still to be added**.

## Already present
- `klipe-logo-light.svg` — logo for GitHub's **light** theme (dark wordmark).
- `klipe-logo-dark.svg` — logo for GitHub's **dark** theme (light wordmark).

## To add (placeholders in the README)
Each item below maps to a commented-out `<!-- Add demo ... -->` slot in
[`../../README.md`](../../README.md) and [`../../README.es.md`](../../README.es.md).
Drop the file here with the exact name, then uncomment its line.

| File                       | Used in            | Shows                                  |
| -------------------------- | ------------------ | -------------------------------------- |
| `feature-zoom.gif`         | Core features      | Auto-zoom + cinematic camera-follow    |
| `feature-cursor.gif`       | Core features      | Cursor smoothing / styles / bounce     |
| `feature-background.gif`   | Core features      | Backgrounds, framing, webcam bubble    |
| `feature-phone.gif`        | Core features      | Android phone mirroring                |
| `screenshot-editor.png`    | Screenshots        | The editor with timeline + panels      |
| `screenshot-recorder.png`  | Screenshots        | The floating recorder HUD              |
| `screenshot-export.png`    | Screenshots        | The export modal                       |

## Two ways to add them
1. **Commit the file here** (e.g. `docs/media/feature-zoom.gif`) and uncomment the
   matching `<img>` / `<!-- ... -->` line in the README. Good for GIFs and PNGs.
2. **Upload via GitHub** to get a stable `user-attachments` URL (best for videos):
   open any Issue, drag the file into the comment box, copy the
   `https://github.com/user-attachments/assets/...` URL it generates, and paste it
   into the README `<video>`/`<img>` tag. The hero video already uses this method.

> Tip: keep feature GIFs ~450 px wide and screenshots ~800–1000 px wide to match the
> README layout. Trim GIFs to a few seconds so they stay small.
