import { createHash } from 'node:crypto';
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
  type PreparedRuntimeArtifact,
} from '../../shared/runtime-artifact-preparation';
import {
  lookupCanonicalRuntimeBuildCache,
  publishCanonicalRuntimeBuildCache,
  type RuntimeBuildCacheInputSnapshot,
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
import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';
import type { ActiveProjectWorkspaceSession } from './active-project-workspace-session';
import { nodeRuntimeArtifactPaths } from './node-runtime-artifact-adapters';

const MAX_PREVIEW_VARIANTS = 4;

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

interface PreviewVariantEntry {
  artifact: PreparedRuntimeArtifact;
}

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
  return context.kind === 'canonical' ? 'canonical' : `${context.kind}:${context.locale}`;
}

function stableInputFingerprint(
  root: string,
  project: AuthoringProject,
  inputs: RuntimeBuildCacheInputSnapshot | undefined,
  context: EditorRuntimeBuildContext,
): string | null {
  if (!inputs) return null;
  return createHash('sha256')
    .update(root)
    .update('\0')
    .update(runtimeProjectContentJson(project))
    .update('\0')
    .update(JSON.stringify(inputs.entries))
    .update('\0')
    .update(contextKey(context))
    .digest('hex');
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
  private readonly previewVariants = new Map<string, PreviewVariantEntry>();

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

  private touchPreviewVariant(key: string): PreparedRuntimeArtifact | undefined {
    const existing = this.previewVariants.get(key);
    if (!existing) return undefined;
    this.previewVariants.delete(key);
    this.previewVariants.set(key, existing);
    return existing.artifact;
  }

  private rememberPreviewVariant(key: string, artifact: PreparedRuntimeArtifact): void {
    this.previewVariants.delete(key);
    this.previewVariants.set(key, { artifact });
    while (this.previewVariants.size > MAX_PREVIEW_VARIANTS) {
      const oldest = this.previewVariants.keys().next().value as string | undefined;
      if (!oldest) break;
      this.previewVariants.delete(oldest);
    }
  }

  previewVariantCount(): number {
    return this.previewVariants.size;
  }

  private async prepareCanonicalArtifact(
    project: AuthoringProject,
    intent: 'play' | 'test-playback',
  ) {
    return prepareRuntimeArtifact({
      project,
      projectRoot: null,
      profile: selectedExportProfile(project),
      intent,
      paths: logicalRuntimeArtifactPaths,
    });
  }

  private async preparePreviewArtifact(project: AuthoringProject, projectRoot: string) {
    return prepareRuntimeArtifact({
      project,
      projectRoot: null,
      profile: selectedExportProfile(project),
      intent: 'play',
      paths: {
        ...logicalRuntimeArtifactPaths,
        readProjectTextSources: (_ignoredRoot, entries) =>
          nodeRuntimeArtifactPaths.readProjectTextSources!(projectRoot, entries),
      },
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
  ): Promise<CanonicalRuntimeResult> {
    const snapshot = workspace.snapshot();
    const lookup = await lookupCanonicalRuntimeBuildCache(this.fileSystem, snapshot);
    let artifact = lookup.enabled ? lookup.artifact : undefined;
    let testCatalog = lookup.enabled ? lookup.testCatalog : undefined;
    let observation: RuntimeBuildCacheObservation = lookup.enabled
      ? lookup.observation
      : { status: 'unusable', reason: 'metadata-unavailable' };
    const needsArtifact = !artifact;
    const needsCatalog = !testCatalog;

    if (!artifact) {
      const prepared = await this.prepareCanonicalArtifact(project, intent);
      if (prepared.status !== 'prepared') {
        return { status: 'blocked', diagnostics: prepared.diagnostics, observation };
      }
      artifact = prepared.artifact;
    }
    if (!testCatalog) testCatalog = buildRuntimeTestCatalog(project);

    if (lookup.enabled && lookup.inputSnapshot && (needsArtifact || needsCatalog)) {
      const currentSnapshot = await this.revalidatedSnapshot(workspace.projectRoot());
      if (currentSnapshot) {
        const publication = await publishCanonicalRuntimeBuildCache(
          this.fileSystem,
          snapshot,
          currentSnapshot,
          artifact,
          testCatalog,
          lookup.inputSnapshot,
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

    const lookup = await lookupCanonicalRuntimeBuildCache(this.fileSystem, workspace.snapshot());
    const variantKey = stableInputFingerprint(
      workspace.projectRoot(),
      workspace.project(),
      lookup.enabled ? lookup.inputSnapshot : undefined,
      context,
    );
    if (variantKey) {
      const existing = this.touchPreviewVariant(variantKey);
      if (existing) {
        return {
          status: 'prepared',
          artifact: existing,
          buildContext: context,
          cache: { scope: 'preview-session', status: 'hit' },
        };
      }
    }

    const previewProject = previewProjectFromSaved(workspace.project(), project);
    const prepared = await this.preparePreviewArtifact(previewProject, workspace.projectRoot());
    if (prepared.status !== 'prepared') {
      return {
        status: 'blocked',
        diagnostics: prepared.diagnostics,
        buildContext: context,
        cache: { scope: 'preview-session', status: 'prepared' },
      };
    }
    if (variantKey) this.rememberPreviewVariant(variantKey, prepared.artifact);
    return {
      status: 'prepared',
      artifact: prepared.artifact,
      buildContext: context,
      cache: { scope: 'preview-session', status: 'prepared' },
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
    const request = { project: canonical.artifact.compiledProject, spec: entry.spec };
    return entry.runner === 'runtime-ui'
      ? this.invokeNative('run-ui-test', {
          ...request,
          projectRoot: workspace.projectRoot(),
          shaderMaterialMetadata: canonical.artifact.shaderMaterialMetadata ?? null,
        })
      : this.invokeNative('run-test', request);
  }

  async runPlaybackSuite(
    workspace: ActiveProjectWorkspaceSession,
    project: AuthoringProject,
    recoveryFingerprint: unknown,
  ): Promise<unknown> {
    if (!this.isCanonicalCacheEligible(workspace, project, recoveryFingerprint)) {
      const prepared = await this.prepareCanonicalArtifact(project, 'test-playback');
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
    return this.invokeNative('run-test-suite', {
      project: canonical.artifact.compiledProject,
      catalog: canonical.testCatalog,
      projectRoot: workspace.projectRoot(),
      shaderMaterialMetadata: canonical.artifact.shaderMaterialMetadata ?? null,
    });
  }
}
