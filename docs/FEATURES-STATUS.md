# Feature status — ScreenForge Studio 1.0.0

Truth-first breakdown of what is implemented, what is partial/degraded, and
what is not implemented. Verified against the source tree at build time.

## ✅ Implemented (working code paths)

| Feature | Where |
| --- | --- |
| Fullscreen monitor capture (native WGC → MP4/H.264 real-time) | `src/main/capture/wgc-native.ts`, `native/wgc-capture/` |
| Universal fallback capture (desktopCapturer → webm → normalized MP4) | `src/renderer/agent/capture-agent.ts`, `src/main/capture/desktop-capturer.ts` |
| Window capture (desktopCapturer source per window, with thumbnails) | `src/main/capture/desktop-capturer.ts` |
| Region capture (crosshair drag-select overlay, physical-px rect, crop at finalize) | `src/main/windows/overlay-windows.ts`, `src/renderer/region/` |
| Multi-display enumeration with mixed-DPI physical mapping | `src/main/windows/display-utils.ts` |
| Pause / resume / stop / cancel with shared pause-aware clock | `src/main/recording/session-manager.ts`, `clock.ts` |
| Countdown (3 s default, configurable 0–10 s) | `src/renderer/countdown/` |
| System audio loopback + microphone recorded as **separate tracks** | capture agent (webm) |
| Live mic level meter | capture agent → `evt:mic-level` |
| Cursor events as metadata (move/down/up/wheel, virtual-screen physical px) | `src/main/cursor/cursor-recorder.ts` |
| Cursor metadata sidecar (`cursor-events.json`) + SQLite `RecordingMeta` | `session-manager.ts`, `database/sqlite.ts` |
| Cursor replacement / highlight / per-button click effects / smoothing / trail — identical render in preview & export | `src/shared/cursor-render.ts` |
| Live annotation overlays (pen/highlighter/arrow/line/rect/ellipse/text/eraser, undo/redo, click-through when idle) | `src/renderer/overlay/annotation-overlay.ts`, `annotation-service.ts` |
| Annotation shapes persisted with timestamps and re-rendered at export | `annotations.json` + compositor |
| Floating recording toolbar (timer, pause/stop, mic, draw toggle) | `src/renderer/toolbar/` |
| Editor timeline: trim, split, delete segments (EDL), text overlays, audio tracks | `src/shared/edl.ts`, editor page/stores |
| Non-destructive projects (JSON in SQLite; source media never modified) | `database/sqlite.ts` |
| Export MP4 H.264/H.265, resolution presets incl. source, 24/30/60 fps, quality presets or explicit bitrate | `src/main/export/ffmpeg-args.ts` |
| Export overlay compositing (cursor + annotations + text) via RGBA pipe | `src/main/export/compositor.ts` |
| Audio export mixing (mic + system + music, volumes, music delay) → AAC 192k | `ffmpeg-args.ts` |
| Hardware encoder probing (NVENC → QSV → AMF) with software fallback | `src/main/ffmpeg/locate.ts` |
| Export progress (percent/speed/fps), cancellation, FIFO queue | `src/main/export/export-manager.ts` |
| Thumbnails + ffprobe-verified metadata per recording | `session-manager.ts` |
| Recordings library: list/rename/delete (to `.trash`), storage statistics | `ipc/handlers.ts` |
| Settings: theme, recordings dir, defaults, cursor config, hardware encoding, startup toggle | `src/main/settings/store.ts`, settings page |
| Security model: contextIsolation, frozen allowlisted preload API, zod-validated IPC, recfile protocol, CSP, single instance | `src/preload/`, `src/main/ipc/`, `recfile-protocol.ts` |
| NSIS installer (per-user, custom dir, shortcuts, branded icon) + bundled ffmpeg/ffprobe | `electron-builder.yml`, `resources/bin/` |

## 🟡 Partial / degraded (works, with caveats)

| Feature | Condition | Detail |
| --- | --- | --- |
| Global cursor **clicks** | requires `cursor_hook` addon | polling fallback = positions only (`docs/WINDOWS-LIMITATIONS.md` #1) |
| Toolbar/overlay hidden from capture | requires `cursor_hook` addon | without it they are visible in fullscreen/region captures (#2) |
| Native WGC path | requires `wgc_capture` addon | otherwise desktopCapturer (webm transcode at stop) |
| Window-mode annotations **in live capture** | n/a | window capture cannot include the overlay window live; export re-renders annotations from metadata, so final MP4 is correct |
| System audio | depends on Chromium loopback | video-only + warning when unavailable |
| WGC pause | frame-gating | paused spans contain no frames (timing stays aligned) |
| Win10 pre-21H2 WGC border | OS API | yellow border cannot be suppressed |
| Hardware H.265 | encoder probe | uses `hevc_*` when detected; otherwise libx265 (slower) |

## ❌ Not implemented / v1 gaps

| Item | Note |
| --- | --- |
| Magnifier rendering | `CursorConfig.magnifier` exists but the compositor does not draw a lens yet |
| Live mic enable/disable mid-recording | documented gap in capture agent (next session) |
| WASAPI-native loopback addon path | `native/wasapi_capture` scaffolded but not wired as a capture source |
| Multi-track audio editing (cut/split audio independently) | audio tracks play from their start offset with volume; per-item trimming is not exposed yet |
| Editor cursor-event surgery (move/delete individual click markers) | cursor config is global per project; per-event editing is roadmap |
| Automatic updates | no updater configured (documented) |
| Code-signed installer | no certificate configured in this build |
| Non-Windows builds | app targets Windows 10/11 x64 (other platforms untested/unsupported) |
