import { useEffect, useState } from 'react'

/** Indeterminate feedback, never an invented percentage or fixed dismissal. */
export function ResourceLoadingNotice({ title = '正在加载画面资源' }: { title?: string }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 12000)
    return () => window.clearTimeout(timer)
  }, [])
  return <div className="resource-loading-notice" role="status" aria-live="polite" aria-atomic="true">
    <span className="resource-loading-spinner" aria-hidden="true"/>
    <strong>{title}</strong>
    <span>{slow ? '资源仍在加载，资源较大或网络较慢时可能需要更久。' : '正在下载并准备画面，首次打开可能需要几秒钟。'}</span>
    <small>加载完成后会自动显示，请稍候。</small>
  </div>
}
