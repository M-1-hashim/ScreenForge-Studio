/**
 * Cursor event recorder.
 *
 * Primary path  — native `cursor_hook` addon: a global low-level mouse hook
 *                 (WH_MOUSE_LL) that streams moves + clicks + wheel events.
 * Fallback path — polling `screen.getCursorScreenPoint()` at ~60 Hz. This
 *                 captures cursor POSITIONS only; click events are
 *                 unavailable without the native module (documented
 *                 limitation — the editor/exporter degrade gracefully and
 *                 click effects can be added manually in the editor).
 *
 * Events are stored in virtual-screen PHYSICAL pixels with recording-relative
 * timestamps from the shared RecordingClock.
 */
import { screen } from 'electron'
import type { CursorBackend, CursorEvent, CursorEventFile, DisplayInfo } from '../../shared/types'
import { loadNativeAddon } from '../native/loader'
import type { RecordingClock } from '../recording/clock'
import { displayAtPhysicalPoint, virtualOrigin } from '../windows/display-utils'

interface HookAddon {
  setEventCallback: (fn: (event: {
    type: 'move' | 'down' | 'up' | 'wheel'
    x: number
    y: number
    button: number
    delta: number
    t: number
  }) => void) => void
  start?: (hz?: number) => boolean
  stop?: () => void
}

const POLL_INTERVAL_MS = 16 // ~60 Hz

export interface CursorRecordingHandle {
  backend: CursorBackend
  stop(): CursorEventFile | null
}

/**
 * Which cursor backend THIS installation can use right now. Used for honest
 * reporting in the version/settings UI — never claims a backend that is not
 * actually available.
 */
export function getCursorBackend(): CursorBackend {
  const addon = loadNativeAddon('cursor_hook') as HookAddon | null
  return addon?.setEventCallback && addon.start ? 'native-hook' : 'polling'
}

export function startCursorRecording(
  opts: { clock: RecordingClock; displays: DisplayInfo[]; enabled: boolean },
): CursorRecordingHandle {
  if (!opts.enabled) {
    return {
      backend: 'native-hook',
      stop: () => null,
    }
  }

  const origin = virtualOrigin()
  const events: CursorEvent[] = []

  // ---- native hook path ----------------------------------------------------
  const addon = loadNativeAddon('cursor_hook') as HookAddon | null
  if (addon?.setEventCallback && addon.start) {
    try {
      addon.setEventCallback((e) => {
        const display = displayAtPhysicalPoint(opts.displays, e.x, e.y)
        events.push({
          t: Math.round(opts.clock.nowMs()),
          type: e.type,
          x: e.x,
          y: e.y,
          button: e.type === 'down' || e.type === 'up' ? (e.button === 1 ? 'right' : e.button === 2 ? 'middle' : 'left') : undefined,
          displayId: display?.id ?? opts.displays[0]?.id ?? 0,
        })
      })
      const ok = addon.start(120)
      if (ok) {
        return {
          backend: 'native-hook',
          stop: () => {
            try {
              addon.stop?.()
            } catch {
              /* best effort */
            }
            return buildFile(events, opts.displays)
          },
        }
      }
    } catch {
      /* fall through to polling */
    }
  }

  // ---- polling fallback ------------------------------------------------------
  let lastX = Number.NaN
  let lastY = Number.NaN
  const timer = setInterval(() => {
    try {
      const point = screen.getCursorScreenPoint()
      // DIP -> physical within the display containing the point.
      const display = screen.getAllDisplays().find((d) => {
        const b = d.bounds
        return (
          point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height
        )
      })
      if (!display) return
      const px = Math.round((point.x - origin.x) * display.scaleFactor)
      const py = Math.round((point.y - origin.y) * display.scaleFactor)
      if (px === lastX && py === lastY) return
      lastX = px
      lastY = py
      events.push({
        t: Math.round(opts.clock.nowMs()),
        type: 'move',
        x: px,
        y: py,
        displayId: display.id,
      })
    } catch {
      /* screen API unavailable mid-session — skip tick */
    }
  }, POLL_INTERVAL_MS)

  return {
    backend: 'polling',
    stop: () => {
      clearInterval(timer)
      return buildFile(events, opts.displays)
    },
  }
}

function buildFile(events: CursorEvent[], displays: DisplayInfo[]): CursorEventFile | null {
  if (events.length < 2) return null
  return {
    version: 1,
    coordinateSpace: 'virtual-screen-physical',
    fps: 60,
    displays: displays.map((d) => ({
      id: d.id,
      physicalBounds: d.physicalBounds,
      scaleFactor: d.scaleFactor,
    })),
    events,
  }
}
