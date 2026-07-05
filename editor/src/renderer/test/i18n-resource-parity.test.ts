import { describe, expect, it } from 'vitest';
import { SUPPORTED_EDITOR_LANGUAGES } from '@/i18n';
import { editorI18nNamespaces, editorI18nResources } from '@/i18n/resources';

function collectResourceKeys(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value) || value === null || typeof value !== 'object') {
    return prefix ? [prefix] : [];
  }

  const keys: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    keys.push(...collectResourceKeys(child, childPrefix));
  }
  return keys.sort();
}

function diffKeys(actual: readonly string[], expected: readonly string[]) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((key) => !actualSet.has(key)),
    extra: actual.filter((key) => !expectedSet.has(key)),
  };
}

function resourceValueAtKey(resource: unknown, key: string) {
  return key.split('.').reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[segment];
  }, resource);
}

function collectInterpolationNames(value: unknown) {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(/{{\s*([\w.-]+)\s*}}/g)].map((match) => match[1]).sort();
}

function pluralPairKey(key: string) {
  const match = key.match(/^(.*)_(one|other)$/);
  return match ? { base: match[1], form: match[2] } : null;
}

describe('editor i18n resources', () => {
  it('registers resources for every supported editor language', () => {
    const supportedLanguages = SUPPORTED_EDITOR_LANGUAGES.map((language) => language.value).sort();
    const resourceLanguages = Object.keys(editorI18nResources).sort();
    expect(resourceLanguages).toEqual(supportedLanguages);
  });

  it('keeps every locale namespace key-compatible with en-US', () => {
    for (const namespace of editorI18nNamespaces) {
      const sourceKeys = collectResourceKeys(editorI18nResources['en-US'][namespace]);

      for (const language of SUPPORTED_EDITOR_LANGUAGES) {
        if (language.value === 'en-US') continue;

        const localeKeys = collectResourceKeys(editorI18nResources[language.value][namespace]);
        const { missing, extra } = diffKeys(localeKeys, sourceKeys);

        expect(
          { language: language.value, namespace, missing, extra },
          `${language.value}/${namespace} must not have missing or dangling translation keys`,
        ).toEqual({ language: language.value, namespace, missing: [], extra: [] });
      }
    }
  });

  it('keeps interpolation placeholders compatible with en-US', () => {
    for (const namespace of editorI18nNamespaces) {
      const sourceResource = editorI18nResources['en-US'][namespace];
      const sourceKeys = collectResourceKeys(sourceResource);

      for (const language of SUPPORTED_EDITOR_LANGUAGES) {
        if (language.value === 'en-US') continue;

        const localeResource = editorI18nResources[language.value][namespace];
        for (const key of sourceKeys) {
          const sourcePlaceholders = collectInterpolationNames(resourceValueAtKey(sourceResource, key));
          const localePlaceholders = collectInterpolationNames(resourceValueAtKey(localeResource, key));
          expect(
            { language: language.value, namespace, key, placeholders: localePlaceholders },
            `${language.value}/${namespace}:${key} must preserve en-US interpolation placeholders`,
          ).toEqual({ language: language.value, namespace, key, placeholders: sourcePlaceholders });
        }
      }
    }
  });

  it('keeps i18next plural key pairs complete when a namespace uses plural forms', () => {
    for (const namespace of editorI18nNamespaces) {
      const sourceKeys = collectResourceKeys(editorI18nResources['en-US'][namespace]);
      const sourceKeySet = new Set(sourceKeys);

      for (const key of sourceKeys) {
        const pair = pluralPairKey(key);
        if (!pair) continue;

        expect(
          sourceKeySet.has(`${pair.base}_one`) && sourceKeySet.has(`${pair.base}_other`),
          `${namespace}:${pair.base} must define both _one and _other plural forms`,
        ).toBe(true);
      }
    }
  });
});
