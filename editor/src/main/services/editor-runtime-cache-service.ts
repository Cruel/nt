import type {
  EditorRuntimeBuildContext,
  EditorRuntimePreparationResult,
} from '../../shared/editor-runtime-cache';
import { canonicalProjectContentJson } from '../../shared/project-schema/editor-project-state';
import { selectedExportProfile } from '../../shared/project-schema/authoring-export';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { buildRuntimePlaybackSpecFromAuthoringTest } from '../../shared/project-schema/test-playback-project';
import { PSEUDO_PREVIEW_LOCALE } from '../../shared/pseudo-localization';
import { effectivePreviewLocale, projectWithPreviewLocale } from '../../shared/preview-locale';
import type { ProjectValidationDiagnostic } from '../../shared/project-schema/project-validation';
import {
  logicalRuntimeArtifactPaths,
  prepareRuntimeArtifact,
  verifyPreparedRuntimeArtifact,
  type PreparedRuntimeArtifact,
} from '../../shared/runtime-artifact-preparation';
import {
  captureRuntimeBuildCacheTestInputs,
  lookupCanonicalRuntimeBuildCache,
  lookupRuntimeBuildCacheVariant,
  publishCanonicalRuntimeBuildCache,
  publishRuntimeBuildCacheVariant,
  type RuntimeBuildCacheObservation,
} from '../../shared/runtime-build-cache';
import {
  buildRuntimeTestCatalog,
  findRuntimeTestCatalogEntry,
  type RuntimeTestCatalog,
} from '../../shared/runtime-test-catalog';
import {
  NodeProjectWorkspaceFileSystem,
  NodeProjectWorkspaceProcessLiveness,
} from '../../shared/project-workspace/node-project-workspace-file-system';
import { createNodeProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';
import type { LoadedProjectWorkspaceSnapshot } from '../../shared/project-workspace/project-workspace-service';
import { executeCachedRuntimeArtifactWithRecovery } from '../../shared/runtime-cache-native-consumer';
import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';
import type { ActiveProjectWorkspaceSession } from './active-project-workspace-session';
import {
  nodeRuntimeArtifactPaths,
  nodeShaderCompilerAdapter,
} from './node-runtime-artifact-adapters';
import type { ShaderCompileResponse } from '../../shared/editor-tooling';

type CanonicalRuntimeResult =
  | {
      status: 'prepared';
      artifact: PreparedRuntimeArtifact;
      testCatalog: RuntimeTestCatalog;
      observation: RuntimeBuildCacheObservation;
    }
  | {
      status: 'blocked';
      diagnostics: ProjectValidationDiagnostic[];
      observation: RuntimeBuildCacheObservation;
    };

function pendingCompilationInput(
  recoveryFingerprint: unknown,
  options: Readonly<{ ignoreTests: boolean }>,
): boolean {
  if (!recoveryFingerprint || typeof recoveryFingerprint !== 'object') return false;
  for (const [saveUnitId, byPath] of Object.entries(
    recoveryFingerprint as Record<string, unknown>,
  )) {
    if (!byPath || typeof byPath !== 'object') continue;
    if (options.ignoreTests && saveUnitId.startsWith('record:tests:')) continue;
    for (const path of Object.keys(byPath as Record<string, unknown>)) {
      if (path === '/editor' || path.startsWith('/editor/')) continue;
      if (options.ignoreTests && (path === '/tests' || path.startsWith('/tests/'))) continue;
      return true;
    }
  }
  return false;
}

function runtimeProjectContentJson(project: AuthoringProject): string {
  return canonicalProjectContentJson({ ...project, tests: {} });
}

function previewProjectFromSaved(
  saved: AuthoringProject,
  current: AuthoringProject,
): AuthoringProject {
  return projectWithPreviewLocale({
    ...saved,
    editor: { ...saved.editor, previewLocale: current.editor.previewLocale },
  });
}

function buildContext(project: AuthoringProject): EditorRuntimeBuildContext {
  const locale = effectivePreviewLocale(project);
  if (locale === project.localization.defaultLocale) return { kind: 'canonical' };
  if (locale === PSEUDO_PREVIEW_LOCALE) return { kind: 'pseudo-preview-locale', locale };
  return { kind: 'preview-locale', locale };
}

function contextKey(context: EditorRuntimeBuildContext): string {
  return context.kind === 'canonical' ? 'canonical-runtime' : `${context.kind}:${context.locale}`;
}

function observationWithPublication(
  observation: RuntimeBuildCacheObservation,
  publication: Readonly<{ published: boolean; reason?: string }>,
): RuntimeBuildCacheObservation {
  return {
    ...observation,
    published: publication.published,
    ...(publication.reason ? { publicationReason: publication.reason } : {}),
  };
}

export class EditorRuntimeCacheService {
  private readonly fileSystem = new NodeProjectWorkspaceFileSystem();
  private readonly processLiveness = new NodeProjectWorkspaceProcessLiveness();
  constructor(
    private readonly invokeNative: (
      operation: string,
      request: unknown,
    ) => Promise<unknown> = invokeNovelTeaNativeOperation,
  ) {}

  private currentProjectMatchesSaved(
    workspace: ActiveProjectWorkspaceSession,
    project: AuthoringProject,
  ): boolean {
    return (
      canonicalProjectContentJson(project) === canonicalProjectContentJson(workspace.project())
    );
  }

  private currentRuntimeProjectMatchesSaved(
    workspace: ActiveProjectWorkspaceSession,
    project: AuthoringProject,
  ): boolean {
    return runtimeProjectContentJson(project) === runtimeProjectContentJson(workspace.project());
  }

  private shaderCompiler() {
    return nodeShaderCompilerAdapter(
      (shaderProject, options) =>
        this.invokeNative('compile-shaders', {
          shaderProject,
          options,
        }) as Promise<ShaderCompileResponse>,
    );
  }

  private runtimePaths(projectRoot: string) {
    return {
      ...logicalRuntimeArtifactPaths,
      shaderAssetRoot: () => nodeRuntimeArtifactPaths.shaderAssetRoot(projectRoot),
      readProjectTextSources: (
        _ignoredRoot: string | null,
        entries: Parameters<NonNullable<typeof nodeRuntimeArtifactPaths.readProjectTextSources>>[1],
      ) => nodeRuntimeArtifactPaths.readProjectTextSources!(projectRoot, entries),
    };
  }

  private async verifyCachedArtifact(
    project: AuthoringProject,
    projectRoot: string,
    artifact: PreparedRuntimeArtifact,
  ) {
    return verifyPreparedRuntimeArtifact(artifact, {
      project,
      projectRoot,
      profile: selectedExportProfile(project),
      paths: this.runtimePaths(projectRoot),
    });
  }

  private async prepareCanonicalArtifact(
    project: AuthoringProject,
    intent: 'play' | 'test-playback',
    projectRoot: string,
  ) {
    return prepareRuntimeArtifact({
      project,
      projectRoot,
      profile: selectedExportProfile(project),
      intent,
      shaderCompiler: this.shaderCompiler(),
      paths: this.runtimePaths(projectRoot),
    });
  }

  private async preparePreviewArtifact(project: AuthoringProject, projectRoot: string) {
    return prepareRuntimeArtifact({
      project,
      projectRoot,
      profile: selectedExportProfile(project),
      intent: 'play',
      shaderCompiler: this.shaderCompiler(),
      paths: this.runtimePaths(projectRoot),
    });
  }

  private async revalidatedSnapshot(root: string): Promise<LoadedProjectWorkspaceSnapshot | null> {
    const opened = await createNodeProjectWorkspaceService().open(root, {
      recoverTransactions: false,
    });
    return opened.ok ? opened.snapshot : null;
  }

  async obtainCanonical(
    workspace: ActiveProjectWorkspaceSession,
    project: AuthoringProject,
    intent: 'play' | 'test-playback',
    forceRebuild = false,
  ): Promise<CanonicalRuntimeResult> {
    const snapshot = workspace.snapshot();
    const lookup = await lookupCanonicalRuntimeBuildCache(this.fileSystem, snapshot);
    let artifact = forceRebuild ? undefined : lookup.enabled ? lookup.artifact : undefined;
    let testCatalog = lookup.enabled ? lookup.testCatalog : undefined;
    let observation: RuntimeBuildCacheObservation = lookup.enabled
      ? lookup.observation
      : { status: 'unusable', reason: 'metadata-unavailable' };
    if (artifact) {
      const verified = await this.verifyCachedArtifact(project, workspace.projectRoot(), artifact);
      if (verified.status === 'rejected') {
        artifact = undefined;
        observation = { status: 'stale', reason: 'prepared-artifact-rejected' };
      }
    }
    const needsArtifact = !artifact;
    const needsCatalog = !testCatalog;
    const expectedTestInputs =
      lookup.enabled && lookup.inputSnapshot
        ? (lookup.testInputSnapshot ??
          (await captureRuntimeBuildCacheTestInputs(this.fileSystem, snapshot).catch(
            () => undefined,
          )))
        : undefined;

    if (!artifact) {
      const prepared = await this.prepareCanonicalArtifact(
        project,
        intent,
        workspace.projectRoot(),
      );
      if (prepared.status !== 'prepared') {
        return { status: 'blocked', diagnostics: prepared.diagnostics, observation };
      }
      artifact = prepared.artifact;
    }
    if (!testCatalog) testCatalog = buildRuntimeTestCatalog(project);

    if (
      lookup.enabled &&
      lookup.inputSnapshot &&
      expectedTestInputs &&
      (needsArtifact || needsCatalog)
    ) {
      const currentSnapshot = await this.revalidatedSnapshot(workspace.projectRoot());
      if (currentSnapshot) {
        const publication = await publishCanonicalRuntimeBuildCache(
          this.fileSystem,
          snapshot,
          currentSnapshot,
          artifact,
          testCatalog,
          lookup.inputSnapshot,
          expectedTestInputs,
          needsArtifact ? undefined : lookup.artifactText,
          { pid: process.pid, processLiveness: this.processLiveness },
        );
        observation = observationWithPublication(observation, publication);
      } else {
        observation = {
          ...observation,
          published: false,
          publicationReason: 'workspace-revalidation-failed',
        };
      }
    }

    return { status: 'prepared', artifact, testCatalog, observation };
  }

  async preparePlay(
    workspace: ActiveProjectWorkspaceSession,
    project: AuthoringProject,
    recoveryFingerprint: unknown,
  ): Promise<EditorRuntimePreparationResult> {
    const context = buildContext(project);
    if (!this.currentRuntimeProjectMatchesSaved(workspace, project)) {
      return { status: 'session-local', buildContext: context, reason: 'project-content-dirty' };
    }
    if (pendingCompilationInput(recoveryFingerprint, { ignoreTests: true })) {
      return {
        status: 'session-local',
        buildContext: context,
        reason: 'pending-compilation-input',
      };
    }

    if (context.kind === 'canonical') {
      const result = await this.obtainCanonical(workspace, workspace.project(), 'play');
      if (result.status === 'blocked') {
        return {
          status: 'blocked',
          diagnostics: result.diagnostics,
          buildContext: context,
          cache: {
            scope: 'persistent-canonical',
            status: 'prepared',
            observation: result.observation,
          },
        };
      }
      return {
        status: 'prepared',
        artifact: result.artifact,
        buildContext: context,
        cache: {
          scope: 'persistent-canonical',
          status: result.observation.status === 'hit' ? 'hit' : 'prepared',
          observation: result.observation,
        },
      };
    }

    const snapshot = workspace.snapshot();
    const variant = contextKey(context);
    const lookup = await lookupRuntimeBuildCacheVariant(this.fileSystem, snapshot, variant);
    const previewProject = previewProjectFromSaved(workspace.project(), project);
    if (lookup.enabled && lookup.artifact) {
      const verified = await this.verifyCachedArtifact(
        previewProject,
        workspace.projectRoot(),
        lookup.artifact,
      );
      if (verified.status === 'verified') {
        return {
          status: 'prepared',
          artifact: lookup.artifact,
          buildContext: context,
          cache: {
            scope: 'persistent-preview',
            status: 'hit',
            observation: lookup.observation,
          },
        };
      }
    }

    const prepared = await this.preparePreviewArtifact(previewProject, workspace.projectRoot());
    if (prepared.status !== 'prepared') {
      return {
        status: 'blocked',
        diagnostics: prepared.diagnostics,
        buildContext: context,
        cache: {
          scope: 'persistent-preview',
          status: 'prepared',
          ...(lookup.enabled ? { observation: lookup.observation } : {}),
        },
      };
    }

    let observation = lookup.enabled
      ? lookup.observation
      : ({
          status: 'unusable',
          reason: 'metadata-unavailable',
        } satisfies RuntimeBuildCacheObservation);
    const expectedTestInputs =
      lookup.enabled && lookup.inputSnapshot
        ? (lookup.testInputSnapshot ??
          (await captureRuntimeBuildCacheTestInputs(this.fileSystem, snapshot).catch(
            () => undefined,
          )))
        : undefined;
    if (lookup.enabled && lookup.inputSnapshot && expectedTestInputs) {
      const currentSnapshot = await this.revalidatedSnapshot(workspace.projectRoot());
      if (currentSnapshot) {
        const publication = await publishRuntimeBuildCacheVariant(
          this.fileSystem,
          snapshot,
          currentSnapshot,
          prepared.artifact,
          buildRuntimeTestCatalog(workspace.project()),
          lookup.inputSnapshot,
          expectedTestInputs,
          undefined,
          { pid: process.pid, processLiveness: this.processLiveness },
          variant,
        );
        observation = observationWithPublication(observation, publication);
      } else {
        observation = {
          ...observation,
          published: false,
          publicationReason: 'workspace-revalidation-failed',
        };
      }
    }
    return {
      status: 'prepared',
      artifact: prepared.artifact,
      buildContext: context,
      cache: { scope: 'persistent-preview', status: 'prepared', observation },
    };
  }

  isCanonicalCacheEligible(
    workspace: ActiveProjectWorkspaceSession,
    project: AuthoringProject,
    recoveryFingerprint: unknown,
  ): boolean {
    return (
      this.currentProjectMatchesSaved(workspace, project) &&
      !pendingCompilationInput(recoveryFingerprint, { ignoreTests: false })
    );
  }

  async runPlaybackTest(
    workspace: ActiveProjectWorkspaceSession,
    project: AuthoringProject,
    testId: string,
    recoveryFingerprint: unknown,
  ): Promise<unknown> {
    if (!this.isCanonicalCacheEligible(workspace, project, recoveryFingerprint)) {
      const built = await buildRuntimePlaybackSpecFromAuthoringTest(project, testId);
      if (!built.ok || !built.project || !built.spec)
        return { ok: false, success: false, diagnostics: built.diagnostics };
      return built.runner === 'runtime-ui'
        ? this.invokeNative('run-ui-test', {
            project: built.project,
            spec: built.spec,
            projectRoot: workspace.projectRoot(),
            shaderMaterialMetadata: built.shaderMaterialMetadata ?? null,
          })
        : this.invokeNative('run-test', {
            project: built.project,
            spec: built.spec,
          });
    }

    const canonical = await this.obtainCanonical(workspace, project, 'test-playback');
    if (canonical.status === 'blocked')
      return { ok: false, success: false, diagnostics: canonical.diagnostics };
    const entry = findRuntimeTestCatalogEntry(canonical.testCatalog, testId);
    if (!entry)
      return {
        ok: false,
        success: false,
        diagnostics: [
          {
            severity: 'error',
            category: 'Tests',
            path: `/tests/${testId}`,
            message: 'Test record does not exist.',
          },
        ],
      };
    if (entry.status === 'blocked')
      return { ok: false, success: false, diagnostics: entry.diagnostics };
    const execute = (runtime: CanonicalRuntimeResult & { status: 'prepared' }) => {
      const runtimeEntry = findRuntimeTestCatalogEntry(runtime.testCatalog, testId);
      if (!runtimeEntry || runtimeEntry.status === 'blocked')
        return Promise.resolve({
          ok: false,
          success: false,
          diagnostics: runtimeEntry?.status === 'blocked' ? runtimeEntry.diagnostics : [],
        });
      const request = { project: runtime.artifact.compiledProject, spec: runtimeEntry.spec };
      return runtimeEntry.runner === 'runtime-ui'
        ? this.invokeNative('run-ui-test', {
            ...request,
            projectRoot: workspace.projectRoot(),
            shaderMaterialMetadata: runtime.artifact.shaderMaterialMetadata ?? null,
          })
        : this.invokeNative('run-test', request);
    };
    let rebuildFailure: unknown = null;
    const response = await executeCachedRuntimeArtifactWithRecovery({
      cached: canonical.observation.status === 'hit',
      execute: () => execute(canonical),
      rebuild: async () => {
        const rebuilt = await this.obtainCanonical(workspace, project, 'test-playback', true);
        if (rebuilt.status !== 'prepared') {
          rebuildFailure = { ok: false, success: false, diagnostics: rebuilt.diagnostics };
          return null;
        }
        return () => execute(rebuilt);
      },
    });
    return rebuildFailure ?? response;
  }

  async runPlaybackSuite(
    workspace: ActiveProjectWorkspaceSession,
    project: AuthoringProject,
    recoveryFingerprint: unknown,
  ): Promise<unknown> {
    if (!this.isCanonicalCacheEligible(workspace, project, recoveryFingerprint)) {
      const prepared = await this.prepareCanonicalArtifact(
        project,
        'test-playback',
        workspace.projectRoot(),
      );
      if (prepared.status !== 'prepared')
        return { ok: false, success: false, diagnostics: prepared.diagnostics };
      return this.invokeNative('run-test-suite', {
        project: prepared.artifact.compiledProject,
        catalog: buildRuntimeTestCatalog(project),
        projectRoot: workspace.projectRoot(),
        shaderMaterialMetadata: prepared.artifact.shaderMaterialMetadata ?? null,
      });
    }

    const canonical = await this.obtainCanonical(workspace, project, 'test-playback');
    if (canonical.status === 'blocked')
      return { ok: false, success: false, diagnostics: canonical.diagnostics };
    const execute = (runtime: CanonicalRuntimeResult & { status: 'prepared' }) =>
      this.invokeNative('run-test-suite', {
        project: runtime.artifact.compiledProject,
        catalog: runtime.testCatalog,
        projectRoot: workspace.projectRoot(),
        shaderMaterialMetadata: runtime.artifact.shaderMaterialMetadata ?? null,
      });
    let rebuildFailure: unknown = null;
    const response = await executeCachedRuntimeArtifactWithRecovery({
      cached: canonical.observation.status === 'hit',
      execute: () => execute(canonical),
      rebuild: async () => {
        const rebuilt = await this.obtainCanonical(workspace, project, 'test-playback', true);
        if (rebuilt.status !== 'prepared') {
          rebuildFailure = { ok: false, success: false, diagnostics: rebuilt.diagnostics };
          return null;
        }
        return () => execute(rebuilt);
      },
    });
    return rebuildFailure ?? response;
  }
}
