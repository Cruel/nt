import type { AuthoringProject } from '../shared/project-schema/authoring-project';
import { authoringCollectionKeys } from '../shared/project-schema/authoring-collections';
import { novelTeaCliUsageFailure, type ParsedGlobalArguments } from './bootstrap';
import { compileCliShaders, parseCliShaderCompile } from './compile-shaders-command';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
} from './contracts';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';
import { nativeProjectDiagnostics } from './native-project-results';
import type { NovelTeaCliNativeToolService } from './native-tool-service';

/** Local certification candidate. Resident/disposable generation transport is staged separately. */
export async function runNativeProjectShadersCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
  nativeTools: Pick<NovelTeaCliNativeToolService, 'compileShaders'>,
): Promise<NovelTeaCliCommandResult | null> {
  if (globals.command[0] !== 'shaders' || globals.command[1] !== 'compile') return null;
  let options;
  try {
    options = parseCliShaderCompile(globals.command.slice(2));
  } catch (error) {
    return novelTeaCliUsageFailure(
      error instanceof Error ? error.message : String(error),
      globals.json,
    );
  }
  const projectRoot = await nativeProjectRoot(cwd, globals.project);
  const fail = (code: string, message: string, exitCode: 3 | 4 | 6 | 70) =>
    formatCliResult(
      {
        success: false,
        exitCode,
        diagnostics: [cliDiagnostic(code, '/', message)],
        ...(projectRoot ? { projectRoot } : {}),
      },
      globals.json,
      { failure: message },
    );
  if (!projectRoot)
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
  try {
    const prepared = await native({ action: 'shader-preparation', projectRoot });
    if (!prepared.ok)
      return fail(
        prepared.kind === 'conflict' ? 'WORKSPACE_REVISION_CONFLICT' : 'WORKSPACE_SOURCE_READ',
        prepared.error ?? 'Native shader preparation failed.',
        3,
      );
    if (
      !prepared.project ||
      typeof prepared.project !== 'object' ||
      Array.isArray(prepared.project) ||
      typeof prepared.sourceGeneration !== 'string' ||
      !prepared.sourceGeneration ||
      !prepared.sourceOverlays ||
      typeof prepared.sourceOverlays !== 'object' ||
      Array.isArray(prepared.sourceOverlays) ||
      Object.values(prepared.sourceOverlays).some((text) => typeof text !== 'string')
    )
      return fail(
        'CLI_INTERNAL',
        'Native shader preparation returned an invalid result shape.',
        70,
      );
    // Empty collections are transport structure, not TypeScript Project admission/default expansion.
    const project = { ...prepared.project } as AuthoringProject;
    for (const family of authoringCollectionKeys) if (!(family in project)) project[family] = {};
    const semantic = await compileCliShaders(
      project,
      projectRoot,
      nativeTools,
      options,
      prepared.sourceOverlays as Record<string, string>,
    );
    const proof = await native({
      action: 'source-generation-proof',
      projectRoot,
      expectedSourceGeneration: prepared.sourceGeneration,
    });
    if (!proof.ok)
      return fail(
        'WORKSPACE_REVISION_CONFLICT',
        proof.error ?? 'Project sources changed during shader compilation.',
        3,
      );
    const diagnostics = [...nativeProjectDiagnostics(prepared), ...semantic.diagnostics];
    const exitCode = semantic.ok
      ? 0
      : diagnostics.some((item) => item.code.startsWith('native.'))
        ? 6
        : 4;
    return formatCliResult(
      {
        success: semantic.ok,
        exitCode,
        diagnostics,
        projectRoot,
        ...semantic.fields,
      },
      globals.json,
      {
        success: 'NovelTea shaders compile succeeded.',
        failure:
          diagnostics.find((item) => item.severity === 'error')?.message ?? 'Command failed.',
      },
    );
  } catch (error) {
    return fail('CLI_INTERNAL', error instanceof Error ? error.message : String(error), 70);
  }
}
