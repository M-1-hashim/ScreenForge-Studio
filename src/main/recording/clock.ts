/**
 * Recording clock — tracks accumulated ACTIVE recording time across
 * pause/resume. All timestamped sidecars (cursor events, annotations) use
 * this clock so a 30s pause shifts subsequent timestamps by zero.
 */
export class RecordingClock {
  private accumulatedMs = 0
  private lastStart: number | null = null
  private running = false

  start(): void {
    if (this.running) return
    this.running = true
    this.lastStart = performance.now()
  }

  pause(): void {
    if (!this.running || this.lastStart === null) return
    this.accumulatedMs += performance.now() - this.lastStart
    this.lastStart = null
    this.running = false
  }

  resume(): void {
    this.start()
  }

  stop(): void {
    this.pause()
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Current active recording time in ms. */
  nowMs(): number {
    return this.running && this.lastStart !== null
      ? this.accumulatedMs + (performance.now() - this.lastStart)
      : this.accumulatedMs
  }
}
