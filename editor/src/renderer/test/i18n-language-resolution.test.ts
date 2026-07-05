import { describe, expect, it } from 'vitest';
import { resolveEditorLanguage, resolveSupportedEditorLanguage } from '@/i18n';

describe('editor i18n language resolution', () => {
  it('uses explicit language preferences before system languages', () => {
    expect(resolveEditorLanguage('pseudo', ['en-US'])).toBe('pseudo');
  });

  it('resolves supported system languages', () => {
    expect(resolveEditorLanguage('system', ['en-US'])).toBe('en-US');
  });

  it('falls back to English for unsupported system languages', () => {
    expect(resolveEditorLanguage('system', ['fr-FR'])).toBe('en-US');
  });

  it('matches base language tags', () => {
    expect(resolveSupportedEditorLanguage('en-GB')).toBe('en-US');
  });

  it('matches Portuguese to the Brazilian Portuguese locale', () => {
    expect(resolveSupportedEditorLanguage('pt')).toBe('pt-BR');
  });
});
