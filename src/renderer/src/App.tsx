import { useEffect } from 'react'
import { HashRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { Titlebar } from '@/components/layout/titlebar'
import { Sidebar } from '@/components/layout/sidebar'
import { ToastHost } from '@/components/layout/toast-host'
import { useSettingsStore, useThemeClass } from '@/stores/settings-store'
import { HomePage } from '@/pages/home/home-page'
import { RecorderPage } from '@/pages/recorder/recorder-page'
import { EditorPage } from '@/pages/editor/editor-page'
import { RecordingsPage } from '@/pages/recordings/recordings-page'
import { SettingsPage } from '@/pages/settings/settings-page'

const TITLES: Record<string, { title: string; subtitle: string }> = {
  '/': { title: 'ScreenForge Studio', subtitle: 'Home' },
  '/recorder': { title: 'ScreenForge Studio', subtitle: 'Recorder' },
  '/editor': { title: 'ScreenForge Studio', subtitle: 'Editor' },
  '/recordings': { title: 'ScreenForge Studio', subtitle: 'Recordings Library' },
  '/settings': { title: 'ScreenForge Studio', subtitle: 'Settings' },
}

function Shell() {
  const location = useLocation()
  const themeClass = useThemeClass()
  const loadSettings = useSettingsStore((s) => s.load)

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const meta = TITLES[location.pathname] ?? TITLES['/']

  return (
    <div className={themeClass}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <Titlebar title={meta.title} subtitle={meta.subtitle} />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
      <ToastHost />
    </div>
  )
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/recorder" element={<RecorderPage />} />
          <Route path="/editor" element={<EditorPage />} />
          <Route path="/recordings" element={<RecordingsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
