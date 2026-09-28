import { figureKey, poseMatchScore } from './interactionAssetMatch'
import { simplifyDisplay } from './simplifyDisplay'
import type { DisplayNamesManifest, GalleryEntry, MultiPictureActionManifest } from './types'

export type GalleryLabel = {
  primary: string
  secondary: string
  archiveId: number | null
}

/** A CG resource may be an archive's initial picture or one of its later poses. */
export function buildGalleryLabels(
  entries: GalleryEntry[],
  names: DisplayNamesManifest | null,
  actions: MultiPictureActionManifest | null,
): Record<string, GalleryLabel> {
  const result: Record<string, GalleryLabel> = {}
  const cgEntries = entries.filter((entry) => entry.category === 'cg')
  const archives = Object.values(actions?.archive ?? {})

  for (const entry of entries) {
    if (entry.category !== 'character') continue
    const primary = entry.displayName || names?.entryNames[entry.id] || entry.title
    result[entry.id] = {
      primary,
      secondary: primary === entry.title ? '' : entry.title,
      archiveId: null,
    }
  }

  for (const entry of cgEntries) {
    const direct = archives.filter((archive) => archive.entryMatches.some(([id]) => id === entry.id))
    let match = direct.length === 1 ? direct[0] : null
    let role: number | null = null
    if (!match) {
      const poseMatches = archives.flatMap((archive) =>
        Object.values(actions?.poses[String(archive.id)]?.poses ?? {})
          .filter((pose) => entry.variants.some((variant) => poseMatchScore(variant.main, pose.l2dName) > 0))
          .map((pose) => ({ archive, role: pose.role })))
      if (poseMatches.length === 1) {
        match = poseMatches[0].archive
        role = poseMatches[0].role
      }
    }
    const primary = match?.title
      ? `${simplifyDisplay(match.title)}${role !== null && role !== actions?.poses[String(match.id)]?.initialRole ? ` · 姿态 ${role}` : ''}`
      : entry.title
    result[entry.id] = {
      primary,
      secondary: match ? `${entry.title} · 档案 #${match.id}` : entry.title === primary ? '' : entry.title,
      archiveId: match?.id ?? null,
    }
  }
  return result
}

export const gallerySearchText = (entry: GalleryEntry, label: GalleryLabel) =>
  `${label.primary} ${label.secondary} ${entry.title} ${entry.id} ${entry.characterIds.join(' ')} `
  + entry.variants.map((variant) => `${variant.label} ${figureKey(variant.main.sourceName)}`).join(' ')
