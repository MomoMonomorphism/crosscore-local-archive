export type ModelAsset = {
  id: string
  title: string
  sourceName: string
  folder: string
  jsonPath: string
  atlasPath: string
  texturePaths: string[]
  bytes: number
  spineVersion: string
  boneCount: number
  slotCount: number
  animationCount: number
  setupOpaqueSlotCount: number
}

export type Variant = {
  archiveId?: number
  id: string
  label: string
  kind: string
  main: ModelAsset
  effects: Array<{ layer: 'front' | 'back'; asset: ModelAsset; origin?: 'auxiliary' }>
  bytes: number
}

export type CharacterPortrait = {
  modelId: string
  roleId: string
  label: string
  url: string
  touches: import('./staticPictureTouch').StaticPictureTouch[]
}

export type GalleryEntry = {
  displayName?: string
  portraits?: CharacterPortrait[]
  id: string
  title: string
  category: 'character' | 'cg'
  characterIds: string[]
  variants: Variant[]
}

export type Manifest = {
  generatedAt: string
  revision: string
  folderCount: number
  modelCount: number
  mainModelCount: number
  effectModelCount: number
  auxiliaryModelCount: number
  variantAliases: Record<string, string>
  entryAliases: Record<string, string>
  entryDefaultVariants?: Record<string, string>
  entryCount: number
  characterCount: number
  cgCount: number
  variantCount: number
  entries: GalleryEntry[]
}

export type DisplayNamesManifest = {
  source: string
  entryNames: Record<string, string>
  roleNames: Record<string, string>
  characterEntryCount: number
  namedEntryCount: number
}

/** Which table a line's label came from. They are not equally trustworthy. */
export type VoiceLabelSource = 'roleVoice' | 'soundBook'

export type VoiceStream = {
  index: number
  name: string
  duration: number
  /** Recovered from the bank's unanimous audio-id offset and unique ACB cue number. */
  interactionAudioId?: number
  /** Other game IDs that point at this same cue in cfgSound. */
  interactionAudioIds?: number[]
  usage?: { label: string; category: 'battle'; source: 'gameplayConfig';
    provenance: Array<{ platform: 'pc' | 'android'; asset: string; bundleSha256: string; field?: string }> }
  semantic?: {
    /** Absent for 7 sound-book rows that ship without an id (`CfgSound` gap). */
    audioId: number | null
    annotationOnly?: boolean
    cue: number
    /** Position of the line inside the role's own config block. Not a category. */
    position: number | null
    type: number | null
    /** The table's own string: traditional from the sound book, simplified from the
     *  curated table. Kept verbatim so the archive stays faithful. */
    label: string
    /** `label` folded to simplified Chinese. What the UI shows and searches, so the
     *  two label sources read (and match) the same way. */
    labelSimplified: string
    category: 'touch' | 'home' | 'battle' | 'profile' | 'facility' | 'shop' | 'other'
    script: string
    openLv: number | null
    /**
     * `roleVoice` = curated per-card table (simplified labels, only while it still
     * lines up with the shipped ACB); `soundBook` = the master sound book, keyed by
     * ACB path plus stream name (traditional labels, far wider coverage).
     */
    source: VoiceLabelSource
    /** 多人立绘 only: the speaker named in the sound-book label. */
    character?: string
    /** 多人立绘 only: the speaker resolved through `character.key`. Null for NPCs. */
    characterRoleId?: string | null
    textProvenance?: { platform: 'pc' | 'android'; asset: string; audioId: number; cueSheet: string; cueName: string; bundleSha256?: string;
      originalConfig?: { verification: string; activeRecordPresent?: boolean } }
  }
}

export type VoiceBank = {
  id: string
  title: string
  sourceFile: string
  sourceGroup?: 'cv' | 'cv_skin' | 'cv_cn' | 'picture'
  bytes: number
  streamCount: number
  roleId?: string
  roleName?: string | null
  semanticStreamCount?: number
  resolvedCueCount?: number
  /** Which table ended up labelling this bank. */
  labelSource?: VoiceLabelSource | 'none'
  /** Streams the two tables describe differently — the drift signal. */
  labelConflictCount?: number
  /** Whether the curated table still matches this bank's audio. */
  officialAligned?: boolean
  officialCompared?: number
  officialMatched?: number
  streams: VoiceStream[]
  inferredAudioStreamCount?: number
}

/** One speaker inside a 多人立绘 bank, with the streams they own. */
export type PictureSpeaker = {
  name: string
  roleId: string | null
  streamIndexes: number[]
  /** Label carries 「測試用」 — a debug take shipped in the client, not story content. */
  test: boolean
}

export type VoicePictureBank = VoiceBank & {
  titleSimplified: string
  archiveId: number | null
  obtain: string
  itemId: number | null
  l2dName: string
  speakers: PictureSpeaker[]
}

