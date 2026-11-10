/**
 * ScreenForge Studio — Shared type contracts.
 *
 * This file is the single source of truth shared by:
 *   - the Electron main process (src/main)
 *   - the preload bridge (src/preload)
 *   - the React renderer (src/renderer)
 *   - native addon adapters (src/main/capture, src/main/audio)
 *
 * Coordinates conventions:
 *   - "display coordinates" = DIP coordinates as reported by Electron `screen`.
 *   - "virtual-screen physical coordinates" = physical pixels relative to the
 *     origin of the entire virtual desktop (top-left of the primary monitor,
 *     scaled by each display's scaleFactor). Cursor events are stored in this
 *     space because it survives mixed-DPI multi-monitor setups.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type RecordingMode = 'fullscreen' | 'region' | 'window'

export type ResolutionPreset = 'source' | '720p' | '1080p' | '1440p' | '4k'

export type FpsPreset = 24 | 30 | 60

export type RecordingState =
  | 'idle'
  | 'preparing'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'processing'

export type CaptureBackend = 'wgc-native' | 'desktop-capturer'
export type CursorBackend = 'native-hook' | 'polling'

export const RESOLUTION_HEIGHTS: Record<Exclude<ResolutionPreset, 'source'>, number> = {
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '4k': 2160,
}

// ---------------------------------------------------------------------------
// Source enumeration
// ---------------------------------------------------------------------------

export interface DisplayInfo {
  /** Electron display id. */
  id: number
  label: string
  /** DIP bounds. */
  bounds: Rect
  workArea: Rect
  scaleFactor: number
  isPrimary: boolean
  /** Physical pixel bounds within the virtual desktop. */
  physicalBounds: Rect
}

export interface WindowSourceInfo {
  /** desktopCapturer window id, e.g. "window:1234:0". */
  id: string
  title: string
  appName: string
  thumbnailDataUrl?: string
  displayId: number
}

export interface AudioDeviceInfo {
  id: string
  name: string
  kind: 'microphone' | 'system'
  isDefault: boolean
}

// ---------------------------------------------------------------------------
// Cursor configuration (used live, in the editor, and at export)
// ---------------------------------------------------------------------------

export type CursorRenderMode = 'custom' | 'original' | 'hidden'
export type CursorShape = 'default' | 'pointer' | 'circle' | 'crosshair' | 'custom'
export type ClickEffectStyle = 'ripple' | 'burst' | 'pulse'

export interface CursorClickConfig {
  enabled: boolean
  color: string
  style: ClickEffectStyle
  radius: number
  durationMs: number
}

export interface CursorConfig {
  /** 'custom' = replace cursor with configured style, 'original' = keep captured cursor, 'hidden' = hide cursor. */
  mode: CursorRenderMode
  shape: CursorShape
  /** Absolute path or data URL for shape === 'custom'. */
  customImagePath?: string
  /** Cursor sprite size in output pixels. */
  size: number
  color: string
  opacity: number
  smoothing: {
    enabled: boolean
    /** 0..100 — higher = softer/more lagged movement. */
    strength: number
  }
  highlight: {
    enabled: boolean
    color: string
    radius: number
    opacity: number
  }
  clickLeft: CursorClickConfig
  clickRight: CursorClickConfig
  magnifier: {
    enabled: boolean
    zoom: number
    radius: number
  }
  trail: {
    enabled: boolean
    color: string
    /** Number of trail segments. */
    length: number
    fadeMs: number
  }
}

export const DEFAULT_CURSOR_CONFIG: CursorConfig = {
  mode: 'custom',
  shape: 'default',
  size: 28,
  color: '#ffffff',
  opacity: 1,
  smoothing: { enabled: true, strength: 35 },
  highlight: { enabled: true, color: '#f59e0b', radius: 22, opacity: 0.35 },
  clickLeft: {
    enabled: true,
    color: '#f59e0b',
    style: 'ripple',
    radius: 34,
    durationMs: 450,
  },
  clickRight: {
    enabled: true,
    color: '#22d3ee',
    style: 'burst',
    radius: 30,
    durationMs: 380,
  },
  magnifier: { enabled: false, zoom: 2, radius: 60 },
  trail: { enabled: false, color: '#f59e0b', length: 6, fadeMs: 240 },
}

// ---------------------------------------------------------------------------
// Annotation model
// ---------------------------------------------------------------------------

export type AnnotationToolId =
  | 'pen'
  | 'highlighter'
  | 'arrow'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'eraser'

export interface AnnotationStyle {
  color: string
  strokeWidth: number
  fontSize: number
  fontFamily: string
  opacity: number
}

export const DEFAULT_ANNOTATION_STYLE: AnnotationStyle = {
  color: '#f59e0b',
  strokeWidth: 4,
  fontSize: 28,
  fontFamily: 'Inter, Segoe UI, sans-serif',
  opacity: 1,
}

/** One completed annotation shape, stored per recording. */
export interface AnnotationShape {
  id: string
  tool: Exclude<AnnotationToolId, 'eraser'>
  /** Recording-relative timestamp when the stroke started. */
  tStartMs: number
  /** Recording-relative timestamp when the stroke was finished/erased. */
  tEndMs: number
  /** Display the annotation was drawn on. */
  displayId: number
  /** Freehand points in physical display-local coordinates. */
  points?: Array<{ x: number; y: number }>
  rect?: Rect
  text?: string
  style: AnnotationStyle
}

