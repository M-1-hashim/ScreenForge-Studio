/**
 * Export manager — job queue, FFmpeg orchestration, progress events, cancel.
 *
 * Design notes:
 *  - Max 1 running export; additional jobs stay 'queued' (FIFO).
 *  - Everything is async / stream based; the compositor's per-frame work is
 *    bounded (see compositor.ts) so the renderer never freezes.
 *  - When the compositor is enabled, ffmpeg's fd 3 is a Node pipe fed by
 *    OverlayCompositor (input declared as `-i pipe:3`).
 *  - Progress is parsed from ffmpeg stderr (`time=`, `fps=`, `speed=`) and
 *    broadcast throttled to ~250 ms.
 *  - Cancellation: win32 uses `taskkill /T /F` (ffmpeg may have no children,
 *    but /T also covers filtergraph subprocesses); POSIX escalates
 *    SIGTERM -> SIGKILL after 3 s. No orphan ffmpeg is left behind.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { db } from '../database/index'
import { detectHwEncoders, getFfmpegPath, probeMedia } from '../ffmpeg/locate'
import { broadcast } from '../ipc/registry'
import { outputDurationMs, normalizeSegments, remapAnnotations, remapCursorEvents } from '../../shared/edl'
import type {
  AnnotationShape,
  CursorEvent,
  CursorEventFile,
  EditorProject,
  ExportCodec,
  ExportOptions,
  ExportProgress,
  ExportState,
  RecordingMeta,
} from '../../shared/types'

import { OverlayCompositor } from './compositor'
import { buildExportArgs } from './ffmpeg-args'

// ---------------------------------------------------------------------------
// Job bookkeeping
// ---------------------------------------------------------------------------

interface ExportJob {
  id: string
  recordingId: string
  state: ExportState
  percent: number
  output?: string
  error?: string
  speed?: string
  fps?: number
  child: ChildProcess | null
  compositor: OverlayCompositor | null
  canceled: boolean
  /** ExportOptions snapshot taken at start() time. */
  options: ExportOptions
}

const jobs = new Map<string, ExportJob>()
const pendingIds: string[] = []
let runningId: string | null = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function emitProgress(job: ExportJob): void {
  const payload: ExportProgress = {
    jobId: job.id,
    recordingId: job.recordingId,
    state: job.state,
    percent: job.percent,
    output: job.output,
    error: job.error,
    speed: job.speed,
    fps: job.fps,
  }
  broadcast('evt:export-progress', payload)
}

/** Read a settings value that may be stored raw or JSON-encoded. */
function readSettingString(key: string): string | null {
  let raw: string | undefined
  try {
    raw = db.getSettingsRaw()[key]
  } catch {
    return null
  }
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  if (value.startsWith('"') || value.startsWith("'")) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'string' && parsed.trim()) return parsed.trim()
    } catch {
      /* fall through to raw */
    }
  }
  return value
}

function resolveRecordingsDir(): string {
  const configured = readSettingString('recordingsDir')
  if (configured) return configured
  return path.join(os.homedir(), 'Videos', 'ScreenForge')
}

function slugify(input: string): string {
  const slug = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'export'
}

