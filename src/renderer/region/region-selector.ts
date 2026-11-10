/**
 * Region selector overlay: drag to draw, Enter confirms, Esc cancels.
 * Coordinates reported to main are PHYSICAL px, local to this display.
 */
interface Params {
  scaleFactor: number
}

const params: Params = {
  scaleFactor: Number(new URLSearchParams(location.search).get('scaleFactor') ?? '1') || 1,
}

const sel = document.getElementById('sel') as HTMLDivElement
const sizeLabel = document.getElementById('size') as HTMLDivElement

let startX = 0
let startY = 0
let dragging = false
let rect = { x: 0, y: 0, width: 0, height: 0 }

function currentRect(clientX: number, clientY: number) {
  const x = Math.min(startX, clientX)
  const y = Math.min(startY, clientY)
  const width = Math.abs(clientX - startX)
  const height = Math.abs(clientY - startY)
  return { x, y, width, height }
}

function render(r: { x: number; y: number; width: number; height: number }): void {
  sel.style.display = 'block'
  sel.style.left = `${r.x}px`
  sel.style.top = `${r.y}px`
  sel.style.width = `${r.width}px`
  sel.style.height = `${r.height}px`
  const physW = Math.round(r.width * params.scaleFactor)
  const physH = Math.round(r.height * params.scaleFactor)
  sizeLabel.style.display = 'block'
  sizeLabel.textContent = `${physW} × ${physH}`
  sizeLabel.style.left = `${r.x}px`
  sizeLabel.style.top = `${Math.max(2, r.y - 26)}px`
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  dragging = true
  startX = e.clientX
  startY = e.clientY
  rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 }
})

window.addEventListener('mousemove', (e) => {
  if (!dragging) return
  rect = currentRect(e.clientX, e.clientY)
  render(rect)
})

window.addEventListener('mouseup', (e) => {
  if (!dragging || e.button !== 0) return
  dragging = false
  rect = currentRect(e.clientX, e.clientY)
  if (rect.width < 10 || rect.height < 10) {
    sel.style.display = 'none'
    sizeLabel.style.display = 'none'
    return
  }
  submit(rect)
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    void window.screenforge.recorder.submitRegionResult(null)
  } else if (e.key === 'Enter' && rect.width >= 10 && rect.height >= 10) {
    submit(rect)
  }
})

function submit(r: { x: number; y: number; width: number; height: number }): void {
  // DIP (window-local, matches display origin at 0,0) -> display-local physical px
  const physical = {
    x: Math.round(r.x * params.scaleFactor),
    y: Math.round(r.y * params.scaleFactor),
    width: Math.round(r.width * params.scaleFactor),
    height: Math.round(r.height * params.scaleFactor),
  }
  sel.style.display = 'none'
  sizeLabel.style.display = 'none'
  void window.screenforge.recorder.submitRegionResult(physical)
}

export {}
