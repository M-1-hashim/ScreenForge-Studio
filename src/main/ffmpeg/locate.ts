/**
 * FFmpeg / ffprobe binary resolution + hardware encoder detection.
 *
 * Resolution order:
 *   1. SCREENFORGE_FFMPEG / SCREENFORGE_FFPROBE env override
 *   2. bundled binaries in <resources>/bin (shipped by electron-builder)
 *   3. ffmpeg-static / ffprobe-static npm packages (dev)
 *   4. system PATH
 *
 * This module must stay free of Electron imports so it is unit-testable in
 * plain Node.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

let cachedFfmpeg: string | null = null
let cachedFfprobe: string | null = null

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function exe(name: 'ffmpeg' | 'ffprobe'): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function resourceBin(name: 'ffmpeg' | 'ffprobe'): string | null {
  const candidates: string[] = []
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', exe(name)))
  // dev layout: dist-electron/main/<dir> -> project root
  candidates.push(path.join(__dirname, '..', '..', '..', 'resources', 'bin', exe(name)))
  for (const c of candidates) {
    if (isExecutable(c)) return c
  }
  return null
}

function staticBin(name: 'ffmpeg' | 'ffprobe'): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static')
    const p: string | undefined = name === 'ffmpeg' ? (mod as { path?: string }).path ?? (mod as string) : (mod as { path?: string }).path
    if (p && isExecutable(p)) return p
  } catch {
    /* not installed — fine */
  }
  return null
}

function pathBin(name: 'ffmpeg' | 'ffprobe'): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter)
  for (const d of dirs) {
    if (!d) continue
    const p = path.join(d, exe(name))
    if (isExecutable(p)) return p
  }
  return null
}

export function getFfmpegPath(): string {
  if (cachedFfmpeg) return cachedFfmpeg
  const env = process.env.SCREENFORGE_FFMPEG
  const found =
    (env && isExecutable(env) ? env : null) ??
    resourceBin('ffmpeg') ??
    staticBin('ffmpeg') ??
    pathBin('ffmpeg')
  if (!found) throw new Error('FFmpeg binary not found. Install ffmpeg or set SCREENFORGE_FFMPEG.')
  cachedFfmpeg = found
  return found
}

export function getFfprobePath(): string {
  if (cachedFfprobe) return cachedFfprobe
  const env = process.env.SCREENFORGE_FFPROBE
  const found =
    (env && isExecutable(env) ? env : null) ??
    resourceBin('ffprobe') ??
    staticBin('ffprobe') ??
    pathBin('ffprobe')
  if (!found) throw new Error('ffprobe binary not found. Install ffprobe or set SCREENFORGE_FFPROBE.')
  cachedFfprobe = found
  return found
}

/** Probe a media file; returns duration in ms and basic streams info. */
export async function probeMedia(
  filePath: string,
): Promise<{ durationMs: number; width?: number; height?: number; fps?: number; hasAudio: boolean }> {
  const ffprobe = getFfprobePath()
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffprobe, args, { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`ffprobe failed (${code}): ${err.slice(0, 400)}`)),
    )
  })
  const json = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: Array<{
      codec_type?: string
      width?: number
      height?: number
      r_frame_rate?: string
      avg_frame_rate?: string
    }>
  }
  const durationMs = Math.round(parseFloat(json.format?.duration ?? '0') * 1000)
  const video = json.streams?.find((s) => s.codec_type === 'video')
  const hasAudio = (json.streams ?? []).some((s) => s.codec_type === 'audio')
  const rate = video?.avg_frame_rate ?? video?.r_frame_rate
  let fps: number | undefined
  if (rate && rate.includes('/')) {
    const [num, den] = rate.split('/').map(Number)
    if (num > 0 && den > 0) fps = num / den
  }
  return {
    durationMs,
    width: video?.width,
    height: video?.height,
    fps,
    hasAudio,
  }
}

/**
 * Detect hardware H.264 encoders available on this machine by actually test-
 * encoding a tiny frame. Never assume GPU acceleration is available.
 * Returns e.g. ['h264_nvenc', 'h264_qsv'] in priority order.
 */
export async function detectHwEncoders(): Promise<string[]> {
  const candidates = [
    'h264_nvenc', // NVIDIA NVENC
    'h264_qsv', // Intel Quick Sync
    'h264_amf', // AMD AMF
  ]
  const found: string[] = []
  for (const encoder of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      let ffmpeg: string
      try {
        ffmpeg = getFfmpegPath()
      } catch {
        return resolve(false)
      }
      const child = spawn(
        ffmpeg,
        [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2',
          '-c:v', encoder, '-f', 'null', '-',
        ],
        { windowsHide: true },
      )
      let settled = false
      const done = (result: boolean) => {
        if (!settled) {
          settled = true
          resolve(result)
        }
      }
      child.on('error', () => done(false))
      child.on('close', (code) => done(code === 0))
      setTimeout(() => {
        if (!settled) {
          child.kill()
          done(false)
        }
      }, 8000)
    })
    if (ok) found.push(encoder)
  }
  return found
}
