import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLibraryStore } from '@/stores/library-store'
import { useRecorderStore } from '@/stores/recorder-store'
import { useSettingsStore } from '@/stores/settings-store'
import { toast } from '@/stores/toast-store'
import { RecordingCard } from '@/components/shared/recording-card'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import {
  AppWindow,
  ArrowRight,
  Clapperboard,
  FolderOpen,
  HardDrive,
  Monitor,
  Scan,
  Video,
} from 'lucide-react'
import type { EditorProject } from '@shared/types'
import { formatBytes } from '@/lib/utils'

const MODES = [
  { id: 'fullscreen', label: 'Fullscreen', icon: Monitor, description: 'Capture a whole display' },
  { id: 'region', label: 'Region', icon: Scan, description: 'Draw an area to record' },
  { id: 'window', label: 'Window', icon: AppWindow, description: 'Record a single app window' },
] as const

export function HomePage() {
  const navigate = useNavigate()
  const { recordings, storage, load, loading } = useLibraryStore()
  const settings = useSettingsStore((s) => s.settings)
  const loadSettings = useSettingsStore((s) => s.load)
  const recorder = useRecorderStore()

  const [projects, setProjects] = useState<EditorProject[]>([])
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    void load()
    void loadSettings()
    void window.screenforge.projects.list().then(setProjects)
    void recorder.loadSources()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startFullscreen = async () => {
    setStarting(true)
    try {
      if (!recorder.sourcesLoaded) await recorder.loadSources()
      const result = await recorder.start()
      if (!result.ok) toast.error('Cannot start recording', result.reason)
      else navigate('/recorder')
    } finally {
      setStarting(false)
    }
  }

  const openInEditor = (recordingId: string) => navigate(`/editor?recording=${encodeURIComponent(recordingId)}`)

  const diskUsed = storage && storage.totalBytes > 0
    ? Math.min(100, Math.round((1 - storage.freeBytes / storage.totalBytes) * 100))
    : 0

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-8">
      {/* Hero */}
      <section aria-labelledby="new-recording" className="space-y-4">
        <h1 id="new-recording" className="text-lg font-semibold">
          New Recording
        </h1>
        <div className="grid gap-4 lg:grid-cols-[1.2fr_2fr]">
          <div className="flex flex-col justify-between rounded-xl border bg-card p-6">
            <div>
              <p className="text-sm text-muted-foreground">Start with the current configuration</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {settings
                  ? `${settings.defaultMode} · ${settings.defaultResolution} · ${settings.defaultFps} fps`
                  : 'Loading settings…'}
              </p>
            </div>
            <Button
              size="lg"
              className="mt-6 h-14 w-full gap-3 text-base"
              disabled={starting}
              onClick={() => void startFullscreen()}
            >
              <Video className="h-5 w-5" />
              Start Recording
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {MODES.map(({ id, label, icon: Icon, description }) => (
              <button
                key={id}
                onClick={() => {
                  recorder.setConfig({ mode: id })
                  navigate('/recorder')
                }}
                className="group flex flex-col items-start gap-2 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent"
              >
                <Icon className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium">{label}</span>
                <span className="text-xs text-muted-foreground">{description}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Recent recordings */}
      <section aria-labelledby="recent-recordings" className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 id="recent-recordings" className="text-lg font-semibold">
            Recent Recordings
          </h2>
          <Button variant="ghost" size="sm" onClick={() => navigate('/recordings')}>
            View all <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        </div>
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="aspect-video" />
            <Skeleton className="aspect-video" />
          </div>
        ) : recordings.length === 0 ? (
          <EmptyState
            icon={Clapperboard}
            title="No recordings yet"
            description="Your finished recordings will appear here. Set up your first capture in the Recorder."
            actionLabel="Go to Recorder"
            onAction={() => navigate('/recorder')}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {recordings.slice(0, 2).map((rec) => (
              <RecordingCard key={rec.id} recording={rec} onOpenEditor={openInEditor} />
            ))}
          </div>
        )}
      </section>

      {/* Projects + status row */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent Projects</h2>
          </div>
          {projects.length === 0 ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Projects are created automatically when you edit a recording.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {projects.slice(0, 4).map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => openInEditor(p.recordingId)}
                    className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <span className="truncate">{p.title}</span>
                    <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border bg-card p-5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <HardDrive className="h-4 w-4 text-muted-foreground" /> Storage
            </div>
            {storage ? (
              <div className="mt-4 space-y-2">
                <Progress value={diskUsed} className="h-1.5" />
                <p className="text-xs text-muted-foreground">
                  {formatBytes(storage.totalBytes - storage.freeBytes)} used of{' '}
                  {formatBytes(storage.totalBytes)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Recordings: {formatBytes(storage.recordingsBytes)} · Free:{' '}
                  {formatBytes(storage.freeBytes)}
                </p>
              </div>
            ) : (
              <Skeleton className="mt-4 h-12" />
            )}
          </div>
          <div className="rounded-xl border bg-card p-5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Clapperboard className="h-4 w-4 text-muted-foreground" /> Library
            </div>
            <p className="mt-4 text-2xl font-semibold">{recordings.length}</p>
            <p className="text-xs text-muted-foreground">
              recording{recordings.length === 1 ? '' : 's'}
              {storage ? ` · ${formatBytes(storage.recordingsBytes)}` : ''}
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
