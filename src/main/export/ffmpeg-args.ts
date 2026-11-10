/**
 * Pure FFmpeg argument builder for the export pipeline.
 *
 * Deliberately dependency-free (NO electron, NO filesystem, NO child_process):
 * the same function is used by the export manager and by unit tests, and it is
 * fully deterministic — given identical inputs it produces identical args.
 *
 * Pipeline layout (input indices):
 *   0        : the screen recording (video, possibly muxed audio — ignored)
 *   1        : [compositor only] rawvideo rgba frames on fd 3 (pipe:3)
 *   next...  : mic webm, system-audio webm, music file (each optional)
 *
 * Video chain:  trim/concat over segments -> fps -> scale (even dims) ->
 *               overlay(compositor) or null -> format=yuv420p
 * Audio chain:  per-source trim/concat -> volume -> aresample=48k ->
 *               [music: adelay] -> apad/atrim to output duration ->
 *               aformat(48k stereo) -> amix (if >1 source)
 */
import { RESOLUTION_HEIGHTS } from '../../shared/types'
import type { ExportOptions, RecordingMeta } from '../../shared/types'
import { normalizeSegments, outputDurationMs } from '../../shared/edl'
import type { Segment } from '../../shared/edl'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** CRF / CQ value per export quality preset. */
export const QUALITY_CRF: Record<ExportOptions['quality'], number> = {
  ultra: 16,
  high: 20,
  medium: 24,
  low: 28,
}

export interface ExportProbe {
  durationMs: number
  width?: number
  height?: number
  fps?: number
  hasAudio: boolean
}

export interface ExportPlan {
  /** Complete argv for ffmpeg (excluding the binary itself). */
  args: string[]
  /** Output duration in ms (sum of normalized segments). */
  outputDurationMs: number
  outputWidth: number
  outputHeight: number
  compositorEnabled: boolean
  /** Number of `-i` inputs (video + compositor + audio sources). */
  inputCount: number
}

export interface BuildExportArgsOptions {
  recording: RecordingMeta
  options: ExportOptions
  probe: ExportProbe
  outputPath: string
  compositorEnabled: boolean
  /**
   * Hardware encoder name reported by detectHwEncoders(), e.g. 'h264_nvenc'.
   * Ignored when it does not match the requested codec family.
   */
  hwEncoder?: string
}

// ---------------------------------------------------------------------------
// Small numeric helpers (shared with the filter expressions so that the
// predicted output dimensions match FFmpeg's exactly)
// ---------------------------------------------------------------------------

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/** ms -> seconds with ms precision, e.g. 1500 -> "1.500". */
const SEC = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(3)

/** FFmpeg `trunc(x/2)*2` — largest even integer <= x (min 2). */
const evenTrunc = (n: number): number => Math.max(2, Math.trunc(n / 2) * 2)

const round2 = (n: number): number => Math.round(n * 100) / 100

// ---------------------------------------------------------------------------
// Encoder selection
// ---------------------------------------------------------------------------

