/**
 * Editor store.
 *
 * The editor is purely non-destructive: it holds an `EditorProject` (an edit
 * decision list) plus derived view data (remapped cursor events, annotations,
 * thumbnails, waveforms). Undo/redo is snapshot-based over the project JSON —
 * projects are small, and correctness beats cleverness here.
 */
import { create } from 'zustand'
import type {
  AnnotationShape,
  AudioTrackItem,
  CursorConfig,
  CursorEvent,
  EditorProject,
  ExportOptions,
  ExportProgress,
  RecordingMeta,
  TextOverlay,
} from '@shared/types'
import { DEFAULT_CURSOR_CONFIG } from '@shared/types'
import {
  normalizeSegments,
  outputDurationMs,
  remapAnnotations,
  remapCursorEvents,
  type Segment,
} from '@shared/edl'

interface EditorState {
  recording: RecordingMeta | null
  project: EditorProject | null
  /** Source duration (untrimmed). */
  sourceDurationMs: number
  /** Output duration after EDL (derived). */
  durationMs: number
  /** Cursor events remapped to the output timeline. */
  cursorEvents: CursorEvent[]
  cursorDisplays: Array<{ id: number; physicalBounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }>
  annotations: AnnotationShape[]
  thumbnails: string[]
  waveformUrls: Record<string, string>
  exportProgress: ExportProgress | null

  // playback
  playheadMs: number
  playing: boolean
  /** Monotonic counter bumped when derived data should be recomputed by the preview. */
  derivedVersion: number

  // history
  past: EditorProject[]
  future: EditorProject[]

  openRecording: (recording: RecordingMeta) => Promise<void>
  reset: () => void

  // EDL ops (each pushes history)
  setSegments: (segments: Segment[]) => void
  splitAtPlayhead: () => void
  deleteSegmentAtPlayhead: () => void
  trimStart: () => void
  trimEnd: () => void
  undo: () => void
  redo: () => void

  // property editing
  setCursorConfig: (cfg: CursorConfig) => void
  setIncludeCursor: (v: boolean) => void
  setIncludeAnnotations: (v: boolean) => void
  addTextOverlay: (t: TextOverlay) => void
  updateTextOverlay: (id: string, patch: Partial<TextOverlay>) => void
  removeTextOverlay: (id: string) => void
  addAudioTrack: (item: AudioTrackItem) => void
  updateAudioTrack: (id: string, patch: Partial<AudioTrackItem>) => void
  removeAudioTrack: (id: string) => void

  // playback
  play: () => void
  pausePlayback: () => void
  seek: (ms: number) => void
  setPlayhead: (ms: number) => void

  // export
  buildExportOptions: (partial: Partial<ExportOptions>) => ExportOptions
  startExport: (options: ExportOptions) => Promise<void>
  cancelExport: () => Promise<void>
}

function derive(project: EditorProject | null, recording: RecordingMeta | null, cursorEventsRaw: CursorEvent[], annotationsRaw: AnnotationShape[]) {
  if (!project) {
    return { durationMs: 0, cursorEvents: [], annotations: [] as AnnotationShape[] }
  }
  const segments = normalizeSegments(project.segments)
  return {
    durationMs: outputDurationMs(segments),
    cursorEvents: remapCursorEvents(cursorEventsRaw, segments),
    annotations: remapAnnotations(annotationsRaw, segments),
  }
}

let exportUnsub: (() => void) | null = null

