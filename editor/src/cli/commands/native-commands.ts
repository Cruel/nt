import path from 'node:path';
import { buildShaderMaterialProject } from '../../shared/project-schema/shader-material-project';
import { buildRuntimePlaybackSpecFromAuthoringTest } from '../../shared/project-schema/test-playback-project';
import {
  exportSettingsFromProject,
  selectedExportProfile,
} from '../../shared/project-schema/authoring-export';
import { prepareRuntimeArtifact } from '../../shared/runtime-artifact-preparation';
import {
  nodeRuntimeArtifactPaths,
  nodeShaderCompilerAdapter,
} from '../../main/services/node-runtime-artifact-adapters';
import { cliDiagnostic } from '../contracts';
import type { CliSemanticResult } from '../semantic-project';
import type { CliCommandContext, CliCommandDefinition, CliCommandInvocation } from './types';
import { CliCommandUsageError } from './types';

const shaderVariantIds = new Set(['glsl-120', 'essl-100', 'essl-300', 'metal']);

function nativeFailure(code: string, pathValue: string, response: unknown): CliSemanticResult {
  const record =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  const diagnostics = Array.isArray(record.diagnostics)
    ? record.diagnostics.map((item) => {
        const value = item as Record<string, unknown>;
        return cliDiagnostic(
          typeof value.code === 'string' ? `native.${value.code}` : code,
          typeof value.path === 'string' ? value.path : pathValue,
          typeof value.message === 'string' ? value.message : 'Native operation failed.',
          value.severity === 'warning' || value.severity === 'info' ? value.severity : 'error',
        );
      })
    : [];
  if (diagnostics.length === 0)
    diagnostics.push(
      cliDiagnostic(
        code,
        pathValue,
        typeof record.error === 'string' ? record.error : 'Native operation failed.',
      ),
    );
  return { ok: false, diagnostics };
}

function nativeSuccess(response: unknown): CliSemanticResult {
  const record =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  if (record.ok !== true || record.success === false)
    return nativeFailure('native.operation', '/', response);
  return { ok: true, diagnostics: [], fields: { native: record } };
}

function publishedProject(context: CliCommandContext): unknown {
  const published = context.workspace.publishCompiledArtifact(context.snapshot);
  if (!published.ok)
    return {
      ok: false,
      diagnostics: published.diagnostics.map((item) =>
        cliDiagnostic(item.code, item.jsonPointer, item.message, item.severity),
      ),
    } satisfies CliSemanticResult;
  return published.project.project;
}

function valueOption(arguments_: readonly string[], option: string): string | undefined {
  const index = arguments_.indexOf(option);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith('--'))
    throw new CliCommandUsageError(`${option} requires a value.`);
  return value;
}

export const shadersCompileCommand: CliCommandDefinition = {
  path: ['shaders', 'compile'],
  parse(arguments_): CliCommandInvocation {
    const variants: string[] = [];
    let forceRebuild = false;
    for (let index = 0; index < arguments_.length; index += 1) {
      const value = arguments_[index]!;
      if (value === '--force-rebuild') {
        if (forceRebuild)
          throw new CliCommandUsageError("Option '--force-rebuild' may be supplied only once.");
        forceRebuild = true;
        continue;
      }
      if (value === '--variant') {
        const variant = arguments_[++index];
        if (!variant || variant.startsWith('--'))
          throw new CliCommandUsageError('--variant requires a value.');
        if (!shaderVariantIds.has(variant))
          throw new CliCommandUsageError(`Unknown shader variant '${variant}'.`);
        variants.push(variant);
        continue;
      }
      throw new CliCommandUsageError(`Unknown command option '${value}'.`);
    }
    return {
      dryRun: false,
      mutation: false,
      async run(context) {
        const shaderProject = await buildShaderMaterialProject(context.snapshot.project);
        const schemaDiagnostics = shaderProject.diagnostics.map((item) =>
          cliDiagnostic('shader.material_project', item.path, item.message, item.severity),
        );
        if (schemaDiagnostics.some((item) => item.severity === 'error'))
          return { ok: false, diagnostics: schemaDiagnostics };
        const response = await context.nativeTools.compileShaders(shaderProject.project, {
          projectRoot: context.snapshot.projectRoot,
          outputRoot: path.join(context.snapshot.projectRoot, '.noveltea', 'build'),
          cacheRoot: path.join(context.snapshot.projectRoot, '.noveltea', 'cache'),
          shaderVariants:
            variants.length > 0
              ? [...new Set(variants)]
              : ['glsl-120', 'essl-100', 'essl-300', 'metal'],
          forceRebuild,
        });
        const result = nativeSuccess(response);
        return { ...result, diagnostics: [...schemaDiagnostics, ...result.diagnostics] };
      },
    };
  },
};

