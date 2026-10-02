import type { VoiceStream } from './types'

// Text recovered from a verified duplicate bank is an annotation, not a new
// interaction binding. Explicit original runtime IDs remain authoritative.
export function voicePlaybackIds(stream: VoiceStream): number[] {
  return [stream.semantic?.annotationOnly ? null : stream.semantic?.audioId,
    stream.interactionAudioId, ...(stream.interactionAudioIds ?? [])]
    .filter((id): id is number => id != null)
}

export function voiceLabel(stream: VoiceStream): string {
  return stream.semantic?.labelSimplified || stream.semantic?.label || stream.usage?.label || `未识别音轨 ${stream.index}`
}

export function voiceText(stream: VoiceStream, picture = false): string {
  return stream.semantic?.script || (stream.usage ? '用途已确认，暂无台词文本' : picture ? '有语音，暂无台词文本' : stream.name)
}

export function matchesVoiceCategory(stream: VoiceStream, category: string): boolean {
  if (category === 'all') return true
  if (category === 'usage') return !stream.semantic && Boolean(stream.usage)
  if (category === 'raw') return !stream.semantic && !stream.usage
  return (stream.semantic?.category ?? stream.usage?.category) === category
}
