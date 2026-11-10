/**
 * Secure preload bridge.
 *
 * - contextIsolation: ON, nodeIntegration: OFF (enforced in main window opts)
 * - The renderer gets a single, frozen, typed API object (`window.screenforge`)
 *   with a fixed allowlist of channels. It can NEVER pass arbitrary channels,
 *   paths, or shell commands through this bridge.
 * - Input validation happens again in the main process (zod schemas).
 */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  EventChannel,
  EventContract,
  InvokeChannel,
  InvokeContract,
  InvokeRequest,
  InvokeResponse,
} from '../shared/ipc'
import { CAPTURE_AGENT_CHANNELS } from '../shared/ipc'

function invoke<C extends InvokeChannel>(channel: C, payload: InvokeRequest<C>): Promise<InvokeResponse<C>> {
  return ipcRenderer.invoke(channel, payload)
}

const EVENT_CHANNELS: ReadonlySet<string> = new Set([
  'evt:recorder-state',
  'evt:tick',
  'evt:mic-level',
  'evt:export-progress',
  'evt:app-error',
  'evt:region-selected',
  'evt:recordings-changed',
  'evt:annotation-tool',
])

export interface ScreenForgeApi {
  app: {
    getVersion(): Promise<InvokeContract['app:getVersion']['res']>
  }
  window: {
    minimize(): Promise<void>
    maximizeToggle(): Promise<void>
    close(): Promise<void>
  }
  shell: {
    revealPath(path: string): Promise<void>
    openPath(path: string): Promise<void>
  }
  dialogs: {
    chooseDirectory(title: string): Promise<string | null>
    chooseFile(
      title: string,
      filters: Array<{ name: string; extensions: string[] }>,
    ): Promise<string | null>
  }
  recorder: {
    listDisplays(): Promise<InvokeContract['displays:list']['res']>
    listWindows(): Promise<InvokeContract['windows:list']['res']>
    listAudioDevices(): Promise<InvokeContract['audio:listDevices']['res']>
    start(config: InvokeContract['recorder:start']['req']): Promise<InvokeContract['recorder:start']['res']>
    pause(): Promise<void>
    resume(): Promise<void>
    stop(): Promise<InvokeContract['recorder:stop']['res']>
    cancel(): Promise<void>
    getState(): Promise<RecordingStateValue>
    selectRegion(displayId: number): Promise<InvokeContract['recorder:selectRegion']['res']>
    /** Region-selector page -> main: the user's drawn rect (or null on cancel). */
    submitRegionResult(rect: InvokeContract['recorder:selectRegion']['res']): Promise<void>
  }
  annotation: {
    setMode(enabled: boolean): Promise<void>
    setTool(tool: InvokeContract['annotation:setTool']['req']['tool'], style: InvokeContract['annotation:setTool']['req']['style']): Promise<void>
    undo(): Promise<void>
    redo(): Promise<void>
    clear(): Promise<void>
    /** Overlay page -> main: replace the authoritative live shape list. */
    commitShapes(recordingId: string, shapes: InvokeContract['annotation:replaceAll']['req']['shapes']): Promise<void>
  }
  library: {
    list(): Promise<InvokeContract['library:list']['res']>
    get(id: string): Promise<InvokeContract['library:get']['res']>
    remove(id: string): Promise<void>
    rename(id: string, title: string): Promise<void>
    storage(): Promise<InvokeContract['library:storage']['res']>
  }
  projects: {
    list(): Promise<InvokeContract['projects:list']['res']>
    get(id: string): Promise<InvokeContract['projects:get']['res']>
    save(project: InvokeContract['projects:save']['req']['project']): Promise<InvokeContract['projects:save']['res']>
    remove(id: string): Promise<void>
  }
  editor: {
    cursorEvents(recordingId: string): Promise<InvokeContract['editor:cursorEvents']['res']>
    annotations(recordingId: string): Promise<InvokeContract['editor:annotations']['res']>
    waveform(path: string, width: number, height: number): Promise<InvokeContract['editor:waveform']['res']>
    thumbnails(videoPath: string, count: number): Promise<InvokeContract['editor:thumbnails']['res']>
  }
  exporter: {
    start(
      recordingId: string,
      options: InvokeContract['export:start']['req']['options'],
    ): Promise<InvokeContract['export:start']['res']>
    cancel(jobId: string): Promise<void>
  }
  settings: {
    get(): Promise<InvokeContract['settings:get']['res']>
    set(patch: Record<string, unknown>): Promise<InvokeContract['settings:set']['res']>
  }
  events: {
    on<C extends EventChannel>(channel: C, listener: (payload: EventContract[C]) => void): () => void
  }
  // Private API for the hidden capture-agent window only.
  agent: {
    onStart(listener: (payload: AgentStartPayloadShape) => void): () => void
    onStop(listener: () => void): () => void
    onPause(listener: () => void): () => void
    onResume(listener: () => void): () => void
    onMicToggle(listener: (enabled: boolean) => void): () => void
    sendChunk(stream: string, chunk: ArrayBuffer, seq: number): Promise<void>
    sendError(message: string): Promise<void>
    sendMicLevel(level: number): Promise<void>
    ackStart(error: string | null): void
    ackStop(): void
  }
}

/** Mirrors shared/ipc AgentStartPayload without importing main-only modules. */
interface AgentStartPayloadShape {
  sourceId: string
  fps: number
  video: boolean
  mic: { deviceId?: string; enabled: boolean }
  system: { enabled: boolean }
}

type RecordingStateValue = InvokeContract['recorder:getState']['res']

