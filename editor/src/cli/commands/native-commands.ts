import path from 'node:path';
import { buildShaderMaterialProject } from '../../shared/project-schema/shader-material-project';
import { selectedExportProfile } from '../../shared/project-schema/authoring-export';
import {
  logicalRuntimeArtifactPaths,
  prepareRuntimeArtifact,
} from '../../shared/runtime-artifact-preparation';
import {
  captureRuntimeBuildCacheTestInputs,
  lookupCanonicalRuntimeBuildCache,
  publishCanonicalRuntimeBuildCache,
  type RuntimeBuildCacheObservation,
} from '../../shared/runtime-build-cache';
import { localizationWarningDiagnostics } from '../../shared/export-localization-closure';
import {
  buildRuntimeTestCatalog,
  findRuntimeTestCatalogEntry,
} from '../../shared/runtime-test-catalog';
import {
  nodeRuntimeArtifactPaths,
  nodeShaderCompilerAdapter,
} from '../../main/services/node-runtime-artifact-adapters';
import { NodeProjectWorkspaceProcessLiveness } from '../../shared/project-workspace';
import { cliDiagnostic } from '../contracts';
import type { CliSemanticResult } from '../semantic-project';
import type { CliCommandContext, CliCommandDefinition, CliCommandInvocation } from './types';
import { CliCommandUsageError } from './types';
import { executeCachedRuntimeArtifactWithRecovery } from '../../shared/runtime-cache-native-consumer';

const shaderVariantIds = new Set(['glsl-330', 'essl-300', 'metal']);
const runtimeBuildCacheProcessLiveness = new NodeProjectWorkspaceProcessLiveness();

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
            variants.length > 0 ? [...new Set(variants)] : ['glsl-330', 'essl-300', 'metal'],
          forceRebuild,
        });
        const result = nativeSuccess(response);
        return { ...result, diagnostics: [...schemaDiagnostics, ...result.diagnostics] };
      },
    };
  },
};

function withRuntimeCacheObservation(
  result: CliSemanticResult,
  observation: RuntimeBuildCacheObservation | null,
): CliSemanticResult {
  if (!observation) return result;
  return {
    ...result,
    fields: { ...result.fields, runtimeCache: observation },
  };
}

function nativeSuiteResult(response: unknown): CliSemanticResult {
  const record =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  if (record.ok !== true) {
    const failed = nativeFailure('native.test.suite', '/tests', response);
    return { ...failed, fields: { ...failed.fields, native: record } };
  }
  const report =
    record.report && typeof record.report === 'object'
      ? (record.report as Record<string, unknown>)
      : null;
  if (!report || !Array.isArray(report.entries))
    return nativeFailure('native.test.suite', '/tests', {
      error: 'Native suite report is invalid.',
    });

  const diagnostics = report.entries.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const entry = value as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id : 'unknown';
    if (entry.status === 'failed')
      return [cliDiagnostic('native.test.failed', `/tests/${id}`, `Test '${id}' failed.`)];
    if (entry.status === 'blocked') {
      const nested = Array.isArray(entry.diagnostics) ? entry.diagnostics : [];
      const promoted = nested.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const diagnostic = item as Record<string, unknown>;
        if (typeof diagnostic.message !== 'string') return [];
        return [
          cliDiagnostic(
            'native.test.blocked',
            typeof diagnostic.path === 'string' ? diagnostic.path : `/tests/${id}`,
            diagnostic.message,
            'warning',
          ),
        ];
      });
      return promoted.length > 0
        ? promoted
        : [
            cliDiagnostic(
              'native.test.blocked',
              `/tests/${id}`,
              `Test '${id}' is blocked and was not executed.`,
              'warning',
            ),
          ];
    }
    if (entry.status === 'error') {
      const nested = Array.isArray(entry.diagnostics) ? entry.diagnostics : [];
      const promoted = nested.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const diagnostic = item as Record<string, unknown>;
        if (typeof diagnostic.message !== 'string') return [];
        return [
          cliDiagnostic(
            'native.test.error',
            typeof diagnostic.path === 'string' ? diagnostic.path : `/tests/${id}`,
            diagnostic.message,
          ),
        ];
      });
      return promoted.length > 0
        ? promoted
        : [cliDiagnostic('native.test.error', `/tests/${id}`, `Test '${id}' could not execute.`)];
    }
    return [];
  });
  const counts =
    report.counts && typeof report.counts === 'object'
      ? (report.counts as Record<string, unknown>)
      : {};
  const count = (key: string) =>
    typeof counts[key] === 'number' && Number.isInteger(counts[key]) ? counts[key] : 0;
  const summary =
    `Test suite: ${count('passed')} passed, ${count('failed')} failed, ` +
    `${count('blocked')} blocked, ${count('error')} errors.`;
  const success = record.success !== false;
  if (!success) diagnostics.push(cliDiagnostic('native.test.suite.summary', '/tests', summary));
  return {
    ok: success,
    diagnostics,
    fields: { native: record },
    ...(success ? { humanSuccess: summary } : {}),
  };
}

