/**
 * desktopCapturer capture backend.
 *
 * Drives the hidden capture-agent renderer window, which runs getUserMedia
 * (screen source) + MediaRecorder (VP8/Opus) and streams chunked output back
 * over IPC. Main process writes chunks to disk in order, per stream.
 *
 * Command flow (main -> agent):  webContents.send(CAPTURE_AGENT_CHANNELS.*)
 * Data flow   (agent -> main):   ipcRenderer.invoke on agent:* channels.
 *
 * This is the universal fallback backend — it works everywhere and needs no
 * native modules. The native WGC backend is preferred on Windows when present.
 */
import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { StartCaptureOptions, VideoCaptureSession } from './capture-types'
import { CAPTURE_AGENT_CHANNELS } from '../../shared/ipc'
import type { AgentStartPayload } from '../../shared/ipc'
import { broadcast } from '../ipc/registry'

interface OrderedStreamWriter {
  path: string
  fd: number
  pending: Map<number, Buffer>
  nextSeq: number
}

function createOrderedWriter(filePath: string): OrderedStreamWriter {
  return {
    path: filePath,
    fd: fs.openSync(filePath, 'wb'),
    pending: new Map(),
    nextSeq: 0,
  }
}

/** Writes chunks strictly in sequence order, buffering any gaps. */
function writeOrdered(writer: OrderedStreamWriter, seq: number, chunk: Buffer): void {
  if (seq < writer.nextSeq) return
  writer.pending.set(seq, chunk)
  while (writer.pending.has(writer.nextSeq)) {
    const buf = writer.pending.get(writer.nextSeq)!
    writer.pending.delete(writer.nextSeq)
    fs.writeSync(writer.fd, buf)
    writer.nextSeq++
  }
}

function closeWriter(writer: OrderedStreamWriter): Promise<void> {
  return new Promise((resolve, reject) => {
    // Flush orphaned out-of-order chunks (should not happen; harmless).
    const rest = [...writer.pending.keys()].sort((a, b) => a - b)
    for (const seq of rest) {
      try {
        fs.writeSync(writer.fd, writer.pending.get(seq)!)
      } catch {
        /* best effort */
      }
    }
    writer.pending.clear()
    fs.close(writer.fd, (err) => (err ? reject(err) : resolve()))
  })
}

