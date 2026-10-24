import path from 'node:path';
import type { ParsedGlobalArguments } from './bootstrap';
import { novelTeaCliUsageFailure } from './bootstrap';
import { cliDiagnostic, formatCliResult, type NovelTeaCliCommandResult } from './contracts';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';
import { nativeProjectDiagnostics } from './native-project-results';
import type { NovelTeaCliNativeToolService } from './native-tool-service';
import type { NativeResidentProjectPreparation } from '../shared/project-workspace/resident-project-workspace-service';
import type { LoadedProjectWorkspaceSnapshot } from '../shared/project-workspace/project-workspace-service';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import { NodeProjectWorkspaceProcessLiveness } from '../shared/project-workspace/node-project-workspace-file-system';
import { createNodeProjectWorkspaceFileSystem } from '../shared/project-workspace/node-project-workspace-file-system';
import { authoringCollectionKeys } from '../shared/project-schema/authoring-collections';
import type { AuthoringProject } from '../shared/project-schema/authoring-project';
import {
  canonicalProjectContentJson,
  emptyEditorProjectState,
} from '../shared/project-schema/editor-project-state';
import { selectedExportProfile } from '../shared/project-schema/authoring-export';
import {
  prepareRuntimeArtifact,
  preparedRuntimeArtifactSourceFingerprint,
  verifyPreparedRuntimeArtifact,
  type PreparedRuntimeArtifact,
  type RuntimeArtifactPathAdapter,
} from '../shared/runtime-artifact-preparation';
import {
  captureRuntimeBuildCacheTestInputs,
  lookupCanonicalRuntimeBuildCache,
  publishCanonicalRuntimeBuildCache,
  type PinnedRuntimeBuildCacheInputs,
  type RuntimeBuildCacheObservation,
} from '../shared/runtime-build-cache';
import {
  buildRuntimeTestCatalog,
  findRuntimeTestCatalogEntry,
} from '../shared/runtime-test-catalog';
import {
  nodeRuntimeArtifactPaths,
  nodeShaderCompilerAdapter,
} from '../main/services/node-runtime-artifact-adapters';
import { executeCachedRuntimeArtifactWithRecovery } from '../shared/runtime-cache-native-consumer';
import {
  preparedMediaTestRequest,
  nativeTestResult,
  nativeSuiteResult,
} from './native-command-results';
import {
  verifyPinnedExternalAssets,
  type PinnedExternalAssetExpectation,
} from './pinned-external-assets';
import {
  pinnedProjectTextSourceRequest,
  pinnedShaderSourceOverlays,
  runtimeArtifactPathsWithPinnedSources,
  type PinnedProjectTextSources,
} from './pinned-project-text-sources';
import type { CliSemanticResult } from './semantic-project';

type NativePinnedGeneration = Readonly<{
  projectRoot: string;
  preparation: NativeResidentProjectPreparation | null;
}>;

export interface NativeTestCliOptions {
  readonly pinned?: NativePinnedGeneration;
  readonly pinnedRuntimeBuildCacheInputs?: PinnedRuntimeBuildCacheInputs | null;
  readonly pinnedExternalAssets?: readonly PinnedExternalAssetExpectation[];
  readonly pinnedProjectTextSources?: PinnedProjectTextSources;
  readonly paths?: RuntimeArtifactPathAdapter;
  readonly fileSystem?: ProjectWorkspaceFileSystem;
  readonly abortSignal?: AbortSignal;
  readonly forceRuntimeCacheRebuild?: boolean;
  readonly readStdinText?: () => string | undefined;
}

const liveness = new NodeProjectWorkspaceProcessLiveness();

/** Cache APIs need the source membership and revision, not a second TS Workspace admission. */
function cacheSnapshot(prepared: NativeResidentProjectPreparation, root: string) {
  return {
    projectRoot: root,
    project: prepared.project,
    sourceRevision: prepared.sourceGeneration,
    canonicalSourceFiles: Object.entries(prepared.sourceRevisions)
      .filter(
        ([name, revision]) =>
          revision !== 'absent' &&
          (name === 'project.yaml' ||
            name === 'editor.yaml' ||
            name === 'traits.yaml' ||
            name.startsWith('records/') ||
            name.startsWith('i18n/') ||
            name.startsWith('scripts/')),
      )
      .map(([name]) => name),
  } as unknown as LoadedProjectWorkspaceSnapshot;
}

