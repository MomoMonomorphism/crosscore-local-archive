import { figureKey } from './interactionAssetMatch'
import type { GalleryEntry, MultiPictureActionManifest, Variant, VoiceManifest, VoiceStream } from './types'
import voiceFold from '../../voice_fold_map.json'
import { simplifyDisplay } from './simplifyDisplay'

export const pictureVoiceText = (value: string) => simplifyDisplay(Array.from(value,
  char => (voiceFold as Record<string, string>)[char] || char).join(''))

export function pictureVoicePlaybackText(stream: VoiceStream) {
  const script = stream.semantic?.script?.trim()
  const label = stream.semantic?.labelSimplified || stream.semantic?.label
  const content = script ? `${label ? `${pictureVoiceText(label)} · ` : ''}${pictureVoiceText(script)}`
    : '正在播放语音 · 暂无台词文本'
  return `${content} · ${stream.duration.toFixed(1)} 秒`
}

/** Join only authored archive/pose identities; never infer voice ownership from titles. */
export function cgPictureVoiceBanks(entry: GalleryEntry | undefined, variant: Variant | undefined,
  actions: MultiPictureActionManifest | null, voices: VoiceManifest | null) {
  if (entry?.category !== 'cg' || !variant || !actions || !voices) return []
  const ids = new Set<number>()
  if (variant.archiveId != null) ids.add(variant.archiveId)
  for (const archive of Object.values(actions.archive)) {
    if (archive.entryMatches.some(([entryId, variantId]) => entryId === entry.id && variantId === variant.id)) ids.add(archive.id)
  }
  // B/C pose packs can have their own gallery entry but belong to the same archive.
  const keys = [figureKey(variant.main.folder), figureKey(variant.main.sourceName)]
  for (const [id, contract] of Object.entries(actions.poses)) {
    if (Object.values(contract.poses).some(pose => keys.includes(figureKey(pose.l2dName)))) ids.add(Number(id))
  }
  const bankIds = new Set([...ids].flatMap(id => actions.archive[String(id)]?.pictureBankIds ?? []))
  return [...bankIds].flatMap(id => voices.pictureEntries?.[id] ? [voices.pictureEntries[id]] : [])
}

export const pictureSpeakerId = (stream: VoiceStream) =>
  stream.semantic?.characterRoleId || stream.semantic?.character || 'unidentified'

export const pictureSpeakerName = (stream: VoiceStream, roleNames: Record<string, string>) =>
  (stream.semantic?.characterRoleId && roleNames[stream.semantic.characterRoleId]) || stream.semantic?.character || '未识别人物'
