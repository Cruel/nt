import {
  DEFAULT_EDITOR_LANGUAGE,
  resolveSupportedEditorLanguage,
  type SupportedEditorLanguage,
} from './language-types';

export type EditorFormattingLanguage = SupportedEditorLanguage | string | null | undefined;

export type FileSizeUnitSystem = 'decimal' | 'binary';

export interface FileSizeFormatOptions {
  maximumFractionDigits?: number;
  unitSystem?: FileSizeUnitSystem;
}

const decimalFileSizeUnits = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const binaryFileSizeUnits = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

export function resolveFormattingLocale(language: EditorFormattingLanguage = DEFAULT_EDITOR_LANGUAGE) {
  const resolved = language ? resolveSupportedEditorLanguage(language) : DEFAULT_EDITOR_LANGUAGE;
  const locale = resolved ?? DEFAULT_EDITOR_LANGUAGE;
  return locale === 'pseudo' ? DEFAULT_EDITOR_LANGUAGE : locale;
}

export function formatDate(
  value: Date | number | string,
  language?: EditorFormattingLanguage,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
) {
  return new Intl.DateTimeFormat(resolveFormattingLocale(language), options).format(new Date(value));
}

export function formatTime(
  value: Date | number | string,
  language?: EditorFormattingLanguage,
  options: Intl.DateTimeFormatOptions = { timeStyle: 'short' },
) {
  return new Intl.DateTimeFormat(resolveFormattingLocale(language), options).format(new Date(value));
}

export function formatDateTime(
  value: Date | number | string,
  language?: EditorFormattingLanguage,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
) {
  return new Intl.DateTimeFormat(resolveFormattingLocale(language), options).format(new Date(value));
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  language?: EditorFormattingLanguage,
  options: Intl.RelativeTimeFormatOptions = { numeric: 'auto' },
) {
  return new Intl.RelativeTimeFormat(resolveFormattingLocale(language), options).format(value, unit);
}

export function formatNumber(
  value: number,
  language?: EditorFormattingLanguage,
  options?: Intl.NumberFormatOptions,
) {
  return new Intl.NumberFormat(resolveFormattingLocale(language), options).format(value);
}

export function formatPercent(
  value: number,
  language?: EditorFormattingLanguage,
  options: Intl.NumberFormatOptions = { maximumFractionDigits: 1 },
) {
  return new Intl.NumberFormat(resolveFormattingLocale(language), {
    style: 'percent',
    ...options,
  }).format(value);
}

export function formatFileSize(
  bytes: number,
  language?: EditorFormattingLanguage,
  { maximumFractionDigits = 1, unitSystem = 'decimal' }: FileSizeFormatOptions = {},
) {
  if (!Number.isFinite(bytes)) return formatNumber(bytes, language);

  const units = unitSystem === 'binary' ? binaryFileSizeUnits : decimalFileSizeUnits;
  const base = unitSystem === 'binary' ? 1024 : 1000;
  const sign = bytes < 0 ? -1 : 1;
  let value = Math.abs(bytes);
  let unitIndex = 0;

  while (value >= base && unitIndex < units.length - 1) {
    value /= base;
    unitIndex += 1;
  }

  const formattedValue = formatNumber(value * sign, language, {
    maximumFractionDigits: unitIndex === 0 ? 0 : maximumFractionDigits,
  });
  return `${formattedValue} ${units[unitIndex]}`;
}

export function createEditorFormatters(language?: EditorFormattingLanguage) {
  return {
    date: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) =>
      formatDate(value, language, options),
    time: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) =>
      formatTime(value, language, options),
    dateTime: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) =>
      formatDateTime(value, language, options),
    relativeTime: (
      value: number,
      unit: Intl.RelativeTimeFormatUnit,
      options?: Intl.RelativeTimeFormatOptions,
    ) => formatRelativeTime(value, unit, language, options),
    number: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(value, language, options),
    percent: (value: number, options?: Intl.NumberFormatOptions) => formatPercent(value, language, options),
    fileSize: (bytes: number, options?: FileSizeFormatOptions) => formatFileSize(bytes, language, options),
  };
}
