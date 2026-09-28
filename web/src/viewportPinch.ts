/** Viewport-only gesture arbitration; game drags keep ownership of their input. */
export class ViewportPinch {
  private points = new Map<number, { x: number; y: number }>()
  private active = false
  private previousDistance = 0
  private distance() {
    const [a, b] = [...this.points.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }
  reset() { this.points.clear(); this.active = false; this.previousDistance = 0 }
  down(id: number, type: string, x: number, y: number, allowed: boolean, gameOwnsPointer: boolean) {
    if (type !== 'touch') return false
    this.points.set(id, { x, y })
    if (this.points.size === 2 && allowed && !gameOwnsPointer) {
      this.active = true
      this.previousDistance = this.distance()
    }
    return this.active
  }
  move(id: number, x: number, y: number, allowed: boolean) {
    if (this.points.has(id)) this.points.set(id, { x, y })
    if (!this.active) return { consumed: false, ratio: null }
    const next = this.distance(), old = this.previousDistance
    this.previousDistance = next
    return { consumed: true, ratio: allowed && next > 0 && old > 0 ? next / old : null }
  }
  up(id: number) {
    const consumed = this.active
    this.points.delete(id)
    this.previousDistance = this.distance()
    if (!this.points.size) this.reset()
    return consumed
  }
}