const api: ScreenForgeApi = {
  app: {
    getVersion: () => invoke('app:getVersion', undefined as never),
  },
  window: {
    minimize: () => invoke('window:minimize', undefined as never),
    maximizeToggle: () => invoke('window:maximizeToggle', undefined as never),
    close: () => invoke('window:close', undefined as never),
  },
  shell: {
    revealPath: (path) => invoke('shell:revealPath', { path }),
    openPath: (path) => invoke('shell:openPath', { path }),
  },
  dialogs: {
    chooseDirectory: (title) => invoke('dialog:chooseDirectory', { title }),
    chooseFile: (title, filters) => invoke('dialog:chooseFile', { title, filters }),
  },
  recorder: {
    listDisplays: () => invoke('displays:list', undefined as never),
    listWindows: () => invoke('windows:list', undefined as never),
    listAudioDevices: () => invoke('audio:listDevices', undefined as never),
    start: (config) => invoke('recorder:start', config),
    pause: () => invoke('recorder:pause', undefined as never),
    resume: () => invoke('recorder:resume', undefined as never),
    stop: () => invoke('recorder:stop', undefined as never),
    cancel: () => invoke('recorder:cancel', undefined as never),
    getState: () => invoke('recorder:getState', undefined as never),
    selectRegion: (displayId) => invoke('recorder:selectRegion', { displayId }),
    submitRegionResult: (rect) => invoke('recorder:submitRegionResult', { result: rect }),
  },
  annotation: {
    setMode: (enabled) => invoke('annotation:setMode', { enabled }),
    setTool: (tool, style) => invoke('annotation:setTool', { tool, style }),
    undo: () => invoke('annotation:undo', undefined as never),
    redo: () => invoke('annotation:redo', undefined as never),
    clear: () => invoke('annotation:clear', undefined as never),
    commitShapes: (recordingId, shapes) => invoke('annotation:replaceAll', { recordingId, shapes }),
  },
  library: {
    list: () => invoke('library:list', undefined as never),
    get: (id) => invoke('library:get', { id }),
    remove: (id) => invoke('library:delete', { id }),
    rename: (id, title) => invoke('library:rename', { id, title }),
    storage: () => invoke('library:storage', undefined as never),
  },
  projects: {
    list: () => invoke('projects:list', undefined as never),
    get: (id) => invoke('projects:get', { id }),
    save: (project) => invoke('projects:save', { project }),
    remove: (id) => invoke('projects:delete', { id }),
  },
  editor: {
    cursorEvents: (recordingId) => invoke('editor:cursorEvents', { recordingId }),
    annotations: (recordingId) => invoke('editor:annotations', { recordingId }),
    waveform: (path, width, height) => invoke('editor:waveform', { path, width, height }),
    thumbnails: (videoPath, count) => invoke('editor:thumbnails', { videoPath, count }),
  },
  exporter: {
    start: (recordingId, options) => invoke('export:start', { recordingId, options }),
    cancel: (jobId) => invoke('export:cancel', { jobId }),
  },
  settings: {
    get: () => invoke('settings:get', undefined as never),
    set: (patch) => invoke('settings:set', { patch }),
  },
  events: {
    on: (channel, listener) => {
      if (!EVENT_CHANNELS.has(channel)) {
        throw new Error(`ScreenForge: event channel "${channel}" is not allowed`)
      }
      const wrapped = (_event: unknown, payload: unknown) => listener(payload as never)
      ipcRenderer.on(channel, wrapped)
      return () => ipcRenderer.removeListener(channel, wrapped)
    },
  },
  agent: {
    onStart: (listener) => {
      const wrapped = (_e: unknown, payload: AgentStartPayloadShape) => listener(payload)
      ipcRenderer.on(CAPTURE_AGENT_CHANNELS.start, wrapped)
      return () => ipcRenderer.removeListener(CAPTURE_AGENT_CHANNELS.start, wrapped)
    },
    onStop: (listener) => {
      const wrapped = () => listener()
      ipcRenderer.on(CAPTURE_AGENT_CHANNELS.stop, wrapped)
      return () => ipcRenderer.removeListener(CAPTURE_AGENT_CHANNELS.stop, wrapped)
    },
    onPause: (listener) => {
      const wrapped = () => listener()
      ipcRenderer.on(CAPTURE_AGENT_CHANNELS.pause, wrapped)
      return () => ipcRenderer.removeListener(CAPTURE_AGENT_CHANNELS.pause, wrapped)
    },
    onResume: (listener) => {
      const wrapped = () => listener()
      ipcRenderer.on(CAPTURE_AGENT_CHANNELS.resume, wrapped)
      return () => ipcRenderer.removeListener(CAPTURE_AGENT_CHANNELS.resume, wrapped)
    },
    onMicToggle: (listener) => {
      const wrapped = (_e: unknown, enabled: boolean) => listener(enabled)
      ipcRenderer.on(CAPTURE_AGENT_CHANNELS.micToggle, wrapped)
      return () => ipcRenderer.removeListener(CAPTURE_AGENT_CHANNELS.micToggle, wrapped)
    },
    sendChunk: (stream, chunk, seq) =>
      ipcRenderer.invoke(CAPTURE_AGENT_CHANNELS.chunk, { stream, chunk, seq }).then(() => undefined),
    sendError: (message) =>
      ipcRenderer.invoke(CAPTURE_AGENT_CHANNELS.error, message).then(() => undefined),
    sendMicLevel: (level) =>
      ipcRenderer.invoke(CAPTURE_AGENT_CHANNELS.micLevel, level).then(() => undefined),
    ackStart: (error) => {
      ipcRenderer.send(`${CAPTURE_AGENT_CHANNELS.start}:ack`, error)
    },
    ackStop: () => {
      ipcRenderer.send(`${CAPTURE_AGENT_CHANNELS.stop}:ack`)
    },
  },
}

contextBridge.exposeInMainWorld('screenforge', Object.freeze(api))
