import path from 'node:path';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import type { ParsedGlobalArguments } from './bootstrap';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';
import { nativeProjectDiagnostics } from './native-project-results';
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
  native?: NativeProjectCommandCall,
): Promise<NovelTeaWorkspacePreflightResult> {
  const resolvedCwd = path.resolve(cwd);
  if (native) {
    const projectRoot = await nativeProjectRoot(resolvedCwd, globals.project, fileSystem);
    let response: Readonly<Record<string, unknown>>;
    try {
      response = projectRoot
        ? await native({ action: 'workspace-preflight', projectRoot })
        : { ok: false };
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (response.ok === true && projectRoot) return { ok: true, projectRoot };
    const diagnostics = nativeProjectDiagnostics({ cliDiagnostics: response.diagnostics });
    if (diagnostics.length === 0)
      diagnostics.push(
        cliDiagnostic(
          projectRoot ? 'WORKSPACE_MANIFEST_READ' : 'WORKSPACE_NOT_FOUND',
          '/project.yaml',
          (typeof response.error === 'string' ? response.error : undefined) ??
            (projectRoot
              ? 'Native workspace preflight failed.'
              : 'No NovelTea project.yaml was found from the current directory upward.'),
        ),
      );
    return {
      ok: false,
      result: formatCliResult(
        {
          success: false,
          exitCode:
            response.exitCode === 5
              ? NOVELTEA_CLI_EXIT_CODES.mutation
              : NOVELTEA_CLI_EXIT_CODES.workspace,
          diagnostics,
          ...(projectRoot ? { projectRoot } : {}),
        },
        globals.json,
        { failure: diagnostics[0]!.message },
      ),
    };
  }
  const { discoverProjectRoot, validateExplicitProjectRoot } =
    await import('../shared/project-workspace/project-workspace-discovery');
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