export async function startDesktopCapturerCapture(
  opts: StartCaptureOptions,
): Promise<VideoCaptureSession> {
  const { agentWindow, sourceId, fps, outDir } = opts

  const videoPath = path.join(outDir, 'source-video.webm')
  const micPath = path.join(outDir, 'audio-mic.webm')
  const systemPath = path.join(outDir, 'audio-system.webm')

  const writers: Record<string, OrderedStreamWriter> = {
    video: createOrderedWriter(videoPath),
  }
  if (opts.includeMic) writers.mic = createOrderedWriter(micPath)
  if (opts.includeSystemAudio) writers.system = createOrderedWriter(systemPath)

  let agentError: Error | null = null
  let lastMicEmit = 0

  const isAgent = (senderId: number): boolean => senderId === agentWindow.webContents.id

  // -- data listeners (agent -> main) -----------------------------------------

  const onChunk = (
    event: Electron.IpcMainInvokeEvent,
    payload: { stream: string; chunk: ArrayBuffer; seq: number },
  ): void => {
    if (!isAgent(event.sender.id)) return
    const writer = writers[payload.stream]
    if (!writer) return
    try {
      writeOrdered(writer, payload.seq, Buffer.from(payload.chunk))
    } catch (err) {
      agentError = err instanceof Error ? err : new Error(String(err))
    }
  }

  const onMicLevel = (event: Electron.IpcMainInvokeEvent, level: number): void => {
    if (!isAgent(event.sender.id)) return
    const now = Date.now()
    if (now - lastMicEmit < 100) return
    lastMicEmit = now
    broadcast('evt:mic-level', Math.max(0, Math.min(1, level)))
  }

  const onAgentError = (event: Electron.IpcMainInvokeEvent, message: string): void => {
    if (!isAgent(event.sender.id)) return
    agentError = new Error(`capture agent: ${message}`)
  }

  const startAckChannel = `${CAPTURE_AGENT_CHANNELS.start}:ack`
  const stopAckChannel = `${CAPTURE_AGENT_CHANNELS.stop}:ack`

  // Wrap invoke-style agent calls so handler registration is isolated.
  const agentInvoke = <T>(
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, payload: T) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, payload: T) => {
      try {
        return handler(event, payload)
      } finally {
        return undefined
      }
    })
  }

  agentInvoke<{ stream: string; chunk: ArrayBuffer; seq: number }>(
    CAPTURE_AGENT_CHANNELS.chunk,
    onChunk,
  )
  agentInvoke<number>(CAPTURE_AGENT_CHANNELS.micLevel, onMicLevel)
  agentInvoke<string>(CAPTURE_AGENT_CHANNELS.error, onAgentError)

  const cleanup = (): void => {
    for (const channel of [
      CAPTURE_AGENT_CHANNELS.chunk,
      CAPTURE_AGENT_CHANNELS.micLevel,
      CAPTURE_AGENT_CHANNELS.error,
    ]) {
      ipcMain.removeHandler(channel)
    }
  }

  // -- start handshake ---------------------------------------------------------

  const payload: AgentStartPayload = {
    sourceId,
    fps,
    video: true,
    mic: { deviceId: opts.micDeviceId, enabled: opts.includeMic },
    system: { enabled: opts.includeSystemAudio },
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      settle(new Error('capture agent did not acknowledge start (timeout)'))
    }, 20000)

    const onAck = (event: Electron.IpcMainEvent, error: string | null): void => {
      if (!isAgent(event.sender.id)) return
      settle(error ? new Error(`capture agent: ${error}`) : undefined)
    }

    let settled = false
    function settle(err?: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      ipcMain.removeListener(startAckChannel, onAck)
      if (err) reject(err)
      else resolve()
    }

    ipcMain.on(startAckChannel, onAck)
    agentWindow.webContents.send(CAPTURE_AGENT_CHANNELS.start, payload)
  })

  // -- session handle ------------------------------------------------------------

  let stopping = false

  const session: VideoCaptureSession = {
    backend: 'desktop-capturer',
    width: 0, // session manager fills this after probing the file
    height: 0,
    actualFps: fps,

    pause(): void {
      if (!stopping) agentWindow.webContents.send(CAPTURE_AGENT_CHANNELS.pause)
    },

    resume(): void {
      if (!stopping) agentWindow.webContents.send(CAPTURE_AGENT_CHANNELS.resume)
    },

    setMicEnabled(enabled: boolean): void {
      // Documented v1 behavior: mic toggling mid-recording restarts the mic
      // recorder inside the agent (audio gap of a few ms is possible).
      agentWindow.webContents.send('agent:mic-toggle', { enabled })
    },

    async stop(): Promise<{ videoPath: string; micPath?: string; systemPath?: string }> {
      stopping = true
      await new Promise<void>((resolve) => {
        let settled = false
        const settle = (): void => {
          if (settled) return
          settled = true
          ipcMain.removeListener(stopAckChannel, onAck)
          clearTimeout(timer)
          resolve()
        }
        const onAck = (event: Electron.IpcMainEvent): void => {
          if (isAgent(event.sender.id)) settle()
        }
        const timer = setTimeout(settle, 6000) // agent dead or stuck — finalize anyway
        timer.unref?.()
        ipcMain.on(stopAckChannel, onAck)
        agentWindow.webContents.send(CAPTURE_AGENT_CHANNELS.stop)
      })

      cleanup()

      if (agentError) {
        broadcast('evt:app-error', {
          scope: 'recorder',
          message: agentError.message,
          severity: 'warning',
        })
      }

      await Promise.all(Object.values(writers).map((w) => closeWriter(w)))

      const validAudio = (p: string | undefined): string | undefined =>
        p && fs.existsSync(p) && fs.statSync(p).size > 1024 ? p : undefined

      return {
        videoPath,
        micPath: validAudio(opts.includeMic ? micPath : undefined),
        systemPath: validAudio(opts.includeSystemAudio ? systemPath : undefined),
      }
    },
  }

  return session
}

/** Resolve a desktopCapturer source id for a display (screen) or window. */
export async function resolveSourceId(
  kind: 'screen' | 'window',
  ref: { displayId?: number; windowId?: string },
): Promise<string | null> {
  const { desktopCapturer } = await import('electron')
  const sources = await desktopCapturer.getSources({
    types: [kind],
    thumbnailSize: { width: 1, height: 1 },
    fetchWindowIcons: false,
  })
  if (kind === 'window') {
    const found = sources.find((s) => s.id === ref.windowId)
    return found?.id ?? null
  }
  // For screens, Electron sets display_id on each source.
  const byDisplay = sources.find((s) => (s as unknown as { display_id?: string }).display_id === String(ref.displayId))
  return byDisplay?.id ?? sources[0]?.id ?? null
}
