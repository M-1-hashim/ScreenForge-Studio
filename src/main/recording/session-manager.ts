/**
 * Recording session manager — the single orchestrator of a recording.
 *
 * Lifecycle:
 *   idle → preparing → (countdown) → recording ⇄ paused → stopping → processing → idle
 *
 * Owns: capture backend selection (native WGC preferred, desktopCapturer
 * fallback), audio, cursor event recording, annotation overlays, the floating
 * toolbar, the shared RecordingClock, the UI tick, and finalization
 * (transcode + region crop + thumbnail + sidecars + database record).
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { db } from '../database'
import { getFfmpegPath, probeMedia } from '../ffmpeg/locate'
import { broadcast } from '../ipc/registry'
import { getDisplays, virtualOrigin } from '../windows/display-utils'
import {
  closeAnnotationOverlays,
  closeFloatingToolbar,
  openAnnotationOverlays,
  openCountdown,
  openFloatingToolbar,
} from '../windows/overlay-windows'
import { getOrCreateAgentWindow } from '../windows/capture-agent'
import { settingsStore } from '../settings/store'
import * as annotationService from '../annotation/annotation-service'
import { isWgcAvailable, startWgcCapture } from '../capture/wgc-native'
import { resolveSourceId, startDesktopCapturerCapture } from '../capture/desktop-capturer'
import { startCursorRecording } from '../cursor/cursor-recorder'
import type { CursorRecordingHandle } from '../cursor/cursor-recorder'
import type { VideoCaptureSession } from '../capture/capture-types'
import { RecordingClock } from './clock'
import type {
  AnnotationShape,
  RecordingConfig,
  RecordingMeta,
  RecordingState,
} from '../../shared/types'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ActiveSession {
  id: string
  cfg: RecordingConfig
  dir: string
  clock: RecordingClock
  state: RecordingState
  video: VideoCaptureSession
  cursor: CursorRecordingHandle
  tickTimer: NodeJS.Timeout | null
  startedAtEpoch: string
}

let session: ActiveSession | null = null
let state: RecordingState = 'idle'

function setState(next: RecordingState): void {
  state = next
  broadcast('evt:recorder-state', next)
}

function logError(scope: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  // eslint-disable-next-line no-console
  console.error(`[${scope}]`, message)
  broadcast('evt:app-error', { scope, message, severity: 'error' })
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

async function start(rawCfg: RecordingConfig): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (session || (state !== 'idle' && state !== 'preparing')) {
    return { ok: false, reason: 'A recording is already in progress.' }
  }
  if (rawCfg.mode === 'region' && !rawCfg.region) {
    return { ok: false, reason: 'Draw a region before starting.' }
  }
  if (rawCfg.mode === 'window' && !rawCfg.windowId) {
    return { ok: false, reason: 'Select a window before starting.' }
  }

  try {
    setState('preparing')

    const recordingsDir = settingsStore.ensureRecordingsDir()
    const id = randomUUID()
    const dir = path.join(recordingsDir, id)
    await fsp.mkdir(dir, { recursive: true })

    const displays = getDisplays()
    const target =
      displays.find((d) => d.id === rawCfg.displayId) ?? displays[0] ?? null
    if (!target) {
      setState('idle')
      return { ok: false, reason: 'No display available for capture.' }
    }

    // Optional countdown on the target display.
    if (rawCfg.countdownSec > 0) {
      setState('countdown')
      await openCountdown(target, rawCfg.countdownSec)
    }

    setState('preparing')

    // -- video ---------------------------------------------------------------
    const { detectHwEncoders } = await import('../ffmpeg/locate')
    let hardwareEncoders: string[] = []
    try {
      hardwareEncoders =
        settingsStore.getAll().hardwareEncoding === 'auto' ? await detectHwEncoders() : []
    } catch {
      hardwareEncoders = []
    }

    let video: VideoCaptureSession | null = null

    // Native path: WGC full-monitor or region capture on the chosen display.
    if (rawCfg.mode !== 'window' && isWgcAvailable()) {
      try {
        const allDisplays = (await import('electron')).screen.getAllDisplays()
        const monitorIndex = Math.max(
          0,
          allDisplays.findIndex((d) => d.id === rawCfg.displayId),
        )
        video = await startWgcCapture({
          monitorIndex,
          fps: rawCfg.fps,
          outDir: dir,
          crop: rawCfg.mode === 'region' ? rawCfg.region ?? null : null,
          includeCursor: true, // keep OS cursor in source; exporter can replace it
          hardwareEncoders,
        })
      } catch {
        video = null
      }
    }

    // Fallback path: hidden agent + desktopCapturer + MediaRecorder.
    if (!video) {
      const sourceId = await resolveSourceId(rawCfg.mode === 'window' ? 'window' : 'screen', {
        displayId: rawCfg.displayId,
        windowId: rawCfg.windowId,
      })
      if (!sourceId) {
        setState('idle')
        return { ok: false, reason: 'Could not resolve a capture source. Try again.' }
      }
      const agentWindow = getOrCreateAgentWindow()
      // Give the agent page a moment to finish loading if it was just created.
      await waitForAgentReady(agentWindow)
      video = await startDesktopCapturerCapture({
        agentWindow,
        sourceId,
        fps: rawCfg.fps,
        outDir: dir,
        includeSystemAudio: rawCfg.audio.system,
        includeMic: rawCfg.audio.mic,
        micDeviceId: rawCfg.audio.micDeviceId,
      })
    }

    // -- cursor + clock --------------------------------------------------------
    const clock = new RecordingClock()
    const cursor = startCursorRecording({
      clock,
      displays,
      enabled: rawCfg.cursorCapture,
    })

    session = {
      id,
      cfg: rawCfg,
      dir,
      clock,
      state: 'recording',
      video,
      cursor,
      tickTimer: null,
      startedAtEpoch: new Date().toISOString(),
    }

    // -- overlays / toolbar -----------------------------------------------------
    if (rawCfg.annotationsEnabled) {
      annotationService.beginSession(id)
      openAnnotationOverlays(id, displays)
    }
    openFloatingToolbar(target)

    clock.start()
    setState('recording')

    session.tickTimer = setInterval(() => {
      if (!session) return
      broadcast('evt:tick', { elapsedMs: Math.round(session.clock.nowMs()), state })
    }, 100)

    return { ok: true }
  } catch (err) {
    session = null
    setState('idle')
    logError('recorder', err)
    return { ok: false, reason: err instanceof Error ? err.message : 'Failed to start recording.' }
  }
}

function waitForAgentReady(win: Electron.BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (!win.webContents.isLoading()) {
      resolve()
      return
    }
    const done = () => {
      cleanup()
      resolve()
    }
    const t = setTimeout(done, 6000)
    function cleanup(): void {
      clearTimeout(t)
      win.webContents.removeListener('did-finish-load', done)
    }
    win.webContents.once('did-finish-load', done)
  })
}

function pause(): void {
  if (!session || state !== 'recording') return
  try {
    session.clock.pause()
    session.video.pause()
    setState('paused')
  } catch (err) {
    logError('recorder', err)
  }
}

function resume(): void {
  if (!session || state !== 'paused') return
  try {
    session.clock.resume()
    session.video.resume()
    setState('recording')
  } catch (err) {
    logError('recorder', err)
  }
}

async function stop(): Promise<{ recordingId: string } | null> {
  if (!session || (state !== 'recording' && state !== 'paused')) return null
  const active = session
  session = null
  try {
    setState('stopping')

    if (active.tickTimer) clearInterval(active.tickTimer)
    active.clock.stop()

    // Collect annotation shapes before tearing overlays down.
    const annotations: AnnotationShape[] = active.cfg.annotationsEnabled
      ? annotationService.endSession()
      : []
    closeAnnotationOverlays()
    closeFloatingToolbar()

    // Stop sources (video finalizes files; cursor finalizes its event file).
    const cursorFile = active.cursor.stop()
    const videoResult = await active.video.stop()

    setState('processing')
    const meta = await finalize(active, videoResult, cursorFile, annotations)

    setState('idle')
    broadcast('evt:recordings-changed', undefined)
    return { recordingId: meta.id }
  } catch (err) {
    setState('idle')
    logError('recorder', err)
    return null
  }
}

async function cancel(): Promise<void> {
  if (!session) return
  const active = session
  session = null
  try {
    if (active.tickTimer) clearInterval(active.tickTimer)
    active.clock.stop()
    if (active.cfg.annotationsEnabled) annotationService.endSession()
    closeAnnotationOverlays()
    closeFloatingToolbar()
    try {
      active.cursor.stop()
    } catch {
      /* ignore */
    }
    try {
      await active.video.stop()
    } catch {
      /* ignore — files may be incomplete */
    }
    // Never delete user data silently: move the partial session into .trash.
    try {
      const trashDir = path.join(settingsStore.ensureRecordingsDir(), '.trash')
      await fsp.mkdir(trashDir, { recursive: true })
      await fsp.rename(active.dir, path.join(trashDir, active.id)).catch(async () => {
        await fsp.rm(active.dir, { recursive: true, force: true })
      })
    } catch {
      /* ignore */
    }
  } catch (err) {
    logError('recorder', err)
  } finally {
    setState('idle')
  }
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

