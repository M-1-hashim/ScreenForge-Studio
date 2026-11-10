import { create } from 'zustand'
import type { AppSettings } from '@shared/types'

interface SettingsState {
  settings: AppSettings | null
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<AppSettings>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loaded: false,
  load: async () => {
    const settings = await window.screenforge.settings.get()
    set({ settings, loaded: true })
  },
  update: async (patch) => {
    const settings = await window.screenforge.settings.set(patch as Record<string, unknown>)
    set({ settings })
  },
}))

export function useThemeClass(): 'dark' | 'light' {
  const theme = useSettingsStore((s) => s.settings?.theme ?? 'dark')
  return theme === 'light' ? 'light' : 'dark'
}
