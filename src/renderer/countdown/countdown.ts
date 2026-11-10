const numEl = document.getElementById('num') as HTMLDivElement

const seconds = Math.max(0, Number(new URLSearchParams(location.search).get('countdown') ?? '3') || 3)
let remaining = seconds

function tick(): void {
  if (remaining <= 0) {
    window.close()
    return
  }
  numEl.textContent = String(remaining)
  remaining--
  setTimeout(tick, 1000)
}

if (seconds <= 0) {
  window.close()
} else {
  tick()
}

export {}
