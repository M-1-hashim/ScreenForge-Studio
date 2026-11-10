/**
 * Live annotation overlay.
 *
 * One overlay window per display during recording. When drawing mode is off
 * the window is click-through (setIgnoreMouseEvents(true, forward) set by
 * main). Shapes are stored in PHYSICAL display-local pixels with recording-
 * relative timestamps (interpolated from evt:tick), and the complete list is
 * committed to main after every change via annotation.commitShapes.
 */
import type { AnnotationShape, AnnotationStyle, AnnotationToolId } from '../../shared/types'

const q = new URLSearchParams(location.search)
const recordingId = q.get('recordingId') ?? ''
const displayId = Number(q.get('displayId') ?? '0') || 0
const scaleFactor = Number(q.get('scaleFactor') ?? '1') || 1

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const tools = document.getElementById('tools') as HTMLDivElement
const textInput = document.getElementById('textinput') as HTMLTextAreaElement

// --- state -------------------------------------------------------------------

let tool: AnnotationToolId = 'pen'
let style: AnnotationStyle = {
  color: '#f59e0b',
  strokeWidth: 4,
  fontSize: 28,
  fontFamily: 'Inter, Segoe UI, sans-serif',
  opacity: 1,
}

let shapes: AnnotationShape[] = []
let redoStack: AnnotationShape[][] = []
let drawing = false
let draftPoints: Array<{ x: number; y: number }> = []
let draftStart: { x: number; y: number } | null = null
let draftTStart = 0
let pendingTextPos: { x: number; y: number } | null = null

// --- clock interpolation ---------------------------------------------------------

let lastTickMs = 0
let lastTickAt = performance.now()
let recordingActive = false

window.screenforge.events.on('evt:tick', (t) => {
  lastTickMs = t.elapsedMs
  lastTickAt = performance.now()
  recordingActive = t.state === 'recording' || t.state === 'paused'
})

function nowRecordingMs(): number {
  // Interpolate between 100ms ticks for smooth timestamps.
  return lastTickMs + Math.max(0, performance.now() - lastTickAt)
}

// --- coordinate conversion --------------------------------------------------------

/** client px (CSS, DIP) -> physical display-local px */
function toPhysical(x: number, y: number): { x: number; y: number } {
  return { x: Math.round(x * scaleFactor), y: Math.round(y * scaleFactor) }
}

function dpr(): number {
  return window.devicePixelRatio || 1
}

function resizeCanvas(): void {
  const r = dpr()
  canvas.width = Math.round(window.innerWidth * r)
  canvas.height = Math.round(window.innerHeight * r)
  canvas.style.width = `${window.innerWidth}px`
  canvas.style.height = `${window.innerHeight}px`
  ctx.setTransform(r, 0, 0, r, 0, 0)
  redraw()
}
window.addEventListener('resize', resizeCanvas)

// --- rendering ------------------------------------------------------------------------

function styleFor(toolId: AnnotationToolId, s: AnnotationStyle): { stroke: string; width: number; alpha: number } {
  if (toolId === 'highlighter') {
    return { stroke: s.color, width: s.strokeWidth * 5, alpha: 0.35 }
  }
  return { stroke: s.color, width: s.strokeWidth, alpha: s.opacity }
}

function drawShape(g: CanvasRenderingContext2D, shape: AnnotationShape, physToClient: number): void {
  const st = styleFor(shape.tool, shape.style)
  g.save()
  g.globalAlpha = st.alpha
  g.strokeStyle = st.stroke
  g.fillStyle = st.stroke
  g.lineWidth = st.width
  g.lineCap = 'round'
  g.lineJoin = 'round'

  const P = (pt: { x: number; y: number }) => ({ x: pt.x / physToClient, y: pt.y / physToClient })

  if ((shape.tool === 'pen' || shape.tool === 'highlighter') && shape.points && shape.points.length > 0) {
    g.beginPath()
    const first = P(shape.points[0])
    g.moveTo(first.x, first.y)
    for (let i = 1; i < shape.points.length; i++) {
      const p = P(shape.points[i])
      g.lineTo(p.x, p.y)
    }
    g.stroke()
  } else if (shape.tool === 'line' && shape.points && shape.points.length === 2) {
    const a = P(shape.points[0])
    const b = P(shape.points[1])
    g.beginPath()
    g.moveTo(a.x, a.y)
    g.lineTo(b.x, b.y)
    g.stroke()
  } else if (shape.tool === 'arrow' && shape.points && shape.points.length === 2) {
    const a = P(shape.points[0])
    const b = P(shape.points[1])
    g.beginPath()
    g.moveTo(a.x, a.y)
    g.lineTo(b.x, b.y)
    g.stroke()
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    const head = Math.max(10, st.width * 3)
    g.beginPath()
    g.moveTo(b.x, b.y)
    g.lineTo(b.x - head * Math.cos(angle - Math.PI / 7), b.y - head * Math.sin(angle - Math.PI / 7))
    g.lineTo(b.x - head * Math.cos(angle + Math.PI / 7), b.y - head * Math.sin(angle + Math.PI / 7))
    g.closePath()
    g.fill()
  } else if (shape.rect) {
    const r = P({ x: shape.rect.x, y: shape.rect.y })
    const w = shape.rect.width / physToClient
    const h = shape.rect.height / physToClient
    if (shape.tool === 'rect') {
      g.strokeRect(r.x, r.y, w, h)
    } else if (shape.tool === 'ellipse') {
      g.beginPath()
      g.ellipse(r.x + w / 2, r.y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2)
      g.stroke()
    } else if (shape.tool === 'text' && shape.text) {
      g.font = `600 ${shape.style.fontSize}px ${shape.style.fontFamily}`
      g.textBaseline = 'top'
      g.fillText(shape.text, r.x, r.y)
    }
  }
  g.restore()
}

