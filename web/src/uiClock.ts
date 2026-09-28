// Accumulate active logical time across network stalls and pause/speed boundaries.
export class UiClock {
  private last: number
  private running = false
  private speed = 1
  private pending = 0
  private consumed = 0
  constructor(now: number) { this.last = now }
  private collect(now: number) {
    if (this.running) this.pending += Math.max(0, now - this.last) / 1000 * this.speed
    this.last = now
  }
  configure(now: number, running: boolean, speed: number) {
    this.collect(now); this.running = running; this.speed = speed
  }
  take(now: number): number {
    this.collect(now)
    if (!this.running) return 0
    const dt = Math.min(.1, this.pending)
    this.pending -= dt
    this.consumed += dt
    return dt
  }
  get catchingUp() { return this.running && this.pending >= .1 }
  get frontier() { return this.consumed }
  stamp(now: number) { this.collect(now);return this.consumed + this.pending }
}
