export { NOVELTEA_CLI_HELP, NOVELTEA_CLI_VERSION } from './static-contracts';

export const NOVELTEA_CLI_EXIT_CODES = {
  success: 0,
  usage: 2,
  workspace: 3,
  semantic: 4,
  mutation: 5,
  native: 6,
  interrupted: 130,
  internal: 70,
} as const;

export const NOVELTEA_CLI_WORKSPACE_DIAGNOSTIC_CODES = Object.freeze([
  'CLI_USAGE',
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_MANIFEST_READ',
  'WORKSPACE_MANIFEST_INVALID',
  'WORKSPACE_VERSION_UNSUPPORTED',
  'WORKSPACE_PATH_INVALID',
  'WORKSPACE_RECORD_ID_PATH_MISMATCH',
  'WORKSPACE_DUPLICATE_RECORD_ID',
  'WORKSPACE_SOURCE_OWNERSHIP_CONFLICT',
  'WORKSPACE_SOURCE_READ',
  'WORKSPACE_REVISION_CONFLICT',
  'WORKSPACE_BUSY',
  'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT',
  'WORKSPACE_EXTERNAL_STRUCTURAL_INVALID',
  'AGENT_KIT_WORKSPACE_UNSUPPORTED',
  'AGENT_BOOTSTRAP_MISSING',
  'AGENT_BOOTSTRAP_OUTDATED',
  'AGENT_BOOTSTRAP_MANUAL_REPAIR_REQUIRED',
  'AGENT_LOCAL_STATE_NOT_IGNORED',
  'AGENT_SYNC_MUTATION_FAILED',
  'PROJECT_CREATE_DESTINATION_CONFLICT',
  'PROJECT_CREATE_MUTATION_FAILED',
  'PROJECT_CREATE_INTERNAL',
] as const);

export type NovelTeaCliExitCode =
  (typeof NOVELTEA_CLI_EXIT_CODES)[keyof typeof NOVELTEA_CLI_EXIT_CODES];

export interface NovelTeaCliDiagnostic {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly path: string;
  readonly message: string;
  readonly sourceUrl?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface NovelTeaCliEnvelope {
  readonly success: boolean;
  readonly exitCode: NovelTeaCliExitCode;
  readonly diagnostics: readonly NovelTeaCliDiagnostic[];
  readonly [key: string]: unknown;
}

export interface NovelTeaCliCommandResult {
  readonly exitCode: NovelTeaCliExitCode;
  readonly envelope: NovelTeaCliEnvelope;
  readonly stdout: string;
  readonly stderr: string;
}

export function compareCliDiagnostics(
  left: NovelTeaCliDiagnostic,
  right: NovelTeaCliDiagnostic,
): number {
  const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return (
    compareText(left.code, right.code) ||
    compareText(left.path, right.path) ||
    compareText(left.sourceUrl ?? '', right.sourceUrl ?? '') ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0) ||
    compareText(left.message, right.message)
  );
}

export function sortedCliDiagnostics(
  diagnostics: readonly NovelTeaCliDiagnostic[],
): NovelTeaCliDiagnostic[] {
  return [...diagnostics].sort(compareCliDiagnostics);
}

export function cliDiagnostic(
  code: string,
  path: string,
  message: string,
  severity: NovelTeaCliDiagnostic['severity'] = 'error',
  location: Pick<NovelTeaCliDiagnostic, 'sourceUrl' | 'line' | 'column'> = {},
): NovelTeaCliDiagnostic {
  return { code, severity, path, message, ...location };
}

export function formatCliResult(
  envelopeInput: Readonly<Record<string, unknown>> & {
    success: boolean;
    exitCode: NovelTeaCliExitCode;
    diagnostics?: readonly NovelTeaCliDiagnostic[];
  },
  json: boolean,
  human?: Readonly<{ success?: string; failure?: string }>,
): NovelTeaCliCommandResult {
  const diagnostics = sortedCliDiagnostics(envelopeInput.diagnostics ?? []);
  const envelope: NovelTeaCliEnvelope = {
    ...envelopeInput,
    success: envelopeInput.success,
    exitCode: envelopeInput.exitCode,
    diagnostics,
  };
  if (json) {
    return {
      exitCode: envelope.exitCode,
      envelope,
      stdout: `${JSON.stringify(envelope)}\n`,
      stderr: '',
    };
  }
  const diagnosticText = diagnostics
    .map((item) => `[${item.severity}] ${item.code} ${item.path}: ${item.message}`)
    .join('\n');
  const message = envelope.success ? (human?.success ?? '') : (human?.failure ?? '');
  return {
    exitCode: envelope.exitCode,
    envelope,
    stdout: envelope.success && message ? `${message}\n` : '',
    stderr:
      !envelope.success || diagnostics.length > 0
        ? `${[diagnosticText, !envelope.success ? message : ''].filter(Boolean).join('\n')}${diagnosticText || message ? '\n' : ''}`
        : '',
  };
}