export type VoiceManifest = {
  availableBankCount: number
  matchedBankCount: number
  indexedBankCount?: number
  voiceEntryCount: number
  streamCount: number
  inferredAudioStreamCount?: number
  reusedPreviousSemanticCount?: number
  roleVoiceDamagedBlocks?: number[]
  semanticRoleCount: number
  semanticEntryCount: number
  semanticStreamCount: number
  resolvedRoleCount?: number
  semanticBankCount?: number
  soundBookStreamCount?: number
  labelSourceCounts?: Record<VoiceLabelSource, number>
  identityOnlyBankCount?: number
  unresolvedBankCount?: number
  labelConflictCount?: number
  officialAlignedRoleCount?: number
  officialDriftedRoleCount?: number
  skinBankCount?: number
  skinLabelledBankCount?: number
  soundBook?: {
    asset: string
    segments: number
    damagedBlocks: number[]
    bodyBytes: number
    readableBytes: number
    readableRatio: number
    rowCount: number
  }
  entries: Record<string, VoiceBank>
  variantEntries: Record<string, VoiceBank>
  auxiliaryEntries?: Record<string, VoiceBank>
  chineseEntries?: Record<string, VoiceBank>
  chineseVariantEntries?: Record<string, VoiceBank>
  chineseAvailableBankCount?: number
  chineseMatchedBankCount?: number
  chineseStreamCount?: number
  pictureBankCount?: number
  pictureLabelledBankCount?: number
  pictureStreamCount?: number
  pictureLabelledStreamCount?: number
  pictureSpeakerCount?: number
  pictureUnlabelledBanks?: string[]
  pictureEntries?: Record<string, VoicePictureBank>
}

export type MultiPictureActionManifest = {
  corrections?: Array<{ id: string; modelId: number; rowIndex: number; source: { platform: string; asset: string }; reason: string }>
  summary: {
    archiveRows: number; dynamicModels: number; mappedCgModels: number
    mappedCharacterPictureModels: number; pictureLinks: number
    illustrationGroups: number; illustrationBoards: number; unresolvedPictures: number
    audioCues: number; resolvedAudioCues: number; inferredAudioCues: number
  }
  groups: Array<{ id: number; name: string; icon: string; boardIds: number[] }>
  supplementalArchive?: MultiPictureActionManifest['archive']
  archive: Record<string, {
    id: number; img: string | null; icon: string | null; l2dName: string | null
    l2dPos: [number, number, number] | null; imgPos: [number, number, number] | null
    title: string; sort: number | null; groupIds: number[]; entryMatches: Array<[string, string]>
    pictureBankIds: string[]; hasDynamicTouch: boolean; hasStaticTouch: boolean
    source?: { platform: string; archiveId: number; luaSha256: string }
    presentation?: 'static' | 'static-with-particles'
  }>
  entryByModel: Record<string, string>
  variantByModel: Record<string, string>
  pictureLinks: Record<string, {
    archiveId: number; l2dName: string; img: string; icon: string
    evidence: 'archive-img' | 'touch-audio'; entryMatches: Array<[string, string]>
  }>
  unresolvedPictures: string[]
  audioLookup: Record<string, { bankId: string; streamIndex: number; evidence?: 'archive-cue-suffix' }>
  staticModels: Record<string, import('./staticPictureTouch').StaticPictureTouch[]>
  interludeDefaults: Record<string, { animation: string; loop: boolean }>
  poses: Record<string, {
    initialRole: number; initialSpine: string
    poses: Record<string, {
      role: number; l2dName: string; touchIndexes: number[]
      touchSpace?: import('./gameFrame').PrefabSpace | null
    }>
  }>
  models: Record<string, import('./interactionMachine').InteractionRow[]>
}

export type ThumbnailManifest = {
  entryCount: number
  bytes: number
  entries: Record<string, { path: string; sourceName: string; width: number; height: number; bytes: number }>
  archiveEntryCount?: number
  archiveEntries?: Record<string, { path: string; sourceName: string; width: number; height: number; bytes: number }>
}

export type AsmrLine = {
  index: number
  time: number
  word: string
}

export type AsmrAlbum = {
  id: number | null
  voice: number
  title: string
  description: string
  cvName: string
  roleId: string | null
  roleName: string | null
  /** The Spine folder `CfgASMR` names for this album. */
  l2d: string
  /** Gallery variant id resolved from `l2d`. Null when the 立绘 is not in the manifest. */
  spineVariant: string | null
  /** The loadable asset behind `spineVariant`, so the album view needs no second lookup. */
  spine: ModelAsset | null
  sheet: string
  previewSheet: string
  sourceFile: string
  sourceDir: string
  seconds: number
  sampleRate: number | null
  channels: number | null
  previewSeconds: number | null
  lineCount: number
  lines: AsmrLine[]
}

export type AsmrManifest = {
  generatedAt: string
  albumCount: number
  lineCount: number
  totalSeconds: number
  missingSheets: string[]
  /** `l2d` folders that no gallery variant serves — listed, never silently blanked. */
  missingSpine: string[]
  albums: AsmrAlbum[]
}
