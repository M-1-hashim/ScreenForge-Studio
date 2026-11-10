import { create } from 'zustand'
import type { RecordingMeta, StorageInfo } from '@shared/types'

interface LibraryState {
  recordings: RecordingMeta[]
  storage: StorageInfo | null
  loading: boolean
  loaded: boolean
  load: () => Promise<void>
  refreshStorage: () => Promise<void>
  remove: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  recordings: [],
  storage: null,
  loading: false,
  loaded: false,
  load: async () => {
    set({ loading: true })
    try {
      const [recordings, storage] = await Promise.all([
        window.screenforge.library.list(),
        window.screenforge.library.storage(),
      ])
      set({ recordings, storage, loaded: true })
    } finally {
      set({ loading: false })
    }
  },
  refreshStorage: async () => {
    const storage = await window.screenforge.library.storage()
    set({ storage })
  },
  remove: async (id) => {
    await window.screenforge.library.remove(id)
    set({ recordings: get().recordings.filter((r) => r.id !== id) })
    await get().refreshStorage()
  },
  rename: async (id, title) => {
    await window.screenforge.library.rename(id, title)
    set({
      recordings: get().recordings.map((r) => (r.id === id ? { ...r, title } : r)),
    })
  },
}))
