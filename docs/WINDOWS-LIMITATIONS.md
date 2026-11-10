# Windows-specific limitations

Honest, code-verified limitations of ScreenForge Studio 1.0.0 on Windows, each
with its impact and workaround. These exist to keep the documentation truthful —
nothing here is hidden behind marketing language.

## 1. Cursor clicks require the optional native hook

- **Limitation:** global click (and wheel) events come from the optional
  `cursor_hook` C++ addon (`WH_MOUSE_LL`). Without it, tracking falls back to
  ~60 Hz polling of `screen.getCursorScreenPoint()` which captures
  **positions only**.
- **Impact:** click effects (ripple/burst/pulse) cannot be auto-placed on
  recordings made without the addon; `cursorBackend` will report `polling`.
- **Workaround:** build the addon on Windows (`npm run native:build`) and
  place it in `resources/native/`, or add click markers manually in the editor.

## 2. Helper windows can appear in the captured video

- **Limitation:** the floating toolbar and annotation overlays are excluded
  from capture via `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` — but
  that call lives in the optional `cursor_hook` addon. Without it, Windows
  has no API reachable from Electron to hide a window from capture.
- **Impact:** fullscreen/region recordings made without the addon show the
  toolbar/overlay pixels in the video (annotations are usually *wanted* on
  screen; the toolbar usually is not).
- **Workaround:** same as #1 (ship the addon). The countdown window is brief
  and the toolbar sits at the bottom edge — crop it in the editor if needed.

## 3. WGC capture specifics

- **Yellow border:** on Windows 10 versions before 21H2 the Windows Graphics
  Capture API draws a yellow border around captured monitors and cannot
  disable it. Windows 11 / Win10 21H2+ suppress it via
  `IsBorderRequired=false` (the addon does this when supported).
- **Monitor-only:** the native WGC path captures **monitors** (optionally
  cropped). Window mode always uses the desktopCapturer backend.
- **Pause drops frames:** pausing gates frame writes; the gap is compensated
  by ffmpeg rawvideo frame-count timing, so A/V stay aligned but paused
  moments contain no frames (by design).

## 4. System audio loopback availability

- **Limitation:** system audio uses Chromium's desktop loopback
  (`chromeMediaSource: 'desktop'`), which is supported on Windows 10/11. On
  configurations where it fails (driver policies, remote sessions), the
  recorder continues **video-only** with a warning event.
- **Workaround:** record with a microphone, or capture a WAB-level loopback
  via the optional `wasapi_capture` addon (roadmap).

## 5. Microphone toggle mid-recording

- **Limitation:** enabling/disabling the mic after the recording started does
  not take effect until the next session (documented v1 gap inside
  `capture-agent.ts`).
- **Workaround:** choose mic on/off before starting; stop + restart for a
  mid-session change.

## 6. Unsigned installer

- **Limitation:** the shipped `ScreenForge Studio-Setup-1.0.0.exe` is not
  code-signed, so SmartScreen may warn and antivirus heuristics may flag it.
- **Workaround:** "More info → Run anyway", verify the SHA-256 in the README,
  or sign with your own certificate (`docs/BUILDING.md` → Code signing).

## 7. Electron-ABI coupling for better-sqlite3

- **Limitation:** `better-sqlite3` is not N-API; its prebuild must match the
  Electron ABI (`electron-v130` ↔ Electron 33.x).
- **Impact:** upgrading Electron requires re-fetching the matching prebuild
  (`npx prebuild-install --runtime electron --target <new version> ...`).
- **Workaround:** documented in `docs/BUILDING.md`.

## 8. Compositor magnifier is configuration-only

- **Limitation:** `CursorConfig.magnifier` exists in settings/inspector, but
  the export compositor does not render a magnifier lens yet.
- **Workaround:** disable magnifier for now (default is off).

## 9. Global shortcuts / secure desktop

- Windows does not deliver global mouse hooks on the secure desktop (UAC
  prompts, the lock screen). Cursor events during those moments are absent —
  recordings of UAC interactions will show a cursor gap.
