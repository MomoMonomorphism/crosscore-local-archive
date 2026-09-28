import type { Variant } from './types'

const resourceKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/spine$/, '')

/** Catalog grouping does not establish a persistent prefab child relationship. */
export function separatePreviewLayers(effects: Variant['effects'], interludes: ReadonlySet<string>) {
  const separate = (effect: Variant['effects'][number]) => effect.origin === 'auxiliary'
    || interludes.has(resourceKey(effect.asset.sourceName)) || interludes.has(resourceKey(effect.asset.folder))
  return { attached: effects.filter(effect => !separate(effect)), auxiliary: effects.filter(separate) }
}

/** A fallback animation is not an idle, and must not override single-play mode. */
export function selectAnimation(names: string[], requested: string | null, loop: boolean) {
  const idle = names.find(name => /(^|_)idle(?:_?\d+)?($|_)/i.test(name))
    ?? names.find(name => /stand|loop/i.test(name)) ?? null
  return { animation: requested && names.includes(requested) ? requested : idle ?? names[0] ?? '', idle, loop }
}
