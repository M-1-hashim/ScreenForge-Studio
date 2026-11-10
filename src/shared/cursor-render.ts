/**
 * Shared cursor layer renderer.
 *
 * This module draws the customized cursor (sprite, highlight, click effects,
 * trail) onto a Canvas2D context. It is intentionally dependency-free and
 * structurally typed so the EXACT same code runs in:
 *   - the editor preview (browser HTMLCanvasElement)
 *   - the export compositor (main process, @napi-rs/canvas)
 *
 * All drawing is immediate-mode: give it the state at time `t`, it paints one
 * frame. No global mutable state, which keeps editor playback and FFmpeg
 * export visually identical.
 */
import type { CursorConfig } from './types'

/**
 * Structural gradient type shared by browser CanvasGradient and the
 * @napi-rs/canvas implementation. Declared locally so this module compiles in
 * the main process (no DOM lib) and in the renderer (DOM lib) alike.
 */
export interface GradientLike {
  addColorStop(offset: number, color: string): void
}

/** Structural subset of CanvasRenderingContext2D supported by @napi-rs/canvas. */
export interface Ctx2DLike {
  save(): void
  restore(): void
  clearRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, startAngle: number, endAngle: number): void
  rect(x: number, y: number, w: number, h: number): void
  fill(): void
  stroke(): void
  clip(): void
  drawImage(image: unknown, dx: number, dy: number, dw?: number, dh?: number): void
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): GradientLike
  translate(x: number, y: number): void
  scale(x: number, y: number): void
  rotate(angle: number): void
  // properties (assignable in both implementations)
  fillStyle: string | GradientLike
  strokeStyle: string | GradientLike
  lineWidth: number
  globalAlpha: number
  globalCompositeOperation: string
  lineCap: string
  lineJoin: string
  font: string
  textAlign: string
  textBaseline: string
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
}

export interface TrailPoint {
  x: number
  y: number
  t: number
}

export interface ActiveClick {
  /** Click start time (ms, output timeline). */
  t: number
  button: 'left' | 'right'
}

export interface CursorFrameState {
  /** Current output-timeline time in ms. */
  t: number
  x: number
  y: number
  visible: boolean
  down: boolean
  click: ActiveClick | null
  trail: TrailPoint[]
  customImage?: unknown | null
}

const ARROW_POINTS: Array<[number, number]> = [
  [0, 0],
  [0, 16.5],
  [3.9, 13.1],
  [6.6, 19.4],
  [9.4, 18.2],
  [6.8, 12.1],
  [12.1, 12.1],
]

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)
}

function withAlpha(hex: string, alpha: number): string {
  const m = hex.replace('#', '')
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  const r = parseInt(full.slice(0, 2), 16) || 0
  const g = parseInt(full.slice(2, 4), 16) || 0
  const b = parseInt(full.slice(4, 6), 16) || 0
  return `rgba(${r},${g},${b},${alpha})`
}

// ---------------------------------------------------------------------------
// Layer painters
// ---------------------------------------------------------------------------

export function drawTrail(ctx: Ctx2DLike, state: CursorFrameState, cfg: CursorConfig): void {
  if (!cfg.trail.enabled || state.trail.length < 2) return
  const { color, length, fadeMs } = cfg.trail
  const pts = state.trail.slice(-length)
  const now = state.t
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (let i = 1; i < pts.length; i++) {
    const age = now - pts[i].t
    if (age > fadeMs) continue
    const alpha = (1 - age / fadeMs) * 0.6
    const w = (i / pts.length) * cfg.size * 0.35 + 2
    ctx.strokeStyle = withAlpha(color, alpha)
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y)
    ctx.lineTo(pts[i].x, pts[i].y)
    ctx.stroke()
  }
  ctx.restore()
}

