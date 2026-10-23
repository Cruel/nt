import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { ParsedGlobalArguments } from './bootstrap';
import { novelTeaCliUsageFailure } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
  type NovelTeaCliExitCode,
} from './contracts';
import { parseProjectCreate } from './project-create-cli';
import { nativeProjectFailure } from './native-project-results';
import { parseProjectImport, parseProjectExport } from './project-bundle-cli';

type NativeProjectResponse = Readonly<{
  ok: boolean;
  [key: string]: unknown;
  error?: string;
  kind?: string;
  projectRoot?: string;
  projectFilePath?: string;
  projectId?: string;
  outputPath?: string;
  manifest?: Readonly<{ schema: string; version: number; files: readonly unknown[] }>;
}>;

export type NativeProjectCommandCall = (
  request: Readonly<Record<string, unknown>>,
) => NativeProjectResponse | Promise<NativeProjectResponse>;

export async function nativeProjectRoot(
  cwd: string,
  selected?: string,
  fileSystem?: import('../shared/project-workspace/project-workspace-file-system').ProjectWorkspaceFileSystem,
): Promise<string | null> {
  let current = path.resolve(cwd, selected ?? '.');
  const isFile = async (candidate: string): Promise<boolean> =>
    fileSystem
      ? (await fileSystem.inspect(candidate)) === 'file'
      : stat(candidate).then(
          (item) => item.isFile(),
          () => false,
        );
  if (selected) return (await isFile(path.join(current, 'project.yaml'))) ? current : null;
  for (;;) {
    if (await isFile(path.join(current, 'project.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The host transports the request. Parsing, source admission, transactions and ZIP I/O are native. */
export async function runNativeProjectLifecycleCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
  pinned?: Readonly<{
    projectRoot: string;
    preparation:
      | import('../shared/project-workspace/resident-project-workspace-service').NativeResidentProjectPreparation
      | null;
  }>,
): Promise<NovelTeaCliCommandResult | null> {
  const [family, operation] = globals.command;
  if (family !== 'project' || !['create', 'import', 'export'].includes(operation ?? ''))
    return null;

  let request: Record<string, unknown>;
  let errorPath: string;
  try {
    if (operation === 'create') {
      if (globals.project)
        throw new Error("Global option '--project' is not supported by 'project create'.");
      const parsed = parseProjectCreate(globals.command);
      errorPath = path.resolve(cwd, parsed.directory);
      request = { action: 'project-create', projectRoot: errorPath, name: parsed.name };
    } else if (operation === 'import') {
      if (globals.project)
        throw new Error("Global option '--project' is not supported by 'project import'.");
      const parsed = parseProjectImport(globals.command);
      errorPath = path.resolve(cwd, parsed.bundle);
      request = {
        action: 'project-import',
        bundlePath: errorPath,
        destination: path.resolve(cwd, parsed.destination),
      };
    } else {
      const parsed = parseProjectExport(globals.command);
      errorPath = path.resolve(cwd, parsed.output);
      // Discovery locates physical candidates only. The native session is the
      // sole authority for YAML admission, identity and dependent sources.
      if (pinned && !pinned.preparation)
        return formatCliResult(
          {
            success: false,
            exitCode: NOVELTEA_CLI_EXIT_CODES.internal,
            diagnostics: [
              cliDiagnostic(
                'CLI_INTERNAL',
                '/',
                'Pinned Project export has no native preparation. Refusing disk re-admission.',
              ),
            ],
          },
          globals.json,
          { failure: 'Pinned Project export has no native preparation.' },
        );
      const root = pinned?.projectRoot ?? (await nativeProjectRoot(cwd, globals.project));
      if (!root)
        return formatCliResult(
          {
            success: false,
            exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
            diagnostics: [
              cliDiagnostic(
                'WORKSPACE_NOT_FOUND',
                '/project.yaml',
                'No NovelTea project.yaml was found from the current directory upward.',
              ),
            ],
          },
          globals.json,
          { failure: 'No NovelTea project.yaml was found from the current directory upward.' },
        );
      request = {
        action: 'project-export',
        projectRoot: root,
        outputPath: errorPath,
        ...(pinned?.preparation
          ? {
              pinnedProject: pinned.preparation.project,
              expectedSourceRevisions: pinned.preparation.sourceRevisions,
            }
          : {}),
      };
    }
  } catch (error) {
    return novelTeaCliUsageFailure(
      error instanceof Error ? error.message : String(error),
      globals.json,
    );
  }

  let response: NativeProjectResponse;
  try {
    response = await native(request);
  } catch (error) {
    // A transport failure must never retry the native call: it may already have committed.
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    const message = response.error ?? 'Native Project lifecycle operation failed.';
    const code =
      operation === 'create'
        ? response.kind === 'conflict'
          ? 'PROJECT_CREATE_DESTINATION_CONFLICT'
          : response.kind === 'internal'
            ? 'PROJECT_CREATE_INTERNAL'
            : 'PROJECT_CREATE_MUTATION_FAILED'
        : response.kind === 'conflict'
          ? 'PROJECT_BUNDLE_DESTINATION_CONFLICT'
          : response.kind === 'invalid-bundle'
            ? 'PROJECT_BUNDLE_INVALID'
            : response.kind === 'invalid-project'
              ? 'PROJECT_BUNDLE_PROJECT_INVALID'
              : response.kind === 'source-changed'
                ? 'PROJECT_BUNDLE_SOURCE_CHANGED'
                : 'PROJECT_BUNDLE_MUTATION_FAILED';
    const exitCode: NovelTeaCliExitCode =
      operation === 'create' && response.kind === 'internal'
        ? NOVELTEA_CLI_EXIT_CODES.internal
        : response.kind === 'invalid-bundle' || response.kind === 'invalid-project'
          ? NOVELTEA_CLI_EXIT_CODES.semantic
          : NOVELTEA_CLI_EXIT_CODES.mutation;
    return formatCliResult(
      nativeProjectFailure(response, { code, path: errorPath!, message, exitCode }),
      globals.json,
      { failure: message },
    );
  }

  const projectRoot =
    response.projectRoot ?? (typeof request.projectRoot === 'string' ? request.projectRoot : '');
  if (operation === 'create' || operation === 'import') {
    if (
      !response.projectRoot ||
      !response.projectFilePath ||
      (operation === 'create' ? !response.projectId : !response.manifest)
    )
      throw new Error('Native Project lifecycle response is missing required identity fields.');
    const fields =
      operation === 'create'
        ? { projectRoot, projectFilePath: response.projectFilePath, projectId: response.projectId }
        : {
            projectRoot,
            projectFilePath: response.projectFilePath,
            bundleSchema: response.manifest!.schema,
            bundleVersion: response.manifest!.version,
          };
    return formatCliResult(
      { success: true, exitCode: NOVELTEA_CLI_EXIT_CODES.success, diagnostics: [], ...fields },
      globals.json,
      {
        success:
          operation === 'create'
            ? `Created NovelTea project at ${projectRoot}.`
            : `Imported NovelTea project to ${projectRoot}.`,
      },
    );
  }
  if (!response.outputPath || !response.manifest)
    throw new Error('Native Project export response is missing required archive fields.');
  return formatCliResult(
    {
      success: true,
      exitCode: NOVELTEA_CLI_EXIT_CODES.success,
      diagnostics: [],
      projectRoot: String(request.projectRoot),
      outputPath: response.outputPath,
      bundleSchema: response.manifest.schema,
      bundleVersion: response.manifest.version,
      fileCount: response.manifest.files.length,
    },
    globals.json,
    { success: `Exported portable NovelTea project to ${response.outputPath}.` },
  );
}
