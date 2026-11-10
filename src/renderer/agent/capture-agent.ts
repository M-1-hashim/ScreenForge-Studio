/**
 * Hidden capture agent.
 *
 * Runs inside a hidden Electron window. Performs getUserMedia against a
 * desktop source id (screen/window) plus optional system-audio loopback and
 * microphone capture, and streams MediaRecorder chunks to the main process.
 *
 * Command flow: main -> here via window.screenforge.agent.onStart/onStop/...
 * Data flow:    here -> main via window.screenforge.agent.sendChunk / ackStart / ackStop.
 */

let videoRecorder: MediaRecorder | null = null
let micRecorder: MediaRecorder | null = null
let systemRecorder: MediaRecorder | null = null
let videoStream: MediaStream | null = null
let micStream: MediaStream | null = null
let systemStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let seq = 0
let chunkSeqs = { video: 0, mic: 0, system: 0 }
let micLevelTimer: number | null = null
let stopping = false

const videoChunks = new WeakMap<BlobEvent, number>()

function pickVideoMime(): string {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

function pickAudioMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm']
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

function reset(): void {
  videoRecorder = null
  micRecorder = null
  systemRecorder = null
  if (micLevelTimer !== null) {
    clearInterval(micLevelTimer)
    micLevelTimer = null
  }
  if (audioContext) {
    void audioContext.close().catch(() => undefined)
    audioContext = null
  }
  for (const s of [videoStream, micStream, systemStream]) {
    s?.getTracks().forEach((t) => t.stop())
  }
  videoStream = micStream = systemStream = null
  chunkSeqs = { video: 0, mic: 0, system: 0 }
  seq = 0
  stopping = false
}

async function start(payload: {
  sourceId: string
  fps: number
  video: boolean
  mic: { deviceId?: string; enabled: boolean }
  system: { enabled: boolean }
}): Promise<string | null> {
  try {
    reset()

    // --- screen/window video --------------------------------------------------
    if (payload.video) {
      videoStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: payload.sourceId,
            maxFrameRate: payload.fps,
            maxWidth: 99999,
            maxHeight: 99999,
          },
        } as MediaTrackConstraints,
      })
    }

    // --- system audio loopback (Windows Chromium supports this via desktop source)
    if (payload.system.enabled) {
      try {
        systemStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: payload.sourceId,
            },
          } as MediaTrackConstraints,
          video: false,
        })
      } catch {
        systemStream = null // loopback unsupported — main reports gracefully
      }
    }

    // --- microphone -------------------------------------------------------------
    if (payload.mic.enabled) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(payload.mic.deviceId && payload.mic.deviceId !== 'default'
              ? { deviceId: { exact: payload.mic.deviceId } }
              : {}),
            echoCancellation: false,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })
      } catch {
        micStream = null
      }
    }

    // --- mic level meter ---------------------------------------------------------
    if (micStream && micStream.getAudioTracks().length > 0) {
      try {
        audioContext = new AudioContext()
        const source = audioContext.createMediaStreamSource(micStream)
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        const data = new Float32Array(analyser.fftSize)
        micLevelTimer = window.setInterval(() => {
          if (!analyser) return
          analyser.getFloatTimeDomainData(data)
          let sum = 0
          for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
          const rms = Math.sqrt(sum / data.length)
          void window.screenforge.agent.sendMicLevel(Math.min(1, rms * 4))
        }, 100)
      } catch {
        /* meter is best-effort */
      }
    }

    // --- recorders ------------------------------------------------------------------
    const chunkMs = 1000

    const wire = (recorder: MediaRecorder, stream: 'video' | 'mic' | 'system'): void => {
      recorder.ondataavailable = (ev: BlobEvent) => {
        if (!ev.data || ev.data.size === 0) return
        ev.data
          .arrayBuffer()
          .then((buf) => window.screenforge.agent.sendChunk(stream, buf, chunkSeqs[stream]++))
          .catch(() => undefined)
      }
      recorder.onerror = () => {
        void window.screenforge.agent.sendError(`${stream} recorder error`)
      }
    }

    if (videoStream) {
      const mimeType = pickVideoMime()
      videoRecorder = new MediaRecorder(videoStream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: Math.min(24_000_000, Math.max(4_000_000, payload.fps * 350_000)),
      })
      wire(videoRecorder, 'video')
      videoRecorder.start(chunkMs)
    } else {
      return 'no video stream could be captured'
    }

    if (systemStream && systemStream.getAudioTracks().length > 0) {
      systemRecorder = new MediaRecorder(systemStream, { ...(pickAudioMime() ? { mimeType: pickAudioMime() } : {}) })
      wire(systemRecorder, 'system')
      systemRecorder.start(chunkMs)
    }

    if (micStream && micStream.getAudioTracks().length > 0) {
      micRecorder = new MediaRecorder(micStream, { ...(pickAudioMime() ? { mimeType: pickAudioMime() } : {}) })
      wire(micRecorder, 'mic')
      micRecorder.start(chunkMs)
    }

    return null // success
  } catch (err) {
    reset()
    return err instanceof Error ? err.message : String(err)
  }
}

function stopAll(): Promise<void> {
  stopping = true
  const done = Promise.all(
    [videoRecorder, micRecorder, systemRecorder].map(
      (rec) =>
        new Promise<void>((resolve) => {
          if (!rec || rec.state === 'inactive') {
            resolve()
            return
          }
          const finish = () => resolve()
          rec.onstop = finish
          try {
            rec.requestData()
            rec.stop()
          } catch {
            finish()
          }
          setTimeout(finish, 2000)
        }),
    ),
  )
  return done.then(() => {
    // Slight delay so trailing chunks flush through IPC.
    setTimeout(() => reset(), 150)
  })
}

// --- command wiring ----------------------------------------------------------

window.screenforge.agent.onStart(async (payload) => {
  const error = await start(payload)
  window.screenforge.agent.ackStart(error)
})
window.screenforge.agent.onStop(() => {
  void stopAll().then(() => window.screenforge.agent.ackStop())
})
window.screenforge.agent.onPause(() => {
  for (const rec of [videoRecorder, micRecorder, systemRecorder]) {
    if (rec && rec.state === 'recording') rec.pause()
  }
})
window.screenforge.agent.onResume(() => {
  for (const rec of [videoRecorder, micRecorder, systemRecorder]) {
    if (rec && rec.state === 'paused') rec.resume()
  }
})
window.screenforge.agent.onMicToggle((_enabled) => {
  // Live mic re-enable mid-recording is a documented v1 gap — it requires a
  // session restart. The toolbar reflects the change on the next session.
})

export {}