async function prepareCachedTestRuntime(context: CliCommandContext, forceRebuild = false) {
  const lookup = await lookupCanonicalRuntimeBuildCache(context.fileSystem, context.snapshot);
  const rebuild = forceRebuild || context.forceRuntimeCacheRebuild;
  let artifact = rebuild ? undefined : lookup.enabled ? lookup.artifact : undefined;
  let testCatalog = rebuild ? undefined : lookup.enabled ? lookup.testCatalog : undefined;
  let cacheObservation: RuntimeBuildCacheObservation | null = null;
  if (rebuild)
    cacheObservation = { status: 'unusable', reason: 'cached-native-admission-rejected' };
  else if (lookup.enabled) cacheObservation = lookup.observation;
  const cacheHit = !rebuild && lookup.enabled && !!lookup.artifact;
  const needsArtifact = !artifact;
  const needsCatalog = !testCatalog;
  const expectedTestInputs =
    lookup.enabled && lookup.inputSnapshot
      ? (lookup.testInputSnapshot ??
        (await captureRuntimeBuildCacheTestInputs(context.fileSystem, context.snapshot).catch(
          () => undefined,
        )))
      : undefined;

  if (!artifact) {
    const prepared = await prepareRuntimeArtifact({
      project: context.snapshot.project,
      projectRoot: null,
      profile: selectedExportProfile(context.snapshot.project),
      intent: 'test-playback',
      paths: logicalRuntimeArtifactPaths,
    });
    if (prepared.status !== 'prepared') {
      const diagnostics =
        prepared.status === 'cancelled' ? prepared.diagnostics : prepared.assessment.diagnostics;
      return {
        ok: false as const,
        result: withRuntimeCacheObservation(
          {
            ok: false,
            diagnostics: diagnostics.map((item) =>
              cliDiagnostic('native.test.spec', item.path, item.message, item.severity),
            ),
          },
          cacheObservation,
        ),
      };
    }
    artifact = prepared.artifact;
  }
  if (!testCatalog) testCatalog = buildRuntimeTestCatalog(context.snapshot.project);

  if (
    lookup.enabled &&
    lookup.inputSnapshot &&
    expectedTestInputs &&
    (needsArtifact || needsCatalog)
  ) {
    const reopened = await context.workspace.open(context.snapshot.projectRoot, {
      recoverTransactions: false,
    });
    const publication = reopened.ok
      ? await publishCanonicalRuntimeBuildCache(
          context.fileSystem,
          context.snapshot,
          reopened.snapshot,
          artifact,
          testCatalog,
          lookup.inputSnapshot,
          expectedTestInputs,
          needsArtifact ? undefined : lookup.artifactText,
          { pid: process.pid, processLiveness: runtimeBuildCacheProcessLiveness },
        )
      : { published: false, reason: 'workspace-revalidation-failed' };
    cacheObservation = {
      ...(cacheObservation ?? { status: 'unusable', reason: 'metadata-unavailable' }),
      published: publication.published,
      ...(publication.reason ? { publicationReason: publication.reason } : {}),
    };
  }

  return {
    ok: true as const,
    artifact,
    testCatalog,
    cacheObservation,
    cacheHit,
  };
}

