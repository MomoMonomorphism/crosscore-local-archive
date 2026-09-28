/** Public files keep their route under the Vite base, including Pages project sites. */
export const sitePath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

export const spineAssetPath = (path: string) =>
  sitePath(`assets/${path.split('/').map(part => encodeURIComponent(part)).join('/')}`)