export function drawHighlight(ctx: Ctx2DLike, state: CursorFrameState, cfg: CursorConfig): void {
  if (!cfg.highlight.enabled) return
  const h = cfg.highlight
  ctx.save()
  const g = ctx.createRadialGradient(state.x, state.y, 0, state.x, state.y, h.radius)
  g.addColorStop(0, withAlpha(h.color, h.opacity))
  g.addColorStop(0.7, withAlpha(h.color, h.opacity * 0.55))
  g.addColorStop(1, withAlpha(h.color, 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(state.x, state.y, h.radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

export function drawClickEffect(ctx: Ctx2DLike, state: CursorFrameState, cfg: CursorConfig): void {
  if (!state.click) return
  const cc = state.click.button === 'left' ? cfg.clickLeft : cfg.clickRight
  if (!cc.enabled) return
  const p = (state.t - state.click.t) / Math.max(1, cc.durationMs)
  if (p < 0 || p > 1) return
  const e = easeOutCubic(p)
  const alpha = 1 - e
  const r = cc.radius * (cc.style === 'pulse' ? 0.4 + e * 0.4 : e)

  ctx.save()
  if (cc.style === 'ripple') {
    ctx.strokeStyle = withAlpha(cc.color, alpha)
    ctx.lineWidth = Math.max(2, cfg.size * 0.18 * (1 - e))
    ctx.beginPath()
    ctx.arc(state.x, state.y, Math.max(1, r), 0, Math.PI * 2)
    ctx.stroke()
  } else if (cc.style === 'burst') {
    ctx.strokeStyle = withAlpha(cc.color, alpha)
    ctx.lineWidth = Math.max(2, cfg.size * 0.14 * (1 - e))
    const spokes = 8
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2
      const r0 = cfg.size * 0.35
      ctx.beginPath()
      ctx.moveTo(state.x + Math.cos(a) * r0, state.y + Math.sin(a) * r0)
      ctx.lineTo(state.x + Math.cos(a) * Math.max(r0 + 2, r), state.y + Math.sin(a) * Math.max(r0 + 2, r))
      ctx.stroke()
    }
  } else {
    // pulse — filled disc that grows then fades
    ctx.fillStyle = withAlpha(cc.color, alpha * 0.55)
    ctx.beginPath()
    ctx.arc(state.x, state.y, Math.max(1, r), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

export function drawCursorSprite(ctx: Ctx2DLike, state: CursorFrameState, cfg: CursorConfig): void {
  if (cfg.mode === 'hidden') return
  if (!state.visible) return
  ctx.save()
  ctx.globalAlpha = cfg.opacity

  if (cfg.mode === 'original') {
    // 'original' means: do not draw anything here — the underlying video
    // already contains the OS cursor (used when WGC captured it).
    ctx.restore()
    return
  }

  if (cfg.shape === 'custom' && state.customImage) {
    const img = state.customImage as { width?: number; height?: number }
    const iw = (img.width as number) ?? cfg.size
    const ih = (img.height as number) ?? cfg.size
    const scale = cfg.size / Math.max(iw, ih)
    ctx.drawImage(state.customImage, state.x, state.y, iw * scale, ih * scale)
    ctx.restore()
    return
  }

  const pressScale = state.down ? 0.88 : 1
  ctx.translate(state.x, state.y)
  ctx.scale(pressScale, pressScale)
  // soft drop shadow for legibility on any background
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = Math.max(2, cfg.size * 0.18)
  ctx.shadowOffsetX = 1
  ctx.shadowOffsetY = 2

  if (cfg.shape === 'circle') {
    ctx.shadowBlur = 0
    ctx.fillStyle = cfg.color
    ctx.beginPath()
    ctx.arc(0, 0, cfg.size * 0.32, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'
    ctx.lineWidth = Math.max(1.5, cfg.size * 0.06)
    ctx.stroke()
  } else if (cfg.shape === 'crosshair') {
    ctx.shadowBlur = 0
    ctx.strokeStyle = cfg.color
    ctx.lineWidth = Math.max(1.5, cfg.size * 0.07)
    const s = cfg.size * 0.55
    ctx.beginPath()
    ctx.moveTo(-s, 0)
    ctx.lineTo(s, 0)
    ctx.moveTo(0, -s)
    ctx.lineTo(0, s)
    ctx.stroke()
  } else {
    // 'default' — classic arrow
    const s = cfg.size / 20
    ctx.scale(s, s)
    ctx.fillStyle = withAlpha(cfg.color, 1)
    ctx.beginPath()
    ctx.moveTo(ARROW_POINTS[0][0], ARROW_POINTS[0][1])
    for (let i = 1; i < ARROW_POINTS.length; i++) ctx.lineTo(ARROW_POINTS[i][0], ARROW_POINTS[i][1])
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'
    ctx.lineWidth = 1.4
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * Paint one complete cursor layer frame. Callers own clearing the canvas.
 * Layer order: trail → highlight → click effect → sprite.
 */
export function drawCursorLayer(ctx: Ctx2DLike, state: CursorFrameState, cfg: CursorConfig): void {
  drawTrail(ctx, state, cfg)
  drawHighlight(ctx, state, cfg)
  drawClickEffect(ctx, state, cfg)
  drawCursorSprite(ctx, state, cfg)
}

/**
 * Exponential smoothing of cursor positions (used by both live preview and
 * export). strength 0..100 maps to smoothing factor 0..~0.92 per frame.
 */
export function smoothingFactor(strength: number): number {
  return Math.min(0.92, (Math.max(0, Math.min(100, strength)) / 100) * 0.92)
}

export interface SmoothedPoint {
  x: number
  y: number
}

/**
 * Deterministic smoothing: for output time t, compute a smoothed position by
 * low-pass filtering the event path. Pure function so export matches preview.
 */
export function smoothedCursorAt(
  events: Array<{ t: number; x: number; y: number; type: string }>,
  t: number,
  cfg: CursorConfig,
): SmoothedPoint | null {
  if (events.length === 0) return null
  if (!cfg.smoothing.enabled || cfg.smoothing.strength <= 0) {
    // snap to nearest event at or before t
    let best: SmoothedPoint | null = null
    for (const e of events) {
      if (e.t > t) break
      best = { x: e.x, y: e.y }
    }
    return best
  }
  const alpha = 1 - smoothingFactor(cfg.smoothing.strength) // per-frame blend weight
  // Simulate a per-frame filter (assume ~60hz event cadence) up to time t.
  // To stay O(log n)-ish we approximate: iterate events within the last
  // `windowMs` window and blend backwards with decay.
  const windowMs = 400
  let bx: number | null = null
  let by: number | null = null
  let lastT = t
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.t > t) continue
    if (t - e.t > windowMs) break
    const dt = Math.max(1, lastT - e.t)
    const decay = Math.pow(alpha, dt / (1000 / 60))
    if (bx === null || by === null) {
      bx = e.x
      by = e.y
    } else {
      bx = bx * decay + e.x * (1 - decay)
      by = by * decay + e.y * (1 - decay)
    }
    lastT = e.t
  }
  if (bx === null || by === null) {
    // no event inside window — hold last known position
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].t <= t) return { x: events[i].x, y: events[i].y }
    }
    return { x: events[0].x, y: events[0].y }
  }
  return { x: bx, y: by }
}
