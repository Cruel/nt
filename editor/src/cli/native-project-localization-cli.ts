import { novelTeaCliUsageFailure, type ParsedGlobalArguments } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
} from './contracts';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';
import { nativeProjectDiagnostics, nativeProjectFailure } from './native-project-results';

/** Certification-only native localization command adapter. */
export async function runNativeProjectLocalizationCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
): Promise<NovelTeaCliCommandResult | null> {
  if (globals.command[0] !== 'localization') return null;
  if (globals.command[1] === 'accept' || globals.command[1] === 'review')
    return runNativeLocalizationTargetsCli(globals, cwd, native);
  if (globals.command[1] !== 'sync') return null;
  const options = globals.command.slice(2);
  if (options.length > 1 || (options.length === 1 && options[0] !== '--dry-run'))
    return novelTeaCliUsageFailure(
      'localization sync does not accept positional arguments.',
      globals.json,
    );
  const dryRun = options.includes('--dry-run');
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
  const base = { action: 'localization-sync', projectRoot: root, dryRun: true };
  let response;
  try {
    response = await native(base);
    if (response.ok && !dryRun && response.changed) {
      if (
        typeof response.sourceRevision !== 'string' ||
        typeof response.sourceGeneration !== 'string'
      )
        throw new Error('Native localization sync plan omitted source authority.');
      response = await native({
        ...base,
        dryRun: false,
        sourceRevision: response.sourceRevision,
        expectedSourceGeneration: response.sourceGeneration,
      });
    }
  } catch (error) {
    // A transport error may follow a completed commit and must not trigger retry.
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    const message = response.error ?? 'Native localization sync failed.';
    return formatCliResult(
      {
        ...nativeProjectFailure(response, {
          code: 'localization.sync.native',
          path: '/localization',
          message,
          exitCode: NOVELTEA_CLI_EXIT_CODES.mutation,
        }),
        projectRoot: root,
      },
      globals.json,
      { failure: message },
    );
  }
  if (
    !Array.isArray(response.unresolved) ||
    !Array.isArray(response.writes) ||
    !Array.isArray(response.materializedMessageIds) ||
    !Array.isArray(response.preservedMessageIds) ||
    typeof response.structuredMessageCount !== 'number'
  )
    throw new Error('Native localization sync response is missing contract fields.');
  const diagnostics = (
    response.unresolved as Array<{
      family: string;
      ordinal: number;
      sourcePath: string;
    }>
  ).map((item) =>
    cliDiagnostic(
      'localization.sync.reconciliation-required',
      item.sourcePath,
      `Managed ${item.family.toUpperCase()} Message occurrence ${item.ordinal} is ambiguous and was left untracked.`,
      'warning',
    ),
  );
  const fields = {
    dryRun,
    changed: response.changed,
    materializedMessageIds: response.materializedMessageIds,
    preservedMessageIds: response.preservedMessageIds,
    unresolved: response.unresolved,
    structuredMessageCount: response.structuredMessageCount,
    writes: response.writes,
  };
  const humanSuccess = response.changed
    ? dryRun
      ? 'Localization sync found deterministic tracking updates.'
      : 'Localization tracking synchronized.'
    : 'Localization tracking is already synchronized.';
  return formatCliResult(
    {
      success: true,
      exitCode: NOVELTEA_CLI_EXIT_CODES.success,
      diagnostics: [...nativeProjectDiagnostics(response), ...diagnostics],
      projectRoot: root,
      ...fields,
    },
    globals.json,
    { success: humanSuccess },
  );
}

async function runNativeLocalizationTargetsCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
): Promise<NovelTeaCliCommandResult> {
  const operation = globals.command[1] as 'accept' | 'review';
  const { parseCommandFlags } = await import('./commands/types');
  let locale: string;
  let messageIds: string[];
  let dryRun: boolean;
  try {
    const parsed = parseCommandFlags(globals.command.slice(2), ['--dry-run']);
    const [selectedLocale, ...ids] = parsed.positionals;
    if (!selectedLocale || ids.length === 0)
      throw new Error(
        `localization ${operation} requires a target locale and at least one Message ID.`,
      );
    locale = selectedLocale;
    messageIds = ids;
    dryRun = parsed.flags.has('--dry-run');
  } catch (error) {
    return novelTeaCliUsageFailure(
      error instanceof Error ? error.message : String(error),
      globals.json,
    );
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
  const request = {
    action: 'localization-targets',
    projectRoot: root,
    operation,
    locale,
    messageIds,
    dryRun: true,
  };
  let response;
  try {
    response = await native(request);
    if (response.ok && !dryRun) {
      if (
        typeof response.sourceGeneration !== 'string' ||
        typeof response.sourceRevision !== 'string'
      )
        throw new Error('Native localization workflow plan lacks exact source authority.');
      response = await native({
        ...request,
        dryRun: false,
        sourceRevision: response.sourceRevision,
        expectedSourceGeneration: response.sourceGeneration,
      });
    }
  } catch (error) {
    // Do not repeat a mutation when a native transport response is lost.
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    const message = response.error ?? 'Native localization workflow failed.';
    const missing = message.includes('no target translation') || message.includes('missing');
    const outdated = message.includes('Outdated') || message.includes('stale source identity');
    const code = missing
      ? 'localization.workflow.missing'
      : outdated
        ? 'localization.review.outdated'
        : 'localization.workflow.native';
    return formatCliResult(
      {
        ...nativeProjectFailure(response, {
          code,
          path: `/localization/translations/${locale}`,
          message,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
        }),
        projectRoot: root,
        locale,
        messageIds,
      },
      globals.json,
      { failure: message },
    );
  }
  if (!Array.isArray(response.writes))
    throw new Error('Native localization workflow response lacks its physical writes.');
  return formatCliResult(
    {
      success: true,
      exitCode: NOVELTEA_CLI_EXIT_CODES.success,
      diagnostics: nativeProjectDiagnostics(response),
      projectRoot: root,
      locale,
      messageIds,
      dryRun,
      writes: response.writes,
    },
    globals.json,
    { success: `Localization ${operation} updated ${messageIds.length} Message(s).` },
  );
}
