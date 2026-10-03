import { emptyDeveloperOverrides, type DeveloperOverrides, type DeveloperRule, type DeveloperScene } from './developerControls'

export type DeveloperPreset = {
  id: string; name: string; sceneId: string; overrides: DeveloperOverrides; createdAt: number; updatedAt: number
}

export const DEVELOPER_PRESET_STORAGE_KEY = 'crosscore.developer-presets.v1'
export const MAX_DEVELOPER_PRESETS = 128
const MAX_TEXT = 512
const MAX_RULES = 4096
const MAX_JSON_SIZE = 4 * 1024 * 1024
type PresetStorage = Pick<Storage, 'getItem' | 'setItem'>

function invalid(reason: string): never { throw new Error(`开发者预设无效：${reason}`) }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('应为对象')
  const result = value as Record<string, unknown>
  for (const key of Object.keys(result)) if (!fields.includes(key)) invalid(`未知字段 ${key}`)
  return result
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT || /[\u0000-\u001f]/.test(value)) invalid(`${field} 长度或格式错误`)
  return value
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('时间格式错误')
  return value
}
function rule(value: unknown): DeveloperRule {
  const raw = object(value, ['hidden', 'opacity', 'disableClipping'])
  const result: DeveloperRule = {}
  for (const key of ['hidden', 'disableClipping'] as const) {
    if (Object.hasOwn(raw, key)) {
      if (typeof raw[key] !== 'boolean') invalid(`${key} 应为布尔值`)
      result[key] = raw[key] as boolean
    }
  }
  if (Object.hasOwn(raw, 'opacity')) {
    if (typeof raw.opacity !== 'number' || !Number.isFinite(raw.opacity) || raw.opacity < 0 || raw.opacity > 1) invalid('透明度必须在 0 到 1 之间')
    result.opacity = raw.opacity
  }
  return result
}
function rules(value: unknown): Record<string, DeveloperRule> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('图层规则格式错误')
  const entries = Object.entries(value)
  if (entries.length > MAX_RULES) invalid('图层规则过多')
  const result: Record<string, DeveloperRule> = {}
  for (const [key, value] of entries) {
    text(key, '图层标识')
    if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid('保留的图层标识')
    result[key] = rule(value)
  }
  return result
}

export function validateDeveloperOverrides(value: unknown): DeveloperOverrides {
  const raw = object(value, ['layers', 'slots', 'solo'])
  const result: DeveloperOverrides = { layers: rules(raw.layers), slots: rules(raw.slots) }
  if (Object.hasOwn(raw, 'solo')) {
    const solo = object(raw.solo, ['kind', 'id'])
    if (solo.kind !== 'layer' && solo.kind !== 'slot') invalid('单层查看类型错误')
    result.solo = { kind: solo.kind, id: text(solo.id, '单层查看标识') }
  }
  return result
}

function preset(value: unknown): DeveloperPreset {
  const raw = object(value, ['id', 'name', 'sceneId', 'overrides', 'createdAt', 'updatedAt'])
  const createdAt = timestamp(raw.createdAt)
  const updatedAt = timestamp(raw.updatedAt)
  if (updatedAt < createdAt) invalid('更新时间早于创建时间')
  return { id: text(raw.id, '预设标识'), name: text(raw.name, '预设名称'), sceneId: text(raw.sceneId, '画面标识'),
    overrides: validateDeveloperOverrides(raw.overrides), createdAt, updatedAt }
}

function validatedList(value: unknown): DeveloperPreset[] {
  if (!Array.isArray(value) || value.length > MAX_DEVELOPER_PRESETS) invalid(`最多保存 ${MAX_DEVELOPER_PRESETS} 个预设`)
  const result = value.map(preset)
  if (new Set(result.map(item => item.id)).size !== result.length) invalid('预设标识重复')
  return result
}

export function createDeveloperPreset(sceneId: string, name: string, overrides: DeveloperOverrides,
  now = Date.now()): DeveloperPreset {
  const id = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID() : `preset-${now}-${Math.random().toString(36).slice(2)}`
  return preset({ id, name: name.trim(), sceneId, overrides, createdAt: now, updatedAt: now })
}

export function presetsForScene(presets: readonly DeveloperPreset[], sceneId: string): DeveloperPreset[] {
  return presets.filter(item => item.sceneId === sceneId)
}

/** Presets are applied explicitly to their own scene. Stale slot names are
 * omitted, so a replaced resource cannot accidentally target another layer. */
export function applyDeveloperPreset(value: DeveloperPreset, scene: DeveloperScene): DeveloperOverrides | null {
  const item = preset(value)
  if (item.sceneId !== scene.id) return null
  const result = emptyDeveloperOverrides()
  const layerIds = new Set(scene.layers.map(layer => layer.id))
  const slotIds = new Set(scene.slots.map(slot => slot.id))
  for (const [id, rule] of Object.entries(item.overrides.layers)) if (layerIds.has(id)) result.layers[id] = rule
  for (const [id, rule] of Object.entries(item.overrides.slots)) if (slotIds.has(id)) result.slots[id] = rule
  const solo = item.overrides.solo
  if (solo && (solo.kind === 'layer' ? layerIds : slotIds).has(solo.id)) result.solo = solo
  return result
}

export function exportDeveloperPresets(presets: readonly DeveloperPreset[]): string {
  const serialized = JSON.stringify({ version: 1, presets: validatedList(presets) }, null, 2)
  if (serialized.length > MAX_JSON_SIZE) invalid('预设文件过大')
  return serialized
}

export function importDeveloperPresets(json: string): DeveloperPreset[] {
  if (typeof json !== 'string' || json.length > MAX_JSON_SIZE) invalid('预设文件过大')
  let parsed: unknown
  try { parsed = JSON.parse(json) }
  catch { invalid('文件不是有效 JSON') }
  const raw = object(parsed, ['version', 'presets'])
  if (raw.version !== 1) invalid('不支持此版本')
  return validatedList(raw.presets)
}

export function mergeDeveloperPresets(existing: readonly DeveloperPreset[], incoming: readonly DeveloperPreset[]): DeveloperPreset[] {
  const merged = new Map(validatedList(existing).map(item => [item.id, item]))
  for (const item of validatedList(incoming)) merged.set(item.id, item)
  return validatedList([...merged.values()])
}

function defaultStorage(): PresetStorage | undefined {
  try { return globalThis.localStorage }
  catch { return undefined }
}

/** A missing, blocked or corrupt browser store must not prevent the viewer from
 * loading. Saving reports failure so the menu can suggest exporting a file. */
export function loadDeveloperPresets(storage: PresetStorage | undefined = defaultStorage()): DeveloperPreset[] {
  try {
    const raw = storage?.getItem(DEVELOPER_PRESET_STORAGE_KEY)
    return raw ? importDeveloperPresets(raw) : []
  } catch { return [] }
}

export function persistDeveloperPresets(presets: readonly DeveloperPreset[], storage: PresetStorage | undefined = defaultStorage()): boolean {
  try {
    if (!storage) return false
    storage.setItem(DEVELOPER_PRESET_STORAGE_KEY, exportDeveloperPresets(presets))
    return true
  } catch { return false }
}
