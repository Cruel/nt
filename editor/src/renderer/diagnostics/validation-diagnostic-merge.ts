import type { ToolDiagnostic } from '../../shared/editor-tooling';

function diagnosticIdentity(diagnostic: ToolDiagnostic): string {
  return [diagnostic.code ?? '', diagnostic.severity, diagnostic.path, diagnostic.message].join(
    '\u0000',
  );
}

export function mergeEditorValidationDiagnostics(
  primary: readonly ToolDiagnostic[],
  supplemental: readonly ToolDiagnostic[],
): ToolDiagnostic[] {
  const seen = new Set(primary.map(diagnosticIdentity));
  return [
    ...primary,
    ...supplemental.filter((diagnostic) => {
      const key = diagnosticIdentity(diagnostic);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}
