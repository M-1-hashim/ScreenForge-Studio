/**
 * Typed IPC contract.
 *
 * Every channel the renderer can invoke is declared here with:
 *   - the exact channel string
 *   - a zod schema validating the request payload (main side enforces it)
 *   - the response type
 *
 * The preload bridge (`src/preload`) is generated from this contract so the
 * renderer never touches `ipcRenderer` directly and never sends arbitrary
 * channels — that is what makes the architecture secure.
 */
import { z } from 'zod'
import type {
  AnnotationStyle,
  AnnotationToolId,
  AppErrorEvent,
  AppSettings,
  AppVersionInfo,
  AudioDeviceInfo,
  DisplayInfo,
  EditorProject,
  ExportOptions,
  ExportProgress,
  RecordingConfig,
  RecordingMeta,
  RecordingState,
  Rect,
  StorageInfo,
  WindowSourceInfo,
} from './types'

// ---------------------------------------------------------------------------
// Zod schemas (main-process input validation)
// ---------------------------------------------------------------------------

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(1),
  height: z.number().min(1),
})

export const cursorConfigSchema = z.any() // deep-validated in main via normalizeCursorConfig

export const recordingConfigSchema = z.object({
  mode: z.enum(['fullscreen', 'region', 'window']),
  displayId: z.number().int(),
  windowId: z.string().optional(),
  region: rectSchema.optional(),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
  resolution: z.enum(['source', '720p', '1080p', '1440p', '4k']),
  audio: z.object({
    system: z.boolean(),
    mic: z.boolean(),
    micDeviceId: z.string().optional(),
    systemVolume: z.number().min(0).max(2),
    micVolume: z.number().min(0).max(2),
  }),
  cursorCapture: z.boolean(),
  annotationsEnabled: z.boolean(),
  countdownSec: z.number().int().min(0).max(10),
})

export const exportOptionsSchema = z.object({
  codec: z.enum(['h264', 'h265']),
  resolution: z.enum(['source', '720p', '1080p', '1440p', '4k']),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
  quality: z.enum(['low', 'medium', 'high', 'ultra']),
  bitrateKbps: z.number().optional(),
  includeCursor: z.boolean(),
  cursorConfig: cursorConfigSchema,
  includeAnnotations: z.boolean(),
  includeMic: z.boolean(),
  micVolume: z.number().min(0).max(2),
  includeSystemAudio: z.boolean(),
  systemVolume: z.number().min(0).max(2),
  musicPath: z.string().optional(),
  musicVolume: z.number().min(0).max(2),
  musicStartMs: z.number().min(0),
  includeTextOverlays: z.boolean(),
  segments: z.array(z.object({ startMs: z.number().min(0), endMs: z.number().min(0) })),
  outputName: z.string().optional(),
})

export const annotationToolSchema = z.object({
  tool: z.enum(['pen', 'highlighter', 'arrow', 'line', 'rect', 'ellipse', 'text', 'eraser']),
  style: z.object({
    color: z.string(),
    strokeWidth: z.number().min(1).max(64),
    fontSize: z.number().min(8).max(200),
    fontFamily: z.string(),
    opacity: z.number().min(0.05).max(1),
  }),
})

export const settingsPatchSchema = z.record(z.string(), z.any())

// ---------------------------------------------------------------------------
// Invoke channel registry
// ---------------------------------------------------------------------------

export interface InvokeContract {
  // app
  'app:getVersion': { req: void; res: AppVersionInfo }
  'window:minimize': { req: void; res: void }
  'window:maximizeToggle': { req: void; res: void }
  'window:close': { req: void; res: void }
  'shell:revealPath': { req: { path: string }; res: void }
  'shell:openPath': { req: { path: string }; res: void }
  'dialog:chooseDirectory': { req: { title: string }; res: string | null }
  'dialog:chooseFile': {
    req: { title: string; filters: Array<{ name: string; extensions: string[] }> }
    res: string | null
  }

  // source enumeration
  'displays:list': { req: void; res: DisplayInfo[] }
  'windows:list': { req: void; res: WindowSourceInfo[] }
  'audio:listDevices': { req: void; res: AudioDeviceInfo[] }

