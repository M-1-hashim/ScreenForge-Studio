/**
 * Overlay & helper windows: region selector, annotation overlays, floating
 * recording toolbar, countdown. All helper windows share the same preload and
 * strict webPreferences as the main window.
 *
 * Capture-exclusion note: when the native cursor_hook addon is available the
 * toolbar/overlay windows are excluded from the captured video via
 * SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE). Without the addon they may
 * appear in full-screen captures — documented limitation.
 */
import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { ipcMain } from 'electron'
import type { DisplayInfo, Rect } from '../../shared/types'
import { physicalRectToDipRect, virtualOrigin, getDisplays } from './display-utils'
import { pageUrl, rendererBaseUrl } from './main-window'
import { loadNativeAddon } from '../native/loader'

const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'index.js')

const regionSelectors = new Map<number, BrowserWindow>()
const annotationOverlays = new Map<number, BrowserWindow>()
let floatingToolbar: BrowserWindow | null = null

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function helperWebPreferences() {
  return {
    preload: PRELOAD_PATH,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
  }
}

/** Ask the native addon (if present) to hide a window from screen capture. */
export function applyCaptureExclusion(win: BrowserWindow): void {
  try {
    const addon = loadNativeAddon('cursor_hook') as
      | { excludeWindowFromCapture?: (hwnd: Buffer) => boolean }
      | null
    if (addon?.excludeWindowFromCapture) {
      addon.excludeWindowFromCapture(win.getNativeWindowHandle())
    }
  } catch {
    /* non-fatal */
  }
}

function fullscreenWindowForDisplay(display: DisplayInfo, opts: { transparent: boolean; focusable: boolean }): BrowserWindow {
  const [x, y] = [display.bounds.x, display.bounds.y]
  const win = new BrowserWindow({
    x,
    y,
    width: display.bounds.width,
    height: display.bounds.height,
    fullscreen: false,
    frame: false,
    transparent: opts.transparent,
    resizable: false,
    movable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: opts.focusable,
    hasShadow: false,
    enableLargerThanScreen: true,
    backgroundColor: opts.transparent ? '#00000000' : undefined,
    webPreferences: helperWebPreferences(),
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  return win
}

// ---------------------------------------------------------------------------
// Region selector
// ---------------------------------------------------------------------------

/** Opens the crosshair region selector on `displayId`; resolves with a display-local PHYSICAL rect or null. */
export function openRegionSelector(displayId: number): Promise<Rect | null> {
  return new Promise((resolve) => {
    const displays = getDisplays()
    const display =
      displays.find((d) => d.id === displayId) ??
      displays.find((d) => d.isPrimary) ??
      displays[0]
    if (!display) {
      resolve(null)
      return
    }
    const existing = regionSelectors.get(displayId)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      resolve(null)
      return
    }

    let settled = false
    const finish = (rect: Rect | null) => {
      if (settled) return
      settled = true
      ipcMain.removeListener('region-selector:result', onResult)
      regionSelectors.delete(displayId)
      resolve(rect)
    }

    const onResult = (_event: unknown, payload: { result: Rect | null }) => {
      finish(payload?.result ?? null)
      if (win && !win.isDestroyed()) win.close()
    }
    ipcMain.on('region-selector:result', onResult)

    const origin = virtualOrigin()
    const scaleFactor = display.scaleFactor

    const win = fullscreenWindowForDisplay(display, { transparent: true, focusable: true })
    regionSelectors.set(displayId, win)

    win.on('closed', () => finish(null))
    applyCaptureExclusion(win)

    const query = new URLSearchParams({
      displayId: String(displayId),
      scaleFactor: String(scaleFactor),
      originX: String(origin.x),
      originY: String(origin.y),
    })
    void win.loadURL(pageUrl('region.html', query.toString()))
    win.show()
    win.focus()
    void scaleFactor
  })
}

// ---------------------------------------------------------------------------
// Annotation overlays
// ---------------------------------------------------------------------------

export function openAnnotationOverlays(recordingId: string, displays: DisplayInfo[]): void {
  closeAnnotationOverlays()
  for (const display of displays) {
    const win = fullscreenWindowForDisplay(display, { transparent: true, focusable: false })
    win.setIgnoreMouseEvents(true, { forward: true })
    applyCaptureExclusion(win)
    annotationOverlays.set(display.id, win)

    const query = new URLSearchParams({
      recordingId,
      displayId: String(display.id),
      scaleFactor: String(display.scaleFactor),
      width: String(display.physicalBounds.width),
      height: String(display.physicalBounds.height),
    })
    win.on('closed', () => annotationOverlays.delete(display.id))
    void win.loadURL(pageUrl('annotation.html', query.toString()))
    win.showInactive()
  }
}

export function setOverlayMouseMode(enabled: boolean): void {
  for (const win of annotationOverlays.values()) {
    if (win.isDestroyed()) continue
    win.setIgnoreMouseEvents(!enabled, { forward: true })
    win.setFocusable(enabled)
  }
}

export function broadcastToOverlays(channel: string, payload: unknown): void {
  for (const win of annotationOverlays.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function closeAnnotationOverlays(): void {
  for (const [id, win] of annotationOverlays) {
    if (!win.isDestroyed()) win.close()
    annotationOverlays.delete(id)
  }
}

export function hasAnnotationOverlays(): boolean {
  return annotationOverlays.size > 0
}

// ---------------------------------------------------------------------------
// Floating recording toolbar
// ---------------------------------------------------------------------------

export function openFloatingToolbar(display: DisplayInfo): void {
  closeFloatingToolbar()
  const width = 460
  const height = 72
  const work = display.workArea
  const x = Math.round(work.x + (work.width - width) / 2)
  const y = Math.round(work.y + work.height - height - 24)

  floatingToolbar = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: helperWebPreferences(),
  })
  floatingToolbar.setAlwaysOnTop(true, 'screen-saver')
  applyCaptureExclusion(floatingToolbar)
  floatingToolbar.on('closed', () => {
    floatingToolbar = null
  })
  void floatingToolbar.loadURL(pageUrl('toolbar.html'))
  floatingToolbar.once('ready-to-show', () => {
    floatingToolbar?.showInactive()
  })
}

export function closeFloatingToolbar(): void {
  if (floatingToolbar && !floatingToolbar.isDestroyed()) floatingToolbar.close()
  floatingToolbar = null
}

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

export function openCountdown(display: DisplayInfo, seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const win = fullscreenWindowForDisplay(display, { transparent: true, focusable: false })
    applyCaptureExclusion(win)
    const query = new URLSearchParams({ countdown: String(seconds) })
    win.on('closed', () => resolve())
    void win.loadURL(pageUrl('countdown.html', query.toString()))
    win.showInactive()
    // Safety: never block recording longer than countdown + 5s.
    setTimeout(() => {
      if (!win.isDestroyed()) win.close()
    }, (seconds + 5) * 1000)
  })
}

// Re-export for convenience of consumers.
export { physicalRectToDipRect, rendererBaseUrl }
