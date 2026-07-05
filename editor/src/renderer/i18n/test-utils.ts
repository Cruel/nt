import i18next from 'i18next';
import { DEFAULT_EDITOR_LANGUAGE, initEditorI18n, type SupportedEditorLanguage } from './index';

export async function createTestI18n(language: SupportedEditorLanguage = DEFAULT_EDITOR_LANGUAGE) {
  const instance = i18next.createInstance();
  await initEditorI18n({ instance, language, useReact: false });
  return instance;
}
