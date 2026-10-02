import references from '../../pages-pack/spine-references.json'

/** Public files keep their route under the Vite base, including Pages project sites. */
export const sitePath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

export const spineAssetPath = (path: string) => {
  const parts = path.split('/')
  const reference = import.meta.env.VITE_STATIC_DEMO === '1' && parts[0] === 'spine'
    ? (references as Record<string, { platform: string; bundleSha256: string }>)[parts[1]] : undefined
  // Version the entire atlas/texture family together; Pixi propagates the
  // atlas query to its PNG so old PC textures cannot mix with Android data.
  return sitePath(`assets/${parts.map(part => encodeURIComponent(part)).join('/')}`)
    + (reference ? `?reference=${reference.platform}-${reference.bundleSha256.slice(0, 8)}` : '')
}
