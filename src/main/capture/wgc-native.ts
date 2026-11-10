/**
 * Native Windows Graphics Capture backend (via the `wgc_capture` addon).
 *
 * Frames arrive as tightly-packed BGRA buffers; they are piped straight into
 * an FFmpeg rawvideo -> H.264 process, so recording is written as MP4 in real
 * time (hardware encoder when available, libx264 otherwise).
 *
 * Returns null whenever the native module is unavailable (non-Windows dev,
 * missing build) so the caller can fall back to desktopCapturer.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { Rect } from '../../shared/types'
import { getFfmpegPath } from '../ffmpeg/locate'
import { loadNativeAddon } from '../native/loader'
import type { VideoCaptureSession } from './capture-types'

interface WgcFrame {
  buffer: Buffer
  width: number
  height: number
  tMs: number
}

interface WgcStartOptions {
  kind: 'monitor' | 'window'
  monitorIndex?: number
  hwndBuffer?: Buffer
  fps?: number
  crop?: Rect | null
  includeCursor?: boolean
}

interface WgcAddon {
  isSupported?: () => boolean
  start: (opts: WgcStartOptions, callback: (frame: WgcFrame | { error: string }) => void) => boolean
  stop: () => boolean
}

export function isWgcAvailable(): boolean {
  const addon = loadNativeAddon('wgc_capture') as WgcAddon | null
  if (!addon) return false
  try {
    return addon.isSupported ? addon.isSupported() : true
  } catch {
    return false
  }
}

export interface WgcCaptureOptions {
  monitorIndex: number
  fps: number
  outDir: string
  /** Crop within the monitor, physical px, monitor-local. */
  crop?: Rect | null
  includeCursor: boolean
  hardwareEncoders: string[]
}

export async function startWgcCapture(opts: WgcCaptureOptions): Promise<VideoCaptureSession | null> {
  const addon = loadNativeAddon('wgc_capture') as WgcAddon | null
  if (!addon) return null

  const width = opts.crop ? opts.crop.width : 0
  const height = opts.crop ? opts.crop.height : 0
  if (opts.crop && (width <= 0 || height <= 0)) return null

  const outPath = path.join(opts.outDir, 'source-video.mp4')
  const encoder = opts.hardwareEncoders[0] ?? 'libx264'
  const encoderArgs =
    encoder === 'h264_nvenc'
      ? ['-preset', 'p4', '-rc', 'vbr', '-cq', '21', '-b:v', '0']
      : encoder === 'h264_qsv'
        ? ['-preset', 'medium', '-global_quality', '21']
        : encoder === 'h264_amf'
          ? ['-quality', 'balanced', '-rc', 'vbr_peak', '-b:v', '12M']
          : ['-preset', 'veryfast', '-crf', '20']

  const sizeArgs =
    opts.crop && width > 0 && height > 0
      ? ['-video_size', `${width}x${height}`]
      : []

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'bgra',
    ...sizeArgs,
    '-framerate', String(opts.fps),
    '-i', 'pipe:3',
    '-c:v', encoder,
    ...encoderArgs,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath,
  ]

  let child: ChildProcess
  try {
    child = spawn(getFfmpegPath(), args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch {
    return null
  }

  const fd3 = child.stdio[3]
  if (!fd3 || !('write' in fd3)) {
    child.kill()
    return null
  }
  const frameStream = fd3 as NodeJS.WritableStream

  // Pause is implemented by gating frame writes; frames keep flowing into the
  // addon but are dropped while paused (timestamp gap is compensated because
  // ffmpeg rawvideo timestamps are derived from frame count and framerate).
  let paused = false
  let addonFailed: string | null = null
  let writing: Promise<void> = Promise.resolve()

  const queueFrame = (buffer: Buffer): void => {
    writing = writing.then(
      () =>
        new Promise<void>((resolve) => {
          const ok = frameStream.write(buffer)
          if (ok) resolve()
          else frameStream.once('drain', () => resolve())
        }),
    )
  }

  const startOk = addon.start(
    {
      kind: 'monitor',
      monitorIndex: opts.monitorIndex,
      fps: opts.fps,
      crop: opts.crop ?? null,
      includeCursor: opts.includeCursor,
    },
    (frame) => {
      if ('error' in frame) {
        addonFailed = frame.error
        return
      }
      if (paused) return
      queueFrame(frame.buffer)
    },
  )

  if (!startOk) {
    child.kill()
    return null
  }

  let stderrTail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + String(chunk)).slice(-4000)
  })

  const ffmpegClosed = new Promise<{ code: number | null }>((resolve) => {
    child.once('close', (code) => resolve({ code }))
  })

  let stopped = false

  const finish = async (): Promise<{
    videoPath: string
    micPath?: string
    systemPath?: string
  }> => {
    if (!stopped) {
      stopped = true
      try {
        addon.stop()
      } catch {
        /* best effort */
      }
    }
    await writing.catch(() => undefined)
    await new Promise<void>((resolve) => {
      frameStream.end(() => resolve())
    })
    const { code } = await ffmpegClosed
    if (code !== 0) {
      throw new Error(
        `WGC recording failed (ffmpeg ${code}): ${stderrTail.slice(-300)}${addonFailed ? ` / addon: ${addonFailed}` : ''}`,
      )
    }
    return { videoPath: outPath }
  }

  return {
    backend: 'wgc-native',
    width: width || 0,
    height: height || 0,
    actualFps: opts.fps,
    pause(): void {
      paused = true
    },
    resume(): void {
      paused = false
    },
    stop: finish,
  }
}
