import path from 'node:path';
import { novelTeaCliUsageFailure, type ParsedGlobalArguments } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
} from './contracts';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';
import { nativeProjectDiagnostics, nativeProjectFailure } from './native-project-results';

/**
 * Certification-only transport for already-native physical mutations.
 * Native C++ prepares, validates and commits every source. This adapter only
 * interprets the public CLI grammar and the stable JSON result envelope.
 */
export async function runNativeProjectMutationsCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
): Promise<NovelTeaCliCommandResult | null> {
  const [family, operation] = globals.command;
  const entityOperation =
    family === 'entity' && ['create', 'rename', 'delete'].includes(operation ?? '');
  const assetImport = family === 'asset' && operation === 'import';
  if (!entityOperation && !assetImport) return null;

  let attributes: Record<string, unknown>;
  let errorPath = '/';
  let dryRun = false;
  try {
    const { parseCommandFlags, requireAuthoringCollection } = await import('./commands/types');
    const allowedFlags = entityOperation
      ? operation === 'create'
        ? ['--dry-run']
        : operation === 'rename'
          ? ['--dry-run', '--allow-possible-source-references']
          : ['--dry-run', '--force', '--allow-possible-source-references']
      : ['--dry-run'];
    const parsed = parseCommandFlags(globals.command.slice(2), allowedFlags);
    dryRun = parsed.flags.has('--dry-run');
    if (entityOperation) {
      if (parsed.positionals.length !== (operation === 'rename' ? 3 : 2))
        throw new Error(
          operation === 'rename'
            ? 'Usage: noveltea entity rename <collection> <old-id> <new-id> [--dry-run] [--allow-possible-source-references]'
            : operation === 'create'
              ? 'Usage: noveltea entity create <collection> <id> [--dry-run]'
              : 'Usage: noveltea entity delete <collection> <id> [--dry-run] [--force] [--allow-possible-source-references]',
        );
      const [collectionValue, id, toId] = parsed.positionals;
      const collection = requireAuthoringCollection(collectionValue!);
      if (operation === 'create' && collection === 'assets')
        throw new Error(
          "Generic Asset creation is not supported; use 'noveltea asset import <path>'.",
        );
      errorPath = `/${collection}/${id}`;
      attributes = {
        action: `entity-${operation}`,
        collection,
        id,
        dryRun,
        ...(toId === undefined ? {} : { toId }),
        ...(parsed.flags.has('--force') ? { force: true } : {}),
        ...(parsed.flags.has('--allow-possible-source-references')
          ? { allowPossibleSourceReferences: true }
          : {}),
      };
    } else {
      if (!parsed.positionals.length)
        throw new Error('Usage: noveltea asset import <path>... [--dry-run]');
      attributes = {
        action: 'asset-import',
        paths: parsed.positionals.map((source) => path.resolve(cwd, source)),
        dryRun,
      };
      errorPath = '/assets';
    }
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

  const action = String(attributes.action);
  let response;
  try {
    const request = { ...attributes, projectRoot: root };
    // Renames and deletions require the native-generated source revision for
    // their commit. Planning before commit is not a JS-side source authority;
    // native checks the revision again atomically in its YAML transaction.
    if (action === 'entity-rename' || action === 'entity-delete') {
      const planned = await native({ ...request, dryRun: true });
      if (!planned.ok || dryRun) response = planned;
      else if (typeof planned.sourceRevision !== 'string') {
        response = { ok: false, error: 'Native mutation plan lacks an exact source revision.' };
      } else {
        response = await native({ ...request, sourceRevision: planned.sourceRevision });
      }
    } else {
      response = await native(request);
    }
  } catch (error) {
    // Never replay a failed transport. The disk transaction may have committed.
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (!response.ok) {
    const message = response.error ?? 'Native Project mutation failed.';
    const conflict = /revision|source changed|transaction|physical|source authority|conflict/i.test(
      message,
    );
    const code =
      action === 'asset-import'
        ? 'ASSET_IMPORT_FAILED'
        : action === 'entity-rename' && message.includes('Possible source reference')
          ? 'authoring.source_reference.possible'
          : action === 'entity-delete' && message.includes('does not exist')
            ? 'authoring.entity.not_found'
            : `authoring.entity.${operation}`;
    return formatCliResult(
      {
        ...nativeProjectFailure(response, {
          code,
          path: errorPath,
          message,
          exitCode: conflict ? NOVELTEA_CLI_EXIT_CODES.mutation : NOVELTEA_CLI_EXIT_CODES.semantic,
        }),
        projectRoot: root,
      },
      globals.json,
      { failure: message },
    );
  }
  if (action === 'asset-import') {
    const fields = response.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields))
      throw new Error('Native Asset import response lacks its Project-authoritative fields.');
    return formatCliResult(
      {
        success: true,
        exitCode: NOVELTEA_CLI_EXIT_CODES.success,
        diagnostics: nativeProjectDiagnostics(response),
        projectRoot: root,
        ...fields,
      },
      globals.json,
      { success: String(response.humanSuccess ?? 'Asset import completed.') },
    );
  }

  const collection = String(attributes.collection);
  const id = String(attributes.id);
  const plan = response.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan))
    throw new Error('Native entity mutation did not supply its authoritative physical plan.');
  const fields =
    action === 'entity-rename'
      ? {
          collection,
          fromId: id,
          toId: attributes.toId,
          commentImpacts: response.commentImpacts ?? [],
          commentNotices: response.commentNotices ?? [],
          dryRun,
          plan,
          usages: response.usages ?? [],
        }
      : action === 'entity-delete'
        ? {
            collection,
            id,
            commentImpacts: response.commentImpacts ?? [],
            dryRun,
            force: attributes.force === true,
            plan,
            usages: response.usages ?? [],
          }
        : { collection, id, dryRun, plan };
  return formatCliResult(
    {
      success: true,
      exitCode: NOVELTEA_CLI_EXIT_CODES.success,
      diagnostics: nativeProjectDiagnostics(response),
      projectRoot: root,
      ...fields,
    },
    globals.json,
    { success: `${dryRun ? 'Planned' : 'Completed'} ${action} for ${collection}/${id}.` },
  );
}
