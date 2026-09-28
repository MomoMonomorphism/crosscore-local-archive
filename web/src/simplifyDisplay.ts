import supplement from '../../display_simplified_map.json'

const replacements = supplement as Record<string, string>

/** Finish the character conversions missing from the legacy voice-label fold. */
export const simplifyDisplay = (value: string) =>
  Array.from(value, (char) => replacements[char] || char).join('')
