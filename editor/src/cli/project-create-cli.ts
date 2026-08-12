import type {
  ProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
} from '../shared/project-workspace';
import {
  createNovelTeaProject,
  NovelTeaProjectCreationError,
} from '../shared/project-workspace/project-creation-service';
import { novelTeaCliUsageFailure, type ParsedGlobalArguments } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
} from './contracts';

function parseProjectCreate(command: readonly string[]) {
  const directory = command[2];
  let name: string | undefined;
  if (!directory || directory.startsWith('--')) throw new Error('Project directory is required.');
  for (let index = 3; index < command.length; index += 1) {
    if (command[index] !== '--name') throw new Error(`Unknown command option '${command[index]}'.`);
    const value = command[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error("Option '--name' requires a project name.");
    if (name !== undefined) throw new Error("Option '--name' may be supplied only once.");
    name = value;
    index += 1;
  }
  if (name === undefined) throw new Error("Required option '--name' was not supplied.");
  return { directory, name };
}

export async function runNovelTeaProjectCreateCli(
  globals: ParsedGlobalArguments,
  fileSystem: ProjectWorkspaceFileSystem,
  workspace: ProjectWorkspaceService,
): Promise<NovelTeaCliCommandResult> {
  let parsed: ReturnType<typeof parseProjectCreate>;
  try {
    if (globals.project)
      throw new Error("Global option '--project' is not supported by 'project create'.");
    parsed = parseProjectCreate(globals.command);
  } catch (error) {
    return novelTeaCliUsageFailure(
      error instanceof Error ? error.message : String(error),
      globals.json,
    );
  }

  try {
    const created = await createNovelTeaProject(fileSystem, workspace, {
      projectName: parsed.name,
      projectDirectory: fileSystem.resolvePath(parsed.directory),
    });
    return formatCliResult(
      {
        success: true,
        exitCode: NOVELTEA_CLI_EXIT_CODES.success,
        diagnostics: [],
        ...created,
      },
      globals.json,
      { success: `Created NovelTea project at ${created.projectRoot}.` },
    );
  } catch (error) {
    const creation =
      error instanceof NovelTeaProjectCreationError
        ? error
        : new NovelTeaProjectCreationError(
            'internal',
            error instanceof Error ? error.message : String(error),
          );
    const exitCode =
      creation.kind === 'internal'
        ? NOVELTEA_CLI_EXIT_CODES.internal
        : NOVELTEA_CLI_EXIT_CODES.mutation;
    const code =
      creation.kind === 'conflict'
        ? 'PROJECT_CREATE_DESTINATION_CONFLICT'
        : creation.kind === 'internal'
          ? 'PROJECT_CREATE_INTERNAL'
          : 'PROJECT_CREATE_MUTATION_FAILED';
    return formatCliResult(
      {
        success: false,
        exitCode,
        diagnostics: [cliDiagnostic(code, parsed.directory, creation.message)],
      },
      globals.json,
      { failure: creation.message },
    );
  }
}
