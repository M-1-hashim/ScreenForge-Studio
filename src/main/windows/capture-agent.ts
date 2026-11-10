/**
 * Hidden capture-agent window.
 *
 * A permanently-hidden renderer that performs the actual getUserMedia /
 * MediaRecorder work for the desktopCapturer backend (the agent page lives at
 * src/renderer/agent.html). Creating it lazily keeps app startup fast.
 */
import { BrowserWindow } from 'electron'
import path from 'node:path'
import { pageUrl } from './main-window'

let agentWindow: BrowserWindow | null = null

export function getOrCreateAgentWindow(): BrowserWindow {
  if (agentWindow && !agentWindow.isDestroyed()) return agentWindow

  agentWindow = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  agentWindow.setSkipTaskbar(true)
  void agentWindow.loadURL(pageUrl('agent.html'))
  return agentWindow
}

export function destroyAgentWindow(): void {
  if (agentWindow && !agentWindow.isDestroyed()) agentWindow.destroy()
  agentWindow = null
}
