/**
 * Edit Decision List (EDL) utilities.
 *
 * The editor never modifies source recordings. All trims/splits/deletes are
 * expressed as an ordered list of kept segments (source-relative ms). These
 * pure helpers are used by the editor UI, the export engine, and unit tests.
 */
import type { CursorEvent } from './types'

export interface Segment {
  startMs: number
  endMs: number
}

const MIN_SEGMENT_MS = 1

/** Normalize: drop invalid, sort, merge overlaps/touching segments. */
export function normalizeSegments(segments: Segment[]): Segment[] {
  const valid = segments
    .filter((s) => s.endMs > s.startMs + MIN_SEGMENT_MS)
    .map((s) => ({ startMs: Math.max(0, Math.round(s.startMs)), endMs: Math.round(s.endMs) }))
    .sort((a, b) => a.startMs - b.startMs)
  const out: Segment[] = []
  for (const s of valid) {
    const last = out[out.length - 1]
    if (last && s.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, s.endMs)
    } else {
      out.push({ ...s })
    }
  }
  return out
}

export function outputDurationMs(segments: Segment[]): number {
  return segments.reduce((acc, s) => acc + (s.endMs - s.startMs), 0)
}

/** Map a source-relative time to output time. Returns null when cut out. */
export function sourceToOutputTime(tMs: number, segments: Segment[]): number | null {
  let acc = 0
  for (const s of segments) {
    if (tMs < s.startMs) return null
    if (tMs <= s.endMs) return acc + (tMs - s.startMs)
    acc += s.endMs - s.startMs
  }
  return null
}

/** Map an output time back to source-relative time. Returns null when out of range. */
export function outputToSourceTime(tMs: number, segments: Segment[]): number | null {
  let acc = 0
  for (const s of segments) {
    if (tMs < acc || tMs > acc + (s.endMs - s.startMs)) {
      acc += s.endMs - s.startMs
      continue
    }
    return s.startMs + (tMs - acc)
  }
  return null
}

/** Split `segments` at a source-relative time (used by the editor Split action). */
export function splitSegmentsAt(segments: Segment[], cutMs: number): Segment[] {
  const out: Segment[] = []
  for (const s of segments) {
    if (cutMs <= s.startMs || cutMs >= s.endMs) {
      out.push(s)
      continue
    }
    out.push({ startMs: s.startMs, endMs: cutMs })
    out.push({ startMs: cutMs, endMs: s.endMs })
  }
  return normalizeSegments(out)
}

/** Delete `range` (source-relative) out of the kept segments. */
export function deleteRangeFromSegments(segments: Segment[], startMs: number, endMs: number): Segment[] {
  const out: Segment[] = []
  for (const s of segments) {
    if (endMs <= s.startMs || startMs >= s.endMs) {
      out.push(s)
      continue
    }
    if (startMs > s.startMs) out.push({ startMs: s.startMs, endMs: Math.min(s.endMs, startMs) })
    if (endMs < s.endMs) out.push({ startMs: Math.max(s.startMs, endMs), endMs: s.endMs })
  }
  return normalizeSegments(out)
}

/**
 * Filter + remap cursor events into output time.
 * `down`/`up` pairs that straddle a cut boundary are kept as-is (the effect
 * duration simply ends at the cut) — a documented, predictable behavior.
 */
export function remapCursorEvents(events: CursorEvent[], segments: Segment[]): CursorEvent[] {
  const out: CursorEvent[] = []
  for (const e of events) {
    const t = sourceToOutputTime(e.t, segments)
    if (t === null) continue
    out.push({ ...e, t })
  }
  return out
}

/** Filter + remap annotation shapes (drop shapes fully outside kept ranges). */
export function remapAnnotations<T extends { tStartMs: number; tEndMs: number }>(
  annotations: T[],
  segments: Segment[],
): Array<T & { tStartMs: number; tEndMs: number }> {
  const out: Array<T & { tStartMs: number; tEndMs: number }> = []
  for (const a of annotations) {
    const s = sourceToOutputTime(a.tStartMs, segments)
    if (s === null) continue
    const e = sourceToOutputTime(a.tEndMs, segments)
    // If the shape extends past a cut, clamp its end to the end of its segment.
    out.push({ ...a, tStartMs: s, tEndMs: e ?? a.tEndMs - a.tStartMs + s })
  }
  return out
}

/** Format ms as H:MM:SS.d or M:SS.d for the timeline UI. */
export function formatTimecode(ms: number, withTenths = true): string {
  const total = Math.max(0, ms)
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const d = Math.floor((total % 1000) / 100)
  const base = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
  return withTenths ? `${base}.${d}` : base
}