export const testRunCommand: CliCommandDefinition = {
  path: ['test', 'run'],
  parse(arguments_): CliCommandInvocation {
    if (arguments_.length !== 1)
      throw new CliCommandUsageError('test run requires exactly one test ID.');
    const testId = arguments_[0]!;
    return {
      dryRun: false,
      mutation: false,
      async run(context) {
        const built = await buildRuntimePlaybackSpecFromAuthoringTest(
          context.snapshot.project,
          testId,
        );
        if (!built.ok || !built.project || !built.spec)
          return {
            ok: false,
            diagnostics: built.diagnostics.map((item) =>
              cliDiagnostic('native.test.spec', item.path, item.message, item.severity),
            ),
          };
        return nativeSuccess(
          await context.nativeTools.runHeadlessTest({ project: built.project, spec: built.spec }),
        );
      },
    };
  },
};

function stdinTestCommand(pathValue: readonly string[], ui: boolean): CliCommandDefinition {
  return {
    path: pathValue,
    parse(arguments_): CliCommandInvocation {
      if (arguments_.length !== 0)
        throw new CliCommandUsageError(`${pathValue.join(' ')} does not accept arguments.`);
      return {
        dryRun: false,
        mutation: false,
        async run(context) {
          const spec = context.stdinJson;
          if (spec === undefined)
            return {
              ok: false,
              diagnostics: [
                cliDiagnostic(
                  'CLI_USAGE',
                  '/stdin',
                  'Command requires one UTF-8 JSON value on stdin.',
                ),
              ],
            };
          const project = publishedProject(context);
          if (project && typeof project === 'object' && 'ok' in project)
            return project as CliSemanticResult;
          return nativeSuccess(
            await (ui
              ? context.nativeTools.runUiTest({ project, spec })
              : context.nativeTools.runHeadlessTest({ project, spec })),
          );
        },
      };
    },
  };
}

export const testRunSpecCommand = stdinTestCommand(['test', 'run-spec'], false);
export const testRunUiSpecCommand = stdinTestCommand(['test', 'run-ui-spec'], true);

export const packageExportCommand: CliCommandDefinition = {
  path: ['package', 'export'],
  parse(arguments_): CliCommandInvocation {
    const allowed = new Set(['--output', '--profile']);
    for (let index = 0; index < arguments_.length; index += 1) {
      const value = arguments_[index]!;
      if (!allowed.has(value)) throw new CliCommandUsageError(`Unknown command option '${value}'.`);
      if (!arguments_[index + 1] || arguments_[index + 1]!.startsWith('--'))
        throw new CliCommandUsageError(`${value} requires a value.`);
      index += 1;
    }
    const output = valueOption(arguments_, '--output');
    if (!output) throw new CliCommandUsageError("package export requires '--output <path>'.");
    const requestedProfile = valueOption(arguments_, '--profile');
    return {
      dryRun: false,
      mutation: false,
      async run(context) {
        const settings = exportSettingsFromProject(context.snapshot.project);
        const profile = requestedProfile
          ? settings.profiles.find((candidate) => candidate.id === requestedProfile)
          : selectedExportProfile(context.snapshot.project);
        if (!profile)
          return {
            ok: false,
            diagnostics: [
              cliDiagnostic(
                'export.profile_missing',
                '/settings/export',
                `Export profile '${requestedProfile}' does not exist.`,
              ),
            ],
          };
        const prepared = await prepareRuntimeArtifact({
          project: context.snapshot.project,
          projectRoot: context.snapshot.projectRoot,
          profile,
          intent: 'runtime-package-export',
          shaderCompiler: nodeShaderCompilerAdapter((shaderProject, options) =>
            context.nativeTools.compileShaders(shaderProject, options),
          ),
          paths: nodeRuntimeArtifactPaths,
        });
        if (prepared.status !== 'prepared')
          return {
            ok: false,
            diagnostics: prepared.diagnostics.map((item) =>
              cliDiagnostic(item.code, item.path, item.message, item.severity),
            ),
          };
        return nativeSuccess(
          await context.nativeTools.exportPackage({
            project: prepared.artifact.compiledProject,
            outputPath: path.resolve(context.cwd, output),
            options: prepared.artifact.packageOptions,
          }),
        );
      },
    };
  },
};
