import { useLayoutEffect, useRef } from 'react'
import { motionTabBox, type MotionTabBox, type MotionTabVariant } from './motionTabGeometry'

/** One shared underline per strip; it never changes button focus or selection. */
export default function MotionTabIndicator({ activeKey, scopeKey, variant = 'chips' }: {
  activeKey: string | number | null | undefined
  scopeKey?: string | number | null
  variant?: MotionTabVariant
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const measureRef = useRef<(animate: boolean) => void>(() => {})

  useLayoutEffect(() => {
    const indicator = ref.current
    const strip = indicator?.parentElement
    if (!indicator || !strip) return
    strip.classList.add('motion-tab-strip')
    let initialized = false
    let previousBox: MotionTabBox | null = null
    const buttons = () => Array.from(strip.children).filter((child): child is HTMLButtonElement => child instanceof HTMLButtonElement)
    const measure = (animate: boolean) => {
      const selected = buttons().find(button => button.getAttribute('aria-selected') === 'true'
        || button.getAttribute('aria-current') === 'page' || button.classList.contains('active'))
      const style = selected ? getComputedStyle(selected) : null
      const box = selected && selected.getClientRects().length ? motionTabBox({
        left: selected.offsetLeft, top: selected.offsetTop, width: selected.offsetWidth, height: selected.offsetHeight,
        paddingLeft: Number.parseFloat(style!.paddingLeft), paddingRight: Number.parseFloat(style!.paddingRight),
      }, variant) : null
      if (!box) {
        delete strip.dataset.motionIndicator
        indicator.hidden = true
        initialized = false
        previousBox = null
        return
      }
      // Selection can change font weight and trigger ResizeObserver after this effect.
      // An unchanged layout must not interrupt the transition already in progress.
      if (previousBox && box.x === previousBox.x && box.y === previousBox.y
        && box.width === previousBox.width && box.height === previousBox.height) return
      indicator.dataset.animate = String(animate && initialized)
      indicator.style.width = `${box.width}px`
      indicator.style.height = `${box.height}px`
      indicator.style.transform = `translate(${box.x}px, ${box.y}px)`
      indicator.hidden = false
      strip.dataset.motionIndicator = 'ready'
      initialized = true
      previousBox = box
    }
    measureRef.current = measure
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure(false))
    const observeButtons = () => {
      resize?.disconnect()
      resize?.observe(strip)
      for (const button of buttons()) resize?.observe(button)
      measure(false)
    }
    const mutation = new MutationObserver(observeButtons)
    mutation.observe(strip, { childList: true })
    observeButtons()
    const onResize = () => measure(false)
    window.addEventListener('resize', onResize)
    let disposed = false
    void document.fonts?.ready.then(() => { if (!disposed) measure(false) })
    return () => {
      disposed = true
      resize?.disconnect()
      mutation.disconnect()
      window.removeEventListener('resize', onResize)
      measureRef.current = () => {}
      strip.classList.remove('motion-tab-strip')
      delete strip.dataset.motionIndicator
    }
  }, [scopeKey, variant])

  useLayoutEffect(() => { measureRef.current(true) }, [activeKey, scopeKey, variant])
  return <span ref={ref} className="motion-tab-indicator" aria-hidden="true" hidden/>
}
