import i18next, { type i18n as I18nextInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  DEFAULT_EDITOR_LANGUAGE,
  SUPPORTED_EDITOR_LANGUAGES,
  resolveEditorLanguage,
  resolveSupportedEditorLanguage,
  type EditorLanguage,
  type SupportedEditorLanguage,
} from './language-types';
import { editorI18nNamespaces, editorI18nResources } from './resources';
export * from './formatting';

export {
  DEFAULT_EDITOR_LANGUAGE,
  SUPPORTED_EDITOR_LANGUAGES,
  resolveEditorLanguage,
  resolveSupportedEditorLanguage,
  type EditorLanguage,
  type SupportedEditorLanguage,
};

export const editorI18n = i18next;

export interface InitEditorI18nOptions {
  instance?: I18nextInstance;
  language?: SupportedEditorLanguage;
  useReact?: boolean;
}

export async function initEditorI18n({
  instance = editorI18n,
  language = DEFAULT_EDITOR_LANGUAGE,
  useReact = true,
}: InitEditorI18nOptions = {}) {
  if (!instance.isInitialized) {
    if (useReact) instance.use(initReactI18next);
    await instance.init({
      resources: editorI18nResources,
      lng: language,
      fallbackLng: DEFAULT_EDITOR_LANGUAGE,
      supportedLngs: SUPPORTED_EDITOR_LANGUAGES.map((entry) => entry.value),
      defaultNS: 'common',
      ns: editorI18nNamespaces,
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
    return instance;
  }

  if (instance.language !== language) {
    await instance.changeLanguage(language);
  }
  return instance;
}

export function languageLabel(language: SupportedEditorLanguage) {
  const entry = SUPPORTED_EDITOR_LANGUAGES.find((candidate) => candidate.value === language);
  return entry?.nativeLabel ?? language;
}
