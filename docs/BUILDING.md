# Building ScreenForge Studio

## Prerequisites

| What | Where needed | Notes |
| --- | --- | --- |
| Node.js ≥ 18 (built/tested on 24) | all | npm is used by the build scripts |
| Electron 33.4.11 | all | downloaded automatically on `npm install` |
| FFmpeg/ffprobe **win32-x64** | packaging | staged into `resources/bin` (see below) |
| Visual Studio 2022 "Desktop development with C++" + Windows SDK 10.0.19041+ | native addons only | optional |

```bash
npm install
npm run typecheck   # tsc for main/preload and renderer
npm run build       # tsc (main+preload) + vite build (renderer)
npm test            # vitest
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server + `tsc --watch` + Electron with `VITE_DEV_SERVER_URL` |
| `npm run build` | Compile main/preload (`tsconfig.node.json`) + production renderer bundle |
| `npm run icons` | Regenerate `resources/icon.ico` / `icon.png` from `icon-source.png` |
| `npm run patch:nsis` | Apply the Linux (no-wine) NSIS patch to `app-builder-lib` |
| `npm run native:build` | Build optional C++ addons (Windows + MSVC only) |
| `npm run dist` | Full Windows NSIS installer build (`release/<version>/`) |
| `npm run dist:dir` | Unpacked `win-unpacked/` only (no installer) |

## Stage the Windows FFmpeg binaries

`resources/bin/` must contain `ffmpeg.exe` + `ffprobe.exe` before packaging
(`extraResources` copies them to `<resources>/bin`, and
`src/main/ffmpeg/locate.ts` resolves them at runtime).

```bash
# ffmpeg 6.0 static win64 (eugeneware/ffmpeg-static release "b6.0")
curl -L -o /tmp/ffmpeg-win32-x64.gz \
  https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64.gz
gunzip -kf /tmp/ffmpeg-win32-x64.gz
mv /tmp/ffmpeg-win32-x64 resources/bin/ffmpeg.exe

# ffprobe (ships inside the ffprobe-static npm package for all platforms)
cp node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe resources/bin/ffprobe.exe
```

Alternatively point users to `SCREENFORGE_FFMPEG` / `SCREENFORGE_FFPROBE`
env overrides, or a system PATH install — the locator falls back in that order.

## Native-module strategy (no rebuild on user machines)

| Module | How the win32 binary is provided |
| --- | --- |
| `better-sqlite3` | Electron-ABI prebuild fetched at build time: `cd node_modules/better-sqlite3 && npx prebuild-install --runtime electron --target 33.4.11 --platform win32 --arch x64` (electron-v130 ↔ Electron 33.x) |
| `@napi-rs/canvas` | N-API — the explicit dependency `@napi-rs/canvas-win32-x64-msvc` ships the binary |
| optional C++ addons | built on a Windows machine via `npm run native:build`; copied to `resources/native/` to ship |

`electron-builder.yml` sets `npmRebuild: false` because all binaries are
pre-staged for the target platform (cross-rebuilding on Linux is impossible).

## Icon pipeline

```bash
npm run icons   # resources/icon-source.png (1024px master, AI-generated)
                #  → resources/icon.ico (multi-size 16–256, PNG-compressed)
                #  → resources/icon.png (256px)
```

## Build the installer

### On Windows (recommended)

```bash
npm install
npm run build
npx electron-builder --win --config electron-builder.yml
```

You may **remove** `win.signAndEditExecutable: false` from
`electron-builder.yml` on a real Windows machine so the inner
`ScreenForge Studio.exe` also receives the branded icon/version metadata
(rcedit runs natively there).

### Cross-build from Linux (no wine required)

1. Stage `resources/bin/ffmpeg.exe` + `ffprobe.exe` (above).
2. Fetch the better-sqlite3 Electron prebuild (above).
3. `npm run dist` — it automatically:
   - applies `scripts/patch-nsis-linux.mjs`, which patches
     `node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js` to extract
     the NSIS **uninstaller** with the pure-JS `UninstallerReader` (the same
     code path electron-builder uses on macOS Catalina+) instead of executing
     the installer under wine;
   - compiles main/preload + renderer;
   - runs electron-builder → `release/<version>/ScreenForge Studio-Setup-<version>.exe`.

   Re-run `npm run patch:nsis` after reinstalling `node_modules` (the patch is
   idempotent).

> `win.signAndEditExecutable: false` must stay enabled for Linux cross-builds
> (no wine for rcedit/signtool). The NSIS installer itself is fully branded.

### Outputs

```
release/<version>/
├─ ScreenForge Studio-Setup-<version>.exe        # NSIS installer (~228 MB)
├─ ScreenForge Studio-Setup-<version>.exe.blockmap
└─ win-unpacked/                                 # portable build (same content)
```

## Code signing (production)

The shipped build is **unsigned**. For production distribution add a
certificate to `electron-builder.yml`:

```yaml
# EV cert / Azure Trusted Signing
win:
  signtoolOptions:
    azureSignOptions:
      tenantId: ...
      clientId: ...
      certificateSubjectName: ...
```

```yaml
# Classic EV/OV certificate (PFX or cscLink)
win:
  cscLink: /path/to/cert.pfx        # or an HTTPS/Env variable link
  cscKeyPassword: ...
```

electron-builder signs the uninstaller and installer automatically once a
certificate is configured; Windows SmartScreen warnings disappear after
reputation builds up (EV certificates skip the initial warning).

## Troubleshooting

- **`wine is required`** → run `npm run patch:nsis` (see above).
- **`Prebuild symbol not found` / ABI mismatch** → the Electron version
  changed; re-fetch the matching better-sqlite3 prebuild
  (`--target <electron version>`).
- **`FFmpeg binary not found`** → dev: `SCREENFORGE_FFMPEG=/path/to/ffmpeg`;
  packaged: ensure `resources/bin/` is staged before `dist`.
- **asar integrity errors on launch** → repackage; never edit `app.asar`
  in place (Electron 33 embeds the integrity list in the exe).
