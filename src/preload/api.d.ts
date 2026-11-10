import type { ScreenForgeApi } from './index'

declare global {
  interface Window {
    screenforge: ScreenForgeApi
  }
}

export {}
