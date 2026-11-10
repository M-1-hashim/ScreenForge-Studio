import { useEffect, useRef, useState } from 'react'
import { useRecorderStore } from '@/stores/recorder-store'
import { useSettingsStore } from '@/stores/settings-store'
import { toast } from '@/stores/toast-store'
import type { AnnotationToolId, CursorConfig } from '@shared/types'
import { DEFAULT_ANNOTATION_STYLE, DEFAULT_CURSOR_CONFIG } from '@shared/types'
import { formatTimecode } from '@shared/edl'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { ColorPicker } from '@/components/ui/color-picker'
import { CursorConfigPanel } from '@/components/cursor/cursor-config-panel'
import {
  AppWindow,
  Circle,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Scan,
  Square,
  Video,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export function RecorderPage() {
  const store = useRecorderStore()
  const settings = useSettingsStore((s) => s.settings)
  const defaultsApplied = useRef(false)
  const [cursorDialog, setCursorDialog] = useState(false)
  const [cursorCfg, setCursorCfg] = useState<CursorConfig>({ ...DEFAULT_CURSOR_CONFIG })

  useEffect(() => {
    if (!store.sourcesLoaded) void store.loadSources()
    return store.bindEvents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply settings defaults once, before the user touches anything.
  useEffect(() => {
    if (settings && !defaultsApplied.current) {
      defaultsApplied.current = true
      store.setConfig({
        mode: settings.defaultMode,
        fps: settings.defaultFps,
        resolution: settings.defaultResolution,
        countdownSec: settings.countdownSec,
      })
      store.setAudioConfig({
        system: settings.systemAudioDefault,
        mic: settings.micDefault,
        micDeviceId: localStorage.getItem('sf.micDeviceId') ?? undefined,
      })
      setCursorCfg(settings.cursorConfig)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  const recording = store.state === 'recording' || store.state === 'paused'

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 p-8">{recording ? <RecordingStatus /> : <IdleConfigurator />}</div>

      <Dialog open={cursorDialog} onOpenChange={setCursorDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Cursor customization</DialogTitle>
          </DialogHeader>
          <CursorConfigPanel value={cursorCfg} onChange={setCursorCfg} />
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Idle configuration UI
// ---------------------------------------------------------------------------

function IdleConfigurator() {
  const store = useRecorderStore()
  const settings = useSettingsStore((s) => s.settings)
  const { config } = store
  const [drawingRegion, setDrawingRegion] = useState(false)
  const [annotationStyle, setAnnotationStyle] = useState(DEFAULT_ANNOTATION_STYLE)

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-4">
      <div>
        <h1 className="text-lg font-semibold">Recorder</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Configure the capture, then start. A floating toolbar appears while recording.
        </p>
      </div>

      {/* Mode */}
      <section className="grid gap-3 sm:grid-cols-3" aria-label="Capture mode">
        {(
          [
            { id: 'fullscreen', label: 'Fullscreen', icon: Monitor },
            { id: 'region', label: 'Region', icon: Scan },
            { id: 'window', label: 'Window', icon: AppWindow },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => store.setConfig({ mode: id })}
            className={cn(
              'flex items-center gap-3 rounded-lg border p-4 text-left transition-colors',
              config.mode === id
                ? 'border-primary/60 bg-accent ring-1 ring-primary/40'
                : 'bg-card hover:border-primary/30',
            )}
            aria-pressed={config.mode === id}
          >
            <Icon className={cn('h-5 w-5', config.mode === id ? 'text-primary' : 'text-muted-foreground')} />
            <span className="text-sm font-medium">{label}</span>
          </button>
        ))}
      </section>

      {/* Mode-specific source */}
      {config.mode === 'fullscreen' && (
        <Card title="Display">
          <Select value={String(config.displayId)} onValueChange={(v) => store.setConfig({ displayId: Number(v) })}>
            <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
            <SelectContent>
              {store.displays.map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.label} — {d.physicalBounds.width}×{d.physicalBounds.height}
                  {d.isPrimary ? ' · primary' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Card>
      )}

      {config.mode === 'window' && (
        <Card title="Window">
          <Select value={config.windowId ?? ''} onValueChange={(v) => store.setConfig({ windowId: v })}>
            <SelectTrigger className="w-96"><SelectValue placeholder="Select a window" /></SelectTrigger>
            <SelectContent className="max-h-72">
              {store.windows.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {config.windowId && store.windows.find((w) => w.id === config.windowId)?.thumbnailDataUrl && (
            <img
              src={store.windows.find((w) => w.id === config.windowId)!.thumbnailDataUrl}
              alt="Selected window preview"
              className="mt-3 max-h-40 rounded-md border"
            />
          )}
        </Card>
      )}

      {config.mode === 'region' && (
        <Card title="Region">
          {store.regionRect ? (
            <div className="flex items-center gap-4">
              <div className="rounded-md border border-dashed border-primary/60 bg-primary/5 px-4 py-3 font-mono text-sm">
                {store.regionRect.width} × {store.regionRect.height} px
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={drawingRegion}
                onClick={async () => {
                  setDrawingRegion(true)
                  await store.selectRegion()
                  setDrawingRegion(false)
                }}
              >
                Redraw
              </Button>
              <Button variant="ghost" size="sm" onClick={() => store.setConfig({ region: undefined })}>
                Clear
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-8">
              <Scan className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Draw an area on the selected display</p>
              <Button
                disabled={drawingRegion}
                onClick={async () => {
                  setDrawingRegion(true)
                  const rect = await store.selectRegion()
                  setDrawingRegion(false)
                  if (rect) toast.info(`Region selected — ${rect.width} × ${rect.height} px`)
                }}
              >
                {drawingRegion ? 'Drawing…' : 'Draw region'}
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* Video settings */}
      <Card title="Video">
        <div className="flex flex-wrap items-center gap-6">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Resolution</Label>
            <Select value={config.resolution} onValueChange={(v) => store.setConfig({ resolution: v as never })}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="source">Source</SelectItem>
                <SelectItem value="720p">720p</SelectItem>
                <SelectItem value="1080p">1080p</SelectItem>
                <SelectItem value="1440p">1440p</SelectItem>
                <SelectItem value="4k">4K</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Frame rate</Label>
            <RadioGroup
              value={String(config.fps)}
              onValueChange={(v) => store.setConfig({ fps: Number(v) as 24 | 30 | 60 })}
              className="flex gap-4"
            >
              {[24, 30, 60].map((fps) => (
                <div key={fps} className="flex items-center gap-2">
                  <RadioGroupItem value={String(fps)} id={`fps-${fps}`} />
                  <Label htmlFor={`fps-${fps}`} className="text-sm">{fps}</Label>
                </div>
              ))}
            </RadioGroup>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Countdown — {config.countdownSec}s</Label>
            <Slider
              className="w-36"
              min={0}
              max={10}
              value={[config.countdownSec]}
              onValueChange={([countdownSec]) => store.setConfig({ countdownSec })}
            />
          </div>
        </div>
      </Card>

      {/* Audio */}
      <Card title="Audio">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">System audio</Label>
              <Switch
                checked={config.audio.system}
                onCheckedChange={(system) => store.setAudioConfig({ system })}
              />
            </div>
            {config.audio.system && (
              <VolumeSlider
                label="Volume"
                value={config.audio.systemVolume}
                onChange={(systemVolume) => store.setAudioConfig({ systemVolume })}
              />
            )}
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Microphone</Label>
              <Switch checked={config.audio.mic} onCheckedChange={(mic) => store.setAudioConfig({ mic })} />
            </div>
            {config.audio.mic && (
              <>
                <Select
                  value={config.audio.micDeviceId ?? 'default'}
                  onValueChange={(v) => {
                    store.setAudioConfig({ micDeviceId: v === 'default' ? undefined : v })
                    localStorage.setItem('sf.micDeviceId', v)
                  }}
                >
                  <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {store.audioDevices
                      .filter((d) => d.kind === 'microphone')
                      .map((d) => (
                        <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <VolumeSlider
                  label="Volume"
                  value={config.audio.micVolume}
                  onChange={(micVolume) => store.setAudioConfig({ micVolume })}
                />
                <MicLevelBar level={store.micLevel} />
              </>
            )}
          </div>
        </div>
      </Card>

      {/* Cursor + annotation */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card title="Cursor">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">Customize cursor effects</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Rendered at export — highlight, click effects, smoothing, trail.
              </p>
            </div>
            <Switch checked={config.cursorCapture} onCheckedChange={(cursorCapture) => store.setConfig({ cursorCapture })} />
          </div>
        </Card>
        <Card title="Live drawing">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">Annotation overlay</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Draw over your screen while recording.</p>
            </div>
            <Switch
              checked={config.annotationsEnabled}
              onCheckedChange={(annotationsEnabled) => store.setConfig({ annotationsEnabled })}
            />
          </div>
          {config.annotationsEnabled && (
            <div className="mt-3 flex items-center gap-3">
              <ColorPicker value={annotationStyle.color} onChange={(color) => setAnnotationStyle({ ...annotationStyle, color })} />
              <Slider
                className="w-28"
                min={1}
                max={20}
                value={[annotationStyle.strokeWidth]}
                onValueChange={([strokeWidth]) => setAnnotationStyle({ ...annotationStyle, strokeWidth })}
              />
              <span className="text-xs text-muted-foreground">{annotationStyle.strokeWidth}px</span>
            </div>
          )}
        </Card>
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-between rounded-xl border bg-card p-4">
        <p className="text-xs text-muted-foreground">
          {config.mode === 'region' && !store.regionRect
            ? 'Draw a region to begin.'
            : config.mode === 'window' && !config.windowId
              ? 'Select a window to begin.'
              : `Ready — ${config.mode} · ${config.fps} fps`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              store.setConfig({
                fps: settings?.defaultFps ?? 30,
                resolution: settings?.defaultResolution ?? 'source',
                countdownSec: settings?.countdownSec ?? 3,
              })
              toast.info('Configuration reset to defaults')
            }}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
          </Button>
          <Button
            className="h-11 gap-2 px-6"
            disabled={store.state === 'preparing' || store.state === 'countdown'}
            onClick={async () => {
              if (config.annotationsEnabled) {
                await window.screenforge.annotation.setTool('pen' as AnnotationToolId, annotationStyle)
              }
              const result = await store.start()
              if (!result.ok) toast.error('Cannot start recording', result.reason)
            }}
          >
            <Video className="h-4 w-4" />
            Start Recording
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Active recording UI
// ---------------------------------------------------------------------------

function RecordingStatus() {
  const store = useRecorderStore()
  const [confirmStop, setConfirmStop] = useState(false)

  return (
    <div className="mx-auto max-w-md space-y-8 pt-12 text-center">
      <div className="flex items-center justify-center gap-3">
        <span className={cn('h-3 w-3 rounded-full bg-destructive', store.state === 'recording' && 'animate-pulse-rec')} />
        <span className="font-mono text-4xl font-semibold tabular-nums">
          {formatTimecode(store.elapsedMs)}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {store.state === 'paused' ? 'Paused' : store.state === 'countdown' ? 'Starting…' : 'Recording in progress'}
      </p>

      <MicLevelBar level={store.micLevel} large />

      <div className="flex items-center justify-center gap-3">
        {store.state === 'paused' ? (
          <Button variant="outline" size="lg" onClick={() => void store.resume()}>
            <Play className="mr-2 h-4 w-4" /> Resume
          </Button>
        ) : (
          <Button variant="outline" size="lg" onClick={() => void store.pause()}>
            <Pause className="mr-2 h-4 w-4" /> Pause
          </Button>
        )}
        <Button variant="destructive" size="lg" onClick={() => setConfirmStop(true)}>
          <Square className="mr-2 h-4 w-4" /> Stop
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        A floating toolbar is on your screen — use it or come back here. Annotations can be toggled
        from the toolbar's pencil button.
      </p>

      {confirmStop && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xl">
            <h2 className="text-sm font-semibold">Finish and save recording?</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              The capture will be finalized and added to your library.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmStop(false)}>
                Continue recording
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  setConfirmStop(false)
                  await store.stop()
                  toast.success('Recording saved', 'Find it in the Recordings library.')
                }}
              >
                <Circle className="mr-1.5 h-3 w-3 fill-current" /> Stop & save
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function VolumeSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <Label className="w-14 text-xs text-muted-foreground">{label}</Label>
      <Slider className="flex-1" min={0} max={200} value={[Math.round(value * 100)]} onValueChange={([v]) => onChange(v / 100)} />
      <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{Math.round(value * 100)}%</span>
    </div>
  )
}

function MicLevelBar({ level, large }: { level: number; large?: boolean }) {
  return (
    <div className={cn('w-full overflow-hidden rounded-full bg-muted', large ? 'h-2' : 'h-1.5')} aria-label="Microphone level">
      <div
        className="h-full rounded-full bg-emerald-500 transition-[width] duration-100"
        style={{ width: `${Math.round(Math.min(1, level) * 100)}%` }}
      />
    </div>
  )
}
