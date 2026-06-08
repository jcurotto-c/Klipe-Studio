<div align="center">

[English](README.md) | Español

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/klipe-logo-dark.svg">
  <img src="docs/media/klipe-logo-light.svg" width="260" alt="Klipe Studio">
</picture>

<br/><br/>

[![Windows 10 | 11](https://img.shields.io/badge/Windows%2010%20%7C%2011-7C62FF?style=for-the-badge&logo=windows&logoColor=white)](#instalación)
[![Licencia: GPL-3.0](https://img.shields.io/badge/Licencia-GPL--3.0-7C62FF?style=for-the-badge)](LICENSE)
[![Última versión](https://img.shields.io/github/v/release/jcurotto-c/Klipe-Studio?style=for-the-badge&color=7C62FF&label=Versi%C3%B3n)](https://github.com/jcurotto-c/Klipe-Studio/releases/latest)
[![Descargas](https://img.shields.io/github/downloads/jcurotto-c/Klipe-Studio/total?style=for-the-badge&color=7C62FF&label=Descargas)](https://github.com/jcurotto-c/Klipe-Studio/releases)

### Graba. Haz zoom. Pule. Publica — totalmente open source y 100% local.

Un **grabador de pantalla y editor cinematográfico** para Windows con zoom
automático al hacer clic, cursor suave, fondos bonitos, una burbuja de cámara y
mirroring de teléfonos Android — en el espíritu de Screen Studio, pero para Windows.

[![Descargar para Windows](https://img.shields.io/badge/⬇%20%20Descargar%20para%20Windows-7C62FF?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/jcurotto-c/Klipe-Studio/releases/latest/download/Klipe-Studio-Setup.exe)

<video src="https://github.com/user-attachments/assets/aac24b6c-8c93-4e42-8f38-680ed02964e0" width="820" controls></video>

</div>

---

## ¿Qué es Klipe Studio?

Klipe Studio graba tu pantalla (o un teléfono Android) y convierte capturas en bruto
en videos de producto pulidos y con movimiento: zoom automático en los clics, un
cursor renderizado suavísimo, movimientos de cámara cinematográficos, fondos con
estilo, una burbuja de cámara, tarjetas de título y subtítulos en el dispositivo.
Piensa en **Screen Studio**, pero para Windows y totalmente open source.

Todo corre **localmente**: sin backend, sin telemetría, sin subidas. La exportación
usa el codificador por hardware de tu GPU vía WebCodecs — no FFmpeg.wasm.

> **Plataforma:** Windows 10 (build 19041+) o Windows 11, x64. La captura usa
> **Windows.Graphics.Capture** nativo; el audio del sistema usa **WASAPI** loopback.

> **Stack:** Electron · React · Vite · TypeScript · PixiJS · WebCodecs + [mediabunny](https://www.npmjs.com/package/mediabunny) · scrcpy (captura de teléfono) · transformers.js (Whisper en el dispositivo)

---

## Funciones principales

### 🎯 Zoom automático y cámara cinematográfica
Klipe observa tus clics, ráfagas de tipeo y cambios de tipo de cursor y **hace zoom
automáticamente** en el momento justo — sin keyframes manuales. Agrega o ajusta
**segmentos de zoom manuales** con escala, easing y punto de foco por segmento, y deja
que la **cámara siga** al cursor con los modos `static`, `follow` (zona segura) o
`cinematic` (resortes suaves + anticipación).

<!-- Agregar demo: docs/media/feature-zoom.gif — zoom automático + cámara -->

### 🖱️ Cursor pulido
El cursor grabado se **vuelve a renderizar**, no se captura — así que se puede suavizar,
redimensionar y reestilizar después: varios estilos de cursor, motion blur, rebote al
hacer clic y balanceo según la velocidad. El cursor de la vista previa vive en una
**capa protegida**, por lo que el cursor real del sistema nunca aparece en la grabación.

<!-- Agregar demo: docs/media/feature-cursor.gif — cursor pulido -->

### 🎨 Fondos bonitos, encuadre y burbuja de cámara
Coloca tu grabación sobre **wallpapers, gradientes, colores sólidos, imágenes propias
o un video de fondo en loop**, con blur, radio de esquina, padding y sombra de marco
ajustables. Agrega una **burbuja de cámara** en cualquiera de las 9 posiciones (círculo,
tarjeta o píldora), espejada y redimensionable, que incluso puede encogerse durante el zoom.

<!-- Agregar demo: docs/media/feature-background.gif — fondos / encuadre / cámara -->

### 📱 Mirroring de teléfonos Android
Graba un dispositivo Android — por USB — directo en Klipe mediante **scrcpy + adb**
incluidos (descargados y verificados automáticamente), compuestos dentro de un
**marco de teléfono** en pantalla (iPhone, Dynamic Island o Galaxy).

<!-- Agregar demo: docs/media/feature-phone.gif — mirroring de teléfono -->

---

## Todas las funciones

### Grabación
- Graba una pantalla completa o una sola ventana (`desktopCapturer` / `getDisplayMedia`).
- Micrófono **y** audio del sistema (WASAPI loopback) como pistas independientes.
- **Seguimiento global de entradas** — movimientos de mouse, clics y teclas capturados
  a nivel del SO por un helper de PowerShell sobre Win32 (`GetCursorPos` /
  `GetAsyncKeyState` / `GetCursorInfo`). Sin módulos nativos que compilar.
- Captura de cámara web como pista separada.
- Mirroring de teléfono Android vía scrcpy + adb incluidos.
- Cada grabación se **auto-guarda** en tu biblioteca (galería "Mis videos").

### Edición y línea de tiempo
- Timeline multi-fragmento: recorte, cortar/dividir, reordenar, marcadores de clic,
  cabezal de reproducción navegable.
- Vista previa en tiempo real con PixiJS + WebCodecs.
- Reabre cualquier proyecto anterior desde la biblioteca; deshacer/rehacer.

### Zoom y cámara
- Zoom automático por clics, ráfagas de tipeo y tipos de cursor de foco de UI.
- Segmentos de zoom manuales — punto central, escala, duración, ease-in/ease-out, blur.
- Modos de seguimiento de cámara: `static`, `follow` (zona segura), `cinematic`.

### Cursor
- Mostrar/ocultar, loop, tamaño (0.5×–5×), varios estilos.
- Suavizado, motion blur, rebote al clic y balanceo, más presets de movimiento.

### Fondos y encuadre
- Wallpapers + subidas propias, gradientes, colores sólidos, **videos de fondo**.
- Blur de fondo, sombra de marco, radio de esquina, padding.
- Recorte de la fuente con bloqueo de aspecto opcional; modos `fit` vs `fill`.

### Burbuja de cámara
- Grid de 9 posiciones · formas círculo / tarjeta / píldora · tamaño, redondez, espejo.
- Tamaño distinto opcional durante el zoom.

### Overlays, tarjetas de título y subtítulos
- **Overlays** de texto e imagen con animaciones PixiJS (fade, rise, zoom, blur,
  máquina de escribir) y keyframes por overlay.
- **Tarjetas de intro / outro / mid-roll**, incluida una plantilla **Reveal**
  paramétrica (cascada de imágenes + título + etiquetas con líneas guía) y transiciones.
- **Subtítulos** generados **en el dispositivo** por Whisper (transformers.js, corre en
  un Web Worker — sin API key, sin nube), con auto-detección o idioma a elección y estilo completo.

### Audio
- Volúmenes independientes de micrófono y audio del sistema.
- **Efectos de sonido** de clic / tecla generados (auto / encendido / apagado).
- **Música de fondo** en loop con fade-in / fade-out.

### Blur / censura
- Regiones rectangulares o elípticas, blur gaussiano o pixelado, con posición y tamaño
  **con keyframes** para seguir contenido en movimiento.

### Exportación y publicación
- **MP4 (H.264)** o **WebM (VP9)** vía el codificador por hardware del SO (WebCodecs).
- 720p / 1080p / 4K, 30 o 60 fps, presets de calidad.
- Relaciones de aspecto + **presets de plataforma** (YouTube, Shorts, TikTok, Reels,
  LinkedIn, Facebook) con guías de zona segura.

---

## Capturas

La barra flotante de grabación — colócala sobre cualquier fondo:

<p align="center">
  <img src="docs/media/recorder-hud.png" width="760" alt="HUD flotante de grabación de Klipe Studio">
</p>

El editor — línea de tiempo, zoom automático, cursor, fondos, tarjetas y subtítulos:

<p align="center">
  <img src="docs/media/screenshot-editor.png" width="880" alt="Editor de Klipe Studio">
</p>

Exportación con presets de plataforma, y tu biblioteca de grabaciones auto-guardadas:

<p align="center">
  <img src="docs/media/screenshot-export.png" width="880" alt="Modal de exportación — presets de plataforma, resolución y calidad">
</p>

<p align="center">
  <img src="docs/media/screenshot-library.png" width="880" alt="Mis videos — biblioteca de grabaciones">
</p>

---

## Cómo funciona la exportación

Klipe Studio usa una tubería moderna y acelerada por hardware — **no** FFmpeg.wasm:

1. La grabación fuente se demuxea con **mediabunny** y se decodifica con un
   `VideoDecoder` de WebCodecs (acelerado por hardware cuando el SO/GPU lo permite).
2. Cada fotograma decodificado se compone en un canvas con todos los efectos
   integrados — zoom cinematográfico, cursor, regiones de blur, overlays, tarjetas,
   subtítulos.
3. Los fotogramas se envían a un `VideoEncoder` de WebCodecs (H.264 / VP9) y se muxean
   con mediabunny usando faststart, para que la salida sea reproducible en streaming.
4. El audio (pista fuente + efectos + música de fondo) se mezcla offline con un
   `OfflineAudioContext`.

En Windows esto se mapea a **Media Foundation** para codificar/decodificar — el mismo
enfoque de "usar el códec del SO" que Screen Studio toma con VideoToolbox en macOS.

---

## Instalación

### Descargar (recomendado)

Toma el último instalador de Windows desde **[Releases](https://github.com/jcurotto-c/Klipe-Studio/releases/latest)**,
o el enlace directo estable:

➡️ **[Klipe-Studio-Setup.exe](https://github.com/jcurotto-c/Klipe-Studio/releases/latest/download/Klipe-Studio-Setup.exe)**

> [!IMPORTANT]
> El instalador **aún no está firmado**, así que Windows SmartScreen puede advertirte.
> Haz clic en **Más información → Ejecutar de todas formas** para continuar. La app se
> auto-actualiza desde GitHub Releases después de la primera instalación.

### Compilar desde el código

**Requisitos:** [Node.js](https://nodejs.org) 18+, [pnpm](https://pnpm.io) 11+
(`corepack enable` provee la versión fijada), PowerShell (incluido). Para el mirroring
de teléfono también necesitas un dispositivo Android con **depuración USB** activada —
scrcpy/adb se descargan automáticamente al instalar.

```bash
pnpm install    # también ejecuta postinstall → descarga + verifica scrcpy/adb
pnpm dev        # arranca Vite (renderer) y Electron juntos con HMR
pnpm build      # typecheck → vite build → electron build → instalador NSIS (release/)
```

Si Electron se cierra antes de que Vite esté listo en el primer arranque, simplemente
vuelve a ejecutar `pnpm dev`. Este proyecto usa **pnpm** (no npm).

---

## Requisitos del sistema

| Componente  | Mínimo                               | Notas                                              |
| ----------- | ------------------------------------ | -------------------------------------------------- |
| SO          | Windows 10 (build 19041+) u 11, x64  | Usa Windows.Graphics.Capture + WASAPI loopback     |
| Node.js     | 18+                                  | Solo para desarrollo                               |
| pnpm        | 11+                                  | Solo para desarrollo (`corepack enable`)           |
| PowerShell  | Incluido                             | Mueve el rastreador global de mouse/teclas         |
| Android     | Opcional                             | Depuración USB activada, para mirroring (scrcpy)   |

---

## Uso

1. **Graba** — empieza desde el HUD flotante. Elige una pantalla o ventana, activa
   micrófono, audio del sistema, cámara web o un teléfono conectado, y deja el zoom
   automático activado.
2. **Edita** — Klipe salta directo al editor. Ajusta los segmentos de zoom, el cursor,
   el fondo y encuadre, la burbuja de cámara, las regiones de blur, las tarjetas y los
   subtítulos en la línea de tiempo, con vista previa en vivo.
3. **Exporta** — elige resolución, fps, formato y un preset de plataforma, y renderiza
   a MP4 o WebM. Cada proyecto además se auto-guarda en tu biblioteca.

---

## Privacidad

Todo el procesamiento es local. Klipe Studio no tiene telemetría, no hace llamadas de
red durante la grabación o exportación, y no sube nada. El modelo de subtítulos se
descarga una sola vez desde Hugging Face y luego corre completamente offline.

---

<details>
<summary><b>Estructura del proyecto</b></summary>

```
klipe-studio/
├── electron/              # Proceso principal de Electron
│   ├── main.ts            # ventanas, IPC, rastreador de mouse/teclas, guardado
│   ├── preload.ts         # contextBridge → window.klipe / klipeHud / previews
│   ├── scrcpy-bridge.ts   # mirroring Android vía scrcpy + adb
│   └── cursorHider.ts     # oculta el cursor del SO durante la captura (Win32)
├── src/                   # Renderer (React + Vite)
│   ├── App.tsx            # router Biblioteca ↔ Grabador ↔ Editor
│   ├── components/        # RecorderView, EditorView, LibraryView, Timeline, panels/
│   ├── lib/               # Motores: renderer, exporter, zoom-engine, cursor-engine, …
│   ├── cards/             # Tarjetas de intro/outro/mid-roll + plantilla Reveal
│   ├── overlays/          # Sistema de overlays de texto/imagen + subtítulos (PixiJS)
│   └── types/             # Tipos TypeScript compartidos + typings de window.klipe
├── scripts/               # download-scrcpy.cjs (postinstall), helpers de build
├── public/                # wallpapers, efectos de sonido
└── binaries/              # scrcpy / adb / DLLs de FFmpeg (auto-descargados; no en git)
```

</details>

<details>
<summary><b>Scripts</b></summary>

| Comando              | Qué hace                                                   |
| -------------------- | ---------------------------------------------------------- |
| `pnpm dev`           | Vite + Electron juntos, con HMR                            |
| `pnpm build`         | Typecheck, compila el renderer, empaqueta el instalador    |
| `pnpm release`       | Compila y publica un GitHub Release versionado             |
| `pnpm preview`       | Vista previa de Vite (solo renderer, sin Electron)         |
| `pnpm typecheck`     | `tsc --build` en todos los tsconfigs                       |
| `pnpm setup:scrcpy`  | Re-descarga y verifica los binarios scrcpy/adb             |
| `pnpm audit:check`   | `pnpm audit --audit-level=high`                            |

</details>

---

## Apoyo

Klipe Studio es **libre y open source**. Si te ahorra tiempo o simplemente te gusta
usarlo, puedes apoyar mi trabajo open source — cada café ayuda a mantener el proyecto
vivo y avanzando:

<p align="center">
  <a href="https://ko-fi.com/mrrobot01">
    <img src="https://img.shields.io/badge/Ko--fi-Apoya%20el%20proyecto-7C62FF?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Apoyar a Klipe Studio en Ko-fi">
  </a>
</p>

¡Gracias! ☕

---

## Contribuir

Las contribuciones son bienvenidas — ver [CONTRIBUTING.md](CONTRIBUTING.md). Al
contribuir aceptas que tus cambios se licencian bajo la licencia GPL-3.0-or-later del
proyecto.

---

## Licencia

Klipe Studio es software libre licenciado bajo la **GNU General Public License v3.0 o
posterior** — ver [LICENSE](LICENSE). Puedes usarlo, estudiarlo, compartirlo y
mejorarlo; cualquier versión distribuida (incluidos forks y modificaciones) debe
permanecer open source bajo la misma licencia.

Los binarios de terceros incluidos (scrcpy, FFmpeg, SDL2, libusb, adb) se distribuyen
bajo sus propias licencias — ver [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

## Agradecimientos

- **[Screen Studio](https://screen.studio)** — la inspiración de todo el enfoque.
- **[scrcpy](https://github.com/Genymobile/scrcpy)** — mirroring de pantalla Android.
- **[mediabunny](https://www.npmjs.com/package/mediabunny)** — demux y mux de WebM/MP4.
- **[PixiJS](https://pixijs.com)** — renderizado de overlays y subtítulos.
- **[transformers.js](https://github.com/huggingface/transformers.js)** — subtítulos Whisper en el dispositivo.