// ---------------------------------------------------------------------------
// Cursor event model
// ---------------------------------------------------------------------------

export type CursorEventType = 'move' | 'down' | 'up' | 'wheel'
export type MouseButton = 'left' | 'right' | 'middle'

/**
 * A single captured cursor event.
 * `t` is recording-relative milliseconds. x/y are in virtual-screen physical
 * pixels. Coordinates are guaranteed valid for the display identified by
 * `displayId`.
 */
export interface CursorEvent {
  t: number
  type: CursorEventType
  x: number
  y: number
  button?: MouseButton
  displayId: number
}

export interface CursorEventFile {
  version: 1
  coordinateSpace: 'virtual-screen-physical'
  fps: number
  displays: Array<{ id: number; physicalBounds: Rect; scaleFactor: number }>
  events: CursorEvent[]
}

// ---------------------------------------------------------------------------
// Recording configuration & metadata
// ---------------------------------------------------------------------------

export interface RecordingAudioConfig {
  system: boolean
  mic: boolean
  micDeviceId?: string
  systemVolume: number
  micVolume: number
}

export interface RecordingConfig {
  mode: RecordingMode
  displayId: number
  windowId?: string
  /** Physical px rect local to the chosen display. Required for region mode. */
  region?: Rect
  fps: FpsPreset
  resolution: ResolutionPreset
  audio: RecordingAudioConfig
  cursorCapture: boolean
  annotationsEnabled: boolean
  countdownSec: number
}

export interface RecordingMeta {
  id: string
  title: string
  createdAt: string
  durationMs: number
  mode: RecordingMode
  displayId: number
  region?: Rect
  width: number
  height: number
  fps: number
  videoPath: string
  micAudioPath?: string
  systemAudioPath?: string
  cursorEventsPath?: string
  annotationsPath?: string
  thumbnailPath?: string
  sizeBytes: number
  captureBackend: CaptureBackend
  cursorBackend: CursorBackend
}

// ---------------------------------------------------------------------------
// Editor project (edit decision list — never destructive)
// ---------------------------------------------------------------------------

export interface TextOverlay {
  id: string
  text: string
  tStartMs: number
  tEndMs: number
  /** Relative 0..1 coordinates within the output frame. */
  x: number
  y: number
  fontSize: number
  color: string
  fontFamily: string
  bold: boolean
  background?: string | null
}

export interface AudioTrackItem {
  id: string
  kind: 'music' | 'voiceover'
  path: string
  startMs: number
  volume: number
  durationMs?: number
}

export interface EditorProject {
  id: string
  recordingId: string
  title: string
  createdAt: string
  updatedAt: string
  /** Kept source ranges in source-relative ms, ordered, non-overlapping. */
  segments: Array<{ startMs: number; endMs: number }>
  cursorConfig: CursorConfig
  includeCursor: boolean
  includeAnnotations: boolean
  textOverlays: TextOverlay[]
  audioTracks: AudioTrackItem[]
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ExportCodec = 'h264' | 'h265'
export type ExportQuality = 'low' | 'medium' | 'high' | 'ultra'

export interface ExportOptions {
  codec: ExportCodec
  resolution: ResolutionPreset
  fps: FpsPreset
  quality: ExportQuality
  bitrateKbps?: number
  includeCursor: boolean
  cursorConfig: CursorConfig
  includeAnnotations: boolean
  includeMic: boolean
  micVolume: number
  includeSystemAudio: boolean
  systemVolume: number
  musicPath?: string
  musicVolume: number
  musicStartMs: number
  includeTextOverlays: boolean
  segments: Array<{ startMs: number; endMs: number }>
  outputName?: string
}

export type ExportState = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'

export interface ExportProgress {
  jobId: string
  recordingId: string
  state: ExportState
  percent: number
  output?: string
  error?: string
  speed?: string
  fps?: number
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemePreference = 'dark' | 'light' | 'system'

export interface AppSettings {
  theme: ThemePreference
  recordingsDir: string
  defaultMode: RecordingMode
  defaultFps: FpsPreset
  defaultResolution: ResolutionPreset
  defaultFormat: 'mp4'
  systemAudioDefault: boolean
  micDefault: boolean
  countdownSec: number
  cursorConfig: CursorConfig
  hardwareEncoding: 'auto' | 'off'
  launchOnStartup: boolean
  minimizeToTrayOnClose: boolean
}

// ---------------------------------------------------------------------------
// Storage / misc
// ---------------------------------------------------------------------------

export interface StorageInfo {
  recordingsDir: string
  recordingsBytes: number
  exportsBytes: number
  tempBytes: number
  freeBytes: number
  totalBytes: number
}

export interface AppVersionInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  captureBackend: CaptureBackend
  cursorBackend: CursorBackend
  ffmpegPath: string
  hwEncoders: string[]
}

export type Severity = 'info' | 'warning' | 'error'

export interface AppErrorEvent {
  scope: string
  message: string
  severity: Severity
}
