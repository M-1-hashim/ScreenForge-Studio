/**
 * IPC registration with input validation.
 *
 * Every invoke handler MUST be registered through `handle()` so payloads are
 * validated against the shared zod schemas before any main-process code runs.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { z } from 'zod'
import type { EventChannel, EventContract, InvokeChannel, InvokeRequest, InvokeResponse } from '../../shared/ipc'

type IpcError = Error & { code?: string }

export function handle<C extends InvokeChannel>(
  channel: C,
  schema: z.ZodTypeAny | undefined,
  fn: (payload: InvokeRequest<C>, event: IpcMainInvokeEvent) => Promise<InvokeResponse<C>> | InvokeResponse<C>,
): void {
  ipcMain.handle(channel, async (event, rawPayload: unknown) => {
    try {
      const payload = (schema ? schema.parse(rawPayload) : rawPayload) as InvokeRequest<C>
      return await fn(payload, event)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[ipc:${channel}]`, message)
      const e: IpcError = new Error(message)
      e.code = 'SCREENFORGE_IPC_ERROR'
      throw e
    }
  })
}

/** Push an event to every live renderer window (main, toolbar, overlays). */
export function broadcast<C extends EventChannel>(channel: C, payload: EventContract[C]): void {
  const { BrowserWindow } = require('electron') as typeof import('electron')
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
