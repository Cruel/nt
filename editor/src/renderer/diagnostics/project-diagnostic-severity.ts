import type { ToolDiagnostic, ToolSeverity } from '../../shared/editor-tooling';

const severityRank: Record<ToolSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

function decodePointerSegment(segment: string) {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function diagnosticSeverityForRecord(
  diagnostics: readonly ToolDiagnostic[],
  collection: string | undefined,
  entityId: string | undefined,
): ToolSeverity | null {
  if (!collection || !entityId) return null;
  let result: ToolSeverity | null = null;

  for (const diagnostic of diagnostics) {
    const [, rawCollection, rawEntityId] = diagnostic.path.split('/');
    if (
      decodePointerSegment(rawCollection ?? '') !== collection ||
      decodePointerSegment(rawEntityId ?? '') !== entityId
    ) {
      continue;
    }
    if (result === null || severityRank[diagnostic.severity] > severityRank[result]) {
      result = diagnostic.severity;
    }
  }

  return result;
}

export function diagnosticCountsForCollection(
  diagnostics: readonly ToolDiagnostic[],
  collection: string | undefined,
) {
  const counts = { warning: 0, error: 0 };
  if (!collection) return counts;

  for (const diagnostic of diagnostics) {
    const [, rawCollection] = diagnostic.path.split('/');
    if (decodePointerSegment(rawCollection ?? '') !== collection) continue;
    if (diagnostic.severity === 'warning') counts.warning += 1;
    if (diagnostic.severity === 'error') counts.error += 1;
  }

  return counts;
}
