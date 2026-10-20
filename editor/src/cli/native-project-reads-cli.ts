import { novelTeaCliUsageFailure, type ParsedGlobalArguments } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
  type NovelTeaCliDiagnostic,
} from './contracts';
import type { NativeProjectCommandCall } from './native-project-lifecycle-cli';
import { nativeProjectRoot } from './native-project-lifecycle-cli';
import { nativeProjectDiagnostics } from './native-project-results';

const localizationStatuses = new Set([
  'missing',
  'current',
  'outdated',
  'needs-review',
  'reviewed',
  'human',
  'ai',
  'imported',
  'unknown',
  'attention',
]);

export async function runNativeProjectReadsCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
): Promise<NovelTeaCliCommandResult | null> {
  const args = globals.command;
  const [family, operation] = args;
  const action =
    family === 'entity' && operation === 'inspect'
      ? 'entity-inspect'
      : family === 'usages'
        ? 'entity-usages'
        : family === 'localization' && operation === 'view'
          ? 'localization-view'
          : family === 'asset' && operation === 'audit'
            ? 'asset-audit'
            : null;
  if (!action) return null;

  let attributes: Record<string, unknown> = {};
  let humanSuccess = '';
  let missingPath = '/';
  if (action === 'entity-inspect' || action === 'entity-usages') {
    const values = action === 'entity-inspect' ? args.slice(2) : args.slice(1);
    const provenance = action === 'entity-inspect' && values.includes('--provenance');
    const positionals = values.filter((value) => value !== '--provenance');
    if (
      positionals.length !== 2 ||
      values.length !== positionals.length + (provenance ? 1 : 0) ||
      positionals.some((value) => value.startsWith('--'))
    )
      return novelTeaCliUsageFailure(
        action === 'entity-inspect'
          ? 'Usage: noveltea entity inspect <collection> <id> [--provenance]'
          : 'Usage: noveltea usages <collection> <id>',
        globals.json,
      );
    const [collection, id] = positionals as [string, string];
    // Keep public grammar validation at the transport boundary; native
    // admission and inspection still own the actual Project record.
    const { requireAuthoringCollection } = await import('./commands/types');
    try {
      requireAuthoringCollection(collection);
    } catch {
      return novelTeaCliUsageFailure(`Unknown collection '${collection}'.`, globals.json);
    }
    if (action === 'entity-inspect') {
      const { entityIdSchema } = await import('../shared/project-schema/authoring-common');
      if (!entityIdSchema.safeParse(id).success)
        return novelTeaCliUsageFailure(`Invalid record ID '${id}'.`, globals.json);
    }
    attributes = { collection, id, ...(provenance ? { provenance } : {}) };
    missingPath = `/${collection}/${id}`;
    humanSuccess = action === 'entity-inspect' ? '' : `Found usages for ${collection}/${id}.`;
  } else if (action === 'asset-audit') {
    if (args.length !== 2)
      return novelTeaCliUsageFailure('Usage: noveltea asset audit', globals.json);
  } else {
    const values = args.slice(2);
    const statuses = values.reduce<string[]>((acc, item, index) => {
      if (values[index - 1] === '--status') acc.push(item);
      return acc;
    }, []);
    const locales = values.filter(
      (value, index) => value !== '--status' && values[index - 1] !== '--status',
    );
    if (
      locales.length !== 1 ||
      locales[0]!.startsWith('--') ||
      statuses.length > 1 ||
      values.length !== 1 + statuses.length * 2 ||
      (statuses.length === 1 && !localizationStatuses.has(statuses[0]!))
    )
      return novelTeaCliUsageFailure(
        'Usage: noveltea localization view <locale> [--status <status>]',
        globals.json,
      );
    attributes = { locale: locales[0], ...(statuses.length ? { status: statuses[0] } : {}) };
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

  let response: Record<string, unknown>;
  try {
    response = (await native({ action, projectRoot: root, ...attributes })) as Record<
      string,
      unknown
    >;
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (response.ok !== true) {
    const nativeDiagnostics = Array.isArray(response.diagnostics) ? response.diagnostics : [];
    const diagnostics: NovelTeaCliDiagnostic[] = nativeDiagnostics
      .filter(
        (diagnostic): diagnostic is NovelTeaCliDiagnostic =>
          typeof diagnostic === 'object' &&
          diagnostic !== null &&
          typeof diagnostic.code === 'string' &&
          typeof diagnostic.path === 'string' &&
          typeof diagnostic.message === 'string' &&
          diagnostic.severity === 'error',
      )
      .map((diagnostic) =>
        cliDiagnostic(diagnostic.code, diagnostic.path, diagnostic.message, diagnostic.severity),
      );
    const message = String(
      response.error ?? diagnostics[0]?.message ?? 'Native Project read failed.',
    );
    const entityNotFound =
      (action === 'entity-inspect' || action === 'entity-usages') &&
      /does not exist|cannot read .* source|unknown record/i.test(message);
    const malformedRequestedRecord =
      action === 'entity-inspect' &&
      /^Invalid (?:Room|Map|record) YAML:/i.test(message) &&
      typeof attributes.collection === 'string' &&
      typeof attributes.id === 'string';
    const malformedSourcePath = malformedRequestedRecord
      ? attributes.collection === 'layouts'
        ? `/records/layouts/${attributes.id}/layout.yaml`
        : `/records/${attributes.collection}/${attributes.id}.yaml`
      : missingPath;
    if (diagnostics.length === 0)
      diagnostics.push(
        cliDiagnostic(
          entityNotFound ? 'authoring.entity.not_found' : 'WORKSPACE_SOURCE_READ',
          malformedSourcePath,
          malformedRequestedRecord ? 'Record is malformed.' : message,
        ),
      );
    diagnostics.push(...nativeProjectDiagnostics(response));
    const exitCode = [3, 4, 5, 6].includes(Number(response.exitCode))
      ? (Number(response.exitCode) as 3 | 4 | 5 | 6)
      : diagnostics.some(
            (diagnostic) => diagnostic.code === 'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT',
          )
        ? NOVELTEA_CLI_EXIT_CODES.mutation
        : diagnostics.some((diagnostic) => diagnostic.code.startsWith('WORKSPACE_'))
          ? NOVELTEA_CLI_EXIT_CODES.workspace
          : NOVELTEA_CLI_EXIT_CODES.semantic;
    return formatCliResult(
      {
        success: false,
        exitCode,
        diagnostics,
        projectRoot: root,
      },
      globals.json,
      { failure: message },
    );
  }
  const fields =
    action === 'entity-inspect'
      ? response.fields
      : action === 'entity-usages'
        ? { collection: response.collection, id: response.id, usages: response.usages }
        : action === 'localization-view'
          ? {
              locale: response.locale,
              ...(response.statusFilter ? { statusFilter: response.statusFilter } : {}),
              messages: response.messages,
            }
          : response.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw new Error('Native Project read returned an invalid result shape.');
  if (action === 'entity-inspect') {
    const inspected = fields as { record: unknown; provenance?: unknown };
    humanSuccess = JSON.stringify(
      attributes.provenance
        ? { record: inspected.record, provenance: inspected.provenance }
        : inspected.record,
      null,
      2,
    );
  } else if (action === 'localization-view') {
    humanSuccess = `Localization view for ${String(response.locale)}: ${(response.messages as unknown[]).length} Message(s).`;
  } else if (action === 'asset-audit') {
    humanSuccess = String(response.humanSuccess);
  }
  return formatCliResult(
    {
      success: true,
      exitCode: NOVELTEA_CLI_EXIT_CODES.success,
      diagnostics: nativeProjectDiagnostics(response),
      projectRoot: root,
      ...fields,
    },
    globals.json,
    { success: humanSuccess },
  );
}
