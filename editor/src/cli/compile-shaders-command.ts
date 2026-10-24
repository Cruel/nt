import path from 'node:path';
import { buildShaderMaterialProject } from '../shared/project-schema/shader-material-project';
import type { AuthoringProject } from '../shared/project-schema/authoring-project';
import type { NovelTeaCliNativeToolService } from './native-tool-service';
import { cliDiagnostic } from './contracts';
import type { CliSemanticResult } from './command-result-contract';
import { CliCommandUsageError } from './commands/errors';

export function parseCliShaderCompile(arguments_: readonly string[]) {
  const variants: string[] = [];
  let forceRebuild = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index]!;
    if (value === '--force-rebuild') {
      if (forceRebuild)
        throw new CliCommandUsageError("Option '--force-rebuild' may be supplied only once.");
      forceRebuild = true;
    } else if (value === '--variant') {
      const variant = arguments_[++index];
      if (!variant || variant.startsWith('--'))
        throw new CliCommandUsageError('--variant requires a value.');
      if (!['glsl-330', 'essl-300', 'metal'].includes(variant))
        throw new CliCommandUsageError(`Unknown shader variant '${variant}'.`);
      variants.push(variant);
    } else throw new CliCommandUsageError(`Unknown command option '${value}'.`);
  }
  return {
    shaderVariants: variants.length ? [...new Set(variants)] : ['glsl-330', 'essl-300', 'metal'],
    forceRebuild,
  };
}

/** Shared downstream shader/reflection pipeline; Project admission belongs to the caller. */
export async function compileCliShaders(
  project: AuthoringProject,
  projectRoot: string,
  nativeTools: Pick<NovelTeaCliNativeToolService, 'compileShaders'>,
  options: ReturnType<typeof parseCliShaderCompile>,
  sourceOverlays?: Readonly<Record<string, string>>,
): Promise<CliSemanticResult> {
  const shaderProject = await buildShaderMaterialProject(project, [], {
    certifyPresetPrograms: true,
  });
  const diagnostics = shaderProject.diagnostics.map((item) =>
    cliDiagnostic('shader.material_project', item.path, item.message, item.severity),
  );
  if (diagnostics.some((item) => item.severity === 'error')) return { ok: false, diagnostics };
  const response = await nativeTools.compileShaders(shaderProject.compilation, {
    projectRoot,
    outputRoot: path.join(projectRoot, '.noveltea', 'build'),
    cacheRoot: path.join(projectRoot, '.noveltea', 'cache'),
    ...options,
    sourceOverlays,
  });
  if (response.ok !== true || response.success === false) {
    diagnostics.push(
      ...(response.diagnostics ?? []).map((item) =>
        cliDiagnostic(
          item.code ? `native.${item.code}` : 'native.operation',
          item.path ?? '/',
          item.message,
          item.severity,
        ),
      ),
    );
    if (!response.diagnostics?.length)
      diagnostics.push(
        cliDiagnostic('native.operation', '/', response.error ?? 'Native operation failed.'),
      );
    return { ok: false, diagnostics };
  }
  diagnostics.push(
    ...(await buildShaderMaterialProject(project, response.outputs ?? [])).diagnostics.map((item) =>
      cliDiagnostic('shader.material_project', item.path, item.message, item.severity),
    ),
  );
  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    diagnostics,
    fields: { native: response },
  };
}
