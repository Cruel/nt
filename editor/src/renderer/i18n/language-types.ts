export const DEFAULT_EDITOR_LANGUAGE = 'en-US' as const;


export const SUPPORTED_EDITOR_LANGUAGES = [
  {
    value: 'en-US',
    label: 'English (United States)',
    nativeLabel: 'English (United States)',
    matchTags: ['en-US', 'en'],
  },
  {
    value: 'pt-BR',
    label: 'Brazilian Portuguese',
    nativeLabel: 'Portugu\u00eas (Brasil)',
    matchTags: ['pt-BR', 'pt'],
  },
  {
    value: 'pseudo',
    label: 'Pseudo-localized',
    nativeLabel: 'Pseudo-localized',
    matchTags: ['pseudo'],
  },
] as const;

export type SupportedEditorLanguage = (typeof SUPPORTED_EDITOR_LANGUAGES)[number]['value'];
export type EditorLanguage = 'system' | SupportedEditorLanguage;

const supportedLanguages = new Set<SupportedEditorLanguage>(
  SUPPORTED_EDITOR_LANGUAGES.map((language) => language.value),
);

function normalizedTag(tag: string) {
  return tag.trim().replace('_', '-');
}

export function isSupportedEditorLanguage(value: string): value is SupportedEditorLanguage {
  return supportedLanguages.has(value as SupportedEditorLanguage);
}

export function resolveSupportedEditorLanguage(languageTag: string): SupportedEditorLanguage | null {
  const normalized = normalizedTag(languageTag);
  if (isSupportedEditorLanguage(normalized)) return normalized;

  const lower = normalized.toLowerCase();
  for (const language of SUPPORTED_EDITOR_LANGUAGES) {
    if (language.matchTags.some((tag) => tag.toLowerCase() === lower)) return language.value;
  }

  const base = lower.split('-')[0];
  for (const language of SUPPORTED_EDITOR_LANGUAGES) {
    if (language.matchTags.some((tag) => tag.toLowerCase().split('-')[0] === base)) return language.value;
  }

  return null;
}

export function resolveEditorLanguage(
  preference: EditorLanguage,
  preferredSystemLanguages: readonly string[] = [],
): SupportedEditorLanguage {
  if (preference !== 'system') return preference;
  for (const languageTag of preferredSystemLanguages) {
    const resolved = resolveSupportedEditorLanguage(languageTag);
    if (resolved) return resolved;
  }
  return DEFAULT_EDITOR_LANGUAGE;
}
