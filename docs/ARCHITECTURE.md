# ScreenForge Studio — Architecture

## 1. Process model

```
┌──────────────────────────── Electron main process ────────────────────────────┐
│  SessionManager (recording lifecycle)     FFmpeg locator / HW-encoder probe   │
│  CursorRecorder (hook|polling)            ExportManager (FIFO job queue)      │
│  OverlayCompositor (@napi-rs/canvas)      SQLite (better-sqlite3, WAL)        │
│  SettingsStore                            recfile:// protocol handler         │
│  Window manager: main · agent · overlays · toolbar · region · countdown        │
└───────────────▲───────────────────────────────────────────────▲───────────────┘
                │ IPC (zod-validated contracts)                 │ fd3 rawvideo RGBA
┌───────────────┴───────────────┐                ┌──────────────┴───────────────┐
│ Main window (React UI)        │                │ ffmpeg.exe (bundled 6.0)     │
│  Home/Recorder/Editor/...     │                │  - encode/normalize MP4      │
├───────────────────────────────┤                │  - thumbnails                │
│ Hidden capture agent          │                │  - export filter graph       │
│  getUserMedia + MediaRecorder ├────chunks─────▶│                              │
│  (screen/window + loopback +  │  (IPC, ordered)│                              │
│   mic, chunked webm output)   │                │                              │
├───────────────────────────────┤                │                              │
│ Annotation overlays (per display, transparent, click-through when idle)       │
│ Floating toolbar · Region selector · Countdown (all helper windows)           │
└───────────────────────────────────────────────────────────────────────────────┘
```

Every renderer (including helper windows) loads the same preload and receives
only the allowlisted, frozen `window.screenforge` API. The capture agent is a
permanently hidden `BrowserWindow` (`backgroundThrottling: false`) so capture
survives main-window minimize/navigation.

## 2. IPC security

- `src/shared/ipc.ts` is the single source of truth: every invoke channel has a
  **zod request schema** and a typed response; main registers handlers through
  `ipc/registry.ts` which validates before dispatch.
- Preload exposes `window.screenforge` (frozen) — the renderer can never pass
  arbitrary channels; event channels are allowlisted too.
- Private `agent:*` channels are accepted only from the agent window's
  `webContents.id`.

## 3. Capture backends

```
start(config)
  ├─ mode !== 'window'  AND  wgc_capture native addon available
  │     → native WGC monitor capture (BGRA frames → ffmpeg rawvideo → MP4/H.264)
  │        hardware encoder when detected (nvenc → qsv → amf), else libx264
  └─ otherwise
        → desktopCapturer backend: hidden agent runs getUserMedia (desktop source)
          + MediaRecorder (VP9/VP8 webm); system audio via desktop loopback,
          mic via getUserMedia; chunks stream to main and are written
          sequentially (ordered writer with gap buffering)
```

- `stop()` finalizes through FFmpeg: webm → CFR MP4 (H.264, `+faststart`),
  region crops (`crop=w:h:x:y`), thumbnails (`-ss 1 -frames:v 1`).
- `RecordingMeta` is probed with **ffprobe** for trustworthy duration/size/fps.
- Backend actually used is stored per recording (`captureBackend`), and the
  Settings/About surface reports the *real* backend — never a claimed one.

## 4. Recording session lifecycle

```
idle → preparing → [countdown] → recording ⇄ paused → stopping → processing → idle
```

`RecordingClock` (shared, pause-aware) is the single time authority: video,
cursor events and annotation timestamps all derive from it, which keeps every
stream synchronizable in the editor.

- **Pause:** clock pauses; WGC backend gates frame writes (frame-count timing
  compensates the gap); desktopCapturer backend pauses the MediaRecorders.
- **Cancel:** partial session is moved to `Videos/ScreenForge/.trash` — user
  data is never silently deleted.
- **Stop:** cursor file + annotation shapes are collected, overlays/toolbar
  close, capture finalizes, FFmpeg normalizes to MP4, thumbnail + sidecars +
  DB row + `meta.json` are written.

## 5. Cursor metadata pipeline

- Events: `{ t, type: move|down|up|wheel, x, y, button?, displayId }`.
- Coordinate space: **virtual-screen physical pixels** (origin = primary
  display top-left, each display scaled by its `scaleFactor`). This survives
  mixed-DPI multi-monitor setups; the sidecar JSON also stores per-display
  physical bounds + scale factors for exact remapping.
- Sources: native `cursor_hook` addon (global `WH_MOUSE_LL`, ~120 Hz feed) when
  present; otherwise 60 Hz polling of `screen.getCursorScreenPoint()` with
  DIP→physical conversion (positions only — clicks require the addon).
- Storage: `cursor-events.json` sidecar next to the media + `RecordingMeta`
  row in SQLite. The **source video never contains rendered cursor effects** —
  the OS cursor may appear in WGC captures (by design: `mode:'original'`
  keeps it), while all editor effects are overlay data.

