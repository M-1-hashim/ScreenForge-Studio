/**
 * IPC handlers for export + editor data services.
 *
 * Registered once from src/main/index.ts via `registerExportHandlers()`.
 * Every channel is validated against a zod schema through the shared
 * `handle()` wrapper before any main-process code runs.
 */
import fs from 'node:fs/promises'
import { z } from 'zod'

import { handle } from './registry'
import { exportOptionsSchema } from '../../shared/ipc'
import { exportManager } from '../export/export-manager'
import { thumbnails, waveform } from '../export/editor-services'
import { db } from '../database/index'
import type { AnnotationShape, CursorEventFile } from '../../shared/types'

// ---------------------------------------------------------------------------
// Session sidecar readers (missing / corrupt files -> empty, never throw)
// ---------------------------------------------------------------------------

async function readCursorEvents(
  recordingId: string,
): Promise<{ events: CursorEventFile['events']; displays: CursorEventFile['displays'] } | null> {
  try {
    const recording = db.getRecording(recordingId)
    if (!recording?.cursorEventsPath) return null
    const raw = await fs.readFile(recording.cursorEventsPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CursorEventFile> | null
    if (!parsed || !Array.isArray(parsed.events)) return null
    return {
      events: parsed.events,
      displays: Array.isArray(parsed.displays) ? parsed.displays : [],
    }
  } catch {
    return null
  }
}

async function readAnnotations(recordingId: string): Promise<AnnotationShape[]> {
  try {
    const recording = db.getRecording(recordingId)
    if (!recording?.annotationsPath) return []
    const raw = await fs.readFile(recording.annotationsPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as AnnotationShape[]) : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerExportHandlers(): void {
  handle(
    'export:start',
    z.object({
      recordingId: z.string().min(1),
      options: exportOptionsSchema,
    }),
    (payload) => exportManager.start(payload.recordingId, payload.options),
  )

  handle(
    'export:cancel',
    z.object({ jobId: z.string().min(1) }),
    (payload) => {
      exportManager.cancel(payload.jobId)
    },
  )

  handle(
    'editor:cursorEvents',
    z.object({ recordingId: z.string().min(1) }),
    (payload) => readCursorEvents(payload.recordingId),
  )

  handle(
    'editor:annotations',
    z.object({ recordingId: z.string().min(1) }),
    (payload) => readAnnotations(payload.recordingId),
  )

  handle(
    'editor:waveform',
    z.object({
      path: z.string().min(1),
      width: z.number().int().min(1).max(4096),
      height: z.number().int().min(1).max(1024),
    }),
    (payload) => waveform(payload.path, payload.width, payload.height),
  )

  handle(
    'editor:thumbnails',
    z.object({
      videoPath: z.string().min(1),
      count: z.number().int().min(1).max(50),
    }),
    (payload) => thumbnails(payload.videoPath, payload.count),
  )
}
