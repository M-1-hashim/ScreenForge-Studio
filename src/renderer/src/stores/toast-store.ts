import { create } from 'zustand'

export interface ToastItem {
  id: number
  title: string
  description?: string
  variant: 'default' | 'success' | 'error'
}

interface ToastState {
  toasts: ToastItem[]
  push: (t: Omit<ToastItem, 'id'>) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++
    set({ toasts: [...get().toasts.slice(-4), { ...t, id }] })
    setTimeout(() => get().dismiss(id), t.variant === 'error' ? 7000 : 4000)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export const toast = {
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, variant: 'default' }),
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, variant: 'success' }),
  error: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, variant: 'error' }),
}
