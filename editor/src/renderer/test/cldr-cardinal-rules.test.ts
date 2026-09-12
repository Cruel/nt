import { describe, expect, it } from 'vite-plus/test';
import { cldrCardinalCategories, cldrCardinalCategory } from '../../shared/cldr-cardinal-rules';

const locales = [
  'zh',
  'hi',
  'en',
  'si',
  'tzm',
  'da',
  'is',
  'mk',
  'fil',
  'lv',
  'lag',
  'he',
  'se',
  'shi',
  'ro',
  'sr',
  'fr',
  'pt-PT',
  'es',
  'gd',
  'sl',
  'hsb',
  'cs',
  'pl',
  'be',
  'lt',
  'ru',
  'sgs',
  'br',
  'mt',
  'ga',
  'gv',
  'kw',
  'ar',
  'cy',
] as const;

const decimalSamples = [
  0.1, 0.2, 0.3, 0.4, 0.5, 0.9, 1.1, 1.2, 1.3, 1.9, 2.1, 2.2, 2.4, 3.1, 10.1, 11.1, 21.1, 101.1,
  1000.1,
] as const;

describe('vendored CLDR cardinal rules', () => {
  it('matches Intl.PluralRules categories and selection across representative rule families', () => {
    for (const locale of locales) {
      expect(Intl.PluralRules.supportedLocalesOf([locale])).toHaveLength(1);
      const intl = new Intl.PluralRules(locale, { type: 'cardinal' });
      expect([...cldrCardinalCategories(locale)].sort()).toEqual(
        [...intl.resolvedOptions().pluralCategories].sort(),
      );
      for (let value = 0; value <= 250; value += 1)
        expect(cldrCardinalCategory(locale, value), `${locale}: ${value}`).toBe(intl.select(value));
      for (const value of decimalSamples)
        expect(cldrCardinalCategory(locale, value), `${locale}: ${value}`).toBe(intl.select(value));
      for (const value of [1000, 10_000, 100_000, 1_000_000, 2_000_000])
        expect(cldrCardinalCategory(locale, value), `${locale}: ${value}`).toBe(intl.select(value));
    }
  });
});
