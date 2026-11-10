import type { CaptureBackend } from '../../shared/types'

export interface VideoCaptureSession {
  backend: CaptureBackend
  /** Actual source pixel size of the video file being written. */
  width: number
  height: number
  actualFps: number
  pause(): void
  resume(): void
  /** Finalize and resolve with the written video path (+ side audio paths when applicable). */
  stop(): Promise<{ videoPath: string; micPath?: string; systemPath?: string }>
  /** Optional live mic mute toggle support. */
  setMicEnabled?(enabled: boolean): void
}

export interface StartCaptureOptions {
  agentWindow: Electron.BrowserWindow
  sourceId: string
  fps: number
  outDir: string
  includeSystemAudio: boolean
  includeMic: boolean
  micDeviceId?: string
}
