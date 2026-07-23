// ISO-639-1 code -> display name. Used for the input + target language selects.

export interface Language {
  code: string;
  name: string;
}

/** Languages available as a translation target (no "auto"). */
export const TARGET_LANGUAGES: Language[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ru', name: 'Russian' },
  { code: 'pl', name: 'Polish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'id', name: 'Indonesian' },
  { code: 'sv', name: 'Swedish' },
  { code: 'uk', name: 'Ukrainian' },
];

/** Languages available as the spoken input, with "auto" for auto-detect. */
export const INPUT_LANGUAGES: Language[] = [
  { code: 'auto', name: 'Auto-detect' },
  ...TARGET_LANGUAGES,
];

const NAME_BY_CODE: Record<string, string> = Object.fromEntries(
  INPUT_LANGUAGES.map((l) => [l.code, l.name]),
);

export function languageName(code: string): string {
  return NAME_BY_CODE[code] ?? code;
}
