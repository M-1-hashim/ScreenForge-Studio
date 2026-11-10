import { useEffect, useRef } from 'react'
import { useEditorStore } from '@/stores/editor-store'
import { drawCursorLayer, smoothedCursorAt, type Ctx2DLike } from '@shared/cursor-render'
import type { AnnotationShape } from '@shared/types'
import { normalizeSegments, outputToSourceTime } from '@shared/edl'

/**
 * Video preview with a live cursor/annotation overlay canvas.
 *
 * The overlay is rendered by the SAME code path used for export
 * (shared/cursor-render + the annotation painter below), so what you see in
 * the editor is what the exported file will contain.
 */
export function PreviewPlayer() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef(0)

  const recording = useEditorStore((s) => s.recording)
  const project = useEditorStore((s) => s.project)
  const cursorEvents = useEditorStore((s) => s.cursorEvents)
  const cursorDisplays = useEditorStore((s) => s.cursorDisplays)
  const annotations = useEditorStore((s) => s.annotations)
  const playheadMs = useEditorStore((s) => s.playheadMs)
  const playing = useEditorStore((s) => s.playing)
  const durationMs = useEditorStore((s) => s.durationMs)
  const derivedVersion = useEditorStore((s) => s.derivedVersion)
  const setPlayhead = useEditorStore((s) => s.setPlayhead)
  const pausePlayback = useEditorStore((s) => s.pausePlayback)
  const playingRef = useRef(playing)
  playingRef.current = playing

  // --- video element sync -----------------------------------------------------
  useEffect(() => {
    const video = videoRef.current
    if (!video || !recording) return
    video.src = `recfile://media/${encodeURIComponent(recording.videoPath)}`
    video.load()
  }, [recording])

  // Seek when the user scrubs (not while playing — rAF loop drives then).
  useEffect(() => {
    const video = videoRef.current
    if (!video || playingRef.current) return
    const sourceT = outputToSourceTime(playheadMs, normalizeSegments(project?.segments ?? []))
    if (sourceT !== null && Math.abs(video.currentTime * 1000 - sourceT) > 40) {
      video.currentTime = sourceT / 1000
    }
  }, [playheadMs, project])

  // --- rAF playback loop ---------------------------------------------------------
  useEffect(() => {
    if (!playing) return
    let lastVideoTime = -1
    const loop = () => {
      const video = videoRef.current
      const store = useEditorStore.getState()
      if (video) {
        const vt = video.currentTime * 1000
        if (Math.abs(vt - lastVideoTime) > 0.5) {
          lastVideoTime = vt
          const outT = outputToSourceTime(vt, normalizeSegments(store.project?.segments ?? []))
          // Video may be inside a cut region momentarily while seeking.
          const t = outT ?? store.playheadMs
          store.setPlayhead(Math.min(t, store.durationMs - 1))
        }
      }
      if (store.playheadMs >= store.durationMs - 20) {
        store.pausePlayback()
        return
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing])

  // --- overlay render loop (always on; cheap when idle) -----------------------------
  useEffect(() => {
    const render = () => {
      const canvas = canvasRef.current
      const video = videoRef.current
      if (canvas && video && video.videoWidth > 0) {
        const ctx = canvas.getContext('2d')
        if (ctx) {
          canvas.width = video.clientWidth
          canvas.height = video.clientHeight
          drawOverlayFrame(
            ctx,
            canvas.width,
            canvas.height,
            useEditorStore.getState(),
            cursorEvents,
            cursorDisplays,
            annotations,
            recording,
          )
        }
      }
      rafRef.current = requestAnimationFrame(render)
    }
    rafRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedVersion])

  if (!recording || !project) return null

  return (
    <div className="relative w-full overflow-hidden rounded-lg border bg-black" style={{ aspectRatio: '16 / 9' }}>
      <video
        ref={videoRef}
        className="h-full w-full"
        playsInline
        onClick={() => (playing ? pausePlayback() : useEditorStore.getState().play())}
        onEnded={() => pausePlayback()}
      />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      <span className="sr-only">Video preview with cursor and annotation overlay</span>
      <span className="hidden">{durationMs}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overlay painter (preview twin of the export compositor)
// ---------------------------------------------------------------------------

function drawAnnotationShape(
  ctx: CanvasRenderingContext2D,
  shape: AnnotationShape,
  scaleX: number,
  scaleY: number,
): void {
  const isHighlighter = shape.tool === 'highlighter'
  ctx.save()
  ctx.globalAlpha = isHighlighter ? 0.35 : shape.style.opacity
  ctx.strokeStyle = shape.style.color
  ctx.fillStyle = shape.style.color
  ctx.lineWidth = isHighlighter ? shape.style.strokeWidth * 4 * scaleX : shape.style.strokeWidth * scaleX
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const X = (x: number) => (x - displayOriginX(shape)) * scaleX
  const Y = (y: number) => (y - displayOriginY(shape)) * scaleY

  if ((shape.tool === 'pen' || shape.tool === 'highlighter') && shape.points?.length) {
    ctx.beginPath()
    ctx.moveTo(X(shape.points[0].x), Y(shape.points[0].y))
    for (const p of shape.points.slice(1)) ctx.lineTo(X(p.x), Y(p.y))
    ctx.stroke()
  } else if (shape.points?.length === 2) {
    const [a, b] = shape.points
    ctx.beginPath()
    ctx.moveTo(X(a.x), Y(a.y))
    ctx.lineTo(X(b.x), Y(b.y))
    ctx.stroke()
    if (shape.tool === 'arrow') {
      const angle = Math.atan2(Y(b.y) - Y(a.y), X(b.x) - X(a.x))
      const head = Math.max(10, ctx.lineWidth * 3)
      ctx.beginPath()
      ctx.moveTo(X(b.x), Y(b.y))
      ctx.lineTo(X(b.x) - head * Math.cos(angle - Math.PI / 7), Y(b.y) - head * Math.sin(angle - Math.PI / 7))
      ctx.lineTo(X(b.x) - head * Math.cos(angle + Math.PI / 7), Y(b.y) - head * Math.sin(angle + Math.PI / 7))
      ctx.closePath()
      ctx.fill()
    }
  } else if (shape.rect) {
    const x = X(shape.rect.x)
    const y = Y(shape.rect.y)
    const w = shape.rect.width * scaleX
    const h = shape.rect.height * scaleY
    if (shape.tool === 'rect') ctx.strokeRect(x, y, w, h)
    else if (shape.tool === 'ellipse') {
      ctx.beginPath()
      ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (shape.tool === 'text' && shape.text) {
      ctx.font = `600 ${shape.style.fontSize * scaleY}px ${shape.style.fontFamily}`
      ctx.textBaseline = 'top'
      ctx.fillText(shape.text, x, y)
    }
  }
  ctx.restore()
}

// Annotation coords are display-local physical; cursor displays give the
// display origin. Fall back to zero when data is missing.
let _originCache: { id: number; x: number; y: number }[] = []
function displayOriginX(shape: AnnotationShape): number {
  const d = _originCache.find((o) => o.id === shape.displayId)
  return d?.x ?? 0
}
function displayOriginY(shape: AnnotationShape): number {
  const d = _originCache.find((o) => o.id === shape.displayId)
  return d?.y ?? 0
}

function drawOverlayFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  state: {
    project: { cursorConfig: import('@shared/types').CursorConfig; includeCursor: boolean; includeAnnotations: boolean; textOverlays: import('@shared/types').TextOverlay[] } | null
    playheadMs: number
  },
  cursorEvents: import('@shared/types').CursorEvent[],
  cursorDisplays: Array<{ id: number; physicalBounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }>,
  annotations: AnnotationShape[],
  recording: import('@shared/types').RecordingMeta | null,
) {
  ctx.clearRect(0, 0, w, h)
  const project = state.project
  if (!project) return

  _originCache = cursorDisplays.map((d) => ({ id: d.id, x: d.physicalBounds.x, y: d.physicalBounds.y }))

  // Source-space scale: display physical px -> preview px.
  const srcW = recording?.region?.width || cursorDisplays[0]?.physicalBounds.width || w
  const srcH = recording?.region?.height || cursorDisplays[0]?.physicalBounds.height || h
  const scaleX = w / srcW
  const scaleY = h / srcH
  const t = state.playheadMs

  if (project.includeAnnotations) {
    for (const shape of annotations) {
      if (t >= shape.tStartMs && t <= shape.tEndMs + 60_000) {
        drawAnnotationShape(ctx, shape, scaleX, scaleY)
      }
    }
  }

  if (project.includeCursor && project.cursorConfig.mode !== 'hidden' && cursorEvents.length > 0) {
    const display = cursorDisplays.find((d) => d.id === cursorEvents[cursorEvents.length - 1]?.displayId) ?? cursorDisplays[0]
    const ox = display?.physicalBounds.x ?? 0
    const oy = display?.physicalBounds.y ?? 0
    const pos = smoothedCursorAt(cursorEvents, t, project.cursorConfig)
    const downEvent = [...cursorEvents].reverse().find((e) => (e.type === 'down' || e.type === 'up') && e.t <= t)
    const clickEvent = [...cursorEvents]
      .reverse()
      .find((e) => e.type === 'down' && e.t <= t && (e.button === 'left' || e.button === 'right'))
    const trail = cursorEvents
      .filter((e) => e.type === 'move' && e.t <= t && t - e.t < (project.cursorConfig.trail.fadeMs || 240))
      .slice(-12)
      .map((e) => ({ x: (e.x - ox) * scaleX, y: (e.y - oy) * scaleY, t: e.t }))

    if (pos) {
      drawCursorLayer(
        ctx as unknown as Ctx2DLike,
        {
          t,
          x: (pos.x - ox) * scaleX,
          y: (pos.y - oy) * scaleY,
          visible: true,
          down: downEvent?.type === 'down',
          click: clickEvent ? { t: clickEvent.t, button: clickEvent.button === 'right' ? 'right' : 'left' } : null,
          trail,
        },
        project.cursorConfig,
      )
    }
  }

  if (project.textOverlays.length > 0) {
    for (const overlay of project.textOverlays) {
      if (t >= overlay.tStartMs && t <= overlay.tEndMs) {
        ctx.save()
        const x = overlay.x * w
        const y = overlay.y * h
        ctx.font = `${overlay.bold ? '700' : '400'} ${overlay.fontSize * scaleY}px ${overlay.fontFamily}`
        ctx.textBaseline = 'top'
        if (overlay.background) {
          const metrics = ctx.measureText(overlay.text)
          ctx.fillStyle = overlay.background
          ctx.fillRect(x - 6, y - 4, metrics.width + 12, overlay.fontSize * scaleY + 10)
        }
        ctx.fillStyle = overlay.color
        ctx.fillText(overlay.text, x, y)
        ctx.restore()
      }
    }
  }
}