function redraw(): void {
  const physToClient = scaleFactor / dpr()
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  for (const shape of shapes) {
    if (shape.displayId !== displayId) continue
    drawShape(ctx, shape, physToClient)
  }
}

// --- commit -----------------------------------------------------------------------------

function commit(): void {
  redraw()
  void window.screenforge.annotation.commitShapes(recordingId, shapes)
}

function pushShape(shape: AnnotationShape): void {
  redoStack = []
  shapes.push(shape)
  commit()
}

function eraseAt(x: number, y: number): void {
  const px = x * scaleFactor
  const py = y * scaleFactor
  const threshold = 14 * scaleFactor
  let removed = false
  const next: AnnotationShape[] = []
  for (const shape of shapes) {
    let hit = false
    if (shape.points) {
      for (const p of shape.points) {
        if (Math.hypot(p.x - px, p.y - py) < threshold) {
          hit = true
          break
        }
      }
    } else if (shape.rect) {
      const r = shape.rect
      const inside =
        px >= r.x - threshold && px <= r.x + r.width + threshold && py >= r.y - threshold && py <= r.y + r.height + threshold
      hit = inside
    }
    if (hit) {
      removed = true
    } else {
      next.push(shape)
    }
  }
  if (removed) {
    redoStack = []
    shapes = next
    commit()
  }
}

// --- text tool ------------------------------------------------------------------------------

function beginTextAt(x: number, y: number): void {
  pendingTextPos = { x, y }
  textInput.style.display = 'block'
  textInput.style.left = `${x}px`
  textInput.style.top = `${y}px`
  textInput.style.fontSize = `${style.fontSize}px`
  textInput.style.color = style.color
  textInput.value = ''
  setTimeout(() => textInput.focus(), 0)
}

function commitText(): void {
  if (!pendingTextPos) return
  const text = textInput.value.trim()
  const pos = pendingTextPos
  textInput.style.display = 'none'
  pendingTextPos = null
  if (!text) return
  const physPos = toPhysical(pos.x, pos.y)
  const phys = toPhysical(pos.x + textInput.offsetWidth, pos.y + textInput.offsetHeight)
  pushShape({
    id: crypto.randomUUID(),
    tool: 'text',
    tStartMs: Math.round(draftTStart),
    tEndMs: Math.round(nowRecordingMs()),
    displayId,
    rect: { x: physPos.x, y: physPos.y, width: Math.max(40, phys.x - physPos.x), height: Math.max(20, phys.y - physPos.y) },
    text,
    style: { ...style },
  })
}

textInput.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    commitText()
  } else if (e.key === 'Escape') {
    textInput.style.display = 'none'
    pendingTextPos = null
  }
})
textInput.addEventListener('blur', () => {
  if (pendingTextPos) commitText()
})

// --- pointer input -------------------------------------------------------------------------

canvas.addEventListener('pointerdown', (e) => {
  if (!recordingActive || pendingTextPos) return
  if (tool === 'text') {
    beginTextAt(e.clientX, e.clientY)
    return
  }
  if (tool === 'eraser') {
    drawing = true
    eraseAt(e.clientX, e.clientY)
    return
  }
  drawing = true
  draftStart = { x: e.clientX, y: e.clientY }
  draftPoints = [toPhysical(e.clientX, e.clientY)]
  draftTStart = nowRecordingMs()
  canvas.setPointerCapture(e.pointerId)
})

