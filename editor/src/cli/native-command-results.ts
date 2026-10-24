import { PREPARED_MEDIA_MANIFEST_PATH } from '../shared/prepared-media';
import type { PreparedRuntimeArtifact } from '../shared/project-schema/prepared-runtime-artifact';
import { cliDiagnostic } from './contracts';
import type { CliSemanticResult } from './command-result-contract';

export function preparedMediaTestRequest(artifact: PreparedRuntimeArtifact) {
  const manifest = artifact.packageOptions.textEntries.find(
    (entry) => entry.packagePath === PREPARED_MEDIA_MANIFEST_PATH,
  );
  return manifest ? { preparedMediaManifest: manifest.text } : {};
}

function nativeFailure(code: string, pathValue: string, response: unknown): CliSemanticResult {
  const record =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  const diagnostics = Array.isArray(record.diagnostics)
    ? record.diagnostics.map((item) => {
        const value = item as Record<string, unknown>;
        return cliDiagnostic(
          typeof value.code === 'string' ? `native.${value.code}` : code,
          typeof value.path === 'string' ? value.path : pathValue,
          typeof value.message === 'string' ? value.message : 'Native operation failed.',
          value.severity === 'warning' || value.severity === 'info' ? value.severity : 'error',
        );
      })
    : [];
  if (diagnostics.length === 0)
    diagnostics.push(
      cliDiagnostic(
        code,
        pathValue,
        typeof record.error === 'string' ? record.error : 'Native operation failed.',
      ),
    );
  return { ok: false, diagnostics };
}

export function nativeSuccess(response: unknown): CliSemanticResult {
  const record =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  if (record.ok !== true || record.success === false)
    return nativeFailure('native.operation', '/', response);
  return { ok: true, diagnostics: [], fields: { native: record } };
}

export function nativeTestResult(response: unknown): CliSemanticResult {
  const record =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  if (record.ok !== true) return nativeFailure('native.test', '/tests', response);
  const report =
    record.report && typeof record.report === 'object'
      ? (record.report as Record<string, unknown>)
      : null;
  if (report?.passed === false) {
    const diagnostics = Array.isArray(report.diagnostics)
      ? report.diagnostics.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const diagnostic = item as Record<string, unknown>;
          if (typeof diagnostic.message !== 'string') return [];
          return [
            cliDiagnostic(
              'native.test.failed',
              typeof diagnostic.path === 'string' ? diagnostic.path : '/tests',
              diagnostic.message,
              diagnostic.severity === 'warning' || diagnostic.severity === 'info'
                ? diagnostic.severity
                : 'error',
            ),
          ];
        })
      : [];
    return {
      ok: false,
      diagnostics:
        diagnostics.length > 0
          ? diagnostics
          : [cliDiagnostic('native.test.failed', '/tests', 'Authored Test failed.')],
      fields: { native: record },
    };
  }
  if (record.success === false) {
    const failed = nativeFailure('native.test', '/tests', response);
    return { ...failed, fields: { ...failed.fields, native: record } };
  }
  return { ok: true, diagnostics: [], fields: { native: record } };
}

export function nativeSuiteResult(response: unknown): CliSemanticResult {
  const record =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  if (record.ok !== true) {
    const failed = nativeFailure('native.test.suite', '/tests', response);
    return { ...failed, fields: { ...failed.fields, native: record } };
  }
  const report =
    record.report && typeof record.report === 'object'
      ? (record.report as Record<string, unknown>)
      : null;
  if (!report || !Array.isArray(report.entries))
    return nativeFailure('native.test.suite', '/tests', {
      error: 'Native suite report is invalid.',
    });

  const diagnostics = report.entries.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const entry = value as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id : 'unknown';
    if (entry.status === 'failed')
      return [cliDiagnostic('native.test.failed', `/tests/${id}`, `Test '${id}' failed.`)];
    if (entry.status === 'blocked') {
      const nested = Array.isArray(entry.diagnostics) ? entry.diagnostics : [];
      const promoted = nested.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const diagnostic = item as Record<string, unknown>;
        if (typeof diagnostic.message !== 'string') return [];
        return [
          cliDiagnostic(
            'native.test.blocked',
            typeof diagnostic.path === 'string' ? diagnostic.path : `/tests/${id}`,
            diagnostic.message,
            'warning',
          ),
        ];
      });
      return promoted.length > 0
        ? promoted
        : [
            cliDiagnostic(
              'native.test.blocked',
              `/tests/${id}`,
              `Test '${id}' is blocked and was not executed.`,
              'warning',
            ),
          ];
    }
    if (entry.status === 'error') {
      const nested = Array.isArray(entry.diagnostics) ? entry.diagnostics : [];
      const promoted = nested.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const diagnostic = item as Record<string, unknown>;
        if (typeof diagnostic.message !== 'string') return [];
        return [
          cliDiagnostic(
            'native.test.error',
            typeof diagnostic.path === 'string' ? diagnostic.path : `/tests/${id}`,
            diagnostic.message,
          ),
        ];
      });
      return promoted.length > 0
        ? promoted
        : [cliDiagnostic('native.test.error', `/tests/${id}`, `Test '${id}' could not execute.`)];
    }
    return [];
  });
  const counts =
    report.counts && typeof report.counts === 'object'
      ? (report.counts as Record<string, unknown>)
      : {};
  const count = (key: string) =>
    typeof counts[key] === 'number' && Number.isInteger(counts[key]) ? counts[key] : 0;
  const summary =
    `Test suite: ${count('passed')} passed, ${count('failed')} failed, ` +
    `${count('blocked')} blocked, ${count('error')} errors.`;
  const verdictFailure = report.entries.some(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      ((value as Record<string, unknown>).status === 'failed' ||
        (value as Record<string, unknown>).status === 'error'),
  );
  // Native transport acceptance and Test verdict are different authorities.
  // A malformed runner success flag must not turn a failed suite into success.
  const success = record.success !== false && report.passed !== false && !verdictFailure;
  if (!success) diagnostics.push(cliDiagnostic('native.test.suite.summary', '/tests', summary));
  return {
    ok: success,
    diagnostics,
    fields: { native: record },
    ...(success ? { humanSuccess: summary } : {}),
  };
}