export const useEditorStore = create<EditorState>((set, get) => ({
  recording: null,
  project: null,
  sourceDurationMs: 0,
  durationMs: 0,
  cursorEvents: [],
  cursorDisplays: [],
  annotations: [],
  thumbnails: [],
  waveformUrls: {},
  exportProgress: null,
  playheadMs: 0,
  playing: false,
  derivedVersion: 0,
  past: [],
  future: [],

  openRecording: async (recording) => {
    if (exportUnsub) {
      exportUnsub()
      exportUnsub = null
    }
    exportUnsub = window.screenforge.events.on('evt:export-progress', (p) =>
      set({ exportProgress: p }),
    )

    const [cursor, annotations, thumbnails] = await Promise.all([
      recording.cursorEventsPath
        ? window.screenforge.editor.cursorEvents(recording.id)
        : Promise.resolve(null),
      recording.annotationsPath
        ? window.screenforge.editor.annotations(recording.id)
        : Promise.resolve([]),
      window.screenforge.editor.thumbnails(recording.videoPath, 8),
    ])

    const now = new Date().toISOString()
    const project: EditorProject = {
      id: `proj_${recording.id}`,
      recordingId: recording.id,
      title: recording.title,
      createdAt: now,
      updatedAt: now,
      segments: [{ startMs: 0, endMs: recording.durationMs }],
      cursorConfig: { ...DEFAULT_CURSOR_CONFIG },
      includeCursor: true,
      includeAnnotations: true,
      textOverlays: [],
      audioTracks: [],
    }

    // Try to load an existing saved project for this recording.
    const projects = await window.screenforge.projects.list()
    const existing = projects.find((p) => p.recordingId === recording.id)

    const finalProject = existing ?? project
    const derived = derive(finalProject, recording, cursor?.events ?? [], annotations)

    set({
      recording,
      project: finalProject,
      sourceDurationMs: recording.durationMs,
      durationMs: derived.durationMs,
      cursorEvents: derived.cursorEvents,
      cursorDisplays: cursor?.displays ?? [],
      annotations: derived.annotations,
      thumbnails,
      waveformUrls: {},
      playheadMs: 0,
      playing: false,
      past: [],
      future: [],
      derivedVersion: get().derivedVersion + 1,
      exportProgress: null,
    })
  },

  reset: () =>
    set({
      recording: null,
      project: null,
      cursorEvents: [],
      annotations: [],
      thumbnails: [],
      waveformUrls: {},
      exportProgress: null,
      playheadMs: 0,
      playing: false,
      past: [],
      future: [],
    }),

  setSegments: (segments) => {
    const { project } = get()
    if (!project) return
    const nextSegments = normalizeSegments(segments)
    set({
      past: [...get().past.slice(-49), project],
      future: [],
      project: { ...project, segments: nextSegments, updatedAt: new Date().toISOString() },
    })
    const derived = derive({ ...project, segments: nextSegments }, get().recording, get().cursorEvents, [])
    set({
      durationMs: derived.durationMs,
      playheadMs: Math.min(get().playheadMs, Math.max(0, derived.durationMs - 1)),
      derivedVersion: get().derivedVersion + 1,
    })
  },

  splitAtPlayhead: () => {
    const { project, playheadMs, cursorEvents } = get()
    if (!project) return
    // map output playhead -> source time
    let acc = 0
    let cutSource: number | null = null
    for (const s of normalizeSegments(project.segments)) {
      if (playheadMs > acc && playheadMs < acc + (s.endMs - s.startMs)) {
        cutSource = s.startMs + (playheadMs - acc)
        break
      }
      acc += s.endMs - s.startMs
    }
    if (cutSource === null) return
    void cursorEvents
    const segs: Segment[] = []
    for (const s of normalizeSegments(project.segments)) {
      if (cutSource > s.startMs && cutSource < s.endMs) {
        segs.push({ startMs: s.startMs, endMs: cutSource })
        segs.push({ startMs: cutSource, endMs: s.endMs })
      } else {
        segs.push(s)
      }
    }
    get().setSegments(segs)
  },

  deleteSegmentAtPlayhead: () => {
    const { project, playheadMs } = get()
    if (!project) return
    const segs = normalizeSegments(project.segments)
    let acc = 0
    for (let i = 0; i < segs.length; i++) {
      const len = segs[i].endMs - segs[i].startMs
      if (playheadMs >= acc && playheadMs < acc + len) {
        const next = segs.filter((_, idx) => idx !== i)
        get().setSegments(next)
        const newDur = outputDurationMs(normalizeSegments(next))
        set({ playheadMs: Math.min(playheadMs, Math.max(0, newDur - 1)) })
        return
      }
      acc += len
    }
  },

  trimStart: () => {
    const { project, playheadMs } = get()
    if (!project) return
    let acc = 0
    const segs = normalizeSegments(project.segments)
    const out: Segment[] = []
    for (const s of segs) {
      if (playheadMs <= acc) {
        out.push(s)
      } else if (playheadMs < acc + (s.endMs - s.startMs)) {
        out.push({ startMs: s.startMs + (playheadMs - acc), endMs: s.endMs })
      }
      acc += s.endMs - s.startMs
    }
    get().setSegments(out)
    set({ playheadMs: 0 })
  },

  trimEnd: () => {
    const { project, playheadMs } = get()
    if (!project) return
    let acc = 0
    const out: Segment[] = []
    for (const s of normalizeSegments(project.segments)) {
      const len = s.endMs - s.startMs
      if (playheadMs <= acc) {
        // keep nothing from here on
        break
      } else if (playheadMs < acc + len) {
        out.push({ startMs: s.startMs, endMs: s.startMs + (playheadMs - acc) })
        break
      } else {
        out.push(s)
      }
      acc += len
    }
    get().setSegments(out)
  },

  undo: () => {
    const { past, project, future } = get()
    if (past.length === 0 || !project) return
    const prev = past[past.length - 1]
    set({
      past: past.slice(0, -1),
      future: [...future, project],
      project: prev,
      durationMs: outputDurationMs(normalizeSegments(prev.segments)),
      derivedVersion: get().derivedVersion + 1,
    })
  },

  redo: () => {
    const { future, project, past } = get()
    if (future.length === 0 || !project) return
    const next = future[future.length - 1]
    set({
      future: future.slice(0, -1),
      past: [...past, project],
      project: next,
      durationMs: outputDurationMs(normalizeSegments(next.segments)),
      derivedVersion: get().derivedVersion + 1,
    })
  },

  setCursorConfig: (cfg) => {
    const { project } = get()
    if (!project) return
    set({
      past: [...get().past.slice(-49), project],
      future: [],
      project: { ...project, cursorConfig: cfg, updatedAt: new Date().toISOString() },
      derivedVersion: get().derivedVersion + 1,
    })
  },

  setIncludeCursor: (v) => {
    const { project } = get()
    if (!project) return
    set({
      past: [...get().past.slice(-49), project],
      future: [],
      project: { ...project, includeCursor: v, updatedAt: new Date().toISOString() },
    })
  },

  setIncludeAnnotations: (v) => {
    const { project } = get()
    if (!project) return
    set({
      past: [...get().past.slice(-49), project],
      future: [],
      project: { ...project, includeAnnotations: v, updatedAt: new Date().toISOString() },
    })
  },

  addTextOverlay: (t) => {
    const { project } = get()
    if (!project) return
    pushProject(set, get, { ...project, textOverlays: [...project.textOverlays, t] })
  },

  updateTextOverlay: (id, patch) => {
    const { project } = get()
    if (!project) return
    pushProject(set, get, {
      ...project,
      textOverlays: project.textOverlays.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })
  },

  removeTextOverlay: (id) => {
    const { project } = get()
    if (!project) return
    pushProject(set, get, { ...project, textOverlays: project.textOverlays.filter((t) => t.id !== id) })
  },

  addAudioTrack: (item) => {
    const { project } = get()
    if (!project) return
    pushProject(set, get, { ...project, audioTracks: [...project.audioTracks, item] })
  },

  updateAudioTrack: (id, patch) => {
    const { project } = get()
    if (!project) return
    pushProject(set, get, {
      ...project,
      audioTracks: project.audioTracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })
  },

  removeAudioTrack: (id) => {
    const { project } = get()
    if (!project) return
    pushProject(set, get, { ...project, audioTracks: project.audioTracks.filter((t) => t.id !== id) })
  },

  play: () => set({ playing: true }),
  pausePlayback: () => set({ playing: false }),
  seek: (ms) => set({ playheadMs: Math.max(0, ms), playing: false }),
  setPlayhead: (ms) => set({ playheadMs: ms }),

  buildExportOptions: (partial) => {
    const { project, recording } = get()
    const cfg = project?.cursorConfig ?? { ...DEFAULT_CURSOR_CONFIG }
    return {
      codec: 'h264' as const,
      resolution: recording ? 'source' : '1080p',
      fps: 30 as const,
      quality: 'high' as const,
      includeCursor: project?.includeCursor ?? true,
      cursorConfig: cfg,
      includeAnnotations: project?.includeAnnotations ?? true,
      includeMic: Boolean(recording?.micAudioPath),
      micVolume: 1,
      includeSystemAudio: Boolean(recording?.systemAudioPath),
      systemVolume: 1,
      musicVolume: 0.6,
      musicStartMs: 0,
      includeTextOverlays: (project?.textOverlays.length ?? 0) > 0,
      segments: normalizeSegments(project?.segments ?? [{ startMs: 0, endMs: recording?.durationMs ?? 0 }]),
      ...partial,
    }
  },

  startExport: async (options) => {
    const { recording, project } = get()
    if (!recording || !project) return
    await window.screenforge.projects.save(project)
    await window.screenforge.exporter.start(recording.id, options)
  },

  cancelExport: async () => {
    const job = get().exportProgress
    if (job) await window.screenforge.exporter.cancel(job.jobId)
  },
}))

function pushProject(
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState,
  next: EditorProject,
) {
  const current = get().project
  if (!current) return
  set({
    past: [...get().past.slice(-49), current],
    future: [],
    project: { ...next, updatedAt: new Date().toISOString() },
  })
}
