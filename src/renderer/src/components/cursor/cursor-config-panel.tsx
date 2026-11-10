import { useEffect, useRef, useState } from 'react'
import type { CursorConfig } from '@shared/types'
import { DEFAULT_CURSOR_CONFIG } from '@shared/types'
import { drawCursorLayer, type Ctx2DLike } from '@shared/cursor-render'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ColorPicker } from '@/components/ui/color-picker'
import { Label } from '@/components/ui/label'
import { FolderOpen } from 'lucide-react'

/**
 * Full editor for CursorConfig — shared by the Recorder and Editor
 * workspaces. Includes an animated live preview canvas driven by the same
 * renderer used for export (shared/cursor-render).
 */
export function CursorConfigPanel({
  value,
  onChange,
  className,
}: {
  value: CursorConfig
  onChange: (cfg: CursorConfig) => void
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cfgRef = useRef(value)
  cfgRef.current = value

  // -- live animated preview --------------------------------------------------
  useEffect(() => {
    let raf = 0
    const start = performance.now()
    const clicks: Array<{ t: number; button: 'left' | 'right' }> = []
    const trail: Array<{ x: number; y: number; t: number }> = []
    let lastClick = 0

    const loop = (now: number) => {
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        if (ctx) {
          const t = now - start
          const w = canvas.width
          const h = canvas.height
          ctx.clearRect(0, 0, w, h)
          // subtle grid backdrop
          ctx.fillStyle = '#101319'
          ctx.fillRect(0, 0, w, h)
          ctx.strokeStyle = 'rgba(255,255,255,0.05)'
          ctx.lineWidth = 1
          for (let gx = 0; gx < w; gx += 24) {
            ctx.beginPath()
            ctx.moveTo(gx, 0)
            ctx.lineTo(gx, h)
            ctx.stroke()
          }
          for (let gy = 0; gy < h; gy += 24) {
            ctx.beginPath()
            ctx.moveTo(0, gy)
            ctx.lineTo(w, gy)
            ctx.stroke()
          }

          const x = w / 2 + Math.sin(t / 900) * (w * 0.32)
          const y = h / 2 + Math.cos(t / 700) * (h * 0.26)
          trail.push({ x, y, t })
          while (trail.length > 16) trail.shift()

          if (t - lastClick > 2200) {
            lastClick = t
            clicks.push({ t, button: Math.random() > 0.5 ? 'left' : 'right' })
          }
          const activeClick = clicks.find((c) => t - c.t < 600) ?? null
          const clickCfg = activeClick
            ? activeClick.button === 'left'
              ? cfgRef.current.clickLeft
              : cfgRef.current.clickRight
            : null
          if (!clickCfg || !clickCfg.enabled) {
            // drop stale clicks
            while (clicks.length > 0 && t - clicks[0].t > 1200) clicks.shift()
          }

          drawCursorLayer(
            ctx as unknown as Ctx2DLike,
            {
              t,
              x,
              y,
              visible: true,
              down: activeClick !== null && t - activeClick.t < 120,
              click: activeClick,
              trail,
            },
            cfgRef.current,
          )
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const patch = (p: Partial<CursorConfig>) => onChange({ ...value, ...p })
  const [customPicking, setCustomPicking] = useState(false)

  return (
    <div className={cn('space-y-4', className)}>
      <div className="overflow-hidden rounded-md border">
        <canvas ref={canvasRef} width={320} height={180} className="h-[140px] w-full" />
      </div>

      <Tabs defaultValue="style">
        <TabsList className="w-full">
          <TabsTrigger value="style" className="flex-1">Style</TabsTrigger>
          <TabsTrigger value="clicks" className="flex-1">Clicks</TabsTrigger>
          <TabsTrigger value="motion" className="flex-1">Motion</TabsTrigger>
        </TabsList>

        <TabsContent value="style" className="mt-3 space-y-4">
          <Row label="Mode">
            <Select
              value={value.mode}
              onValueChange={(v) => patch({ mode: v as CursorConfig['mode'] })}
            >
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">Custom cursor</SelectItem>
                <SelectItem value="original">Keep original</SelectItem>
                <SelectItem value="hidden">Hidden</SelectItem>
              </SelectContent>
            </Select>
          </Row>

          {value.mode === 'custom' && (
            <Row label="Shape">
              <div className="flex items-center gap-2">
                <Select
                  value={value.shape === 'custom' ? 'custom' : value.shape}
                  onValueChange={(v) => patch({ shape: v as CursorConfig['shape'] })}
                >
                  <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Arrow</SelectItem>
                    <SelectItem value="circle">Dot</SelectItem>
                    <SelectItem value="crosshair">Crosshair</SelectItem>
                    <SelectItem value="custom">Custom image…</SelectItem>
                  </SelectContent>
                </Select>
                {value.shape === 'custom' && (
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Choose cursor image"
                    onClick={async () => {
                      setCustomPicking(true)
                      try {
                        const p = await window.screenforge.dialogs.chooseFile('Choose cursor image', [
                          { name: 'Images', extensions: ['png', 'svg', 'gif'] },
                        ])
                        if (p) patch({ customImagePath: p, shape: 'custom' })
                      } finally {
                        setCustomPicking(false)
                      }
                    }}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </Row>
          )}

          {value.mode === 'custom' && (
            <>
              <Row label={`Size — ${value.size}px`}>
                <Slider
                  className="w-40"
                  min={12}
                  max={96}
                  step={1}
                  value={[value.size]}
                  onValueChange={([size]) => patch({ size })}
                />
              </Row>
              <Row label="Color">
                <ColorPicker value={value.color} onChange={(color) => patch({ color })} />
              </Row>
              <Row label={`Opacity — ${Math.round(value.opacity * 100)}%`}>
                <Slider
                  className="w-40"
                  min={20}
                  max={100}
                  step={1}
                  value={[Math.round(value.opacity * 100)]}
                  onValueChange={([v]) => patch({ opacity: v / 100 })}
                />
              </Row>
              <Row label="Highlight">
                <Switch
                  checked={value.highlight.enabled}
                  onCheckedChange={(enabled) => patch({ highlight: { ...value.highlight, enabled } })}
                />
              </Row>
              {value.highlight.enabled && (
                <div className="space-y-3 rounded-md border bg-accent/30 p-3">
                  <Row label="Color">
                    <ColorPicker
                      value={value.highlight.color}
                      onChange={(color) => patch({ highlight: { ...value.highlight, color } })}
                    />
                  </Row>
                  <Row label={`Radius — ${value.highlight.radius}px`}>
                    <Slider
                      className="w-40"
                      min={8}
                      max={80}
                      value={[value.highlight.radius]}
                      onValueChange={([radius]) => patch({ highlight: { ...value.highlight, radius } })}
                    />
                  </Row>
                  <Row label={`Opacity — ${Math.round(value.highlight.opacity * 100)}%`}>
                    <Slider
                      className="w-40"
                      min={5}
                      max={100}
                      value={[Math.round(value.highlight.opacity * 100)]}
                      onValueChange={([v]) => patch({ highlight: { ...value.highlight, opacity: v / 100 } })}
                    />
                  </Row>
                </div>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="clicks" className="mt-3 space-y-3">
          <ClickCard
            title="Left click"
            cfg={value.clickLeft}
            onChange={(clickLeft) => patch({ clickLeft })}
          />
          <ClickCard
            title="Right click"
            cfg={value.clickRight}
            onChange={(clickRight) => patch({ clickRight })}
          />
        </TabsContent>

        <TabsContent value="motion" className="mt-3 space-y-4">
          <Row label="Smooth movement">
            <Switch
              checked={value.smoothing.enabled}
              onCheckedChange={(enabled) => patch({ smoothing: { ...value.smoothing, enabled } })}
            />
          </Row>
          {value.smoothing.enabled && (
            <Row label={`Smoothing — ${value.smoothing.strength}% (higher is softer)`}>
              <Slider
                className="w-40"
                min={0}
                max={100}
                value={[value.smoothing.strength]}
                onValueChange={([strength]) => patch({ smoothing: { ...value.smoothing, strength } })}
              />
            </Row>
          )}
          <Row label="Cursor trail">
            <Switch
              checked={value.trail.enabled}
              onCheckedChange={(enabled) => patch({ trail: { ...value.trail, enabled } })}
            />
          </Row>
          {value.trail.enabled && (
            <div className="space-y-3 rounded-md border bg-accent/30 p-3">
              <Row label="Color">
                <ColorPicker
                  value={value.trail.color}
                  onChange={(color) => patch({ trail: { ...value.trail, color } })}
                />
              </Row>
              <Row label={`Length — ${value.trail.length}`}>
                <Slider
                  className="w-40"
                  min={2}
                  max={12}
                  value={[value.trail.length]}
                  onValueChange={([length]) => patch({ trail: { ...value.trail, length } })}
                />
              </Row>
              <Row label={`Fade — ${value.trail.fadeMs}ms`}>
                <Slider
                  className="w-40"
                  min={100}
                  max={600}
                  step={20}
                  value={[value.trail.fadeMs]}
                  onValueChange={([fadeMs]) => patch({ trail: { ...value.trail, fadeMs } })}
                />
              </Row>
            </div>
          )}
          <Row label="Magnifier (experimental)">
            <Switch
              checked={value.magnifier.enabled}
              onCheckedChange={(enabled) => patch({ magnifier: { ...value.magnifier, enabled } })}
            />
          </Row>
          {value.magnifier.enabled && (
            <Row label="Zoom">
              <Select
                value={String(value.magnifier.zoom)}
                onValueChange={(v) => patch({ magnifier: { ...value.magnifier, zoom: Number(v) } })}
              >
                <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="2">2×</SelectItem>
                  <SelectItem value="3">3×</SelectItem>
                  <SelectItem value="4">4×</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          )}
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange({ ...DEFAULT_CURSOR_CONFIG })}
            >
              Reset to defaults
            </Button>
          </div>
        </TabsContent>
      </Tabs>
      {customPicking && <span className="sr-only">Picking custom cursor image…</span>}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

function ClickCard({
  title,
  cfg,
  onChange,
}: {
  title: string
  cfg: CursorConfig['clickLeft']
  onChange: (cfg: CursorConfig['clickLeft']) => void
}) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-medium">{title}</Label>
        <Switch checked={cfg.enabled} onCheckedChange={(enabled) => onChange({ ...cfg, enabled })} />
      </div>
      {cfg.enabled && (
        <>
          <Row label="Style">
            <Select value={cfg.style} onValueChange={(v) => onChange({ ...cfg, style: v as typeof cfg.style })}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ripple">Ripple</SelectItem>
                <SelectItem value="burst">Burst</SelectItem>
                <SelectItem value="pulse">Pulse</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Color">
            <ColorPicker value={cfg.color} onChange={(color) => onChange({ ...cfg, color })} />
          </Row>
          <Row label={`Radius — ${cfg.radius}px`}>
            <Slider
              className="w-36"
              min={12}
              max={80}
              value={[cfg.radius]}
              onValueChange={([radius]) => onChange({ ...cfg, radius })}
            />
          </Row>
          <Row label={`Duration — ${cfg.durationMs}ms`}>
            <Slider
              className="w-36"
              min={150}
              max={1000}
              step={25}
              value={[cfg.durationMs]}
              onValueChange={([durationMs]) => onChange({ ...cfg, durationMs })}
            />
          </Row>
        </>
      )}
    </div>
  )
}