export const testRunCommand: CliCommandDefinition = {
  path: ['test', 'run'],
  parse(arguments_): CliCommandInvocation {
    if (arguments_.length > 1)
      throw new CliCommandUsageError('test run accepts at most one test ID.');
    const testId = arguments_[0];
    return {
      dryRun: false,
      mutation: false,
      async run(context) {
        if (testId && !context.snapshot.project.tests[testId])
          return {
            ok: false,
            diagnostics: [
              cliDiagnostic('native.test.spec', `/tests/${testId}`, 'Test record does not exist.'),
            ],
          };

        const prepared = await prepareCachedTestRuntime(context);
        if (!prepared.ok) return prepared.result;
        const { testCatalog, cacheObservation, cacheHit } = prepared;

        if (!testId) {
          if (!context.nativeTools.runTestSuite)
            return withRuntimeCacheObservation(
              {
                ok: false,
                diagnostics: [
                  cliDiagnostic(
                    'native.test.suite.unavailable',
                    '/tests',
                    'Native test-suite runner is unavailable.',
                  ),
                ],
              },
              cacheObservation,
            );
          let finalObservation = cacheObservation;
          let rebuildFailure: CliSemanticResult | null = null;
          const executeSuite = (runtime: typeof prepared) => {
            if (!runtime.ok) return Promise.resolve({ ok: false });
            return context.nativeTools.runTestSuite!({
              project: runtime.artifact.compiledProject,
              catalog: runtime.testCatalog,
              projectRoot: context.snapshot.projectRoot,
              shaderMaterialMetadata: runtime.artifact.shaderMaterialMetadata ?? null,
            });
          };
          const response = await executeCachedRuntimeArtifactWithRecovery({
            cached: cacheHit,
            execute: () => executeSuite(prepared),
            rebuild: async () => {
              const rebuilt = await prepareCachedTestRuntime(context, true);
              if (!rebuilt.ok) {
                rebuildFailure = rebuilt.result;
                return null;
              }
              finalObservation = rebuilt.cacheObservation;
              return () => executeSuite(rebuilt);
            },
          });
          if (rebuildFailure) return rebuildFailure;
          return withRuntimeCacheObservation(nativeSuiteResult(response), finalObservation);
        }

        const entry = findRuntimeTestCatalogEntry(testCatalog, testId);
        if (!entry)
          return withRuntimeCacheObservation(
            {
              ok: false,
              diagnostics: [
                cliDiagnostic(
                  'native.test.spec',
                  `/tests/${testId}`,
                  'Test record does not exist.',
                ),
              ],
            },
            cacheObservation,
          );
        if (entry.status === 'blocked')
          return withRuntimeCacheObservation(
            {
              ok: false,
              diagnostics: entry.diagnostics.map((item) =>
                cliDiagnostic('native.test.spec', item.path, item.message, item.severity),
              ),
            },
            cacheObservation,
          );

        let finalObservation = cacheObservation;
        let rebuildFailure: CliSemanticResult | null = null;
        const executeTest = async (runtime: typeof prepared) => {
          if (!runtime.ok) return { ok: false };
          const runtimeEntry = findRuntimeTestCatalogEntry(runtime.testCatalog, testId);
          if (!runtimeEntry || runtimeEntry.status !== 'runnable') return { ok: false };
          const request = { project: runtime.artifact.compiledProject, spec: runtimeEntry.spec };
          return runtimeEntry.runner === 'runtime-ui'
            ? context.nativeTools.runUiTest({
                ...request,
                projectRoot: context.snapshot.projectRoot,
                shaderMaterialMetadata: runtime.artifact.shaderMaterialMetadata ?? null,
              })
            : context.nativeTools.runHeadlessTest(request);
        };
        const response = await executeCachedRuntimeArtifactWithRecovery({
          cached: cacheHit,
          execute: () => executeTest(prepared),
          rebuild: async () => {
            const rebuilt = await prepareCachedTestRuntime(context, true);
            if (!rebuilt.ok) {
              rebuildFailure = rebuilt.result;
              return null;
            }
            finalObservation = rebuilt.cacheObservation;
            return () => executeTest(rebuilt);
          },
        });
        if (rebuildFailure) return rebuildFailure;
        return withRuntimeCacheObservation(nativeSuccess(response), finalObservation);
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
          const prepared = await prepareCachedTestRuntime(context);
          if (!prepared.ok) return prepared.result;
          let finalObservation = prepared.cacheObservation;
          let rebuildFailure: CliSemanticResult | null = null;
          const execute = (runtime: typeof prepared) =>
            ui
              ? context.nativeTools.runUiTest({
                  project: runtime.artifact.compiledProject,
                  spec,
                  projectRoot: context.snapshot.projectRoot,
                  shaderMaterialMetadata: runtime.artifact.shaderMaterialMetadata ?? null,
                })
              : context.nativeTools.runHeadlessTest({
                  project: runtime.artifact.compiledProject,
                  spec,
                });
          const response = await executeCachedRuntimeArtifactWithRecovery({
            cached: prepared.cacheHit,
            execute: () => execute(prepared),
            rebuild: async () => {
              const rebuilt = await prepareCachedTestRuntime(context, true);
              if (!rebuilt.ok) {
                rebuildFailure = rebuilt.result;
                return null;
              }
              finalObservation = rebuilt.cacheObservation;
              return () => execute(rebuilt);
            },
          });
          if (rebuildFailure) return rebuildFailure;
          return withRuntimeCacheObservation(nativeSuccess(response), finalObservation);
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
    const valueOptions = new Set(['--output', '--profile']);
    const flags = new Set([
      '--include-unused-assets',
      '--include-shader-sources',
      '--allow-localization-warnings',
    ]);
    for (let index = 0; index < arguments_.length; index += 1) {
      const value = arguments_[index]!;
      if (flags.has(value)) continue;
      if (!valueOptions.has(value))
        throw new CliCommandUsageError(`Unknown command option '${value}'.`);
      if (!arguments_[index + 1] || arguments_[index + 1]!.startsWith('--'))
        throw new CliCommandUsageError(`${value} requires a value.`);
      index += 1;
    }
    const output = valueOption(arguments_, '--output');
    if (!output) throw new CliCommandUsageError("package export requires '--output <path>'.");
    const requestedProfile = valueOption(arguments_, '--profile');
    const includeUnusedAssets = arguments_.includes('--include-unused-assets');
    const includeShaderSources = arguments_.includes('--include-shader-sources');
    const allowLocalizationWarnings = arguments_.includes('--allow-localization-warnings');
    return {
      dryRun: false,
      mutation: false,
      async run(context) {
        const profile = selectedExportProfile(context.snapshot.project);
        if (requestedProfile && requestedProfile !== profile.id)
          return {
            ok: false,
            diagnostics: [
              cliDiagnostic(
                'export.profile_missing',
                '/export/runtime',
                `Export profile '${requestedProfile}' does not exist.`,
              ),
            ],
          };
        const prepared = await prepareRuntimeArtifact({
          project: context.snapshot.project,
          projectRoot: context.snapshot.projectRoot,
          profile: {
            ...profile,
            ...(includeUnusedAssets ? { excludeUnusedAssets: false } : {}),
            ...(includeShaderSources
              ? { includeShaderSources: true, stripShaderSources: false }
              : {}),
          },
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
        const localizationWarnings = localizationWarningDiagnostics(prepared.artifact.diagnostics);
        if (localizationWarnings.length > 0 && !allowLocalizationWarnings)
          return {
            ok: false,
            diagnostics: [
              ...localizationWarnings.map((item) =>
                cliDiagnostic(item.code, item.path, item.message, item.severity),
              ),
              cliDiagnostic(
                'localization.export.warning_override_required',
                '/export/runtime/localization',
                'Localization quality warnings require explicit acknowledgement; pass --allow-localization-warnings to continue.',
              ),
            ],
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
