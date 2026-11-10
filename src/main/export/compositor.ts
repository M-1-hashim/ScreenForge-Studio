/**
 * Overlay compositor — renders the cursor / annotation / text-overlay layer
 * frame-by-frame with @napi-rs/canvas and pipes raw RGBA frames into FFmpeg.
 *
 * Threading model: compositing runs on the main process event loop. Each frame
 * does a bounded amount of synchronous work (draw + getImageData) and then
 * awaits pipe backpressure, so the event loop is never blocked for long and
 * FFmpeg consumes at its own pace (rawvideo input). For v1 this is acceptable
 * and keeps export pixel-identical to the editor preview (same shared painters
 * from `shared/cursor-render.ts`).
 *
 * Coordinate spaces:
 *  - Cursor events: virtual-screen PHYSICAL pixels (see shared/types.ts).
 *    Mapped: display-local = event - display.physicalBounds.origin, then
 *    scaled by outputWidth / sourceWidth where sourceWidth = region width
 *    (region mode) or the display's physical width (fullscreen mode).
 *  - Annotations: points/rects are already display-local PHYSICAL pixels;
 *    they only get the region offset removed, then the same scale.
 *  - Text overlays: relative 0..1 coordinates in the OUTPUT frame.
 */
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'

import type {
  ActiveClick,
  CursorFrameState,
  Ctx2DLike,
  TrailPoint,
} from '../../shared/cursor-render'
import { drawCursorLayer, smoothedCursorAt } from '../../shared/cursor-render'
import type {
  AnnotationShape,
  CursorConfig,
  CursorEvent,
  CursorEventFile,
  RecordingMeta,
  TextOverlay,
} from '../../shared/types'

// ---------------------------------------------------------------------------
// Font registration (best effort — export must NEVER crash over fonts)
// ---------------------------------------------------------------------------

let fontsRegistered = false

