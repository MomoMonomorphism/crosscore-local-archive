export const CAPRICCIO_MASK_ASSET = '20140_skin_capriccio04b_spine/20140_skin_Capriccio04b'
export const CAPRICCIO_MASK_SLOTS = ['heidian', 'heiying1'] as const

type Slot<T> = { data: { name: string }; attachment: T | null }

/** An instance-only render filter. Do not reset attachments with setAttachment:
 * that also clears animated mesh deforms and can damage a paused comparison. */
export function createDeveloperMaskFilter<T>(slots: readonly Slot<T>[], assetId: string) {
  const targets = assetId === CAPRICCIO_MASK_ASSET
    ? slots.filter(slot => CAPRICCIO_MASK_SLOTS.some(name => name === slot.data.name)) : []
  return (hidden: boolean, render: () => void) => {
    const saved: Array<{ slot: Slot<T>; attachment: T }> = []
    if (hidden) for (const slot of targets) {
      if (slot.attachment) {
        saved.push({ slot, attachment: slot.attachment })
        slot.attachment = null
      }
    }
    try { render() }
    finally { for (const { slot, attachment } of saved) slot.attachment = attachment }
  }
}
