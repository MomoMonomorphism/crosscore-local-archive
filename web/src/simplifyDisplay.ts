import supplement from '../../display_simplified_map.json'
import voiceFold from '../../voice_fold_map.json'

const replacements: Record<string, string> = { ...voiceFold, ...supplement }

/** Fallback for UI labels; game transcripts arrive from the Android text overlay. */
export const simplifyDisplay = (value: string) =>
  Array.from(value, (char) => replacements[char] || char).join('')
