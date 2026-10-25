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
  if (!native) throw new Error('Workspace preflight requires native Project authority.');
  const projectRoot = await nativeProjectRoot(path.resolve(cwd), globals.project, fileSystem);
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