function timestampName(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`
}

async function buildOutputPath(title: string, outputName?: string): Promise<string> {
  const dir = path.join(resolveRecordingsDir(), 'exports')
  await fsp.mkdir(dir, { recursive: true })
  const base = slugify(outputName && outputName.trim() ? outputName : title)
  return path.join(dir, `${base}-${timestampName()}.mp4`)
}

async function loadCursorSession(
  recording: RecordingMeta,
): Promise<{ events: CursorEvent[]; displays: CursorEventFile['displays'] }> {
  if (!recording.cursorEventsPath) return { events: [], displays: [] }
  try {
    const raw = await fsp.readFile(recording.cursorEventsPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CursorEventFile>
    if (!parsed || !Array.isArray(parsed.events)) return { events: [], displays: [] }
    return {
      events: parsed.events,
      displays: Array.isArray(parsed.displays) ? parsed.displays : [],
    }
  } catch {
    return { events: [], displays: [] }
  }
}

async function loadAnnotations(recording: RecordingMeta): Promise<AnnotationShape[]> {
  if (!recording.annotationsPath) return []
  try {
    const raw = await fsp.readFile(recording.annotationsPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as AnnotationShape[]) : []
  } catch {
    return []
  }
}

function loadProjectFor(recordingId: string): EditorProject | null {
  try {
    return db.listProjects(recordingId)[0] ?? null
  } catch {
    return null
  }
}

// -- hardware encoder detection (probe once, then memoize) --------------------

let hwEncodersCache: string[] | null = null

async function detectHwEncodersCached(): Promise<string[]> {
  if (hwEncodersCache === null) {
    try {
      hwEncodersCache = await detectHwEncoders()
    } catch {
      hwEncodersCache = []
    }
  }
  return hwEncodersCache
}

async function resolveHwEncoder(codec: ExportCodec): Promise<string | undefined> {
  const setting = readSettingString('hardwareEncoding')
  if (setting === 'off') return undefined
  const prefix = codec === 'h264' ? 'h264_' : 'hevc_'
  const list = await detectHwEncodersCached()
  return list.find((e) => e.startsWith(prefix))
}

// -- process teardown -----------------------------------------------------------

function killChild(child: ChildProcess | null): void {
  if (!child) return
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') {
      if (child.pid) {
        // /T kills the whole tree, /F forces — ffmpeg never survives cancel.
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
      }
    } else {
      child.kill('SIGTERM')
      const t = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, 3000)
      // Do not hold the event loop open just for the escalation timer.
      ;(t as { unref?: () => void }).unref?.()
    }
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

async function runJob(job: ExportJob): Promise<void> {
  const options = job.options
  let child: ChildProcess | null = null
  let compositor: OverlayCompositor | null = null
  try {
    const recording = db.getRecording(job.recordingId)
    if (!recording) throw new Error(`Recording ${job.recordingId} not found`)

    job.state = 'running'
    emitProgress(job)

    const probe = await probeMedia(recording.videoPath)
    if (job.canceled) {
      job.state = 'canceled'
      emitProgress(job)
      return
    }

    // Session sidecars may legitimately not exist (recording without cursor
    // capture / annotations) — missing files mean empty data, not failure.
    const session = await loadCursorSession(recording)
    const annotations = await loadAnnotations(recording)
    const project = loadProjectFor(recording.id)

    // Timeline: normalize (drop invalid, merge overlaps); empty = full video.
    const segments = normalizeSegments(
      options.segments.length > 0
        ? options.segments
        : [{ startMs: 0, endMs: Math.max(probe.durationMs, recording.durationMs, 1) }],
    )
    const outDurMs = outputDurationMs(segments)
    if (outDurMs <= 0) throw new Error('Export timeline is empty (zero-length output)')

    const cursorEvents = remapCursorEvents(session.events, segments)
    const remappedAnnotations = remapAnnotations(annotations, segments)
    const textOverlays = options.includeTextOverlays ? (project?.textOverlays ?? []) : []
    const compositorEnabled =
      options.includeCursor || options.includeAnnotations || textOverlays.length > 0

    // Validate that the audio sources the user asked for actually exist —
    // a missing file should fail fast with a clear message, not mid-encode.
    if (options.includeMic && recording.micAudioPath) await assertFile(recording.micAudioPath, 'microphone audio')
    if (options.includeSystemAudio && recording.systemAudioPath)
      await assertFile(recording.systemAudioPath, 'system audio')
    if (options.musicPath) await assertFile(options.musicPath, 'music track')

    const hwEncoder = await resolveHwEncoder(options.codec)
    const outputPath = await buildOutputPath(recording.title, options.outputName)

    const plan = buildExportArgs({
      recording,
      options: { ...options, segments },
      probe,
      outputPath,
      compositorEnabled,
      hwEncoder,
    })

    // Spawn: fd 3 is the compositor pipe when the overlay layer is enabled.
    if (job.canceled) {
      job.state = 'canceled'
      emitProgress(job)
      return
    }
    const stdio: Array<'ignore' | 'pipe'> = ['ignore', 'ignore', 'pipe']
    if (compositorEnabled) stdio.push('pipe')
    child = spawn(getFfmpegPath(), plan.args, { stdio, windowsHide: true })
    job.child = child

    let compositorTask: Promise<void> | null = null
    if (compositorEnabled) {
      const fd3 = child.stdio[3] as NodeJS.WritableStream | undefined
      if (!fd3) throw new Error('export: failed to open the compositor pipe (fd 3)')
      compositor = new OverlayCompositor({
        width: plan.outputWidth,
        height: plan.outputHeight,
        fps: options.fps,
        cursorConfig: options.cursorConfig,
        cursorEvents,
        cursorDisplays: session.displays,
        annotations: remappedAnnotations,
        textOverlays,
        recordingMeta: recording,
        durationMs: plan.outputDurationMs,
      })
      job.compositor = compositor
      compositorTask = (async () => {
        await compositor!.open(fd3)
        try {
          await compositor!.writeFrames()
        } finally {
          // End the stream so ffmpeg receives EOF and can finalize the file.
          compositor!.close()
        }
      })()
      compositorTask.catch(() => {
        /* handled after ffmpeg exits */
      })
    }

    // -- progress parsing (throttled to ~250 ms) --------------------------------
    let stderrTail = ''
    let lastEmit = 0
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + String(chunk)).slice(-8000)
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderrTail)
      if (!m) return
      const timeMs =
        (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
      const now = Date.now()
      if (now - lastEmit < 250) return
      lastEmit = now
      job.percent = Math.min(99, Math.max(0, Math.floor((timeMs / plan.outputDurationMs) * 100)))
      const fpsMatch = /fps=\s*([\d.]+)/.exec(stderrTail)
      if (fpsMatch) job.fps = Number(fpsMatch[1])
      const speedMatch = /speed=\s*([\d.]+x)/.exec(stderrTail)
      if (speedMatch) job.speed = speedMatch[1]
      emitProgress(job)
    })

    // -- wait for ffmpeg ---------------------------------------------------------
    const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      let settled = false
      child!.once('error', (err) => {
        if (!settled) {
          settled = true
          resolve({ code: null, error: err })
        }
      })
      child!.once('close', (code) => {
        if (!settled) {
          settled = true
          resolve({ code })
        }
      })
    })

    // ffmpeg is gone (or never started): unblock the compositor if it was
    // still waiting on backpressure, then collect its outcome.
    compositor?.abort()
    let compositorError: Error | null = null
    if (compositorTask) {
      try {
        await compositorTask
      } catch (err) {
        compositorError = asError(err)
      }
    }
    compositor?.close()
    job.compositor = null

    if (job.canceled) {
      job.state = 'canceled'
      emitProgress(job)
      broadcast('evt:recordings-changed', undefined)
      return
    }
    if (exit.error) throw new Error(`Failed to start ffmpeg: ${exit.error.message}`)
    if (compositorError) throw new Error(`Overlay compositor failed: ${compositorError.message}`)
    if (exit.code !== 0) {
      throw new Error(`ffmpeg exited with code ${exit.code}: ${stderrTail.slice(-400).trim()}`)
    }

    job.state = 'completed'
    job.percent = 100
    job.output = outputPath
    emitProgress(job)
    broadcast('evt:recordings-changed', undefined)
  } catch (err) {
    job.state = job.canceled ? 'canceled' : 'failed'
    job.error = asError(err).message
    emitProgress(job)
  } finally {
    // Never leave orphan processes or dangling streams behind.
    if (job.state === 'failed' || job.state === 'canceled') killChild(child)
    compositor?.close()
    job.child = null
    job.compositor = null
  }
}

async function assertFile(filePath: string, label: string): Promise<void> {
  try {
    const st = await fsp.stat(filePath)
    if (!st.isFile()) throw new Error('not a file')
  } catch {
    throw new Error(`Export aborted: ${label} file not found: ${filePath}`)
  }
}

function pump(): void {
  if (runningId !== null || pendingIds.length === 0) return
  const id = pendingIds.shift()
  if (!id) return
  const job = jobs.get(id)
  if (!job || job.state !== 'queued') {
    pump()
    return
  }
  runningId = id
  void runJob(job).finally(() => {
    runningId = null
    pump()
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const exportManager = {
  /** Enqueue an export; resolves immediately with the job id. */
  start(recordingId: string, options: ExportOptions): { jobId: string } {
    const job: ExportJob = {
      id: randomUUID(),
      recordingId,
      state: 'queued',
      percent: 0,
      child: null,
      compositor: null,
      canceled: false,
      options,
    }
    jobs.set(job.id, job)
    pendingIds.push(job.id)
    emitProgress(job)
    pump()
    return { jobId: job.id }
  },

  /** Cancel a queued or running job. Unknown / finished jobs are ignored. */
  cancel(jobId: string): void {
    const job = jobs.get(jobId)
    if (!job) return
    if (job.state === 'queued') {
      const idx = pendingIds.indexOf(jobId)
      if (idx >= 0) pendingIds.splice(idx, 1)
      job.state = 'canceled'
      emitProgress(job)
      return
    }
    if (job.state === 'running') {
      job.canceled = true
      killChild(job.child)
    }
  },

  /** Snapshot of all queued/running jobs. */
  getActive(): ExportProgress[] {
    const out: ExportProgress[] = []
    for (const job of jobs.values()) {
      if (job.state === 'queued' || job.state === 'running') {
        out.push({
          jobId: job.id,
          recordingId: job.recordingId,
          state: job.state,
          percent: job.percent,
          output: job.output,
          error: job.error,
          speed: job.speed,
          fps: job.fps,
        })
      }
    }
    return out
  },
}
