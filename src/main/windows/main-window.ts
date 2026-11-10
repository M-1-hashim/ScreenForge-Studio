/**
 * Main application window (frameless, custom titlebar, secure webPreferences).
 */
import { BrowserWindow, shell } from 'electron'
import path from 'node:path'

const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'index.js')

export function rendererBaseUrl(): string {
  if (process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL.endsWith('/')
      ? process.env.VITE_DEV_SERVER_URL.slice(0, -1)
      : process.env.VITE_DEV_SERVER_URL
  }
  // dist-electron/main -> dist/renderer
  return 'file://' + path.join(__dirname, '..', '..', 'dist', 'renderer').replace(/\\/g, '/')
}

export function pageUrl(page: string, query = ''): string {
  const base = rendererBaseUrl()
  if (base.startsWith('http')) {
    return `${base}/${page}${query ? `?${query}` : ''}`
  }
  return `${base}/${page}${query ? `?${query}` : ''}`
}

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0e1116',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webviewTag: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Defensive: any window.open / target=_blank goes to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(pageUrl('index.html'))
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'))
  }

  return mainWindow
}
