/** Shared lexical contract for numeric Project controls. An incomplete number
 * is never coerced into a native Project value; its raw text remains pending. */
export function parseProjectNumberText(
  text: string,
  options: { mode?: 'integer' | 'decimal'; min?: number; max?: number } = {},
): number | undefined {
  const { mode = 'decimal', min, max } = options;
  const complete =
    mode === 'integer' ? /^[+-]?\d+$/u.test(text) : /^[+-]?(?:\d+|\d+\.\d+|\.\d+)$/u.test(text);
  if (!complete) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return undefined;
  if (mode === 'integer' && !Number.isSafeInteger(parsed)) return undefined;
  if (min !== undefined && parsed < min) return undefined;
  if (max !== undefined && parsed > max) return undefined;
  return parsed;
}
