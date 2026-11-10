/**
 * Annotation service — the authoritative, main-process store of live
 * annotation shapes per recording session.
 *
 * Overlay windows are the only writers during recording: after every
 * committed stroke / erase / clear they invoke 'annotation:replaceAll' with
 * their complete shape list (they own undo/redo). The service persists the
 * latest list so the session manager can write annotations.json at stop.
 */
import { z } from 'zod'
import type { AnnotationShape } from '../../shared/types'
import { handle } from '../ipc/registry'
import { broadcastToOverlays, hasAnnotationOverlays, setOverlayMouseMode } from '../windows/overlay-windows'

const shapeSchema = z.object({
  id: z.string(),
  tool: z.enum(['pen', 'highlighter', 'arrow', 'line', 'rect', 'ellipse', 'text']),
  tStartMs: z.number().min(0),
  tEndMs: z.number().min(0),
  displayId: z.number(),
  points: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  rect: z
    .object({ x: z.number(), y: z.number(), width: z.number().min(1), height: z.number().min(1) })
    .optional(),
  text: z.string().optional(),
  style: z.object({
    color: z.string(),
    strokeWidth: z.number(),
    fontSize: z.number(),
    fontFamily: z.string(),
    opacity: z.number(),
  }),
})

const replaceAllSchema = z.object({
  recordingId: z.string().min(1),
  shapes: z.array(shapeSchema),
})

const state = new Map<string, AnnotationShape[]>()
let currentRecordingId: string | null = null

export function beginSession(recordingId: string): void {
  currentRecordingId = recordingId
  state.set(recordingId, [])
}

export function endSession(): AnnotationShape[] {
  const id = currentRecordingId
  const shapes = id ? state.get(id) ?? [] : []
  if (id) state.delete(id)
  currentRecordingId = null
  return shapes
}

export function getShapes(recordingId: string): AnnotationShape[] {
  return state.get(recordingId) ?? []
}

export function registerAnnotationHandlers(): void {
  handle('annotation:replaceAll', replaceAllSchema, (payload) => {
    state.set(payload.recordingId, payload.shapes as AnnotationShape[])
    return undefined
  })

  handle(
    'annotation:setMode',
    z.object({ enabled: z.boolean() }),
    (payload) => {
      if (!currentRecordingId) return undefined
      if (payload.enabled && !hasAnnotationOverlays()) {
        // Overlays are opened by the session manager at start; dynamic
        // enablement while recording re-opens them on demand.
        const { openAnnotationOverlaysForCurrentRecording } = require('../recording/session-manager') as {
          openAnnotationOverlaysForCurrentRecording?: () => void
        }
        openAnnotationOverlaysForCurrentRecording?.()
      }
      setOverlayMouseMode(payload.enabled)
      return undefined
    },
  )

  handle(
    'annotation:setTool',
    z.object({
      tool: z.enum(['pen', 'highlighter', 'arrow', 'line', 'rect', 'ellipse', 'text', 'eraser']),
      style: z.object({
        color: z.string(),
        strokeWidth: z.number(),
        fontSize: z.number(),
        fontFamily: z.string(),
        opacity: z.number(),
      }),
    }),
    (payload) => {
      broadcastToOverlays('evt:annotation-tool', { tool: payload.tool, style: payload.style })
      return undefined
    },
  )

  // Undo/redo are owned by the overlay pages (their own toolbars). The
  // main-window handlers exist for API completeness; Clear from the renderer
  // clears the authoritative list and tells overlays to redraw empty.
  handle('annotation:undo', z.undefined(), () => undefined)
  handle('annotation:redo', z.undefined(), () => undefined)
  handle('annotation:clear', z.undefined(), () => {
    if (currentRecordingId) state.set(currentRecordingId, [])
    return undefined
  })
}