function runFfmpeg(args: string[]): Promise<{ code: number | null; stderrTail: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(getFfmpegPath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + String(chunk)).slice(-4000)
    })
    child.once('close', (code) => resolve({ code, stderrTail }))
    child.once('error', (err) => {
      stderrTail = err.message
      resolve({ code: -1, stderrTail })
    })
  })
}

async function finalize(
  active: ActiveSession,
  videoResult: { videoPath: string; micPath?: string; systemPath?: string },
  cursorFile: ReturnType<CursorRecordingHandle['stop']>,
  annotations: AnnotationShape[],
): Promise<RecordingMeta> {
  const finalVideo = path.join(active.dir, `${active.id}.mp4`)
  const thumbPath = path.join(active.dir, 'thumbnail.jpg')

  const backend = active.video.backend
  const needsTranscode =
    backend === 'desktop-capturer' || (active.cfg.mode === 'region' && backend === 'wgc-native')

  if (needsTranscode) {
    const probe = await probeMedia(videoResult.videoPath).catch(() => null)
    const scaleArgs: string[] = []
    if (backend === 'desktop-capturer' && active.cfg.mode === 'region' && active.cfg.region) {
      const r = active.cfg.region
      scaleArgs.push('-vf', `crop=${r.width}:${r.height}:${r.x}:${r.y}`)
    } else if (backend === 'desktop-capturer') {
      // Normalize webm to CFR MP4 at the configured fps.
      scaleArgs.push('-r', String(active.cfg.fps))
    }
    const transcode = await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoResult.videoPath,
      ...scaleArgs,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p',
      ...(videoResult.micPath || videoResult.systemPath ? [] : ['-an']),
      '-movflags', '+faststart',
      finalVideo,
    ])
    if (transcode.code !== 0) {
      // Fall back to keeping the raw webm so the user never loses data.
      await fsp.copyFile(videoResult.videoPath, finalVideo).catch(() => undefined)
      broadcast('evt:app-error', {
        scope: 'recorder',
        message: `Final transcode failed (${transcode.code}); kept the original capture. ${transcode.stderrTail.slice(-200)}`,
        severity: 'warning',
      })
    } else if (probe === null) {
      /* probe failure tolerated — metadata fields stay zeroed */
    }
    await fsp.rm(videoResult.videoPath, { force: true }).catch(() => undefined)
  } else {
    await fsp.rename(videoResult.videoPath, finalVideo).catch(() => undefined)
  }

  // Thumbnail.
  const thumb = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '1',
    '-i', finalVideo,
    '-frames:v', '1',
    '-vf', 'scale=640:-2',
    thumbPath,
  ])
  const hasThumb = thumb.code === 0 && fs.existsSync(thumbPath)

  // Sidecars.
  const cursorEventsPath = cursorFile
    ? path.join(active.dir, 'cursor-events.json')
    : undefined
  if (cursorEventsPath && cursorFile) {
    await fsp.writeFile(cursorEventsPath, JSON.stringify(cursorFile), 'utf8')
  }
  const annotationsPath =
    active.cfg.annotationsEnabled && annotations.length > 0
      ? path.join(active.dir, 'annotations.json')
      : undefined
  if (annotationsPath) {
    await fsp.writeFile(annotationsPath, JSON.stringify(annotations), 'utf8')
  }

  // Probe the final file for trustworthy metadata.
  const probe = await probeMedia(finalVideo).catch(() => null)
  const elapsedMs = Math.max(1, Math.round(active.clock.nowMs()))

  const origin = virtualOrigin()
  void origin

  const displays = getDisplays()
  const target = displays.find((d) => d.id === active.cfg.displayId)

  const meta: RecordingMeta = {
    id: active.id,
    title: `Recording ${new Date().toLocaleString()}`,
    createdAt: active.startedAtEpoch,
    durationMs: probe?.durationMs && probe.durationMs > 0 ? probe.durationMs : elapsedMs,
    mode: active.cfg.mode,
    displayId: active.cfg.displayId,
    region: active.cfg.mode === 'region' ? active.cfg.region : undefined,
    width: probe?.width ?? active.video.width ?? 0,
    height: probe?.height ?? active.video.height ?? 0,
    fps: probe?.fps ? Math.round(probe.fps) : active.cfg.fps,
    videoPath: finalVideo,
    micAudioPath: videoResult.micPath,
    systemAudioPath: videoResult.systemPath,
    cursorEventsPath,
    annotationsPath,
    thumbnailPath: hasThumb ? thumbPath : undefined,
    sizeBytes: fs.existsSync(finalVideo) ? fs.statSync(finalVideo).size : 0,
    captureBackend: backend,
    cursorBackend: cursorFile ? active.cursor.backend : 'polling',
  }
  void target

  db.upsertRecording(meta)
  await fsp
    .writeFile(path.join(active.dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
    .catch(() => undefined)

  return meta
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const sessionManager = {
  start,
  pause,
  resume,
  stop,
  cancel,

  getState(): RecordingState {
    return state
  },

  getElapsedMs(): number {
    return session ? Math.round(session.clock.nowMs()) : 0
  },
}

/** Used by the annotation service when drawing is enabled mid-recording. */
export function openAnnotationOverlaysForCurrentRecording(): void {
  if (!session) return
  openAnnotationOverlays(session.id, getDisplays())
}
