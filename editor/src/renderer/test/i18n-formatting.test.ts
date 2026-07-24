import { describe, expect, it } from 'vite-plus/test';
import {
  createEditorFormatters,
  formatBigIntPercent,
  formatFileSize,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  resolveFormattingLocale,
} from '@/i18n';

describe('editor i18n formatting helpers', () => {
  it('resolves pseudo formatting through the English source locale', () => {
    expect(resolveFormattingLocale('pseudo')).toBe('en-US');
  });

  it('formats numbers with the active locale', () => {
    expect(formatNumber(1234.5, 'en-US')).toBe('1,234.5');
    expect(formatNumber(1234.5, 'pt-BR')).toBe('1.234,5');
    expect(formatNumber(9_007_199_254_740_993n, 'en-US')).toBe('9,007,199,254,740,993');
  });

  it('formats percentages through Intl percent formatting', () => {
    expect(formatPercent(0.125, 'en-US')).toBe('12.5%');
    expect(formatPercent(0.125, 'pt-BR')).toBe('12,5%');
    expect(formatBigIntPercent(9_007_199_254_740_993n, 10_000_000_000_000_000n, 'en-US')).toBe(
      '90.1%',
    );
    expect(formatBigIntPercent(11n, 10n, 'pt-BR')).toBe('110%');
  });

  it('formats relative time with locale-aware wording', () => {
    expect(formatRelativeTime(-1, 'day', 'en-US')).toBe('yesterday');
    expect(formatRelativeTime(-1, 'day', 'pt-BR')).toBe('ontem');
  });

  it('formats decimal and binary file sizes', () => {
    expect(formatFileSize(1536, 'en-US')).toBe('1.5 KB');
    expect(formatFileSize(1536, 'en-US', { unitSystem: 'binary' })).toBe('1.5 KiB');
    expect(formatFileSize(1536, 'pt-BR')).toBe('1,5 KB');
    expect(formatFileSize(9_007_199_254_740_993n, 'en-US')).toBe('9,007.2 TB');
  });

  it('creates formatter bundles for components', () => {
    const format = createEditorFormatters('pt-BR');
    expect(format.number(1234.5)).toBe('1.234,5');
    expect(format.fileSize(1536)).toBe('1,5 KB');
    expect(format.durationNs(9_007_199_254_740_993n)).toBe('9.007.199,3 s');
  });
});
