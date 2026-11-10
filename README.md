# ScreenForge Studio

**Professional Windows screen recording studio with advanced cursor editing, live annotation, and a built-in non-destructive video editor.**

ScreenForge Studio records your screen with real capture engines (Windows Graphics Capture when available, Chromium desktop capture as a universal fallback), captures system audio and microphone separately, tracks every cursor movement and click as **re-editable metadata** (never burned into the source video), and ships an FFmpeg-powered export pipeline with hardware-encoding support.

- **Target platform:** Windows 10 / 11 (x64)
- **Installer:** `ScreenForge Studio-Setup-1.0.0.exe` (NSIS, ~228 MB, assisted install)
- **Runtime:** Electron 33 + React 18 + TypeScript + Tailwind CSS
- **Media engine:** FFmpeg 6.0 (bundled, win32-x64) + `@napi-rs/canvas` compositor

---

## Feature highlights

| Area | Highlights |
| --- | --- |
| Recording | Fullscreen / region (crosshair drag-select) / window capture, multi-display, 24/30/60 fps, resolution presets up to 4K, pause/resume with live clock, countdown, floating toolbar |
| Audio | System loopback (WASAPI-backed Chromium loopback) + microphone, recorded to **separate tracks**, live mic level meter |
| Cursor editor | Cursor events (move / click / wheel) stored as timestamped metadata in physical virtual-screen coordinates; replacement sprites, highlight, per-button click effects, motion smoothing, trail — rendered identically in editor preview and export |
| Live annotation | Transparent always-on-top overlay per display: pen, highlighter, arrow, line, rectangle, ellipse, text, eraser, undo/redo; shapes are timestamped and re-renderable after recording |
| Editor | Multi-track timeline (video / audio / cursor / annotations), trim, split, delete segments, text overlays, background music with volume + delay, non-destructive projects |
| Export | MP4 (H.264 / H.265), 720p–4K or source, quality presets or explicit bitrate, audio mixing (mic + system + music), real progress, cancellation, hardware encoders (NVENC / QSV / AMF) with software fallback |
| Library | SQLite-backed recordings catalog with thumbnails, rename/delete (trash folder, never silent data loss), storage statistics |

See [docs/FEATURES-STATUS.md](docs/FEATURES-STATUS.md) for the honest implemented / partial / not-implemented breakdown and [docs/WINDOWS-LIMITATIONS.md](docs/WINDOWS-LIMITATIONS.md) for platform caveats.

## Quick start

### Install (Windows)

1. Download `ScreenForge Studio-Setup-1.0.0.exe`.
2. Run the installer (choose the install directory, desktop / Start-menu shortcuts).
3. Launch **ScreenForge Studio** from the Start menu.

> The build is **unsigned**: Windows SmartScreen may show a warning ("Windows protected your PC"). Choose *More info → Run anyway*, or sign the installer with your own certificate (see [docs/BUILDING.md](docs/BUILDING.md)).

Verify the download (PowerShell):

```powershell
Get-FileHash "ScreenForge Studio-Setup-1.0.0.exe" -Algorithm SHA256
# ccba5bf5f185895247fc73832077ffd83c836f6e268ec9ac98b30d1c77851048
```

### Development

```bash
npm install          # Electron binary downloads on postinstall
npm run dev          # vite (renderer HMR) + tsc watch + electron
npm run typecheck    # main+preload and renderer tsc
npm run build        # compile main/preload (tsc) + build renderer (vite)
npm test             # vitest
npm run dist         # patch NSIS target (Linux) + build + NSIS installer
```

Recordings are written to `Videos\ScreenForge` by default (changeable in Settings); the SQLite database lives in the app's `userData` directory.

## Project structure

```
desktop-app/
├─ src/
│  ├─ main/                  # Electron main process
│  │  ├─ capture/            #   WGC native + desktopCapturer backends
│  │  ├─ recording/          #   session manager + shared recording clock
│  │  ├─ cursor/             #   cursor event recorder (native hook / polling)
│  │  ├─ annotation/         #   live annotation session service
│  │  ├─ export/             #   export manager, compositor, ffmpeg args
│  │  ├─ ffmpeg/             #   binary resolution, probing, HW encoder detect
│  │  ├─ database/           #   better-sqlite3 service (recordings/projects/settings)
│  │  ├─ windows/            #   main window, overlays, toolbar, recfile protocol
│  │  ├─ settings/           #   typed settings store
│  │  ├─ native/             #   safe native addon loader
│  │  └─ ipc/                #   validated IPC handlers
│  ├─ preload/               # contextBridge API (frozen, allowlisted)
│  ├─ renderer/              # React UI: app, agent, overlay, toolbar, region, countdown
│  │  └─ src/pages/          #   Home / Recorder / Editor / Recordings / Settings
│  └─ shared/                # types, IPC contracts (zod), EDL math, cursor painters
├─ native/                   # optional C++ addons (wgc_capture, cursor_hook, wasapi_capture)
├─ resources/                # icons, bundled win32 ffmpeg/ffprobe, fonts
├─ scripts/                  # icon pipeline, NSIS wine patch, native build helper
└─ docs/                     # architecture, building, limitations, feature status
```

## Security model

- `contextIsolation: true`, `nodeIntegration: false`; the renderer only sees a frozen `window.screenforge` API built from a fixed channel allowlist.
- Every IPC payload is validated in the main process with **zod** schemas derived from the same contract (`src/shared/ipc.ts`).
- Media playback of recordings goes through a custom `recfile://` protocol handler — no blanket `file://` access.
- Strict CSP in every renderer HTML; `window.open` is denied; single-instance lock; helper windows share the same hardened `webPreferences`.

## Packaging summary

- **NSIS assisted installer** (per-user, custom directory, shortcuts) built by electron-builder.
- Bundles **ffmpeg.exe / ffprobe.exe** so exports work out of the box.
- `better-sqlite3` ships with the **electron-v130 win32-x64 prebuild**; `@napi-rs/canvas` ships its win32-x64 N-API binary — no rebuild step is needed on the user machine.
- Optional native addons (WGC capture, global cursor hook) can be compiled on Windows with `npm run native:build`; everything degrades gracefully without them.

Details: [docs/BUILDING.md](docs/BUILDING.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## License

MIT — see [LICENSE](LICENSE).
