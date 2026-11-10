/**
 * Main-process IPC handlers (recorder, system, library, projects, settings).
 *
 * Export/editor handlers live in handlers-export.ts. Every handler is
 * registered through the validating wrapper in registry.ts.
 */
import { BrowserWindow, dialog, ipcMain, screen, shell, desktopCapturer } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { db } from '../database'
import { getFfmpegPath } from '../ffmpeg/locate'
import { handle, broadcast } from './registry'
import { recordingConfigSchema, settingsPatchSchema } from '../../shared/ipc'
import type { RecordingMeta, StorageInfo } from '../../shared/types'
import { sessionManager } from '../recording/session-manager'
import { getCursorBackend } from '../cursor/cursor-recorder'
import { registerAnnotationHandlers } from '../annotation/annotation-service'
import { settingsStore } from '../settings/store'
import { getDisplays } from '../windows/display-utils'
import { openRegionSelector } from '../windows/overlay-windows'
import { detectHwEncoders } from '../ffmpeg/locate'
import { isWgcAvailable } from '../capture/wgc-native'

let cachedVersion: Awaited<ReturnType<typeof buildVersionInfo>> | null = null

async function buildVersionInfo() {
  const { app } = await import('electron')
  let hwEncoders: string[] = []
  try {
    hwEncoders =
      settingsStore.getAll().hardwareEncoding === 'auto' ? await detectHwEncoders() : []
  } catch {
    hwEncoders = []
  }
  let ffmpegPath = ''
  try {
    ffmpegPath = getFfmpegPath()
  } catch {
    ffmpegPath = 'not found'
  }
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: `${process.platform} ${process.arch}`,
    captureBackend: isWgcAvailable() ? ('wgc-native' as const) : ('desktop-capturer' as const),
    cursorBackend: getCursorBackend(),
    ffmpegPath,
    hwEncoders,
  }
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function dirSize(dir: string): Promise<number> {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const p = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(p)
      else {
        try {
          total += (await fsp.stat(p)).size
        } catch {
          /* file vanished */
        }
      }
    }
  }
  return total
}

