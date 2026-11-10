/**
 * ScreenForge Studio — Electron main process entry.
 *
 * Security posture: contextIsolation ON, nodeIntegration OFF, sandbox off
 * (required by better-sqlite3 / native addons in main only — the renderer has
 * no Node access), all IPC validated through zod schemas, no unrestricted
 * fs/shell surface exposed to the renderer.
 */
import { app, Menu } from 'electron'
import path from 'node:path'

import { db } from './database'
import { initSettings, settingsStore } from './settings/store'
import { createMainWindow, getMainWindow } from './windows/main-window'
import {
  closeAnnotationOverlays,
  closeFloatingToolbar,
} from './windows/overlay-windows'
import { handleRecfileRequests, registerRecfileProtocol } from './windows/recfile-protocol'
import { registerMainHandlers } from './ipc/handlers'
import { registerExportHandlers } from './ipc/handlers-export'
import { broadcast } from './ipc/registry'
import { sessionManager } from './recording/session-manager'
import { destroyAgentWindow } from './windows/capture-agent'

// Single instance lock — a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  // Privileged scheme must be registered before app ready.
  registerRecfileProtocol()

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)

    // Database + settings.
    db.init(path.join(app.getPath('userData'), 'screenforge.db'))
    initSettings()
    settingsStore.ensureRecordingsDir()

    // Local media protocol for <video> playback of recordings.
    handleRecfileRequests()

    // IPC surface.
    registerMainHandlers()
    registerExportHandlers()

    // Main window.
    createMainWindow()

    app.on('activate', () => {
      if (!getMainWindow()) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', (event) => {
    // Graceful shutdown: never tear down mid-recording without stopping it.
    const state = sessionManager.getState()
    if (state === 'recording' || state === 'paused') {
      event.preventDefault()
      void sessionManager.stop().then(() => {
        cleanupAndQuit()
        app.exit(0)
      })
      return
    }
    cleanupAndQuit()
  })

  function cleanupAndQuit(): void {
    closeAnnotationOverlays()
    closeFloatingToolbar()
    destroyAgentWindow()
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }

  // Process guards — surface errors instead of dying silently.
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[uncaughtException]', err)
    broadcast('evt:app-error', { scope: 'main', message: err.message, severity: 'error' })
  })
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[unhandledRejection]', reason)
    broadcast('evt:app-error', {
      scope: 'main',
      message: reason instanceof Error ? reason.message : String(reason),
      severity: 'error',
    })
  })
}

export { app as _app }
