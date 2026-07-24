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

export function resolveFormattingLocale(
  language: EditorFormattingLanguage = DEFAULT_EDITOR_LANGUAGE,
) {
  const resolved = language ? resolveSupportedEditorLanguage(language) : DEFAULT_EDITOR_LANGUAGE;
  const locale = resolved ?? DEFAULT_EDITOR_LANGUAGE;
  return locale === 'pseudo' ? DEFAULT_EDITOR_LANGUAGE : locale;
}

export function formatDate(
  value: Date | number | string,
  language?: EditorFormattingLanguage,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
) {
  return new Intl.DateTimeFormat(resolveFormattingLocale(language), options).format(
    new Date(value),
  );
}

export function formatTime(
  value: Date | number | string,
  language?: EditorFormattingLanguage,
  options: Intl.DateTimeFormatOptions = { timeStyle: 'short' },
) {
  return new Intl.DateTimeFormat(resolveFormattingLocale(language), options).format(
    new Date(value),
  );
}

export function formatDateTime(
  value: Date | number | string,
  language?: EditorFormattingLanguage,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
) {
  return new Intl.DateTimeFormat(resolveFormattingLocale(language), options).format(
    new Date(value),
  );
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  language?: EditorFormattingLanguage,
  options: Intl.RelativeTimeFormatOptions = { numeric: 'auto' },
) {
  return new Intl.RelativeTimeFormat(resolveFormattingLocale(language), options).format(
    value,
    unit,
  );
}

export function formatNumber(
  value: number | bigint,
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

function formatBigIntRatio(
  value: bigint,
  divisor: bigint,
  language?: EditorFormattingLanguage,
  maximumFractionDigits = 1,
) {
  const negative = value < 0n;
  const absoluteValue = negative ? -value : value;
  const scale = 10n ** BigInt(maximumFractionDigits);
  const rounded = (absoluteValue * scale + divisor / 2n) / divisor;
  const whole = rounded / scale;
  const fraction = rounded % scale;
  const signedWhole = negative ? -whole : whole;
  const formattedWhole = formatNumber(signedWhole, language);
  if (fraction === 0n || maximumFractionDigits === 0) return formattedWhole;
  const decimalSeparator =
    new Intl.NumberFormat(resolveFormattingLocale(language))
      .formatToParts(1.1)
      .find((part) => part.type === 'decimal')?.value ?? '.';
  const formattedFraction = fraction
    .toString()
    .padStart(maximumFractionDigits, '0')
    .replace(/0+$/, '');
  return `${formattedWhole}${decimalSeparator}${formattedFraction}`;
}

export function formatBigIntPercent(
  numerator: bigint,
  denominator: bigint,
  language?: EditorFormattingLanguage,
  { maximumFractionDigits = 1 }: Intl.NumberFormatOptions = {},
) {
  if (denominator === 0n) return null;
  const locale = resolveFormattingLocale(language);
  const templateParts = new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits,
  }).formatToParts(1);
  const numericTypes = new Set(['integer', 'group', 'decimal', 'fraction']);
  const firstNumeric = templateParts.findIndex((part) => numericTypes.has(part.type));
  const lastNumeric = templateParts.findLastIndex((part) => numericTypes.has(part.type));
  const prefix = templateParts
    .slice(0, firstNumeric)
    .map((part) => part.value)
    .join('');
  const suffix = templateParts
    .slice(lastNumeric + 1)
    .map((part) => part.value)
    .join('');
  return `${prefix}${formatBigIntRatio(
    numerator * 100n,
    denominator,
    language,
    maximumFractionDigits,
  )}${suffix}`;
}

export function formatFileSize(
  bytes: number | bigint,
  language?: EditorFormattingLanguage,
  { maximumFractionDigits = 1, unitSystem = 'decimal' }: FileSizeFormatOptions = {},
) {
  if (typeof bytes === 'number' && !Number.isFinite(bytes)) return formatNumber(bytes, language);

  if (typeof bytes === 'bigint') {
    const units = unitSystem === 'binary' ? binaryFileSizeUnits : decimalFileSizeUnits;
    const base = BigInt(unitSystem === 'binary' ? 1024 : 1000);
    const sign = bytes < 0n ? -1n : 1n;
    const value = bytes < 0n ? -bytes : bytes;
    let divisor = 1n;
    let unitIndex = 0;
    while (value >= divisor * base && unitIndex < units.length - 1) {
      divisor *= base;
      unitIndex += 1;
    }
    if (unitIndex === 0) return `${formatNumber(bytes, language)} ${units[0]}`;
    return `${formatBigIntRatio(value * sign, divisor, language, maximumFractionDigits)} ${units[unitIndex]}`;
  }

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
    number: (value: number | bigint, options?: Intl.NumberFormatOptions) =>
      formatNumber(value, language, options),
    percent: (value: number, options?: Intl.NumberFormatOptions) =>
      formatPercent(value, language, options),
    percentRatio: (numerator: bigint, denominator: bigint, options?: Intl.NumberFormatOptions) =>
      formatBigIntPercent(numerator, denominator, language, options),
    fileSize: (bytes: number | bigint, options?: FileSizeFormatOptions) =>
      formatFileSize(bytes, language, options),
    durationNs: (nanoseconds: bigint) => {
      if (nanoseconds < 1_000_000n) return `${formatBigIntRatio(nanoseconds, 1_000n, language)} µs`;
      if (nanoseconds < 1_000_000_000n)
        return `${formatBigIntRatio(nanoseconds, 1_000_000n, language)} ms`;
      return `${formatBigIntRatio(nanoseconds, 1_000_000_000n, language)} s`;
    },
  };
}