canvas.addEventListener('pointermove', (e) => {
  if (!drawing) return
  if (tool === 'eraser') {
    eraseAt(e.clientX, e.clientY)
    return
  }
  if (tool === 'pen' || tool === 'highlighter') {
    draftPoints.push(toPhysical(e.clientX, e.clientY))
  } else {
    draftPoints = [draftStart!, toPhysical(e.clientX, e.clientY)]
  }
  // live draft render
  const physToClient = scaleFactor / dpr()
  redraw()
  ctx.save()
  ctx.globalAlpha = tool === 'highlighter' ? 0.35 : style.opacity
  ctx.strokeStyle = style.color
  ctx.lineWidth = tool === 'highlighter' ? style.strokeWidth * 5 : style.strokeWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const p = draftPoints
  ctx.beginPath()
  if (tool === 'pen' || tool === 'highlighter') {
    ctx.moveTo(p[0].x / physToClient, p[0].y / physToClient)
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x / physToClient, p[i].y / physToClient)
  } else if (draftStart) {
    const a = { x: draftStart.x, y: draftStart.y }
    const b = { x: e.clientX, y: e.clientY }
    if (tool === 'line' || tool === 'arrow') {
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      if (tool === 'arrow') {
        const angle = Math.atan2(b.y - a.y, b.x - a.x)
        const head = Math.max(10, ctx.lineWidth * 3)
        ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 7), b.y - head * Math.sin(angle - Math.PI / 7))
        ctx.moveTo(b.x, b.y)
        ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 7), b.y - head * Math.sin(angle + Math.PI / 7))
      }
    } else if (tool === 'rect') {
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
    } else if (tool === 'ellipse') {
      ctx.ellipse(
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        Math.abs(b.x - a.x) / 2,
        Math.abs(b.y - a.y) / 2,
        0,
        0,
        Math.PI * 2,
      )
    }
  }
  ctx.stroke()
  ctx.restore()
})

canvas.addEventListener('pointerup', (e) => {
  if (!drawing) return
  drawing = false
  if (tool === 'eraser') return

  const p = draftPoints
  draftPoints = []
  if (tool === 'pen' || tool === 'highlighter') {
    if (p.length < 2) return
    pushShape({
      id: crypto.randomUUID(),
      tool,
      tStartMs: Math.round(draftTStart),
      tEndMs: Math.round(nowRecordingMs()),
      displayId,
      points: p,
      style: { ...style },
    })
    return
  }
  const a = draftStart!
  const b = { x: e.clientX, y: e.clientY }
  const pa = toPhysical(a.x, a.y)
  const pb = toPhysical(b.x, b.y)
  const rect = {
    x: Math.min(pa.x, pb.x),
    y: Math.min(pa.y, pb.y),
    width: Math.max(2, Math.abs(pb.x - pa.x)),
    height: Math.max(2, Math.abs(pb.y - pa.y)),
  }
  if (tool === 'line' || tool === 'arrow') {
    pushShape({
      id: crypto.randomUUID(),
      tool,
      tStartMs: Math.round(draftTStart),
      tEndMs: Math.round(nowRecordingMs()),
      displayId,
      points: [pa, pb],
      style: { ...style },
    })
  } else {
    pushShape({
      id: crypto.randomUUID(),
      tool: tool === 'ellipse' ? 'ellipse' : 'rect',
      tStartMs: Math.round(draftTStart),
      tEndMs: Math.round(nowRecordingMs()),
      displayId,
      rect,
      style: { ...style },
    })
  }
})

// --- toolbar wiring ---------------------------------------------------------------------------

function setToolUI(next: AnnotationToolId): void {
  tool = next
  for (const btn of tools.querySelectorAll('button[data-tool]')) {
    btn.classList.toggle('active', (btn as HTMLButtonElement).dataset.tool === next)
  }
}

for (const btn of tools.querySelectorAll('button[data-tool]')) {
  btn.addEventListener('click', () => setToolUI((btn as HTMLButtonElement).dataset.tool as AnnotationToolId))
}

document.getElementById('color')?.addEventListener('input', (e) => {
  style = { ...style, color: (e.target as HTMLInputElement).value }
})
document.getElementById('width')?.addEventListener('change', (e) => {
  style = { ...style, strokeWidth: Number((e.target as HTMLSelectElement).value) }
})
document.getElementById('undoBtn')?.addEventListener('click', () => undo())
document.getElementById('redoBtn')?.addEventListener('click', () => redo())
document.getElementById('clearBtn')?.addEventListener('click', () => {
  redoStack = []
  shapes = []
  commit()
})
document.getElementById('doneBtn')?.addEventListener('click', () => {
  tools.classList.remove('visible')
  drawVisible = false
  void window.screenforge.annotation.setMode(false)
})

function undo(): void {
  const prev = shapes
  if (prev.length === 0) return
  shapes = prev.slice(0, -1)
  redoStack.push(prev)
  commit()
}

function redo(): void {
  const next = redoStack.pop()
  if (!next) return
  shapes = next
  commit()
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
  }
})

// Tool updates from main (Recorder page / defaults).
window.screenforge.events.on('evt:annotation-tool', (payload) => {
  if (payload.tool !== 'eraser') {
    style = payload.style
  }
  setToolUI(payload.tool)
  if (!drawVisible) {
    drawVisible = true
    tools.classList.add('visible')
  }
})

let drawVisible = false
setToolUI('pen')
resizeCanvas()

export {}
