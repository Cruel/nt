import { cliDiagnostic, type NovelTeaCliDiagnostic } from './contracts';

/** Project-authoritative pre-mutation diagnostics supplied by the native owner. */
export function nativeProjectDiagnostics(
  response: Readonly<Record<string, unknown>>,
): NovelTeaCliDiagnostic[] {
  if (!Array.isArray(response.cliDiagnostics)) return [];
  return response.cliDiagnostics.flatMap((value): NovelTeaCliDiagnostic[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (
      typeof item.code !== 'string' ||
      typeof item.path !== 'string' ||
      typeof item.message !== 'string' ||
      (item.severity !== 'warning' && item.severity !== 'info' && item.severity !== 'error')
    )
      return [];
    return [
      cliDiagnostic(item.code, item.path, item.message, item.severity, {
        ...(typeof item.sourceUrl === 'string' ? { sourceUrl: item.sourceUrl } : {}),
        ...(typeof item.line === 'number' ? { line: item.line } : {}),
        ...(typeof item.column === 'number' ? { column: item.column } : {}),
      }),
    ];
  });
}
