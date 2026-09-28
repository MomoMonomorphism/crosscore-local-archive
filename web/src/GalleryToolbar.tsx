import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export function GalleryToolbar({ items }: { items: { id: string; node: ReactNode; minWidth: number }[] }) {
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDetailsElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!root.current) return
    const update = () => setWidth(root.current?.clientWidth ?? 0)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  const available = items.filter(item => Boolean(item.node))
  return <div ref={root} className="gallery-compact-toolbar" role="group" aria-label="播放与视图工具栏">
    {available.filter(item => width >= item.minWidth).map(item => <div key={item.id} className={`gallery-toolbar-item toolbar-${item.id}`}>{item.node}</div>)}
    <details ref={menu} className="gallery-toolbar-more" onKeyDown={event => {
      if (event.key === 'Escape' && menu.current?.open) {
        event.stopPropagation(); menu.current.open = false
        menu.current.querySelector('summary')?.focus()
      }
    }}>
      <summary aria-label="更多工具" title="更多工具">⋯</summary>
      <div className="gallery-toolbar-menu" role="group" aria-label="更多工具设置">
        {available.filter(item => width < item.minWidth).map(item => <div key={item.id} className={`gallery-toolbar-item toolbar-${item.id}`}>{item.node}</div>)}
      </div>
    </details>
  </div>
}
