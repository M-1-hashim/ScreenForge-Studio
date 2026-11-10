import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/settings-store'
import { useRecorderStore } from '@/stores/recorder-store'
import { useLibraryStore } from '@/stores/library-store'
import { toast } from '@/stores/toast-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Skeleton } from '@/components/ui/skeleton'
import { formatBytes } from '@/lib/utils'
import { FolderOpen, Keyboard, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

export function SettingsPage() {
  const { settings, loaded, update } = useSettingsStore()
  const { audioDevices, loadSources } = useRecorderStore()
  const { storage } = useLibraryStore()
  const [micDeviceId, setMicDeviceId] = useState(() => localStorage.getItem('sf.micDeviceId') ?? 'default')

  useEffect(() => {
    void loadSources()
  }, [loadSources])

  if (!loaded || !settings) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-8">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  const applyTheme = (theme: string) => {
    if (theme === 'dark') document.documentElement.classList.add('dark')
    else if (theme === 'light') document.documentElement.classList.remove('dark')
    else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.documentElement.classList.remove('dark')
    } else {
      document.documentElement.classList.add('dark')
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <Tabs defaultValue="general" className="space-y-6">
        <TabsList className="flex-wrap">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="recording">Recording</TabsTrigger>
          <TabsTrigger value="audio">Audio</TabsTrigger>
          <TabsTrigger value="cursor">Cursor</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
        </TabsList>

        {/* General */}
        <TabsContent value="general" className="space-y-5">
          <Row label="Theme" hint="Interface appearance">
            <Select
              value={settings.theme}
              onValueChange={(v) => {
                applyTheme(v)
                void update({ theme: v as 'dark' | 'light' | 'system' })
              }}
            >
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Launch on startup" hint="Start ScreenForge when Windows starts">
            <Switch
              checked={settings.launchOnStartup}
              onCheckedChange={(v) => void update({ launchOnStartup: v })}
            />
          </Row>
          <Row label="Minimize to tray on close" hint="Keep recording after closing the window">
            <Switch
              checked={settings.minimizeToTrayOnClose}
              onCheckedChange={(v) => void update({ minimizeToTrayOnClose: v })}
            />
          </Row>
          <Row label="Recordings folder" hint="Where new recordings are stored">
            <div className="flex items-center gap-2">
              <Input readOnly value={settings.recordingsDir} className="h-9 w-80 font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0"
                aria-label="Choose recordings folder"
                onClick={async () => {
                  const dir = await window.screenforge.dialogs.chooseDirectory('Choose recordings folder')
                  if (dir) {
                    await update({ recordingsDir: dir })
                    toast.success('Recordings folder updated')
                  }
                }}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </Row>
        </TabsContent>

        {/* Recording */}
        <TabsContent value="recording" className="space-y-5">
          <Row label="Default mode">
            <Select value={settings.defaultMode} onValueChange={(v) => void update({ defaultMode: v as never })}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="fullscreen">Fullscreen</SelectItem>
                <SelectItem value="region">Region</SelectItem>
                <SelectItem value="window">Window</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Default resolution">
            <Select value={settings.defaultResolution} onValueChange={(v) => void update({ defaultResolution: v as never })}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="source">Source</SelectItem>
                <SelectItem value="720p">720p</SelectItem>
                <SelectItem value="1080p">1080p</SelectItem>
                <SelectItem value="1440p">1440p</SelectItem>
                <SelectItem value="4k">4K</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Default FPS">
            <Select value={String(settings.defaultFps)} onValueChange={(v) => void update({ defaultFps: Number(v) as 24 | 30 | 60 })}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="24">24</SelectItem>
                <SelectItem value="30">30</SelectItem>
                <SelectItem value="60">60</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label={`Countdown — ${settings.countdownSec}s`} hint="Delay before capture starts">
            <Slider
              className="w-40"
              min={0}
              max={10}
              value={[settings.countdownSec]}
              onValueChange={([countdownSec]) => void update({ countdownSec })}
            />
          </Row>
          <Row label="Hardware encoding" hint="Detect and prefer NVENC / QSV / AMF when available">
            <Select value={settings.hardwareEncoding} onValueChange={(v) => void update({ hardwareEncoding: v as 'auto' | 'off' })}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="off">Off (software)</SelectItem>
              </SelectContent>
            </Select>
          </Row>
        </TabsContent>

        {/* Audio */}
        <TabsContent value="audio" className="space-y-5">
          <Row label="Record system audio by default">
            <Switch
              checked={settings.systemAudioDefault}
              onCheckedChange={(v) => void update({ systemAudioDefault: v })}
            />
          </Row>
          <Row label="Record microphone by default">
            <Switch checked={settings.micDefault} onCheckedChange={(v) => void update({ micDefault: v })} />
          </Row>
          <Row label="Microphone device" hint="Used when microphone recording is enabled">
            <Select
              value={micDeviceId}
              onValueChange={(v) => {
                setMicDeviceId(v)
                localStorage.setItem('sf.micDeviceId', v)
              }}
            >
              <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                {audioDevices
                  .filter((d) => d.kind === 'microphone')
                  .map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Row>
        </TabsContent>

        {/* Cursor */}
        <TabsContent value="cursor" className="space-y-5">
          <Row label="Cursor highlight by default">
            <Switch
              checked={settings.cursorConfig.highlight.enabled}
              onCheckedChange={(v) =>
                void update({ cursorConfig: { ...settings.cursorConfig, highlight: { ...settings.cursorConfig.highlight, enabled: v } } })
              }
            />
          </Row>
          <Row label="Left-click effect by default">
            <Switch
              checked={settings.cursorConfig.clickLeft.enabled}
              onCheckedChange={(v) =>
                void update({ cursorConfig: { ...settings.cursorConfig, clickLeft: { ...settings.cursorConfig.clickLeft, enabled: v } } })
              }
            />
          </Row>
          <Row label="Smooth cursor movement">
            <Switch
              checked={settings.cursorConfig.smoothing.enabled}
              onCheckedChange={(v) =>
                void update({ cursorConfig: { ...settings.cursorConfig, smoothing: { ...settings.cursorConfig.smoothing, enabled: v } } })
              }
            />
          </Row>
          <p className="flex items-start gap-2 rounded-md border bg-accent/40 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The full cursor editor lives in the Recorder (before capture) and in the Editor (per
            project). Cursor effects are rendered at export time — the original capture is never
            modified.
          </p>
        </TabsContent>

        {/* Storage */}
        <TabsContent value="storage" className="space-y-5">
          <Row label="Recordings folder">
            <div className="flex items-center gap-2">
              <Input readOnly value={settings.recordingsDir} className="h-9 w-80 font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                aria-label="Open recordings folder"
                onClick={() => void window.screenforge.shell.openPath(settings.recordingsDir)}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </Row>
          {storage && (
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat label="Recordings" value={formatBytes(storage.recordingsBytes)} />
              <Stat label="Exports" value={formatBytes(storage.exportsBytes)} />
              <Stat label="Trash" value={formatBytes(storage.tempBytes)} />
              <Stat label="Disk free" value={formatBytes(storage.freeBytes)} />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Canceled recordings are moved to <code>.trash</code> inside the recordings folder and are
            never silently destroyed. Deleting a recording from the library removes its files after
            confirmation.
          </p>
        </TabsContent>

        {/* About */}
        <TabsContent value="about" className="space-y-5">
          <AboutPanel />
        </TabsContent>
      </Tabs>

      {/* Shortcuts note */}
      <div className="mt-10 rounded-lg border p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Keyboard className="h-4 w-4 text-muted-foreground" /> Keyboard shortcuts
        </div>
        <ul className="mt-3 grid grid-cols-1 gap-1 text-xs text-muted-foreground sm:grid-cols-2">
          <li><Kbd>Esc</Kbd> cancel region selection</li>
          <li><Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> undo annotation</li>
          <li><Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>Z</Kbd> redo annotation</li>
          <li><Kbd>Enter</Kbd> confirm region selection</li>
        </ul>
      </div>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className={cn('rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]')}>
      {children}
    </kbd>
  )
}

function AboutPanel() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.screenforge.app.getVersion>> | null>(null)
  useEffect(() => {
    void window.screenforge.app.getVersion().then(setInfo)
  }, [])
  if (!info) return <Skeleton className="h-40" />
  return (
    <div className="space-y-2 text-sm">
      <p className="font-semibold">ScreenForge Studio v{info.version}</p>
      <p className="text-xs text-muted-foreground">Electron {info.electron} · Chromium {info.chrome} · Node {info.node}</p>
      <p className="text-xs text-muted-foreground">Capture backend: {info.captureBackend}</p>
      <p className="text-xs text-muted-foreground">Hardware encoders: {info.hwEncoders.length > 0 ? info.hwEncoders.join(', ') : 'none detected (software fallback)'}</p>
      <p className="break-all font-mono text-[11px] text-muted-foreground">ffmpeg: {info.ffmpegPath}</p>
    </div>
  )
}
