import path from 'node:path';
import { collectRuntimeDistributionNotices } from '../shared/runtime-distribution-notices';
import { nodeRuntimeArtifactPaths } from '../main/services/node-runtime-artifact-adapters';
import type { AuthoringValidationContribution } from '../shared/project-schema/authoring-validation-contributions';
import type { AuthoringDependencyGraphSnapshot } from '../shared/authoring-dependency-contracts';
import { exactSourceRewritePatches } from '../shared/authoring-source-rewrite';
import {
  authoringCollectionKeys,
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from '../shared/project-schema/authoring-collections';
import type { AuthoringProject, ReferenceTarget } from '../shared/project-schema/authoring-project';
import type { ProjectValidationDiagnostic } from '../shared/project-schema/project-validation';
import { isSafeProjectAssetPath, parseAssetData } from '../shared/project-schema/authoring-assets';
import { sha256HexUtf8 } from '../shared/web-crypto';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import { authoringProjectSchema } from '../shared/project-schema/authoring-project';
import { buildShaderMaterialProject } from '../shared/project-schema/shader-material-project';
import {
  localizationFontCoverageLocales,
  fontCoverageMessageIdentities,
  fontCoverageStackIdentity,
  fontCoverageUnverifiedMessages,
  updateFontCoverageForMessageEdits,
  type LocalizationFontCoverageLocale,
} from '../shared/localization-font-coverage';
import {
  projectWorkspaceAffectedFiles,
  projectWorkspaceFile,
  projectWorkspaceFiles,
  type LoadedProjectWorkspaceSnapshot,
  type ProjectWorkspaceDependencyAnalysis,
  type ProjectWorkspaceOpenOptions,
  type ProjectWorkspaceOpenResult,
  type ProjectWorkspaceReusableDependencyState,
  type ProjectWorkspaceService,
  type ProjectWorkspaceSourceContributions,
  type ProjectWorkspaceSourceWork,
} from '../shared/project-workspace/project-workspace-service';
import { applyJsonPatch, type JsonPatchOperation } from '../renderer/project/json-patch';
import { toJsonValue } from '../renderer/project/json-value';
import {
  createEntityRecordPatches,
  renameEntityIdPatches,
} from '../renderer/project/entity-operations';
import {
  referenceIndexFromCurrentGraph,
  semanticUsagesForTarget,
  type SemanticGraphUsage,
} from '../renderer/project/authoring-graph-consumers';
import { generateAuthoringRepairPlan, recordTarget } from '../renderer/project/authoring-repair';
import { hasJsonAtPointer } from '../renderer/project/json-pointer';
import type { NovelTeaCliNativeToolService } from './native-tool-service';
import {
  activeFontRevisions,
  publishValidationStageCache,
  readValidationStageCache,
  compileWithVerifiedValidationCache,
} from './validation-stage-cache';
import { cliDiagnostic, type NovelTeaCliDiagnostic } from './contracts';
import type { NovelTeaCliExitCode } from './contracts';

export interface CliOpenedProject {
  readonly snapshot: LoadedProjectWorkspaceSnapshot;
  readonly editorState: LoadedProjectWorkspaceSnapshot['project']['editor'];
  readonly sourceContributions: ProjectWorkspaceSourceContributions;
  readonly validationContributions: readonly AuthoringValidationContribution[];
  readonly validationWork: Readonly<{ executed: number; reused: number }>;
  readonly sourceWork: ProjectWorkspaceSourceWork;
  readonly authoringDiagnostics: readonly ProjectValidationDiagnostic[];
}

export interface CliMutationPlan {
  readonly writes: readonly string[];
  readonly deletes: readonly string[];
  readonly moves: readonly Readonly<{ from: string; to: string }>[];
  readonly referenceRepairs: readonly string[];
}

export interface CliAuthoringValidationMetrics {
  readonly preflightMs: number;
  readonly distributionNoticeMs: number;
  readonly dependencyMs: number;
  readonly nativeMs: number;
  readonly fontCoveragePreparationMs: number;
  readonly fontCoverageNativeMs: number;
  readonly shaderPreparationMs: number;
  readonly shaderNativeMs: number;
  readonly shaderReflectionMs: number;
  readonly validationStageCacheReadMs: number;
  readonly fontRevisionProofMs: number;
  readonly shaderRevisionProofMs: number;
  readonly shaderOutputProofMs: number;
  readonly dependencyWork: ProjectWorkspaceDependencyAnalysis['work'];
  readonly compilerWork: Readonly<{
    wholeProjectNormalizations: number;
    linkBuilds: number;
    artifactLowerings: number;
    serializations: number;
  }>;
}

export interface CliSemanticResult {
  readonly ok: boolean;
  readonly diagnostics: readonly NovelTeaCliDiagnostic[];
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly humanSuccess?: string;
  readonly exitCode?: NovelTeaCliExitCode;
  readonly authoringDependencyAnalysis?: ProjectWorkspaceDependencyAnalysis;
  readonly authoringValidationMetrics?: CliAuthoringValidationMetrics;
}

const localizationCoveragePreparationCache = new WeakMap<
  ProjectWorkspaceService,
  Map<
    string,
    Readonly<{
      dependencyRevision: `sha256:${string}`;
      locales: readonly LocalizationFontCoverageLocale[];
      snapshot: LoadedProjectWorkspaceSnapshot;
    }>
  >
>();

function preparedLocalizationCoverageLocales(
  workspace: ProjectWorkspaceService,
  snapshot: LoadedProjectWorkspaceSnapshot,
  sourceWork: ProjectWorkspaceSourceWork,
): readonly LocalizationFontCoverageLocale[] {
  let byProject = localizationCoveragePreparationCache.get(workspace);
  if (!byProject) {
    byProject = new Map();
    localizationCoveragePreparationCache.set(workspace, byProject);
  }
  const cached = byProject.get(snapshot.projectRoot);
  if (cached?.dependencyRevision === sourceWork.localizationCoverageDependencyRevision)
    return cached.locales;
  const before = cached?.snapshot.fileRevisions;
  const after = snapshot.fileRevisions;
  const physicalPaths = before ? new Set([...Object.keys(before), ...Object.keys(after)]) : null;
  const changed = physicalPaths
    ? [...physicalPaths].filter(
        (path) =>
          before?.[path]?.contentHash !== after[path]?.contentHash ||
          before?.[path]?.byteSize !== after[path]?.byteSize,
      )
    : [];
  const messageOnlyChange =
    changed.length === 1 && changed[0] === 'i18n/messages.yaml' && sourceWork.readTextSources === 0;
  const incremental =
    cached && messageOnlyChange
      ? updateFontCoverageForMessageEdits(cached.snapshot.project, snapshot.project, cached.locales)
      : null;
  const prepared =
    incremental ??
    localizationFontCoverageLocales(snapshot.project, workspace.localizationSourceViews(snapshot));
  byProject.set(snapshot.projectRoot, {
    dependencyRevision: sourceWork.localizationCoverageDependencyRevision,
    locales: prepared,
    snapshot,
  });
  return prepared;
}

function workspaceDiagnosticCode(message: string, fallback = 'WORKSPACE_SOURCE_READ'): string {
  if (message.includes('ID does not match its path')) return 'WORKSPACE_RECORD_ID_PATH_MISMATCH';
  if (message.includes('cannot own the same') || message.includes('same Lua source file'))
    return 'WORKSPACE_SOURCE_OWNERSHIP_CONFLICT';
  if (
    message.includes('safe project-relative path') ||
    message.includes('escapes the project root') ||
    message.includes('is not in scripts/')
  )
    return 'WORKSPACE_PATH_INVALID';
  return fallback;
}

export async function openCliProject(
  workspace: ProjectWorkspaceService,
  projectRoot: string,
  options: Readonly<{
    readOnly?: boolean;
    reusableSourceContributions?: ProjectWorkspaceSourceContributions;
    reusableValidationContributions?: readonly AuthoringValidationContribution[];
    reusableDependencyState?: ProjectWorkspaceReusableDependencyState;
    openProject?: (
      projectRoot: string,
      options: ProjectWorkspaceOpenOptions,
    ) => Promise<ProjectWorkspaceOpenResult>;
  }> = {},
): Promise<
  | Readonly<{ ok: true; opened: CliOpenedProject; diagnostics: readonly NovelTeaCliDiagnostic[] }>
  | Readonly<{ ok: false; diagnostics: readonly NovelTeaCliDiagnostic[] }>
> {
  const opened = await (
    options.openProject ?? ((root, openOptions) => workspace.open(root, openOptions))
  )(projectRoot, {
    recoverTransactions: options.readOnly ? false : true,
    reusableSourceContributions: options.reusableSourceContributions,
    reusableValidationContributions: options.reusableValidationContributions,
    reusableDependencyState: options.reusableDependencyState,
  });
  if (!opened.ok) {
    return {
      ok: false,
      diagnostics: opened.diagnostics.map((item) =>
        cliDiagnostic(
          item.code.startsWith('WORKSPACE_') ? item.code : workspaceDiagnosticCode(item.message),
          item.path,
          item.message,
          item.severity,
        ),
      ),
    };
  }
  return {
    ok: true,
    opened: {
      snapshot: opened.snapshot,
      editorState: opened.snapshot.project.editor,
      sourceContributions: opened.sourceContributions,
      validationContributions: opened.validationContributions,
      validationWork: opened.validationWork,
      sourceWork: opened.sourceWork,
      authoringDiagnostics: opened.diagnostics,
    },
    diagnostics: opened.diagnostics.map((item) =>
      cliDiagnostic(item.code, item.path, item.message, item.severity),
    ),
  };
}

async function graphSnapshot(
  workspace: ProjectWorkspaceService,
  snapshot: LoadedProjectWorkspaceSnapshot,
): Promise<AuthoringDependencyGraphSnapshot> {
  return {
    projectInstanceId: 'noveltea-cli',
    projectRevision: 1,
    graphRevision: 1,
    graph: await workspace.buildDependencyGraphWithSources(snapshot),
  };
}

function target(collection: AuthoringCollectionKey, id: string): ReferenceTarget {
  return { collection, id };
}

function validateCollection(value: string): AuthoringCollectionKey | null {
  return isAuthoringCollectionKey(value) ? value : null;
}

function candidateProject(project: AuthoringProject, patches: readonly JsonPatchOperation[]) {
  return authoringProjectSchema.parse(applyJsonPatch(toJsonValue(project), [...patches]).document);
}

function changedWorkspaceFiles(
  before: LoadedProjectWorkspaceSnapshot,
  after: AuthoringProject,
  scriptSourcePaths: Readonly<Record<string, string>>,
  referenceRepairs: readonly string[] = [],
  affectedPaths: readonly string[] = [],
): CliMutationPlan {
  const affectedFiles = projectWorkspaceAffectedFiles(
    before,
    after,
    scriptSourcePaths,
    affectedPaths,
  );
  const beforeFiles = affectedFiles
    ? null
    : projectWorkspaceFiles(before.project, before.project.editor, before.scriptSourcePaths);
  const afterFiles = affectedFiles
    ? null
    : projectWorkspaceFiles(after, after.editor, scriptSourcePaths);
  const writes: string[] = [];
  const deletes: string[] = [];
  const candidates = affectedFiles
    ? [...affectedFiles]
    : [...new Set([...Object.keys(beforeFiles!), ...Object.keys(afterFiles!)])].sort();
  for (const file of candidates) {
    const beforeText = affectedFiles
      ? projectWorkspaceFile(before.project, before.project.editor, before.scriptSourcePaths, file)
      : beforeFiles![file];
    const afterText = affectedFiles
      ? projectWorkspaceFile(after, after.editor, scriptSourcePaths, file)
      : afterFiles![file];
    if (beforeText === afterText) continue;
    if (afterText === undefined) deletes.push(file);
    else writes.push(file);
  }
  return {
    writes,
    deletes,
    moves: [],
    referenceRepairs: [...new Set(referenceRepairs)].sort(),
  };
}

function sourceUsageFields(usage: SemanticGraphUsage) {
  return {
    edgeId: usage.edgeId,
    role: usage.role,
    sourcePath: usage.sourcePath,
    ...(usage.sourceUrl ? { sourceUrl: usage.sourceUrl } : {}),
    ...(usage.sourceReferenceClassification
      ? { classification: usage.sourceReferenceClassification }
      : {}),
    ...(usage.sourceLocation ? { location: usage.sourceLocation } : {}),
  };
}

export async function usagesForEntity(
  workspace: ProjectWorkspaceService,
  snapshot: LoadedProjectWorkspaceSnapshot,
  collectionValue: string,
  id: string,
): Promise<CliSemanticResult> {
  const collection = validateCollection(collectionValue);
  if (!collection)
    return {
      ok: false,
      diagnostics: [
        cliDiagnostic('CLI_USAGE', '/collection', `Unknown collection '${collectionValue}'.`),
      ],
    };
  if (!snapshot.project[collection][id])
    return {
      ok: false,
      diagnostics: [
        cliDiagnostic(
          'authoring.entity.not_found',
          `/${collection}/${id}`,
          'Entity record does not exist.',
        ),
      ],
    };
  const graph = await graphSnapshot(workspace, snapshot);
  const usages = semanticUsagesForTarget(graph, target(collection, id));
  return {
    ok: true,
    diagnostics: [],
    fields: { collection, id, usages: usages.map(sourceUsageFields) },
  };
}

export async function validateCliProject(
  workspace: ProjectWorkspaceService,
  snapshot: LoadedProjectWorkspaceSnapshot,
  sourceWork: ProjectWorkspaceSourceWork,
  nativeTools: NovelTeaCliNativeToolService,
  fileSystem?: ProjectWorkspaceFileSystem,
): Promise<CliSemanticResult> {
  const preflightStarted = Date.now();
  const preflight = workspace.preflightCompiledArtifact(snapshot);
  const diagnostics: NovelTeaCliDiagnostic[] = preflight.diagnostics.map((item) =>
    cliDiagnostic(item.code, item.jsonPointer, item.message, item.severity),
  );
  // Registered physical Assets are not workspace record fragments. A missing
  // payload must nevertheless invalidate validate, including cold/no-daemon
  // runs that have no native resident Asset authority installed.
  if (fileSystem) {
    const sources = new Map<string, string[]>();
    for (const [id, record] of Object.entries(snapshot.project.assets)) {
      const asset = parseAssetData(record.data);
      if (!asset || !isSafeProjectAssetPath(asset.source.path)) continue;
      const owners = sources.get(asset.source.path) ?? [];
      owners.push(id);
      sources.set(asset.source.path, owners);
    }
    const ordered = [...sources].sort(([a], [b]) => a.localeCompare(b));
    // Bound concurrency rather than serially issuing a filesystem round trip
    // for every physical Asset. The complete sorted result and missing-source
    // diagnostics are preserved, including for cold/no-daemon validation.
    for (let start = 0; start < ordered.length; start += 16) {
      const statuses = await Promise.all(
        ordered.slice(start, start + 16).map(async ([relative, owners]) => {
          const absolute = fileSystem.joinPath(snapshot.projectRoot, relative);
          try {
            const kind = fileSystem.readPathMetadata
              ? (await fileSystem.readPathMetadata(absolute)).kind
              : await fileSystem.inspect(absolute);
            return { relative, owners, kind };
          } catch {
            return { relative, owners, kind: 'missing' as const };
          }
        }),
      );
      for (const { relative, owners, kind } of statuses)
        if (kind !== 'file')
          for (const id of owners)
            diagnostics.push(
              cliDiagnostic(
                'authoring.asset.source_unavailable',
                `/assets/${id.replaceAll('~', '~0').replaceAll('/', '~1')}/data/source/path`,
                `Asset '${id}' source '${relative}' is ${kind === 'missing' ? 'missing' : 'not a regular file'}.`,
              ),
            );
    }
  }
  const noticeStarted = Date.now();
  try {
    await collectRuntimeDistributionNotices(
      snapshot.project,
      new Set(Object.keys(snapshot.project.assets)),
      snapshot.projectRoot,
      nodeRuntimeArtifactPaths,
    );
  } catch (error) {
    diagnostics.push(
      cliDiagnostic(
        'authoring.distribution-notice.invalid',
        '/settings/distributionNotices',
        error instanceof Error ? error.message : 'Distribution notice cannot be verified.',
      ),
    );
  }
  const distributionNoticeMs = Date.now() - noticeStarted;
  const preflightMs = Date.now() - preflightStarted;
  const dependencyStarted = Date.now();
  const dependencyAnalysis = await workspace.buildDependencyGraphAnalysis(snapshot);
  const dependencyMs = Date.now() - dependencyStarted;
  const nativeStarted = Date.now();
  const cacheReadStarted = Date.now();
  const stageCache =
    fileSystem && nativeTools.validationCacheIdentity
      ? await readValidationStageCache(
          fileSystem,
          snapshot.projectRoot,
          nativeTools.validationCacheIdentity,
        )
      : null;
  const validationStageCacheReadMs = Date.now() - cacheReadStarted;
  let stageCacheChanged = false;
  let fontCoveragePreparationMs = 0;
  let fontCoverageNativeMs = 0;
  let shaderPreparationMs = 0;
  let shaderNativeMs = 0;
  let shaderReflectionMs = 0;
  let fontRevisionProofMs = 0;
  let shaderRevisionProofMs = 0;
  let shaderOutputProofMs = 0;
  diagnostics.push(
    ...dependencyAnalysis.graph.diagnostics.map((item) =>
      cliDiagnostic(item.code, item.path, item.message, item.severity, {
        sourceUrl: item.sourceUrl,
        line: item.line,
        column: item.column,
      }),
    ),
  );
  if (nativeTools.validateFontCoverage && !diagnostics.some((item) => item.severity === 'error')) {
    try {
      const proofStarted = Date.now();
      const fontRevisions =
        stageCache && fileSystem ? await activeFontRevisions(fileSystem, snapshot) : null;
      fontRevisionProofMs = Date.now() - proofStarted;
      const cachedFont = stageCache?.font;
      let response;
      if (
        fontRevisions !== null &&
        cachedFont?.dependencyRevision === sourceWork.localizationCoverageDependencyRevision &&
        cachedFont.fontRevisions === fontRevisions
      ) {
        response = cachedFont.response;
      } else {
        const preparationStarted = Date.now();
        const locales = preparedLocalizationCoverageLocales(workspace, snapshot, sourceWork);
        fontCoveragePreparationMs = Date.now() - preparationStarted;
        const localeFingerprint = await sha256HexUtf8(
          JSON.stringify(
            locales.map(({ locale, supported, fonts, fingerprint }) => [
              locale,
              supported,
              fonts,
              fingerprint,
            ]),
          ),
        );
        const stackIdentities = Object.fromEntries(
          locales.map((locale) => [locale.locale, fontCoverageStackIdentity(locale)]),
        );
        // Native shaping is contextual: an unchanged character set does not
        // prove that a newly composed string can be shaped. Only reuse exact
        // complete message texts from a previously clean native result.
        const deltaAllowed = Boolean(
          fontRevisions !== null &&
          cachedFont?.fontRevisions === fontRevisions &&
          cachedFont.response.diagnostics.length === 0 &&
          cachedFont.provenMessages &&
          cachedFont.stackIdentities,
        );
        const changedLocales = deltaAllowed
          ? locales.flatMap((locale) => {
              const known = cachedFont!.provenMessages?.[locale.locale];
              const delta = known
                ? fontCoverageUnverifiedMessages(locale, {
                    stackIdentity: cachedFont!.stackIdentities?.[locale.locale] ?? '',
                    messageIdentities: known,
                    diagnosticCount: 0,
                  })
                : null;
              const request = delta ?? locale;
              return request.messages.length ? [request] : [];
            })
          : locales;
        if (
          fontRevisions !== null &&
          cachedFont?.fontRevisions === fontRevisions &&
          cachedFont.localeFingerprint === localeFingerprint
        ) {
          response = cachedFont.response;
        } else if (deltaAllowed && changedLocales.length === 0) {
          response = cachedFont!.response;
        } else {
          const coverageStarted = Date.now();
          response = await nativeTools.validateFontCoverage({
            projectRoot: snapshot.projectRoot,
            locales: changedLocales,
          });
          fontCoverageNativeMs = Date.now() - coverageStarted;
        }
        if (stageCache && fontRevisions !== null && response.ok && response.success) {
          stageCache.font = {
            dependencyRevision: sourceWork.localizationCoverageDependencyRevision,
            fontRevisions,
            localeFingerprint,
            response,
            ...(response.diagnostics.length === 0
              ? {
                  provenMessages: Object.fromEntries(
                    locales.map((locale) => [locale.locale, fontCoverageMessageIdentities(locale)]),
                  ),
                  stackIdentities,
                }
              : {}),
          };
          stageCacheChanged = true;
        }
      }
      diagnostics.push(
        ...response.diagnostics.map((item) =>
          cliDiagnostic(
            item.code,
            item.path,
            `${item.message} Message: ${item.messageId}. Effective stack: ${item.fontStack.join(', ')}.`,
            item.severity,
          ),
        ),
      );
      if (!response.ok)
        diagnostics.push(
          cliDiagnostic(
            'native.localization.font_coverage',
            '/localization',
            response.error ?? 'Font coverage validation failed.',
          ),
        );
    } catch (error) {
      diagnostics.push(
        cliDiagnostic(
          'native.localization.font_coverage',
          '/localization',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  const hasShaders = Object.keys(snapshot.project.materials).length > 0;
  if (hasShaders && !diagnostics.some((item) => item.severity === 'error')) {
    const shaderPreparationStarted = Date.now();
    const shaderProject = await buildShaderMaterialProject(snapshot.project, [], {
      certifyPresetPrograms: true,
    });
    shaderPreparationMs = Date.now() - shaderPreparationStarted;
    diagnostics.push(
      ...shaderProject.diagnostics.map((item) =>
        cliDiagnostic('shader.material_project', item.path, item.message, item.severity),
      ),
    );
    if (!diagnostics.some((item) => item.severity === 'error')) {
      try {
        const options = {
          projectRoot: snapshot.projectRoot,
          outputRoot: path.join(snapshot.projectRoot, '.noveltea', 'build'),
          cacheRoot: path.join(snapshot.projectRoot, '.noveltea', 'cache'),
          shaderVariants: ['glsl-330', 'essl-300', 'metal'],
        };
        const previousShader = stageCache?.shader;
        const response = await compileWithVerifiedValidationCache(
          fileSystem,
          snapshot.projectRoot,
          nativeTools.validationCacheIdentity,
          shaderProject.compilation,
          options,
          () => nativeTools.compileShaders(shaderProject.compilation, options),
          {
            cache: stageCache ?? undefined,
            onTiming(stage, milliseconds) {
              if (stage === 'revision') shaderRevisionProofMs += milliseconds;
              else if (stage === 'outputs') shaderOutputProofMs += milliseconds;
              else shaderNativeMs += milliseconds;
            },
          },
        );
        stageCacheChanged ||= stageCache?.shader !== previousShader;
        diagnostics.push(
          ...(response.diagnostics ?? []).map((item) =>
            cliDiagnostic(
              `native.shader.${item.code ?? 'compile'}`,
              item.path ?? item.sourcePath ?? item.outputPath ?? '/materials',
              item.message,
              item.severity,
            ),
          ),
        );
        if (response.success) {
          const shaderReflectionStarted = Date.now();
          const reflectedProject = await buildShaderMaterialProject(
            snapshot.project,
            response.outputs ?? [],
          );
          shaderReflectionMs = Date.now() - shaderReflectionStarted;
          diagnostics.push(
            ...reflectedProject.diagnostics.map((item) =>
              cliDiagnostic('shader.material_project', item.path, item.message, item.severity),
            ),
          );
        } else if (!response.diagnostics?.some((item) => item.severity === 'error'))
          diagnostics.push(
            cliDiagnostic(
              'native.shader.compile',
              '/shaders',
              response.error ?? 'Shader compilation failed.',
            ),
          );
      } catch (error) {
        diagnostics.push(
          cliDiagnostic(
            'native.shader.compile',
            '/shaders',
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  }
  if (stageCache && fileSystem && stageCacheChanged)
    await publishValidationStageCache(fileSystem, stageCache);
  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    diagnostics,
    fields: { projectRoot: snapshot.projectRoot },
    authoringDependencyAnalysis: dependencyAnalysis,
    authoringValidationMetrics: {
      preflightMs,
      distributionNoticeMs,
      dependencyMs,
      nativeMs: Date.now() - nativeStarted,
      fontCoveragePreparationMs,
      fontCoverageNativeMs,
      shaderPreparationMs,
      shaderNativeMs,
      shaderReflectionMs,
      validationStageCacheReadMs,
      fontRevisionProofMs,
      shaderRevisionProofMs,
      shaderOutputProofMs,
      dependencyWork: dependencyAnalysis.work,
      compilerWork: {
        wholeProjectNormalizations: preflight.stages.some(
          (stage) => stage.name === 'normalize' && stage.status === 'completed',
        )
          ? 1
          : 0,
        linkBuilds: preflight.stages.some(
          (stage) => stage.name === 'link' && stage.status === 'completed',
        )
          ? 1
          : 0,
        artifactLowerings: preflight.stages.some(
          (stage) => stage.name === 'lower' && stage.status === 'completed',
        )
          ? 1
          : 0,
        serializations: preflight.stages.some(
          (stage) => stage.name === 'serialize' && stage.status === 'completed',
        )
          ? 1
          : 0,
      },
    },
  };
}

export async function createEntity(
  workspace: ProjectWorkspaceService,
  snapshot: LoadedProjectWorkspaceSnapshot,
  collectionValue: string,
  id: string,
  dryRun: boolean,
): Promise<CliSemanticResult> {
  const collection = validateCollection(collectionValue);
  if (!collection)
    return {
      ok: false,
      diagnostics: [
        cliDiagnostic('CLI_USAGE', '/collection', `Unknown collection '${collectionValue}'.`),
      ],
    };
  if (collection === 'assets')
    return {
      ok: false,
      diagnostics: [
        cliDiagnostic(
          'CLI_USAGE',
          '/collection',
          "Generic Asset creation is not supported; use 'noveltea asset import <path>'.",
        ),
      ],
    };
  const result = createEntityRecordPatches(snapshot.project, { collection, entityId: id });
  if (result.diagnostics?.some((item) => item.severity === 'error'))
    return {
      ok: false,
      diagnostics: result.diagnostics.map((item) =>
        cliDiagnostic(
          'authoring.entity.create',
          item.path ?? `/${collection}/${id}`,
          item.message,
          item.severity,
        ),
      ),
    };
  const candidate = candidateProject(snapshot.project, result.patches);
  const plan = changedWorkspaceFiles(
    snapshot,
    candidate,
    snapshot.scriptSourcePaths,
    result.affectedPaths,
    result.patches.map((patch) => patch.path),
  );
  if (!dryRun) {
    await workspace.write(
      snapshot.projectRoot,
      snapshot.workspaceRevision,
      candidate,
      candidate.editor,
      snapshot.scriptSourcePaths,
      {
        operationLabel: `cli entity create ${collection}/${id}`,
        affectedPaths: result.patches.map((patch) => patch.path),
      },
    );
  }
  return { ok: true, diagnostics: [], fields: { collection, id, dryRun, plan } };
}

export async function renameEntity(
  workspace: ProjectWorkspaceService,
  snapshot: LoadedProjectWorkspaceSnapshot,
  collectionValue: string,
  fromId: string,
  toId: string,
  options: Readonly<{ dryRun: boolean; allowPossibleSourceReferences: boolean }>,
): Promise<CliSemanticResult> {
  const collection = validateCollection(collectionValue);
  if (!collection)
    return {
      ok: false,
      diagnostics: [
        cliDiagnostic('CLI_USAGE', '/collection', `Unknown collection '${collectionValue}'.`),
      ],
    };
  const graph = await graphSnapshot(workspace, snapshot);
  const usages = semanticUsagesForTarget(graph, target(collection, fromId));
  const exactManual = usages.filter(
    (usage) => usage.sourceReferenceClassification === 'exact-manual',
  );
  if (exactManual.length > 0)
    return {
      ok: false,
      diagnostics: exactManual.map((usage) =>
        cliDiagnostic(
          'authoring.source_reference.exact_manual',
          usage.edge.sourcePath,
          'Rename is blocked by an exact source reference that is not safely rewriteable.',
          'error',
          {
            sourceUrl: usage.sourceUrl,
            line: usage.sourceLocation?.line,
            column: usage.sourceLocation?.column,
          },
        ),
      ),
      fields: { usages: usages.map(sourceUsageFields) },
    };
  const possible = usages.filter(
    (usage) => usage.sourceReferenceClassification === 'possible-lexical',
  );
  if (possible.length > 0 && !options.allowPossibleSourceReferences)
    return {
      ok: false,
      diagnostics: possible.map((usage) =>
        cliDiagnostic(
          'authoring.source_reference.possible',
          usage.edge.sourcePath,
          'Possible source reference requires --allow-possible-source-references.',
          'error',
          {
            sourceUrl: usage.sourceUrl,
            line: usage.sourceLocation?.line,
            column: usage.sourceLocation?.column,
          },
        ),
      ),
      fields: { usages: usages.map(sourceUsageFields) },
    };
  const renamed = renameEntityIdPatches(
    snapshot.project,
    { collection, fromId, toId },
    referenceIndexFromCurrentGraph(snapshot.project, graph),
  );
  if (renamed.diagnostics?.some((item) => item.severity === 'error'))
    return {
      ok: false,
      diagnostics: renamed.diagnostics.map((item) =>
        cliDiagnostic(
          'authoring.entity.rename',
          item.path ?? `/${collection}/${fromId}`,
          item.message,
          item.severity,
        ),
      ),
    };
  const exactRewrites = exactSourceRewritePatches(toJsonValue(snapshot.project), usages, toId);
  if (!exactRewrites.ok)
    return {
      ok: false,
      diagnostics: [
        cliDiagnostic(
          'authoring.source_reference.rewrite_failed',
          exactRewrites.path,
          exactRewrites.message,
        ),
      ],
    };
  const patches = [...renamed.patches, ...(exactRewrites.patches as JsonPatchOperation[])];
  const candidate = candidateProject(snapshot.project, patches);
  const sourcePaths = {
    ...snapshot.scriptSourcePaths,
    ...(collection === 'scripts' && snapshot.scriptSourcePaths[fromId]
      ? { [toId]: snapshot.scriptSourcePaths[fromId] }
      : {}),
  };
  const plan = changedWorkspaceFiles(
    snapshot,
    candidate,
    sourcePaths,
    patches.map((patch) => patch.path),
    patches.map((patch) => patch.path),
  );
  const written = await workspace.write(
    snapshot.projectRoot,
    snapshot.workspaceRevision,
    candidate,
    candidate.editor,
    sourcePaths,
    {
      dryRun: options.dryRun,
      preflightSnapshot: snapshot,
      operationLabel: `cli entity rename ${collection}/${fromId} -> ${toId}`,
      identityRemap: [{ fromPath: `/${collection}/${fromId}`, toPath: `/${collection}/${toId}` }],
      affectedPaths: patches.map((patch) => patch.path),
    },
  );
  return {
    ok: true,
    diagnostics: possible.map((usage) =>
      cliDiagnostic(
        'authoring.source_reference.possible',
        usage.edge.sourcePath,
        'Possible source reference was acknowledged and requires manual review.',
        'warning',
        {
          sourceUrl: usage.sourceUrl,
          line: usage.sourceLocation?.line,
          column: usage.sourceLocation?.column,
        },
      ),
    ),
    fields: {
      collection,
      fromId,
      toId,
      commentImpacts: written.commentImpacts,
      dryRun: options.dryRun,
      plan,
      usages: usages.map(sourceUsageFields),
    },
  };
}

export async function deleteEntity(
  workspace: ProjectWorkspaceService,
  snapshot: LoadedProjectWorkspaceSnapshot,
  collectionValue: string,
  id: string,
  options: Readonly<{
    dryRun: boolean;
    force: boolean;
    allowPossibleSourceReferences: boolean;
  }>,
): Promise<CliSemanticResult> {
  const collection = validateCollection(collectionValue);
  if (!collection)
    return {
      ok: false,
      diagnostics: [
        cliDiagnostic('CLI_USAGE', '/collection', `Unknown collection '${collectionValue}'.`),
      ],
    };
  if (!snapshot.project[collection][id])
    return {
      ok: false,
      diagnostics: [
        cliDiagnostic(
          'authoring.entity.not_found',
          `/${collection}/${id}`,
          'Entity record does not exist.',
        ),
      ],
    };
  const graph = await graphSnapshot(workspace, snapshot);
  const usages = semanticUsagesForTarget(graph, target(collection, id));
  const exactSource = usages.filter(
    (usage) =>
      usage.sourceReferenceClassification === 'exact-rewriteable' ||
      usage.sourceReferenceClassification === 'exact-manual',
  );
  if (exactSource.length > 0 && !options.force)
    return {
      ok: false,
      diagnostics: exactSource.map((usage) =>
        cliDiagnostic(
          'authoring.source_reference.exact_blocker',
          usage.edge.sourcePath,
          'Delete is blocked by an exact source reference; use --force to remove the target without rewriting that source.',
          'error',
          {
            sourceUrl: usage.sourceUrl,
            line: usage.sourceLocation?.line,
            column: usage.sourceLocation?.column,
          },
        ),
      ),
      fields: { usages: usages.map(sourceUsageFields) },
    };
  const possible = usages.filter(
    (usage) => usage.sourceReferenceClassification === 'possible-lexical',
  );
  if (possible.length > 0 && !options.allowPossibleSourceReferences)
    return {
      ok: false,
      diagnostics: possible.map((usage) =>
        cliDiagnostic(
          'authoring.source_reference.possible',
          usage.edge.sourcePath,
          'Possible source reference requires --allow-possible-source-references.',
          'error',
          {
            sourceUrl: usage.sourceUrl,
            line: usage.sourceLocation?.line,
            column: usage.sourceLocation?.column,
          },
        ),
      ),
      fields: { usages: usages.map(sourceUsageFields) },
    };
  const deletePath = `/${collection}/${id}` as const;
  const metadataPath = `/editor/recordMetadata/${collection}/${id}` as const;
  const repair = generateAuthoringRepairPlan({
    snapshot: graph,
    projectInstanceId: graph.projectInstanceId,
    projectRevision: graph.projectRevision,
    target: recordTarget(collection, id),
    deletePath,
    ...(hasJsonAtPointer(toJsonValue(snapshot.project), metadataPath) ? { metadataPath } : {}),
    force: options.force,
  });
  if (repair.status !== 'ready')
    return {
      ok: false,
      diagnostics: [cliDiagnostic('authoring.entity.delete_blocked', deletePath, repair.reason)],
      fields: { usages: usages.map(sourceUsageFields) },
    };
  const candidate = candidateProject(snapshot.project, repair.plan.patches);
  const plan = changedWorkspaceFiles(
    snapshot,
    candidate,
    snapshot.scriptSourcePaths,
    repair.plan.preview.map((item) => `${item.sourcePath}: ${item.action}`),
    repair.plan.patches.map((patch) => patch.path),
  );
  const written = await workspace.write(
    snapshot.projectRoot,
    snapshot.workspaceRevision,
    candidate,
    candidate.editor,
    snapshot.scriptSourcePaths,
    {
      dryRun: options.dryRun,
      preflightSnapshot: snapshot,
      operationLabel: `cli entity delete ${collection}/${id}`,
      affectedPaths: repair.plan.patches.map((patch) => patch.path),
    },
  );
  return {
    ok: true,
    diagnostics: [
      ...repair.plan.warnings.map((message) =>
        cliDiagnostic('authoring.entity.delete_warning', deletePath, message, 'warning'),
      ),
      ...possible.map((usage) =>
        cliDiagnostic(
          'authoring.source_reference.possible',
          usage.edge.sourcePath,
          'Possible source reference was acknowledged and requires manual review.',
          'warning',
          {
            sourceUrl: usage.sourceUrl,
            line: usage.sourceLocation?.line,
            column: usage.sourceLocation?.column,
          },
        ),
      ),
    ],
    fields: {
      collection,
      id,
      commentImpacts: written.commentImpacts,
      dryRun: options.dryRun,
      force: options.force,
      plan,
      usages: usages.map(sourceUsageFields),
    },
  };
}

export const CLI_ENTITY_COLLECTIONS = authoringCollectionKeys;
