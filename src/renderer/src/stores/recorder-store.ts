import { create } from 'zustand'
import type {
  AudioDeviceInfo,
  DisplayInfo,
  RecordingAudioConfig,
  RecordingConfig,
  RecordingState,
  Rect,
  WindowSourceInfo,
} from '@shared/types'
import { DEFAULT_CURSOR_CONFIG } from '@shared/types'

interface RecorderState {
  state: RecordingState
  elapsedMs: number
  micLevel: number
  displays: DisplayInfo[]
  windows: WindowSourceInfo[]
  audioDevices: AudioDeviceInfo[]
  sourcesLoaded: boolean
  config: RecordingConfig
  /** Region drawn by the user for the current display (physical px, display-local). */
  regionRect: Rect | null
  lastStopResult: { recordingId: string } | null

  loadSources: () => Promise<void>
  setConfig: (patch: Partial<RecordingConfig>) => void
  setAudioConfig: (patch: Partial<RecordingAudioConfig>) => void
  selectRegion: () => Promise<Rect | null>
  start: () => Promise<{ ok: boolean; reason?: string }>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<{ recordingId: string } | null>
  cancel: () => Promise<void>
  refreshState: () => Promise<void>
  /** Subscribe to main-process events; returns an unsubscribe fn. Call once. */
  bindEvents: () => () => void
}

export const useRecorderStore = create<RecorderState>((set, get) => ({
  state: 'idle',
  elapsedMs: 0,
  micLevel: 0,
  displays: [],
  windows: [],
  audioDevices: [],
  sourcesLoaded: false,
  config: {
    mode: 'fullscreen',
    displayId: 0,
    fps: 30,
    resolution: 'source',
    audio: { system: true, mic: false, systemVolume: 1, micVolume: 1 },
    cursorCapture: true,
    annotationsEnabled: false,
    countdownSec: 3,
  },
  regionRect: null,
  lastStopResult: null,

  loadSources: async () => {
    const [displays, windows, audioDevices] = await Promise.all([
      window.screenforge.recorder.listDisplays(),
      window.screenforge.recorder.listWindows(),
      window.screenforge.recorder.listAudioDevices(),
    ])
    const { config } = get()
    const primary = displays.find((d) => d.isPrimary) ?? displays[0]
    set({
      displays,
      windows,
      audioDevices,
      sourcesLoaded: true,
      config:
        primary && !displays.some((d) => d.id === config.displayId)
          ? { ...config, displayId: primary.id }
          : config,
    })
  },

  setConfig: (patch) => {
    set((s) => {
      const next = { ...s.config, ...patch }
      // switching mode/display invalidates a drawn region
      const resetRegion =
        patch.mode !== undefined || patch.displayId !== undefined
      return {
        config: next,
        regionRect: resetRegion ? null : s.regionRect,
      }
    })
  },

  setAudioConfig: (patch) =>
    set((s) => ({ config: { ...s.config, audio: { ...s.config.audio, ...patch } } })),

  selectRegion: async () => {
    const { config } = get()
    const rect = await window.screenforge.recorder.selectRegion(config.displayId)
    set({ regionRect: rect })
    return rect
  },

  start: async () => {
    const { config, regionRect } = get()
    if (config.mode === 'region' && !regionRect) {
      return { ok: false, reason: 'Draw a region first.' }
    }
    const payload: RecordingConfig = {
      ...config,
      region: config.mode === 'region' ? regionRect ?? undefined : undefined,
    }
    const res = await window.screenforge.recorder.start(payload)
    if (res.ok) {
      set({ elapsedMs: 0, lastStopResult: null })
    }
    return res
  },

  pause: async () => {
    await window.screenforge.recorder.pause()
  },

  resume: async () => {
    await window.screenforge.recorder.resume()
  },

  stop: async () => {
    set({ state: 'stopping' })
    const res = await window.screenforge.recorder.stop()
    if (res) set({ lastStopResult: res })
    return res
  },

  cancel: async () => {
    await window.screenforge.recorder.cancel()
  },

  refreshState: async () => {
    const state = await window.screenforge.recorder.getState()
    set({ state })
  },

  bindEvents: () => {
    const un1 = window.screenforge.events.on('evt:recorder-state', (state) => set({ state }))
    const un2 = window.screenforge.events.on('evt:tick', ({ elapsedMs, state }) =>
      set({ elapsedMs, state }),
    )
    const un3 = window.screenforge.events.on('evt:mic-level', (level) => set({ micLevel: level }))
    return () => {
      un1()
      un2()
      un3()
    }
  },
}))

// Re-exported for convenience in settings screens (single source of truth).
export { DEFAULT_CURSOR_CONFIG }
