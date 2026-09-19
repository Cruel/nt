import { describe, expect, it } from 'vite-plus/test';
import { compileLocalization } from '../../shared/authoring-message-lowering';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

describe('authoring message lowering', () => {
  it('uses deterministic locale autonyms instead of host Intl display-name data', () => {
    const project = createAuthoringProject({ id: 'locale-lowering', name: 'Locale Lowering' });
    project.localization.locales = {
      en: { supported: true, parentLocale: null, fontStack: null },
      es: { supported: true, parentLocale: null, fontStack: null },
      'x-private': {
        supported: true,
        parentLocale: null,
        fontStack: null,
        displayName: 'Private Locale',
      },
    };

    expect(
      compileLocalization(project).locales.map(({ locale, nativeName, displayName }) => ({
        locale,
        nativeName,
        displayName,
      })),
    ).toEqual([
      { locale: 'en', nativeName: 'English', displayName: 'English' },
      { locale: 'es', nativeName: 'español', displayName: 'español' },
      { locale: 'x-private', nativeName: 'x-private', displayName: 'Private Locale' },
    ]);
  });
});