  // recorder
  'recorder:start': { req: RecordingConfig; res: { ok: true } | { ok: false; reason: string } }
  'recorder:pause': { req: void; res: void }
  'recorder:resume': { req: void; res: void }
  'recorder:stop': { req: void; res: { recordingId: string } | null }
  'recorder:cancel': { req: void; res: void }
  'recorder:getState': { req: void; res: RecordingState }
  'recorder:selectRegion': { req: { displayId: number }; res: Rect | null }
  /** Region-selector overlay -> main: the drawn rect (display-local physical px) or null. */
  'recorder:submitRegionResult': { req: { result: Rect | null }; res: void }

  // live annotation overlay control
  'annotation:setMode': { req: { enabled: boolean }; res: void }
  'annotation:setTool': { req: { tool: AnnotationToolId; style: AnnotationStyle }; res: void }
  'annotation:undo': { req: void; res: void }
  'annotation:redo': { req: void; res: void }
  'annotation:clear': { req: void; res: void }
  /** Overlay window -> main: replace the authoritative live shape list. */
  'annotation:replaceAll': { req: { recordingId: string; shapes: import('./types').AnnotationShape[] }; res: void }

  // library
  'library:list': { req: void; res: RecordingMeta[] }
  'library:get': { req: { id: string }; res: RecordingMeta | null }
  'library:delete': { req: { id: string }; res: void }
  'library:rename': { req: { id: string; title: string }; res: void }
  'library:storage': { req: void; res: StorageInfo }

  // projects
  'projects:list': { req: void; res: EditorProject[] }
  'projects:get': { req: { id: string }; res: EditorProject | null }
  'projects:save': { req: { project: EditorProject }; res: EditorProject }
  'projects:delete': { req: { id: string }; res: void }

  // editor data services
  'editor:cursorEvents': {
    req: { recordingId: string }
    res: { events: import('./types').CursorEvent[]; displays: import('./types').CursorEventFile['displays'] } | null
  }
  'editor:annotations': { req: { recordingId: string }; res: import('./types').AnnotationShape[] }
  'editor:waveform': { req: { path: string; width: number; height: number }; res: string | null }
  'editor:thumbnails': { req: { videoPath: string; count: number }; res: string[] }

  // export
  'export:start': { req: { recordingId: string; options: ExportOptions }; res: { jobId: string } }
  'export:cancel': { req: { jobId: string }; res: void }

  // settings
  'settings:get': { req: void; res: AppSettings }
  'settings:set': { req: { patch: Record<string, unknown> }; res: AppSettings }
}

export type InvokeChannel = keyof InvokeContract

// ---------------------------------------------------------------------------
// Event channels (main -> renderer push)
// ---------------------------------------------------------------------------

export interface EventContract {
  'evt:recorder-state': RecordingState
  'evt:tick': { elapsedMs: number; state: RecordingState }
  'evt:mic-level': number
  'evt:export-progress': ExportProgress
  'evt:app-error': AppErrorEvent
  'evt:region-selected': { displayId: number; rect: Rect | null }
  'evt:recordings-changed': void
  /** Main -> annotation overlay windows: active tool + style. */
  'evt:annotation-tool': { tool: AnnotationToolId; style: AnnotationStyle }
}

export type EventChannel = keyof EventContract

// ---------------------------------------------------------------------------
// Capture-agent private channels (used by the hidden capture window only)
// ---------------------------------------------------------------------------

export const CAPTURE_AGENT_CHANNELS = {
  start: 'agent:start-capture',
  stop: 'agent:stop-capture',
  pause: 'agent:pause-capture',
  resume: 'agent:resume-capture',
  micToggle: 'agent:mic-toggle',
  chunk: 'agent:chunk',
  error: 'agent:error',
  micLevel: 'agent:mic-level',
} as const

export interface AgentStartPayload {
  sourceId: string
  fps: number
  video: boolean
  mic: { deviceId?: string; enabled: boolean }
  system: { enabled: boolean }
}

// ---------------------------------------------------------------------------
// Helper: derive the renderer-facing API surface from the contracts
// ---------------------------------------------------------------------------

export type InvokeRequest<C extends InvokeChannel> = InvokeContract[C]['req']
export type InvokeResponse<C extends InvokeChannel> = InvokeContract[C]['res']

export const EXPORT_SEGMENTS_ALL = 'ALL' as const