function buildVideoEncoderArgs(
  codec: ExportOptions['codec'],
  quality: ExportOptions['quality'],
  bitrateKbps: number | undefined,
  hwEncoder: string | undefined,
): { encoder: string; flags: string[] } {
  const crf = QUALITY_CRF[quality]
  const wantedPrefix = codec === 'h264' ? 'h264_' : 'hevc_'
  const hw = hwEncoder && hwEncoder.startsWith(wantedPrefix) ? hwEncoder : undefined

  const encoder = hw ?? (codec === 'h264' ? 'libx264' : 'libx265')
  const flags: string[] = []
  const useBitrate = typeof bitrateKbps === 'number' && bitrateKbps > 0

  if (useBitrate) {
    const kbps = Math.round(bitrateKbps)
    flags.push('-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${Math.round(kbps * 3)}k`)
    if (codec === 'h265') flags.push('-tag:v', 'hvc1')
    return { encoder, flags }
  }

  if (!hw) {
    flags.push('-preset', 'medium', '-crf', String(crf))
  } else if (hw.endsWith('_nvenc')) {
    flags.push('-preset', 'p5', '-rc', 'vbr', '-cq', String(crf))
  } else if (hw.endsWith('_qsv')) {
    flags.push('-preset', 'medium', '-global_quality', String(crf))
  } else if (hw.endsWith('_amf')) {
    flags.push('-quality', 'quality', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf))
  }
  if (codec === 'h265') flags.push('-tag:v', 'hvc1')
  return { encoder, flags }
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildExportArgs(opts: BuildExportArgsOptions): ExportPlan {
  const { recording, options, probe, outputPath, compositorEnabled } = opts

  // -- timeline -------------------------------------------------------------
  const fallbackEnd = Math.max(probe.durationMs, recording.durationMs, 1)
  const segments: Segment[] = normalizeSegments(
    options.segments.length > 0 ? options.segments : [{ startMs: 0, endMs: fallbackEnd }],
  )
  const outputDurMs = outputDurationMs(segments)
  if (outputDurMs <= 0) {
    throw new Error('export: normalized segments produce a zero-length output')
  }
  const outFps = options.fps

  // -- output dimensions (must match the scale filter exactly) ---------------
  const srcW = probe.width ?? recording.width
  const srcH = probe.height ?? recording.height
  if (compositorEnabled && (srcW <= 0 || srcH <= 0)) {
    throw new Error('export: unknown source dimensions, cannot enable compositor overlay')
  }
  let outW: number
  let outH: number
  let scaleFilter: string
  if (options.resolution === 'source') {
    outW = evenTrunc(srcW || 2)
    outH = evenTrunc(srcH || 2)
    scaleFilter = `[vfps]scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2[vscale]`
  } else {
    outH = RESOLUTION_HEIGHTS[options.resolution]
    // Mirrors the ffmpeg expression below so overlay input sizes match.
    // (0 = unknown, only possible when the compositor is disabled)
    outW = srcW > 0 && srcH > 0 ? Math.max(2, Math.trunc((srcW * outH) / srcH / 2) * 2) : 0
    scaleFilter = `[vfps]scale=w=trunc(iw*${outH}/ih/2)*2:h=${outH}[vscale]`
  }

  // -- filter graph -----------------------------------------------------------
  const graph: string[] = []

  // video: trim/concat kept segments
  segments.forEach((s, i) => {
    graph.push(`[0:v]trim=start=${SEC(s.startMs)}:end=${SEC(s.endMs)},setpts=PTS-STARTPTS[vs${i}]`)
  })
  const videoConcatInputs = segments.map((_, i) => `[vs${i}]`).join('')
  graph.push(`${videoConcatInputs}concat=n=${segments.length}:v=1:a=0[vcat]`)
  graph.push(`[vcat]fps=${outFps}[vfps]`)
  graph.push(scaleFilter)
  graph.push(
    compositorEnabled
      ? `[vscale][1:v]overlay=0:0:format=auto[vlc]`
      : `[vscale]null[vlc]`,
  )
  graph.push(`[vlc]format=yuv420p[vout]`)

  // -- audio inputs -----------------------------------------------------------
  let inputCount = 1 + (compositorEnabled ? 1 : 0)
  const audioInputArgs: string[] = []
  const audioMapLabels: string[] = []

  const pushAudioChain = (inputIndex: number, volume: number, isMusic: boolean): void => {
    segments.forEach((s, i) => {
      graph.push(
        `[${inputIndex}:a]atrim=start=${SEC(s.startMs)}:end=${SEC(s.endMs)},asetpts=PTS-STARTPTS[as${inputIndex}_${i}]`,
      )
    })
    const concatInputs = segments.map((_, i) => `[as${inputIndex}_${i}]`).join('')
    graph.push(`${concatInputs}concat=n=${segments.length}:v=0:a=1[ac${inputIndex}]`)

    const chain: string[] = []
    if (Math.abs(volume - 1) > 1e-6) chain.push(`volume=${round2(clamp(volume, 0, 2))}`)
    chain.push('aresample=48000')
    if (isMusic && options.musicStartMs > 0) {
      const delayMs = Math.round(options.musicStartMs)
      // music start is relative to the OUTPUT timeline -> delay both channels
      chain.push(`adelay=${delayMs}|${delayMs}`)
    }
    // Force every chain to exactly the output duration so amix cannot drift.
    chain.push(`apad=whole_dur=${SEC(outputDurMs)}`)
    chain.push(`atrim=0:${SEC(outputDurMs)}`)
    chain.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo')
    graph.push(`[ac${inputIndex}]${chain.join(',')}[af${inputIndex}]`)
    audioMapLabels.push(`[af${inputIndex}]`)
  }

  if (options.includeMic && recording.micAudioPath) {
    pushAudioChain(inputCount, options.micVolume, false)
    audioInputArgs.push('-i', recording.micAudioPath)
    inputCount += 1
  }
  if (options.includeSystemAudio && recording.systemAudioPath) {
    pushAudioChain(inputCount, options.systemVolume, false)
    audioInputArgs.push('-i', recording.systemAudioPath)
    inputCount += 1
  }
  if (options.musicPath) {
    pushAudioChain(inputCount, options.musicVolume, true)
    audioInputArgs.push('-i', options.musicPath)
    inputCount += 1
  }

  let audioMap: string | null = null
  if (audioMapLabels.length > 1) {
    graph.push(
      `${audioMapLabels.join('')}amix=inputs=${audioMapLabels.length}:duration=first:normalize=0[aout]`,
    )
    audioMap = '[aout]'
  } else if (audioMapLabels.length === 1) {
    audioMap = audioMapLabels[0]
  }

  // -- assemble argv ------------------------------------------------------------
  const { encoder, flags: encoderFlags } = buildVideoEncoderArgs(
    options.codec,
    options.quality,
    options.bitrateKbps,
    opts.hwEncoder,
  )

  const args: string[] = ['-hide_banner', '-nostdin', '-y', '-stats']
  args.push('-i', recording.videoPath)
  if (compositorEnabled) {
    args.push(
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-video_size', `${outW}x${outH}`,
      '-framerate', String(outFps),
      '-i', 'pipe:3',
    )
  }
  args.push(...audioInputArgs)
  args.push('-filter_complex', graph.join(';'))
  args.push('-map', '[vout]')
  if (audioMap) {
    args.push('-map', audioMap, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000')
  } else {
    args.push('-an')
  }
  args.push('-c:v', encoder, ...encoderFlags)
  args.push('-movflags', '+faststart')
  // Safety bound: never let ffmpeg run past the expected output duration.
  args.push('-t', SEC(outputDurMs))
  args.push('-f', 'mp4')
  args.push(outputPath)

  return {
    args,
    outputDurationMs: outputDurMs,
    outputWidth: outW,
    outputHeight: outH,
    compositorEnabled,
    inputCount,
  }
}
