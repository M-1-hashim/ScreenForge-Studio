/**
 * Editor data services — media-derived assets for the editor UI.
 *
 *  - waveform():  mono PCM -> PNG amplitude picture via ffmpeg `showwavespic`,
 *                 returned as a data URL (directly usable in <img src>).
 *  - thumbnails(): N evenly spaced JPEG frames, returned as data URLs.
 *
 * Every spawn is wrapped: failures resolve to `null` / `[]` instead of
 * throwing, processes are killed on timeout, and results are cached per
 * input so scrubbing the timeline does not re-encode the same asset.
 */
import { spawn } from 'node:child_process'
import { getFfmpegPath, probeMedia } from '../ffmpeg/locate'

// ---------------------------------------------------------------------------
// Shared spawn helper
// ---------------------------------------------------------------------------

interface RunOptions {
  timeoutMs?: number
  maxStdoutBytes?: number
}

/**
 * Run ffmpeg and collect stdout as a Buffer. Rejects on non-zero exit,
 * spawn errors, or timeout (process is killed — no orphans).
 */
async function runFfmpegCapture(args: string[], opts: RunOptions = {}): Promise<Buffer> {
  const { timeoutMs = 30_000, maxStdoutBytes = 64 * 1024 * 1024 } = opts
  const ffmpeg = getFfmpegPath()
  return new Promise<Buffer>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const chunks: Buffer[] = []
    let total = 0
    let stderrTail = ''
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (err: Error | null, data?: Buffer): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (err) {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        reject(err)
      } else {
        resolve(data ?? Buffer.concat(chunks))
      }
    }

    timer = setTimeout(() => finish(new Error('ffmpeg timed out after ' + timeoutMs + 'ms')), timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total <= maxStdoutBytes) chunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000)
    })
    child.on('error', (err) => finish(err))
    child.on('close', (code) => {
      if (code === 0) finish(null)
      else finish(new Error(`ffmpeg exited with code ${code}: ${stderrTail.slice(-400).trim()}`))
    })
  })
}

// ---------------------------------------------------------------------------
// Waveform
// ---------------------------------------------------------------------------

const waveformCache = new Map<string, string | null>()
const WAVEFORM_CACHE_MAX = 256

export async function waveform(filePath: string, width: number, height: number): Promise<string | null> {
  const w = Number.isFinite(width) ? Math.min(4096, Math.max(64, Math.round(width))) : 800
  const h = Number.isFinite(height) ? Math.min(1024, Math.max(16, Math.round(height))) : 80
  const key = `${filePath}|${w}|${h}`
  const cached = waveformCache.get(key)
  if (cached !== undefined) return cached

  let result: string | null = null
  try {
    const buf = await runFfmpegCapture([
      '-hide_banner',
      '-nostdin',
      '-loglevel', 'error',
      '-i', filePath,
      '-filter_complex',
      `aformat=channel_layouts=mono,showwavespic=s=${w}x${h}:colors=#f59e0b`,
      '-frames:v', '1',
      '-f', 'image2',
      '-c:v', 'png',
      'pipe:1',
    ])
    if (buf.length > 0) result = `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    result = null
  }

  if (waveformCache.size >= WAVEFORM_CACHE_MAX) waveformCache.clear()
  waveformCache.set(key, result)
  return result
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

const thumbnailsCache = new Map<string, string[]>()
const THUMBNAILS_CACHE_MAX = 64

/**
 * Extract `count` evenly spaced frames (at (i / (count+1)) * duration) as
 * JPEG data URLs. Individual frame failures are skipped; a total failure
 * (probe error, unreadable file) resolves to [].
 */
export async function thumbnails(videoPath: string, count: number): Promise<string[]> {
  const n = Number.isFinite(count) ? Math.min(50, Math.max(1, Math.round(count))) : 10
  const key = `${videoPath}|${n}`
  const cached = thumbnailsCache.get(key)
  if (cached) return cached

  const out: string[] = []
  try {
    const probe = await probeMedia(videoPath)
    if (probe.durationMs > 0) {
      for (let i = 1; i <= n; i++) {
        const tSec = ((i / (n + 1)) * probe.durationMs) / 1000
        try {
          const buf = await runFfmpegCapture(
            [
              '-hide_banner',
              '-nostdin',
              '-loglevel', 'error',
              '-ss', tSec.toFixed(3),
              '-i', videoPath,
              '-frames:v', '1',
              '-vf', 'scale=480:-2',
              '-q:v', '6',
              '-f', 'image2',
              '-c:v', 'mjpeg',
              'pipe:1',
            ],
            { timeoutMs: 20_000 },
          )
          if (buf.length > 0) out.push(`data:image/jpeg;base64,${buf.toString('base64')}`)
        } catch {
          /* skip this frame */
        }
      }
    }
  } catch {
    /* probe failed -> [] */
  }

  if (thumbnailsCache.size >= THUMBNAILS_CACHE_MAX) thumbnailsCache.clear()
  thumbnailsCache.set(key, out)
  return out
}