function firstExistingFile(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * Register one real font file under the family aliases the app uses
 * ('Inter', 'Segoe UI') so `ctx.font = "...px Inter, Segoe UI, sans-serif"`
 * resolves in the main process. Purely additive; failures are swallowed.
 */
function registerFontsOnce(): void {
  if (fontsRegistered) return
  fontsRegistered = true
  try {
    const candidates: string[] =
      process.platform === 'win32'
        ? ['C:\\Windows\\Fonts\\segoeui.ttf', 'C:\\Windows\\Fonts\\arial.ttf']
        : process.platform === 'darwin'
          ? ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/SFNS.ttf']
          : [
              '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
              '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
              '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
            ]
    // Bundled fonts shipped with the app (resources/fonts), if any.
    const bundledDir = path.join(__dirname, '..', '..', '..', 'resources', 'fonts')
    try {
      if (fs.existsSync(bundledDir)) {
        const bundled = fs
          .readdirSync(bundledDir)
          .filter((f) => /\.(ttf|otf|ttc)$/i.test(f))
          .map((f) => path.join(bundledDir, f))
        candidates.unshift(...bundled)
      }
    } catch {
      /* ignore */
    }
    const fontFile = firstExistingFile(candidates)
    if (fontFile) {
      for (const alias of ['Inter', 'Segoe UI']) {
        try {
          GlobalFonts.registerFromPath(fontFile, alias)
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* never crash export over fonts */
  }
}

// ---------------------------------------------------------------------------
// Context type: Ctx2DLike plus the few members the compositor itself needs.
// (The shared painters also rely on translate/scale at runtime.)
// ---------------------------------------------------------------------------

interface CompositorCtx extends Ctx2DLike {
  translate(x: number, y: number): void
  scale(x: number, y: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  measureText(text: string): { width: number }
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray }
}

// ---------------------------------------------------------------------------
// Options & class
// ---------------------------------------------------------------------------

export interface OverlayCompositorOptions {
  /** Output frame width in px. */
  width: number
  /** Output frame height in px. */
  height: number
  fps: number
  cursorConfig: CursorConfig
  /** Output-timeline cursor events (virtual-screen physical coordinates). */
  cursorEvents: CursorEvent[]
  cursorDisplays: CursorEventFile['displays']
  /** Output-timeline annotation shapes (display-local physical coordinates). */
  annotations: AnnotationShape[]
  textOverlays: TextOverlay[]
  recordingMeta: RecordingMeta
  /**
   * Total output duration in ms — determines the number of generated frames.
   * Defaults to recordingMeta.durationMs when omitted.
   */
  durationMs?: number
}

interface MappedPoint {
  x: number
  y: number
}

export class OverlayCompositor {
  readonly width: number
  readonly height: number
  readonly fps: number
  frameCount = 0

  private readonly cursorConfig: CursorConfig
  private readonly annotations: AnnotationShape[]
  private readonly textOverlays: TextOverlay[]
  private readonly recordingMeta: RecordingMeta
  private readonly durationMs: number

  /** Cursor events mapped into OUTPUT pixel coordinates, sorted by t. */
  private readonly cursorEvents: Array<CursorEvent & MappedPoint>
  private readonly mapCursor: (x: number, y: number) => MappedPoint
  private readonly mapAnnotation: (x: number, y: number) => MappedPoint
  private readonly scaleX: number
  private readonly scaleY: number

  private readonly canvas: import('@napi-rs/canvas').Canvas
  private readonly ctx: CompositorCtx

  private stream: NodeJS.WritableStream | null = null
  private streamError: Error | null = null
  private onError: ((err: Error) => void) | null = null
  private aborted = false
  private abortResolve: (() => void) | null = null
  private abortPromise: Promise<void> = Promise.resolve()
  private customImage: unknown = null

  constructor(opts: OverlayCompositorOptions) {
    registerFontsOnce()

    this.width = Math.max(2, Math.round(opts.width))
    this.height = Math.max(2, Math.round(opts.height))
    this.fps = Math.max(1, opts.fps)
    this.cursorConfig = opts.cursorConfig
    this.textOverlays = opts.textOverlays
    this.recordingMeta = opts.recordingMeta
    this.durationMs = opts.durationMs ?? opts.recordingMeta.durationMs

    const region = opts.recordingMeta.region
    const display =
      opts.cursorDisplays.find((d) => d.id === opts.recordingMeta.displayId) ??
      opts.cursorDisplays[0]

    // Source pixel size of the recording: region width in region mode,
    // otherwise the recorded display's physical width.
    const sourceWidth =
      region?.width ?? (opts.recordingMeta.width || display?.physicalBounds.width || 1)
    const sourceHeight =
      region?.height ?? (opts.recordingMeta.height || display?.physicalBounds.height || 1)
    this.scaleX = this.width / sourceWidth
    this.scaleY = this.height / sourceHeight

    // Cursor events: virtual-screen physical -> display-local -> region -> scale
    const dispX = display?.physicalBounds.x ?? 0
    const dispY = display?.physicalBounds.y ?? 0
    const regX = region?.x ?? 0
    const regY = region?.y ?? 0
    this.mapCursor = (x, y) => ({
      x: (x - dispX - regX) * this.scaleX,
      y: (y - dispY - regY) * this.scaleY,
    })
    // Annotations: display-local physical -> region -> scale
    this.mapAnnotation = (x, y) => ({
      x: (x - regX) * this.scaleX,
      y: (y - regY) * this.scaleY,
    })

    // Keep only events belonging to the recorded display (other monitors would
    // streak across the frame); fall back to all events if ids never match.
    const all = [...opts.cursorEvents].sort((a, b) => a.t - b.t)
    const sameDisplay = all.filter((e) => e.displayId === opts.recordingMeta.displayId)
    const usable = sameDisplay.length > 0 ? sameDisplay : all
    this.cursorEvents = usable.map((e) => {
      const p = this.mapCursor(e.x, e.y)
      return { ...e, x: p.x, y: p.y }
    })

    // Only annotations drawn on the recorded display can be placed correctly.
    const annos = [...opts.annotations]
    const sameDisplayAnnos = annos.filter((a) => a.displayId === opts.recordingMeta.displayId)
    this.annotations = sameDisplayAnnos.length > 0 ? sameDisplayAnnos : annos

    this.canvas = createCanvas(this.width, this.height)
    this.ctx = this.canvas.getContext('2d') as unknown as CompositorCtx
  }

  // -- stream lifecycle ------------------------------------------------------

  /** Attach the raw RGBA output stream (ffmpeg's fd 3). */
  async open(stream: NodeJS.WritableStream): Promise<void> {
    this.stream = stream
    this.aborted = false
    this.streamError = null
    this.abortPromise = new Promise<void>((resolve) => {
      this.abortResolve = resolve
    })
    this.onError = (err: Error) => {
      this.streamError = err
    }
    stream.on('error', this.onError)
  }

  /** Unblock a pending backpressure wait and stop producing frames. */
  abort(): void {
    this.aborted = true
    this.abortResolve?.()
  }

  /**
   * Finish writing (ends the stream so ffmpeg sees EOF) and detach listeners.
   * Idempotent and safe to call after an error.
   */
  close(): void {
    this.aborted = true
    this.abortResolve?.()
    const stream = this.stream
    this.stream = null
    if (stream) {
      try {
        stream.end()
      } catch {
        /* already ended */
      }
      if (this.onError) stream.removeListener('error', this.onError)
      this.onError = null
    }
  }

  /**
   * Render and write every frame. Resolves once the last frame has been
   * accepted by the stream; backpressure (drain) is awaited between frames.
   * Rejects on stream errors or after abort().
   */
  async writeFrames(): Promise<void> {
    if (!this.stream) {
      throw new Error('compositor: open() must be called before writeFrames()')
    }
    await this.loadCustomCursorImage()
    const totalFrames = Math.max(1, Math.round((this.durationMs * this.fps) / 1000))
    for (let n = 0; n < totalFrames; n++) {
      if (this.aborted) throw new Error('compositor aborted')
      if (this.streamError) throw this.streamError
      this.renderFrame(n)
      const img = this.ctx.getImageData(0, 0, this.width, this.height)
      await this.write(Buffer.from(img.data))
      this.frameCount = n + 1
    }
  }

  // -- internals ---------------------------------------------------------------

  private async write(buf: Buffer): Promise<void> {
    const stream = this.stream
    if (!stream) throw new Error('compositor: stream closed')
    if (this.streamError) throw this.streamError
    let ok = false
    try {
      ok = stream.write(buf)
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
    }
    if (ok) return
    // Backpressure: wait for drain, but wake up on abort.
    await Promise.race([once(stream, 'drain'), this.abortPromise])
    if (this.aborted) throw new Error('compositor aborted')
    if (this.streamError) throw this.streamError
  }

  private async loadCustomCursorImage(): Promise<void> {
    const cfg = this.cursorConfig
    if (cfg.mode === 'hidden' || cfg.shape !== 'custom' || !cfg.customImagePath) return
    if (this.customImage) return
    try {
      const src = cfg.customImagePath
      if (!src.startsWith('data:') && !fs.existsSync(src)) return
      this.customImage = await loadImage(src)
    } catch {
      this.customImage = null // fall back to the built-in arrow sprite
    }
  }

  /** Render one full overlay frame at output time t = n * 1000 / fps. */
  private renderFrame(n: number): void {
    const t = (n * 1000) / this.fps
    this.ctx.clearRect(0, 0, this.width, this.height)
    this.drawTextOverlays(t)
    this.drawAnnotations(t)
    if (this.cursorConfig.mode !== 'hidden') {
      this.drawCursor(t)
    }
  }

  // -- text overlays ---------------------------------------------------------

  private drawTextOverlays(t: number): void {
    for (const overlay of this.textOverlays) {
      if (t < overlay.tStartMs || t > overlay.tEndMs) continue
      const ctx = this.ctx
      const size = Math.max(6, overlay.fontSize)
      const lines = String(overlay.text ?? '').split('\n')
      ctx.save()
      ctx.font = `${overlay.bold ? 'bold ' : ''}${size}px ${overlay.fontFamily}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      const x = clamp01(overlay.x) * this.width
      const y = clamp01(overlay.y) * this.height
      if (overlay.background) {
        let maxW = 0
        for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width)
        const padX = size * 0.4
        const padY = size * 0.25
        ctx.fillStyle = overlay.background
        ctx.fillRect(x - padX, y - padY, maxW + padX * 2, lines.length * size * 1.25 + padY * 2)
      }
      ctx.fillStyle = overlay.color
      lines.forEach((line, i) => {
        ctx.fillText(line, x, y + i * size * 1.25)
      })
      ctx.restore()
    }
  }

  // -- annotations -------------------------------------------------------------

  private drawAnnotations(t: number): void {
    for (const shape of this.annotations) {
      if (shape.tStartMs > t) continue
      this.drawAnnotationShape(shape)
    }
  }

  private drawAnnotationShape(shape: AnnotationShape): void {
    const ctx = this.ctx
    const style = shape.style
    const lw = Math.max(1, style.strokeWidth * this.scaleY)
    ctx.save()
    ctx.strokeStyle = style.color
    ctx.fillStyle = style.color
    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.globalAlpha = style.opacity

    switch (shape.tool) {
      case 'pen': {
        this.strokeFreehand(shape.points ?? [], lw)
        break
      }
      case 'highlighter': {
        ctx.globalAlpha = 0.4 * style.opacity
        this.strokeFreehand(shape.points ?? [], lw * 4)
        break
      }
      case 'line': {
        const pts = shapeEndpoints(shape)
        if (pts) {
          const a = this.mapAnnotation(pts[0].x, pts[0].y)
          const b = this.mapAnnotation(pts[1].x, pts[1].y)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
        break
      }
      case 'arrow': {
        const pts = shapeEndpoints(shape)
        if (pts) {
          const a = this.mapAnnotation(pts[0].x, pts[0].y)
          const b = this.mapAnnotation(pts[1].x, pts[1].y)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          // filled arrowhead at the end point
          const angle = Math.atan2(b.y - a.y, b.x - a.x)
          const len = Math.max(10, lw * 3.5)
          const wing = Math.PI * 0.85
          ctx.beginPath()
          ctx.moveTo(b.x, b.y)
          ctx.lineTo(b.x + Math.cos(angle + wing) * len, b.y + Math.sin(angle + wing) * len)
          ctx.lineTo(b.x + Math.cos(angle - wing) * len, b.y + Math.sin(angle - wing) * len)
          ctx.closePath()
          ctx.fill()
        }
        break
      }
      case 'rect': {
        const r = shape.rect
        if (r) {
          const p = this.mapAnnotation(r.x, r.y)
          ctx.strokeRect(p.x, p.y, Math.max(1, r.width * this.scaleX), Math.max(1, r.height * this.scaleY))
        }
        break
      }
      case 'ellipse': {
        const r = shape.rect
        if (r) {
          const c = this.mapAnnotation(r.x + r.width / 2, r.y + r.height / 2)
          ctx.beginPath()
          ctx.ellipse(
            c.x,
            c.y,
            Math.max(1, (r.width * this.scaleX) / 2),
            Math.max(1, (r.height * this.scaleY) / 2),
            0,
            0,
            Math.PI * 2,
          )
          ctx.stroke()
        }
        break
      }
      case 'text': {
        const r = shape.rect
        if (r) {
          const p = this.mapAnnotation(r.x, r.y)
          const size = Math.max(8, style.fontSize * this.scaleY)
          ctx.font = `${size}px ${style.fontFamily}`
          ctx.textAlign = 'left'
          ctx.textBaseline = 'top'
          const lines = String(shape.text ?? '').split('\n')
          lines.forEach((line, i) => ctx.fillText(line, p.x, p.y + i * size * 1.25))
        }
        break
      }
      default:
        break
    }
    ctx.restore()
  }

  private strokeFreehand(points: Array<{ x: number; y: number }>, lineWidth: number): void {
    if (points.length === 0) return
    const ctx = this.ctx
    ctx.lineWidth = lineWidth
    ctx.beginPath()
    const first = this.mapAnnotation(points[0].x, points[0].y)
    ctx.moveTo(first.x, first.y)
    for (let i = 1; i < points.length; i++) {
      const p = this.mapAnnotation(points[i].x, points[i].y)
      ctx.lineTo(p.x, p.y)
    }
    if (points.length === 1) {
      // single click: draw a dot
      ctx.lineTo(first.x + 0.01, first.y)
    }
    ctx.stroke()
  }

  // -- cursor -------------------------------------------------------------------

  private drawCursor(t: number): void {
    const cfg = this.cursorConfig
    const events = this.cursorEvents

    // Index of the last event at or before t (binary search — events sorted).
    let lo = 0
    let hi = events.length - 1
    let upto = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (events[mid].t <= t) {
        upto = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (upto < 0) return // cursor has not entered the recording yet

    const uptoEvents = events.slice(0, upto + 1)
    const pos = smoothedCursorAt(uptoEvents, t, cfg)
    if (!pos) return

    // Trail: positional events within the fade window, mapped to output coords.
    let trail: TrailPoint[] = []
    if (cfg.trail.enabled) {
      const cutoff = t - cfg.trail.fadeMs
      let start = upto
      while (start >= 0 && events[start].t >= cutoff) start--
      trail = events.slice(start + 1, upto + 1).map((e) => ({ x: e.x, y: e.y, t: e.t }))
    }

    // Down state: whichever of down/up happened last.
    let down = false
    for (let i = upto; i >= 0; i--) {
      if (events[i].type === 'down') {
        down = true
        break
      }
      if (events[i].type === 'up') {
        down = false
        break
      }
    }

    // Active click effect: latest 'down' still inside its effect window.
    let click: ActiveClick | null = null
    for (let i = upto; i >= 0; i--) {
      const e = events[i]
      if (e.type === 'down' && (e.button === 'left' || e.button === 'right')) {
        const dur = e.button === 'left' ? cfg.clickLeft.durationMs : cfg.clickRight.durationMs
        if (t - e.t <= dur) click = { t: e.t, button: e.button }
        break
      }
    }

    const state: CursorFrameState = {
      t,
      x: pos.x,
      y: pos.y,
      visible: true,
      down,
      click,
      trail,
      customImage: this.customImage,
    }
    drawCursorLayer(this.ctx, state, cfg)
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const clamp01 = (v: number): number => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))

function shapeEndpoints(shape: AnnotationShape): Array<{ x: number; y: number }> | null {
  if (shape.points && shape.points.length >= 2) {
    return [shape.points[0], shape.points[shape.points.length - 1]]
  }
  if (shape.rect) {
    return [
      { x: shape.rect.x, y: shape.rect.y },
      { x: shape.rect.x + shape.rect.width, y: shape.rect.y + shape.rect.height },
    ]
  }
  return null
}