function nativeProject(prepared: NativeResidentProjectPreparation): AuthoringProject {
  if (!prepared.project || typeof prepared.project !== 'object' || Array.isArray(prepared.project))
    throw new Error('Native Test preparation omitted the Project.');
  if (!prepared.sourceGeneration || !prepared.sourceRevisions?.['project.yaml'])
    throw new Error('Native Test preparation omitted its admitted source generation.');
  if (
    !prepared.sourceOverlays ||
    Object.values(prepared.sourceOverlays).some((v) => typeof v !== 'string')
  )
    throw new Error('Native Test preparation returned invalid source overlays.');
  if (
    !Array.isArray(prepared.referencedAssetIds) ||
    prepared.referencedAssetIds.some((id) => typeof id !== 'string') ||
    Object.entries(prepared.sourceRevisions).some(
      ([name, revision]) =>
        !name ||
        path.posix.normalize(name) !== name ||
        name.startsWith('/') ||
        name.includes('\\') ||
        name.includes(':') ||
        name.split('/').includes('..') ||
        typeof revision !== 'string' ||
        !/^sha256:[0-9a-f]{64}$|^absent$/u.test(revision),
    )
  )
    throw new Error('Native Test preparation returned invalid source authority.');
  // A sparse native transport omits empty collections and editor-local defaults.
  // Neither is a disk read or an alternative Project validator.
  const project: Record<string, unknown> = { ...prepared.project };
  for (const family of authoringCollectionKeys) if (!(family in project)) project[family] = {};
  if (!project.editor) project.editor = emptyEditorProjectState();
  return project as AuthoringProject;
}

function exitFor(result: CliSemanticResult): 0 | 4 | 6 {
  return result.ok
    ? 0
    : result.diagnostics.some((diagnostic) => diagnostic.code.startsWith('native.'))
      ? 6
      : 4;
}

/** Candidate native-authoritative CLI Test adapter. The native owner admits the
 * Project once, while all four commands reuse the runtime artifact and runners.
 * Pinned workers must never use the native disk command to refresh that owner. */
