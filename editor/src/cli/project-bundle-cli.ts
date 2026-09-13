import path from 'node:path';
import {
  discoverProjectRoot,
  validateExplicitProjectRoot,
  type ProjectWorkspaceFileSystem,
  type ProjectWorkspaceService,
} from '../shared/project-workspace';
import {
  exportPortableProjectBundle,
  importPortableProjectBundle,
  PortableProjectBundleError,
} from '../main/services/portable-project-bundle-service';
import { novelTeaCliUsageFailure, type ParsedGlobalArguments } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
  type NovelTeaCliExitCode,
} from './contracts';

function parseProjectExport(command: readonly string[]): { output: string } {
  let output: string | undefined;
  for (let index = 2; index < command.length; index += 1) {
    const argument = command[index];
    if (argument !== '--output') throw new Error(`Unknown command option '${argument}'.`);
    const value = command[index + 1];
    if (!value || value.startsWith('--')) throw new Error("Option '--output' requires a path.");
    if (output !== undefined) throw new Error("Option '--output' may be supplied only once.");
    output = value;
    index += 1;
  }
  if (output === undefined) throw new Error("Required option '--output' was not supplied.");
  return { output };
}

function parseProjectImport(command: readonly string[]): { bundle: string; destination: string } {
  if (command.length !== 4)
    throw new Error('Usage: noveltea project import <bundle.ntproject> <destination-directory>.');
  const bundle = command[2];
  const destination = command[3];
  if (!bundle || bundle.startsWith('--'))
    throw new Error('Portable Project bundle path is required.');
  if (!destination || destination.startsWith('--'))
    throw new Error('Project destination directory is required.');
  return { bundle, destination };
}

function bundleFailureCode(error: PortableProjectBundleError): string {
  switch (error.kind) {
    case 'conflict':
      return 'PROJECT_BUNDLE_DESTINATION_CONFLICT';
    case 'invalid-bundle':
      return 'PROJECT_BUNDLE_INVALID';
    case 'invalid-project':
      return 'PROJECT_BUNDLE_PROJECT_INVALID';
    case 'source-changed':
      return 'PROJECT_BUNDLE_SOURCE_CHANGED';
    case 'mutation':
      return 'PROJECT_BUNDLE_MUTATION_FAILED';
  }
}

function bundleFailureExitCode(error: PortableProjectBundleError): NovelTeaCliExitCode {
  return error.kind === 'invalid-bundle' || error.kind === 'invalid-project'
    ? NOVELTEA_CLI_EXIT_CODES.semantic
    : NOVELTEA_CLI_EXIT_CODES.mutation;
}

function failure(
  error: PortableProjectBundleError,
  json: boolean,
  diagnosticPath: string,
): NovelTeaCliCommandResult {
  return formatCliResult(
    {
      success: false,
      exitCode: bundleFailureExitCode(error),
      diagnostics: [cliDiagnostic(bundleFailureCode(error), diagnosticPath, error.message)],
    },
    json,
    { failure: error.message },
  );
}

export async function runNovelTeaProjectBundleCli(
  globals: ParsedGlobalArguments,
  fileSystem: ProjectWorkspaceFileSystem,
  workspace: ProjectWorkspaceService,
  cwd: string,
): Promise<NovelTeaCliCommandResult | null> {
  if (globals.command[0] !== 'project') return null;

  if (globals.command[1] === 'import') {
    let parsed: ReturnType<typeof parseProjectImport>;
    try {
      if (globals.project)
        throw new Error("Global option '--project' is not supported by 'project import'.");
      parsed = parseProjectImport(globals.command);
    } catch (error) {
      return novelTeaCliUsageFailure(
        error instanceof Error ? error.message : String(error),
        globals.json,
      );
    }
    const bundlePath = path.resolve(cwd, parsed.bundle);
    const destination = path.resolve(cwd, parsed.destination);
    try {
      const imported = await importPortableProjectBundle(
        fileSystem,
        workspace,
        bundlePath,
        destination,
      );
      return formatCliResult(
        {
          success: true,
          exitCode: NOVELTEA_CLI_EXIT_CODES.success,
          diagnostics: [],
          projectRoot: imported.projectRoot,
          projectFilePath: imported.projectFilePath,
          bundleSchema: imported.manifest.schema,
          bundleVersion: imported.manifest.version,
        },
        globals.json,
        { success: `Imported NovelTea project to ${imported.projectRoot}.` },
      );
    } catch (error) {
      const bundleError =
        error instanceof PortableProjectBundleError
          ? error
          : new PortableProjectBundleError(
              'mutation',
              error instanceof Error ? error.message : String(error),
            );
      return failure(bundleError, globals.json, bundlePath);
    }
  }

  if (globals.command[1] !== 'export') return null;
  let parsed: ReturnType<typeof parseProjectExport>;
  try {
    parsed = parseProjectExport(globals.command);
  } catch (error) {
    return novelTeaCliUsageFailure(
      error instanceof Error ? error.message : String(error),
      globals.json,
    );
  }

  const discovery = globals.project
    ? await validateExplicitProjectRoot(fileSystem, path.resolve(cwd, globals.project))
    : await discoverProjectRoot(fileSystem, cwd);
  if (!discovery.ok)
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
        diagnostics: [cliDiagnostic(discovery.code, discovery.path, discovery.message)],
      },
      globals.json,
      { failure: discovery.message },
    );

  const opened = await workspace.open(discovery.projectRoot);
  if (!opened.ok || opened.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    const diagnostic =
      opened.diagnostics.find((candidate) => candidate.severity === 'error') ??
      opened.diagnostics[0];
    const message = diagnostic?.message ?? 'Project Workspace is invalid.';
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
        diagnostics: [
          cliDiagnostic(
            diagnostic?.code ?? 'PROJECT_BUNDLE_PROJECT_INVALID',
            diagnostic?.path ?? '/',
            message,
            diagnostic?.severity ?? 'error',
          ),
        ],
      },
      globals.json,
      { failure: message },
    );
  }

  const outputPath = path.resolve(cwd, parsed.output);
  try {
    const exported = await exportPortableProjectBundle(fileSystem, opened.snapshot, outputPath);
    return formatCliResult(
      {
        success: true,
        exitCode: NOVELTEA_CLI_EXIT_CODES.success,
        diagnostics: [],
        projectRoot: discovery.projectRoot,
        outputPath: exported.outputPath,
        bundleSchema: exported.manifest.schema,
        bundleVersion: exported.manifest.version,
        fileCount: exported.manifest.files.length,
      },
      globals.json,
      { success: `Exported portable NovelTea project to ${exported.outputPath}.` },
    );
  } catch (error) {
    const bundleError =
      error instanceof PortableProjectBundleError
        ? error
        : new PortableProjectBundleError(
            'mutation',
            error instanceof Error ? error.message : String(error),
          );
    return failure(bundleError, globals.json, outputPath);
  }
}
