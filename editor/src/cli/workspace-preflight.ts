import path from 'node:path';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import {
  discoverProjectRoot,
  validateExplicitProjectRoot,
} from '../shared/project-workspace/project-workspace-discovery';
import type { ParsedGlobalArguments } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
} from './contracts';

export type NovelTeaWorkspacePreflightResult =
  | Readonly<{ ok: true; projectRoot: string }>
  | Readonly<{ ok: false; result: NovelTeaCliCommandResult }>;

export async function preflightNovelTeaWorkspace(
  globals: ParsedGlobalArguments,
  fileSystem: ProjectWorkspaceFileSystem,
  cwd = process.cwd(),
): Promise<NovelTeaWorkspacePreflightResult> {
  const resolvedCwd = path.resolve(cwd);
  const discovery = globals.project
    ? await validateExplicitProjectRoot(fileSystem, path.resolve(resolvedCwd, globals.project))
    : await discoverProjectRoot(fileSystem, resolvedCwd);
  if (discovery.ok) return { ok: true, projectRoot: discovery.projectRoot };
  return {
    ok: false,
    result: formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
        diagnostics: [cliDiagnostic(discovery.code, discovery.path, discovery.message)],
        ...(discovery.projectRoot ? { projectRoot: discovery.projectRoot } : {}),
      },
      globals.json,
      { failure: discovery.message },
    ),
  };
}