### Rendering (preview == export)

`src/shared/cursor-render.ts` implements the painters (sprite, highlight,
click ripple/burst/pulse, trail, smoothing) against a structural `Ctx2DLike`
context. The **same functions** run in:

- the editor preview (browser canvas), and
- the export compositor (`@napi-rs/canvas` in main, per-frame RGBA → ffmpeg).

Smoothing is a deterministic pure function of the event list + config, so
preview and exported frames match.

## 6. Annotation overlays

- One transparent, always-on-top, skip-taskbar window per display, created on
  the target display's bounds (`screen-saver` z-order).
- Idle: `setIgnoreMouseEvents(true, { forward: true })` → clicks pass through
  to underlying apps. Drawing mode: mouse events enabled, tools provided by
  `annotation-overlay.ts` (pen, highlighter, arrow, line, rect, ellipse, text,
  eraser + undo/redo, color/width/font/opacity).
- Shapes are display-local physical coordinates with `tStartMs/tEndMs`; the
  overlay window pushes the authoritative list to main on every stroke
  (`annotation:replaceAll`), main persists at stop as `annotations.json`.
- Fullscreen/region captures include the overlay **as drawn on screen**;
  window-mode capture does not (separate window) — the exporter re-renders all
  shapes from metadata regardless, so window-mode exports still get annotations.

## 7. Editor & EDL model

- `EditorProject` = ordered `segments[{startMs,endMs}]` (kept ranges) +
  `cursorConfig` + text overlays + audio track items. Projects are JSON blobs
  in SQLite — the source recording is **never modified**.
- `shared/edl.ts` provides pure math: `normalizeSegments` (sort/merge/validate),
  `outputDurationMs`, `remapCursorEvents` / `remapAnnotations` (source time →
  output time across cuts), `formatTimecode`.
- Playback maps project-time ↔ source-time through the segment list; the
  preview canvas composites video + cursor layer + annotations + text overlays
  using the shared painters.

## 8. Export pipeline

```
ExportOptions → buildExportArgs() (pure, deterministic)
  inputs:  0 = source mp4 | [1 = pipe:3 RGBA overlay] | mic.webm | system.webm | music
  video:   trim/concat segments → fps → even-dim scale → overlay → yuv420p
  audio:   per-source atrim/concat → volume → 48k → (music: adelay) →
           apad/atrim to duration → aformat → amix → aac 192k
  safety:  -t <output duration> (never overruns), +faststart
```

- `OverlayCompositor` renders only when needed (cursor/annotations/text
  requested); it draws each frame with `@napi-rs/canvas`, honors pipe
  backpressure, supports abort, and registers bundled/system fonts for text.
- Hardware encoders are **probed by actually test-encoding one frame**
  (`h264_nvenc` → `h264_qsv` → `h264_amf`); settings can force software.
- Progress is parsed from ffmpeg stderr (`time=`, `fps=`, `speed=`) and
  broadcast throttled (~250 ms). Cancel = `taskkill /T /F` (win32) or
  SIGTERM→SIGKILL escalation (POSIX); no orphan ffmpeg survives.
- One export runs at a time; further jobs queue FIFO and can be canceled while
  queued.

## 9. Database (better-sqlite3, WAL)

```sql
recordings(id PK, title, created_at, duration_ms, mode, display_id, region_json,
           width, height, fps, video_path, mic_audio_path, system_audio_path,
           cursor_events_path, annotations_path, thumbnail_path, size_bytes,
           capture_backend, cursor_backend)
projects(id PK, recording_id, title, created_at, updated_at, data_json)   -- EditorProject JSON
settings(key PK, value)                                                   -- string map
```

A lazy proxy (`database/index.ts`) decouples call sites from init order; the
concrete `SqliteDb` implements the `DbService` interface (swap-friendly).

## 10. Settings store

Typed view over the `settings` table with deep-merged `cursorConfig`,
validated enums, login-item side effects, and a recordings-directory helper
that also creates the `.trash` folder. Unknown keys persist raw for forward
compatibility.

## 11. Native addons (optional)

| Addon | Purpose | Fallback when absent |
| --- | --- | --- |
| `wgc_capture` | Windows Graphics Capture monitor frames → ffmpeg | desktopCapturer backend |
| `cursor_hook` | `WH_MOUSE_LL` global mouse events + `SetWindowDisplayAffinity` capture exclusion | 60 Hz position polling; helper windows visible in capture |
| `wasapi_capture` | Reserved for dedicated loopback capture | Chromium desktop loopback |

All loads go through `native/loader.ts` (search: env dir → resources/native →
dev checkout) and never throw — every consumer degrades gracefully, and the UI
reports the *actual* backend in use.
