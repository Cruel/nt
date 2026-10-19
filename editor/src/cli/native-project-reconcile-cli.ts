import { novelTeaCliUsageFailure, type ParsedGlobalArguments } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
} from './contracts';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';
import { nativeProjectDiagnostics } from './native-project-results';

interface ReconciliationInput {
  expectedWorkspaceRevision: string;
  expectedFingerprint: string;
  resolutions: Record<string, string>;
}

function reconciliationInput(value: unknown): ReconciliationInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.expectedWorkspaceRevision !== 'string' ||
    typeof item.expectedFingerprint !== 'string' ||
    !item.resolutions ||
    typeof item.resolutions !== 'object' ||
    Array.isArray(item.resolutions) ||
    !Object.values(item.resolutions).every((entry) => typeof entry === 'string' && entry.length > 0)
  )
    return null;
  return {
    expectedWorkspaceRevision: item.expectedWorkspaceRevision,
    expectedFingerprint: item.expectedFingerprint,
    resolutions: item.resolutions as Record<string, string>,
  };
}

/** Native reconciliation owns both planning and source-authoritative commit. */
export async function runNativeProjectReconcileCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
  readStdinText: () => string | undefined,
): Promise<NovelTeaCliCommandResult | null> {
  if (globals.command[0] !== 'localization' || globals.command[1] !== 'reconcile') return null;
  const options = globals.command.slice(2);
  if (options.length > 1 || (options.length === 1 && options[0] !== '--apply'))
    return novelTeaCliUsageFailure(
      'localization reconcile does not accept positional arguments.',
      globals.json,
    );
  const apply = options.includes('--apply');
  let input: ReconciliationInput | null = null;
  if (apply) {
    let stdin: unknown;
    try {
      const text = readStdinText();
      if (!text || text.trim() === '')
        throw new Error('Command requires one UTF-8 JSON value on stdin.');
      stdin = JSON.parse(text) as unknown;
    } catch (error) {
      return novelTeaCliUsageFailure(
        error instanceof Error ? error.message : String(error),
        globals.json,
      );
    }
    input = reconciliationInput(stdin);
  }
  const root = await nativeProjectRoot(cwd, globals.project);
  if (!root) {
    const message = 'No NovelTea project.yaml was found from the current directory upward.';
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
        diagnostics: [cliDiagnostic('WORKSPACE_NOT_FOUND', '/project.yaml', message)],
      },
      globals.json,
      { failure: message },
    );
  }
  const planningRequest = { action: 'localization-reconcile', projectRoot: root, dryRun: true };
  let prepared;
  try {
    prepared = await native(planningRequest);
  } catch (error) {
    prepared = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!prepared.ok) {
    const message = prepared.error ?? 'Native localization reconciliation could not be planned.';
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
        diagnostics: [cliDiagnostic('localization.reconcile.native', '/localization', message)],
        projectRoot: root,
      },
      globals.json,
      { failure: message },
    );
  }
  const plan = prepared.plan as {
    expectedWorkspaceRevision?: unknown;
    expectedFingerprint?: unknown;
    groups?: unknown;
  };
  if (
    !plan ||
    typeof plan.expectedWorkspaceRevision !== 'string' ||
    typeof plan.expectedFingerprint !== 'string' ||
    !Array.isArray(plan.groups)
  )
    throw new Error('Native reconciliation response omitted its authoritative plan.');

  if (!apply) {
    return formatCliResult(
      {
        success: true,
        exitCode: NOVELTEA_CLI_EXIT_CODES.success,
        diagnostics: nativeProjectDiagnostics(prepared),
        projectRoot: root,
        plan,
        writes: [],
      },
      globals.json,
      {
        success:
          plan.groups.length === 0
            ? 'Localization reconciliation has no pending work.'
            : `Localization reconciliation found ${plan.groups.length} pending group(s).`,
      },
    );
  }
  const fail = (code: string, message: string, fields: Record<string, unknown> = {}) =>
    formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
        diagnostics: [
          cliDiagnostic(code, code.endsWith('invalid-input') ? '/stdin' : '/localization', message),
          ...nativeProjectDiagnostics(prepared),
        ],
        projectRoot: root,
        plan,
        ...fields,
      },
      globals.json,
      { failure: message },
    );
  if (!input)
    return fail(
      'localization.reconcile.invalid-input',
      'localization reconcile --apply requires one JSON object on stdin with expectedWorkspaceRevision, expectedFingerprint, and resolutions.',
    );
  if (
    input.expectedWorkspaceRevision !== plan.expectedWorkspaceRevision ||
    input.expectedFingerprint !== plan.expectedFingerprint
  )
    return fail(
      'localization.reconcile.stale-plan',
      'The reconciliation plan is stale because the Project workspace changed. Recompute the plan before applying it.',
    );
  if (
    typeof prepared.sourceGeneration !== 'string' ||
    !prepared.diskPreconditions ||
    typeof prepared.diskPreconditions !== 'object'
  )
    throw new Error('Native reconciliation plan omitted exact physical source preconditions.');
  let applied;
  try {
    applied = await native({
      ...planningRequest,
      dryRun: false,
      workspaceRevision: plan.expectedWorkspaceRevision,
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      expectedFingerprint: input.expectedFingerprint,
      resolutions: input.resolutions,
      expectedSourceGeneration: prepared.sourceGeneration,
      diskPreconditions: prepared.diskPreconditions,
    });
  } catch (error) {
    applied = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!applied.ok) {
    if (applied.status === 'needs-decision' && Array.isArray(applied.occurrenceIds))
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          projectRoot: root,
          plan: applied.plan ?? plan,
          occurrenceIds: applied.occurrenceIds,
          diagnostics: (applied.occurrenceIds as string[]).map((id) =>
            cliDiagnostic(
              'localization.reconcile.decision-required',
              '/localization',
              `Reconciliation occurrence '${id}' contains valuable prior work and requires an explicit resolution.`,
            ),
          ),
        },
        globals.json,
      );
    const message =
      applied.error ?? 'Native reconciliation source authority changed during commit.';
    return fail('localization.reconcile.stale-plan', message);
  }
  const fields = {
    relinkedMessageIds: applied.relinkedMessageIds,
    materializedMessageIds: applied.materializedMessageIds,
    orphanedMessageIds: applied.orphanedMessageIds,
    garbageCollectedMessageIds: applied.garbageCollectedMessageIds,
    writes: applied.writes,
  };
  if (!Object.values(fields).every(Array.isArray))
    throw new Error('Native reconciliation result omitted its committed changes.');
  return formatCliResult(
    {
      success: true,
      exitCode: NOVELTEA_CLI_EXIT_CODES.success,
      diagnostics: nativeProjectDiagnostics(applied),
      projectRoot: root,
      ...fields,
    },
    globals.json,
    {
      success:
        (applied.writes as unknown[]).length > 0
          ? 'Localization reconciliation applied.'
          : 'Localization reconciliation is already resolved.',
    },
  );
}
