/**
 * Floating recording toolbar: timer, pause/resume, stop, draw toggle, mic level.
 */

const dot = document.getElementById('dot') as HTMLDivElement
const timerEl = document.getElementById('timer') as HTMLDivElement
const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement
const drawBtn = document.getElementById('drawBtn') as HTMLButtonElement
const micFill = document.getElementById('micfill') as HTMLDivElement

let state = 'recording'
let elapsedMs = 0
let drawOn = false

function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms))
  const m = Math.floor(total / 60000)
  const s = Math.floor((total % 60000) / 1000)
  const d = Math.floor((total % 1000) / 100)
  return `${m}:${String(s).padStart(2, '0')}.${d}`
}

function renderState(): void {
  dot.classList.toggle('paused', state !== 'recording')
  timerEl.textContent = fmt(elapsedMs)
  pauseBtn.textContent = state === 'paused' ? '▶' : '⏸'
  pauseBtn.title = state === 'paused' ? 'Resume recording' : 'Pause recording'
  drawBtn.classList.toggle('active', drawOn)
}

pauseBtn.addEventListener('click', () => {
  if (state === 'recording') void window.screenforge.recorder.pause()
  else if (state === 'paused') void window.screenforge.recorder.resume()
})

stopBtn.addEventListener('click', () => {
  void window.screenforge.recorder.stop()
})

drawBtn.addEventListener('click', () => {
  drawOn = !drawOn
  renderState()
  void window.screenforge.annotation.setMode(drawOn)
})

document.getElementById('hideBtn')?.addEventListener('click', () => {
  // Minimize the toolbar out of the way (documented: reopen via main window).
  window.close()
})

// --- events --------------------------------------------------------------------

window.screenforge.events.on('evt:tick', (t) => {
  elapsedMs = t.elapsedMs
  state = t.state
  renderState()
})

window.screenforge.events.on('evt:recorder-state', (s) => {
  state = s
  if (s === 'idle' || s === 'processing' || s === 'stopping') {
    window.close()
    return
  }
  renderState()
})

window.screenforge.events.on('evt:mic-level', (level) => {
  micFill.style.width = `${Math.round(Math.min(1, level) * 100)}%`
})

renderState()
export {}
