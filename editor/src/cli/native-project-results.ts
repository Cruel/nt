import { cliDiagnostic, type NovelTeaCliDiagnostic, type NovelTeaCliExitCode } from './contracts';

export function nativeProjectFailure(
  response: Readonly<Record<string, unknown>>,
  fallback: Readonly<{
    code: string;
    path: string;
    message: string;
    exitCode: NovelTeaCliExitCode;
  }>,
) {
  const errors = nativeProjectDiagnostics({ cliDiagnostics: response.diagnostics });
  return {
    success: false as const,
    exitCode: [2, 3, 4, 5, 6, 70, 130].includes(Number(response.exitCode))
      ? (Number(response.exitCode) as NovelTeaCliExitCode)
      : errors.some((item) =>
            [
              'WORKSPACE_BUSY',
              'WORKSPACE_REVISION_CONFLICT',
              'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT',
            ].includes(item.code),
          )
        ? (5 as const)
        : errors.some((item) => item.code.startsWith('WORKSPACE_'))
          ? (3 as const)
          : fallback.exitCode,
    diagnostics: [
      ...(errors.length ? errors : [cliDiagnostic(fallback.code, fallback.path, fallback.message)]),
      ...nativeProjectDiagnostics(response),
    ],
  };
}

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
