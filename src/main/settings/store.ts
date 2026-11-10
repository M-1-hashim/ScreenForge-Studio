/**
 * Typed settings service backed by SQLite.
 *
 * Raw string storage lives in the settings table; this module owns defaults,
 * typed access, deep-merging of nested values (cursorConfig) and side effects
 * such as OS-level login item registration.
 */
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

import { db } from '../database'
import { DEFAULT_CURSOR_CONFIG } from '../../shared/types'
import type { AppSettings, CursorConfig } from '../../shared/types'

function defaultRecordingsDir(): string {
  try {
    return path.join(app.getPath('videos'), 'ScreenForge')
  } catch {
    // Some Linux CI environments have no XDG videos dir.
    return path.join(app.getPath('home'), 'Videos', 'ScreenForge')
  }
}

let cached: AppSettings | null = null

function readRaw(): Record<string, string> {
  try {
    return db.getSettingsRaw()
  } catch {
    return {}
  }
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** Merge a partial cursor config over the defaults so new fields never break old settings. */
export function normalizeCursorConfig(input: unknown): CursorConfig {
  const raw = (input ?? {}) as Partial<CursorConfig>
  return {
    ...DEFAULT_CURSOR_CONFIG,
    ...raw,
    smoothing: { ...DEFAULT_CURSOR_CONFIG.smoothing, ...(raw.smoothing ?? {}) },
    highlight: { ...DEFAULT_CURSOR_CONFIG.highlight, ...(raw.highlight ?? {}) },
    magnifier: { ...DEFAULT_CURSOR_CONFIG.magnifier, ...(raw.magnifier ?? {}) },
    trail: { ...DEFAULT_CURSOR_CONFIG.trail, ...(raw.trail ?? {}) },
    clickLeft: { ...DEFAULT_CURSOR_CONFIG.clickLeft, ...(raw.clickLeft ?? {}) },
    clickRight: { ...DEFAULT_CURSOR_CONFIG.clickRight, ...(raw.clickRight ?? {}) },
  }
}

function getAll(): AppSettings {
  const raw = readRaw()
  const base: AppSettings = {
    theme: 'dark',
    recordingsDir: defaultRecordingsDir(),
    defaultMode: 'fullscreen',
    defaultFps: 30,
    defaultResolution: 'source',
    defaultFormat: 'mp4',
    systemAudioDefault: true,
    micDefault: false,
    countdownSec: 3,
    cursorConfig: DEFAULT_CURSOR_CONFIG,
    hardwareEncoding: 'auto',
    launchOnStartup: false,
    minimizeToTrayOnClose: false,
  }
  const settings: AppSettings = {
    theme: (raw.theme as AppSettings['theme']) ?? base.theme,
    recordingsDir: raw.recordingsDir || base.recordingsDir,
    defaultMode: (raw.defaultMode as AppSettings['defaultMode']) ?? base.defaultMode,
    defaultFps: (Number(raw.defaultFps) as AppSettings['defaultFps']) || base.defaultFps,
    defaultResolution:
      (raw.defaultResolution as AppSettings['defaultResolution']) ?? base.defaultResolution,
    defaultFormat: 'mp4',
    systemAudioDefault: raw.systemAudioDefault !== 'false',
    micDefault: raw.micDefault === 'true',
    countdownSec: raw.countdownSec !== undefined ? Math.max(0, Math.min(10, Number(raw.countdownSec) || 0)) : base.countdownSec,
    cursorConfig: normalizeCursorConfig(parseJson<Partial<CursorConfig>>(raw.cursorConfig, {})),
    hardwareEncoding: (raw.hardwareEncoding as AppSettings['hardwareEncoding']) ?? base.hardwareEncoding,
    launchOnStartup: raw.launchOnStartup === 'true',
    minimizeToTrayOnClose: raw.minimizeToTrayOnClose === 'true',
  }
  return settings
}

function applyLoginItem(launch: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: launch, path: process.execPath })
  } catch {
    /* best effort — some platforms reject this */
  }
}

export const settingsStore = {
  getAll(): AppSettings {
    if (!cached) cached = getAll()
    return cached
  },

  set(patch: Record<string, unknown>): AppSettings {
    const current = this.getAll()
    for (const [key, value] of Object.entries(patch)) {
      switch (key) {
        case 'cursorConfig': {
          const merged = normalizeCursorConfig({
            ...current.cursorConfig,
            ...(value as Partial<CursorConfig>),
          })
          db.setSettingRaw('cursorConfig', JSON.stringify(merged))
          break
        }
        case 'recordingsDir': {
          if (typeof value === 'string' && value.trim()) {
            db.setSettingRaw('recordingsDir', value.trim())
          }
          break
        }
        case 'defaultFps': {
          const fps = Number(value)
          if (fps === 24 || fps === 30 || fps === 60) db.setSettingRaw('defaultFps', String(fps))
          break
        }
        case 'countdownSec': {
          const n = Math.max(0, Math.min(10, Math.round(Number(value) || 0)))
          db.setSettingRaw('countdownSec', String(n))
          break
        }
        case 'launchOnStartup': {
          const on = value === true
          db.setSettingRaw('launchOnStartup', on ? 'true' : 'false')
          applyLoginItem(on)
          break
        }
        case 'theme':
        case 'defaultMode':
        case 'defaultResolution':
        case 'hardwareEncoding': {
          if (typeof value === 'string' && value) db.setSettingRaw(key, value)
          break
        }
        case 'systemAudioDefault':
        case 'micDefault':
        case 'minimizeToTrayOnClose': {
          db.setSettingRaw(key, value === true ? 'true' : 'false')
          break
        }
        default:
          // Unknown keys are stored raw (forward compatibility).
          if (value !== undefined && value !== null) {
            db.setSettingRaw(key, typeof value === 'string' ? value : JSON.stringify(value))
          }
      }
    }
    cached = getAll()
    return cached
  },

  ensureRecordingsDir(): string {
    const dir = this.getAll().recordingsDir
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.mkdirSync(path.join(dir, '.trash'), { recursive: true })
    } catch {
      /* surfaces later on write */
    }
    return dir
  },

  /** Invalidate the in-process cache (used after direct DB writes in tests). */
  invalidate(): void {
    cached = null
  },
}

export function initSettings(): void {
  cached = getAll()
  applyLoginItem(cached.launchOnStartup)
}