export async function runNativeProjectTestsCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
  nativeTools: NovelTeaCliNativeToolService,
  options: NativeTestCliOptions = {},
): Promise<NovelTeaCliCommandResult | null> {
  const [family, operation, ...args] = globals.command;
  if (family !== 'test' || !['run', 'run-spec', 'run-ui-spec'].includes(operation ?? ''))
    return null;
  if (operation === 'run' && (args.length > 1 || args.some((a) => a.startsWith('--'))))
    return novelTeaCliUsageFailure('test run accepts at most one test ID.', globals.json);
  if (operation !== 'run' && args.length)
    return novelTeaCliUsageFailure(`test ${operation} does not accept arguments.`, globals.json);

  let stdin: unknown;
  if (operation !== 'run') {
    try {
      const text = options.readStdinText?.();
      if (!text?.trim()) throw new Error('Command requires one UTF-8 JSON value on stdin.');
      stdin = JSON.parse(text);
    } catch (error) {
      return novelTeaCliUsageFailure(
        error instanceof Error ? error.message : String(error),
        globals.json,
      );
    }
  }

  const root =
    options.pinned?.projectRoot ??
    (await nativeProjectRoot(cwd, globals.project, options.fileSystem));
  const result = (
    semantic: CliSemanticResult,
    exitCode: 0 | 3 | 4 | 5 | 6 | 70 | 130 = exitFor(semantic),
  ) =>
    formatCliResult(
      {
        success: semantic.ok && exitCode === 0,
        exitCode,
        diagnostics: semantic.diagnostics,
        ...(root ? { projectRoot: root } : {}),
        ...semantic.fields,
      },
      globals.json,
      {
        success: semantic.humanSuccess ?? `NovelTea test ${operation} succeeded.`,
        failure:
          semantic.diagnostics.find((d) => d.severity === 'error')?.message ?? 'Test failed.',
      },
    );
  const fail = (
    code: string,
    message: string,
    exitCode: 3 | 4 | 5 | 6 | 70 | 130,
    pathValue = '/tests',
  ) => result({ ok: false, diagnostics: [cliDiagnostic(code, pathValue, message)] }, exitCode);
  if (!root) return fail('WORKSPACE_NOT_FOUND', 'No NovelTea project.yaml was found.', 3);

  const fileSystem = options.fileSystem ?? createNodeProjectWorkspaceFileSystem();
  const cancelled = () => options.abortSignal?.aborted === true;
  try {
    if (cancelled()) return fail('CLI_INTERRUPTED', 'Test execution was cancelled.', 130);
    if (options.pinned && !options.pinned.preparation)
      return fail('CLI_INTERNAL', 'Pinned generation has no native Test preparation.', 70);
    if (
      options.pinned &&
      (!options.paths || !options.pinnedProjectTextSources || !options.pinnedExternalAssets)
    )
      return fail(
        'CLI_INTERNAL',
        'Pinned generation has no complete physical input authority.',
        70,
      );
    const admitted = options.pinned?.preparation
      ? { ok: true as const, ...options.pinned.preparation }
      : await native({ action: 'shader-preparation', projectRoot: root });
    if (!admitted.ok) {
      if (admitted.kind === 'conflict')
        return fail('WORKSPACE_REVISION_CONFLICT', admitted.error ?? 'Project sources changed.', 5);
      const projectErrors = nativeProjectDiagnostics({
        cliDiagnostics: admitted.projectDiagnostics,
      });
      if (projectErrors.some((diagnostic) => diagnostic.severity === 'error'))
        return result(
          {
            ok: false,
            diagnostics: [...nativeProjectDiagnostics(admitted), ...projectErrors],
          },
          4,
        );
      return fail('WORKSPACE_SOURCE_READ', admitted.error ?? 'Native Test preparation failed.', 3);
    }
    const preparation = admitted as unknown as NativeResidentProjectPreparation;
    const project = nativeProject(preparation);
    const profile = selectedExportProfile(project);
    const snapshot = cacheSnapshot({ ...preparation, project }, root);
    const nativeDiagnostics = nativeProjectDiagnostics(admitted);
    const testId = operation === 'run' ? args[0] : undefined;
    if (testId && !project.tests[testId])
      return fail('native.test.spec', 'Test record does not exist.', 6, `/tests/${testId}`);

    const proof = async () => {
      if (cancelled()) return 'cancelled';
      if (options.pinnedExternalAssets) {
        const drift = await verifyPinnedExternalAssets(
          fileSystem,
          root,
          options.pinnedExternalAssets,
        );
        if (drift.length) return drift[0]!.message;
      }
      if (!options.pinned) {
        const response = await native({
          action: 'source-generation-proof',
          projectRoot: root,
          expectedSourceGeneration: preparation.sourceGeneration,
        });
        if (!response.ok) return response.error ?? 'Native Project generation changed.';
      }
      return null;
    };
    const firstProof = await proof();
    if (firstProof) return fail('WORKSPACE_REVISION_CONFLICT', firstProof, cancelled() ? 130 : 5);

    // Raw stdin specifications do not require an authored Test collection.
    // Do not publish an empty substitute catalog over the canonical one.
    const catalog = operation === 'run' ? buildRuntimeTestCatalog(project) : undefined;
    // Without pinned cache metadata, never recapture newer disk inputs in a
    // disposable worker. A cold build from pinned sources is still valid.
    const lookup =
      options.pinned && !options.pinnedRuntimeBuildCacheInputs
        ? ({ enabled: false } as const)
        : await lookupCanonicalRuntimeBuildCache(
            fileSystem,
            snapshot,
            undefined,
            options.pinnedRuntimeBuildCacheInputs ?? undefined,
          );
    const forced = options.forceRuntimeCacheRebuild === true;
    let observation: RuntimeBuildCacheObservation | null = lookup.enabled
      ? lookup.observation
      : null;
    if (forced) observation = { status: 'unusable', reason: 'cached-native-admission-rejected' };
    const verifiedCache =
      !forced &&
      lookup.enabled &&
      lookup.artifact &&
      lookup.artifact.sourceFingerprint ===
        preparedRuntimeArtifactSourceFingerprint(project, profile) &&
      canonicalProjectContentJson(lookup.artifact.profile) === canonicalProjectContentJson(profile);
    let artifact: PreparedRuntimeArtifact | undefined = verifiedCache ? lookup.artifact : undefined;
    if (artifact) {
      const verified = await verifyPreparedRuntimeArtifact(artifact, {
        project,
        projectRoot: root,
        profile,
        paths: runtimeArtifactPathsWithPinnedSources(
          options.paths ?? nodeRuntimeArtifactPaths,
          options.pinnedProjectTextSources,
        ),
        admittedRuntimeAssetReferences: preparation.referencedAssetIds,
      });
      if (verified.status !== 'verified') artifact = undefined;
    }
    // Native authoring generation remains authoritative even when a cache's
    // Test-input metadata was restored or forged to match an old catalog.
    let currentCatalog =
      catalog &&
      !forced &&
      lookup.enabled &&
      lookup.testCatalog &&
      JSON.stringify(lookup.testCatalog) === JSON.stringify(catalog)
        ? lookup.testCatalog
        : undefined;
    const catalogHit = !!currentCatalog;
    const wasCached = !!artifact;
    // Stdin playback needs only the runtime artifact. On a cold build the
    // canonical cache still publishes the real authored catalog atomically;
    // it never substitutes a fabricated empty catalog over existing Tests.
    const publicationCatalog =
      catalog ?? (!wasCached || forced ? buildRuntimeTestCatalog(project) : undefined);
    if (!verifiedCache && lookup.enabled && lookup.artifact)
      observation = {
        status: 'unusable',
        reason: 'native-generation-artifact-mismatch',
      };

    const prepare = async (rebuild: boolean) => {
      if (rebuild) artifact = undefined;
      if (!artifact) {
        const paths = runtimeArtifactPathsWithPinnedSources(
          options.paths ?? nodeRuntimeArtifactPaths,
          options.pinnedProjectTextSources,
        );
        const prepared = await prepareRuntimeArtifact({
          project,
          projectRoot: root,
          profile,
          intent: 'test-playback',
          admittedAuthoringDiagnostics: [],
          admittedValidationContributions: [],
          admittedRuntimeAssetReferences: preparation.referencedAssetIds,
          shaderCompiler: nodeShaderCompilerAdapter((shaderProject, shaderOptions) =>
            nativeTools.compileShaders(shaderProject, {
              ...shaderOptions,
              sourceOverlays: {
                ...shaderOptions.sourceOverlays,
                ...preparation.sourceOverlays,
                ...pinnedShaderSourceOverlays(options.pinnedProjectTextSources),
              },
            }),
          ),
          paths,
          isCancelled: cancelled,
        });
        if (prepared.status !== 'prepared') {
          return {
            ok: false as const,
            diagnostics: prepared.diagnostics.map((d) =>
              cliDiagnostic('native.test.spec', d.path, d.message, d.severity),
            ),
          };
        }
        artifact = prepared.artifact;
      }
      currentCatalog = catalog;
      return { ok: true as const };
    };

    const initial =
      artifact && (operation !== 'run' || currentCatalog)
        ? { ok: true as const }
        : await prepare(false);
    if (!initial.ok) return result({ ok: false, diagnostics: initial.diagnostics });
    // Publication is never evidence for execution. Prove the native generation
    // independently before consuming a cache hit or a newly prepared artifact.
    const preExecutionProof = await proof();
    if (preExecutionProof)
      return fail('WORKSPACE_REVISION_CONFLICT', preExecutionProof, cancelled() ? 130 : 5);

    const publish = async (rebuild: boolean) => {
      if (!publicationCatalog || !lookup.enabled || !lookup.inputSnapshot) return;
      const testInputs =
        options.pinnedRuntimeBuildCacheInputs?.tests ??
        lookup.testInputSnapshot ??
        (await captureRuntimeBuildCacheTestInputs(fileSystem, snapshot).catch(() => undefined));
      if (testInputs) {
        const publication = await publishCanonicalRuntimeBuildCache(
          fileSystem,
          snapshot,
          snapshot,
          artifact!,
          publicationCatalog,
          lookup.inputSnapshot,
          testInputs,
          !rebuild && !forced && wasCached ? lookup.artifactText : undefined,
          { pid: process.pid, processLiveness: liveness },
          undefined,
          preparation.cliDiagnostics,
        );
        observation = {
          ...(observation ?? { status: 'miss', reason: 'native-generation-prepared' }),
          published: publication.published,
          ...(publication.reason ? { publicationReason: publication.reason } : {}),
        };
      }
    };
    if (forced || !wasCached || (catalog && !catalogHit)) await publish(false);

    const invoke = async () => {
      const request = {
        project: artifact!.compiledProject,
        ...preparedMediaTestRequest(artifact!),
        projectRoot: root,
        ...pinnedProjectTextSourceRequest(options.pinnedProjectTextSources),
        shaderMaterialMetadata: artifact!.shaderMaterialMetadata ?? null,
        shaderVariants: artifact!.packageOptions.shaderVariants,
      };
      if (operation !== 'run')
        return operation === 'run-ui-spec'
          ? nativeTools.runUiTest({ ...request, spec: stdin })
          : nativeTools.runHeadlessTest({ ...request, spec: stdin });
      if (!testId) {
        if (!nativeTools.runTestSuite) throw new Error('Native test-suite runner is unavailable.');
        return nativeTools.runTestSuite({ ...request, catalog: currentCatalog });
      }
      const entry = findRuntimeTestCatalogEntry(currentCatalog!, testId);
      if (!entry || entry.status !== 'runnable') throw new Error('Test was not runnable.');
      return entry.runner === 'runtime-ui'
        ? nativeTools.runUiTest({ ...request, spec: entry.spec })
        : nativeTools.runHeadlessTest({ ...request, spec: entry.spec });
    };

    if (testId) {
      const entry = findRuntimeTestCatalogEntry(currentCatalog!, testId);
      if (!entry)
        return fail('native.test.spec', 'Test record does not exist.', 6, `/tests/${testId}`);
      if (entry.status === 'blocked')
        return result({
          ok: false,
          diagnostics: [
            ...nativeDiagnostics,
            ...entry.diagnostics.map((d) =>
              cliDiagnostic('native.test.spec', d.path, d.message, d.severity),
            ),
          ],
        });
    }
    const retryState: { failure?: CliSemanticResult } = {};
    let response: unknown;
    try {
      response = await executeCachedRuntimeArtifactWithRecovery({
        cached: wasCached,
        execute: invoke,
        rebuild: async () => {
          const rebuilt = await prepare(true);
          if (!rebuilt.ok) {
            retryState.failure = { ok: false, diagnostics: rebuilt.diagnostics };
            return null;
          }
          const reproof = await proof();
          if (reproof) {
            retryState.failure = {
              ok: false,
              diagnostics: [cliDiagnostic('WORKSPACE_REVISION_CONFLICT', '/tests', reproof)],
            };
            return null;
          }
          await publish(true);
          return invoke;
        },
      });
    } catch (error) {
      if (cancelled()) return fail('CLI_INTERRUPTED', 'Test execution was cancelled.', 130);
      return fail('native.test', error instanceof Error ? error.message : String(error), 6);
    }
    if (retryState.failure)
      return result(
        retryState.failure,
        retryState.failure.diagnostics.some((d) => d.code === 'WORKSPACE_REVISION_CONFLICT')
          ? cancelled()
            ? 130
            : 5
          : exitFor(retryState.failure),
      );
    const after = await proof();
    if (after) return fail('WORKSPACE_REVISION_CONFLICT', after, cancelled() ? 130 : 5);
    const semantic =
      operation === 'run' && !testId ? nativeSuiteResult(response) : nativeTestResult(response);
    return result({
      ...semantic,
      diagnostics: [...nativeDiagnostics, ...semantic.diagnostics],
      fields: { ...semantic.fields, ...(observation ? { runtimeCache: observation } : {}) },
    });
  } catch (error) {
    if (cancelled()) return fail('CLI_INTERRUPTED', 'Test execution was cancelled.', 130);
    return fail('CLI_INTERNAL', error instanceof Error ? error.message : String(error), 70);
  }
}
