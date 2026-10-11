import { describe, expect, it } from 'vite-plus/test';
import {
  compileLocalization,
  packageMessageIds,
  withPackageMessageIds,
} from '../../shared/authoring-message-lowering';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

describe('authoring message lowering', () => {
  it('uses one message-id inventory per lowering pass and invalidates it after the pass', () => {
    const project = createAuthoringProject({ id: 'message-cache', name: 'Message Cache' });
    const first = '018f4f8c-9b5d-7ae2-9b36-4c8af613f031';
    const second = '018f4f8c-9b5d-7ae2-9b36-4c8af613f032';
    project.localization.messages[first] = {
      kind: 'named',
      key: 'custom.first',
      source: 'First',
      context: 'Test',
    };
    withPackageMessageIds(project, () => {
      const initial = packageMessageIds(project);
      expect(packageMessageIds(project)).toBe(initial);
      project.localization.messages[second] = {
        kind: 'named',
        key: 'custom.second',
        source: 'Second',
        context: 'Test',
      };
      expect(packageMessageIds(project).has(second)).toBe(false);
    });
    expect(packageMessageIds(project).has(second)).toBe(true);
  });
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