async function getStorageInfo(): Promise<StorageInfo> {
  const recordingsDir = settingsStore.ensureRecordingsDir()
  const [recordingsBytes, exportsBytes, tempBytes, fsStats] = await Promise.all([
    dirSize(recordingsDir),
    dirSize(path.join(recordingsDir, 'exports')),
    dirSize(path.join(recordingsDir, '.trash')),
    fsp.statfs(recordingsDir).catch(() => null),
  ])
  return {
    recordingsDir,
    recordingsBytes,
    exportsBytes,
    tempBytes,
    freeBytes: fsStats ? fsStats.bsize * fsStats.bavail : 0,
    totalBytes: fsStats ? fsStats.bsize * fsStats.blocks : 0,
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMainHandlers(): void {
  // -- app / window / shell ---------------------------------------------------

  handle('app:getVersion', z.undefined(), async () => {
    if (!cachedVersion) cachedVersion = await buildVersionInfo()
    return cachedVersion
  })

  handle('window:minimize', z.undefined(), (_payload, event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  handle('window:maximizeToggle', z.undefined(), (_payload, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  handle('window:close', z.undefined(), (_payload, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (settingsStore.getAll().minimizeToTrayOnClose && win === BrowserWindow.getAllWindows()[0]) {
      win.hide()
    } else {
      win.close()
    }
  })

  handle('shell:revealPath', z.object({ path: z.string() }), (payload) => {
    if (!path.isAbsolute(payload.path)) return
    shell.showItemInFolder(payload.path)
  })

  handle('shell:openPath', z.object({ path: z.string() }), async (payload) => {
    if (!path.isAbsolute(payload.path)) return
    await shell.openPath(payload.path)
  })

  handle('dialog:chooseDirectory', z.object({ title: z.string() }), async (payload, event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: payload.title,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  handle(
    'dialog:chooseFile',
    z.object({
      title: z.string(),
      filters: z.array(z.object({ name: z.string(), extensions: z.array(z.string()) })),
    }),
    async (payload, event) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const result = await dialog.showOpenDialog(win!, {
        title: payload.title,
        filters: payload.filters,
        properties: ['openFile'],
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
  )

  // -- sources ---------------------------------------------------------------

  handle('displays:list', z.undefined(), () => getDisplays())

  handle('windows:list', z.undefined(), async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    })
    const primary = screen.getPrimaryDisplay()
    return sources
      .filter((s) => s.name.trim().length > 0)
      .map((s) => ({
        id: s.id,
        title: s.name,
        appName: s.name.split(' - ')[0] || s.name,
        thumbnailDataUrl: s.thumbnail.toDataURL(),
        displayId: primary.id,
      }))
  })

  handle('audio:listDevices', z.undefined(), async () => {
    const devices: Array<{ id: string; name: string; kind: 'microphone' | 'system'; isDefault: boolean }> = [
      { id: 'default', name: 'System Default Microphone', kind: 'microphone', isDefault: true },
    ]
    // Enumerate native WASAPI input devices when the addon is present.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { loadNativeAddon } = require('../native/loader') as typeof import('../native/loader')
      const wasapi = loadNativeAddon('wasapi_capture') as
        | { listDevices?: () => Array<{ id: string; name: string; kind: string; isDefault: boolean }> }
        | null
      if (wasapi?.listDevices) {
        for (const d of wasapi.listDevices()) {
          if (d.kind === 'capture') {
            devices.push({ id: d.id, name: d.name, kind: 'microphone', isDefault: d.isDefault })
          }
        }
      }
    } catch {
      /* native path unavailable — default device only */
    }
    return devices
  })

  // -- recorder ---------------------------------------------------------------

  handle('recorder:start', recordingConfigSchema, (payload) => sessionManager.start(payload))
  handle('recorder:pause', z.undefined(), () => sessionManager.pause())
  handle('recorder:resume', z.undefined(), () => sessionManager.resume())
  handle('recorder:stop', z.undefined(), () => sessionManager.stop())
  handle('recorder:cancel', z.undefined(), () => sessionManager.cancel())
  handle('recorder:getState', z.undefined(), () => sessionManager.getState())

  handle(
    'recorder:selectRegion',
    z.object({ displayId: z.number().int() }),
    async (payload) => {
      const rect = await openRegionSelector(payload.displayId)
      broadcast('evt:region-selected', { displayId: payload.displayId, rect })
      return rect
    },
  )

  // The region-selector overlay resolves its parent await directly.
  ipcMain.on('region-selector:result', () => {
    /* consumed by overlay-windows.ts — no-op here to keep the listener alive */
  })

  // -- library ------------------------------------------------------------------

  handle('library:list', z.undefined(), () =>
    db.listRecordings().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  )

  handle('library:get', z.object({ id: z.string().min(1) }), (payload) =>
    db.getRecording(payload.id),
  )

  handle('library:delete', z.object({ id: z.string().min(1) }), (payload) => {
    const meta = db.getRecording(payload.id)
    db.deleteRecording(payload.id)
    if (meta) {
      // Files live inside the session dir; removing it clears video + sidecars.
      const sessionDir = path.dirname(meta.videoPath)
      if (fs.existsSync(sessionDir)) {
        void fsp.rm(sessionDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    broadcast('evt:recordings-changed', undefined)
    return undefined
  })

  handle('library:rename', z.object({ id: z.string().min(1), title: z.string().min(1).max(200) }), (payload) => {
    db.renameRecording(payload.id, payload.title)
    broadcast('evt:recordings-changed', undefined)
    return undefined
  })

  handle('library:storage', z.undefined(), () => getStorageInfo())

  // -- projects -------------------------------------------------------------------

  handle('projects:list', z.undefined(), () => db.listProjects())

  handle('projects:get', z.object({ id: z.string().min(1) }), (payload) => db.getProject(payload.id))

  handle('projects:save', z.object({ project: z.any() }), (payload) =>
    db.upsertProject(payload.project),
  )

  handle('projects:delete', z.object({ id: z.string().min(1) }), (payload) => {
    db.deleteProject(payload.id)
    broadcast('evt:recordings-changed', undefined)
    return undefined
  })

  // -- settings ---------------------------------------------------------------------

  handle('settings:get', z.undefined(), () => settingsStore.getAll())

  handle('settings:set', settingsPatchSchema, (payload) => settingsStore.set(payload.patch))

  // Expose RecordingMeta type usage for listeners (kept here to satisfy imports).
  void (() => null as unknown as RecordingMeta)()

  registerAnnotationHandlers()
}
