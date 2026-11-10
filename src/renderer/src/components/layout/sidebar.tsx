import { NavLink } from 'react-router-dom'
import {
  FolderOpen,
  Home,
  PenLine,
  Scissors,
  Settings,
  Video,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useRecorderStore } from '@/stores/recorder-store'

const NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/recorder', label: 'Recorder', icon: Video, end: false },
  { to: '/editor', label: 'Editor', icon: Scissors, end: false },
  { to: '/recordings', label: 'Recordings', icon: FolderOpen, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
]

export function Sidebar() {
  const state = useRecorderStore((s) => s.state)
  const recording = state === 'recording' || state === 'paused'

  return (
    <nav aria-label="Main navigation" className="flex w-[200px] shrink-0 flex-col border-r bg-card/40">
      <div className="flex flex-col gap-0.5 p-3">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1">{label}</span>
            {to === '/recorder' && recording && (
              <span className="h-2 w-2 animate-pulse-rec rounded-full bg-destructive" aria-label="Recording active" />
            )}
          </NavLink>
        ))}
      </div>
      <div className="mt-auto p-3">
        <div className="flex items-center gap-2 rounded-md border bg-background/60 px-3 py-2 text-[11px] text-muted-foreground">
          <PenLine className="h-3.5 w-3.5" />
          <span>ScreenForge Studio</span>
        </div>
      </div>
    </nav>
  )
}
