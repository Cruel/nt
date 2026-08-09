import path from 'node:path';
import type { AuthoringDependencyGraphSnapshot } from '../shared/authoring-dependency-contracts';
import { exactSourceRewritePatches } from '../shared/authoring-source-rewrite';
import {
  authoringCollectionKeys,
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from '../shared/project-schema/authoring-collections';
import type { AuthoringProject, ReferenceTarget } from '../shared/project-schema/authoring-project';
import { authoringProjectSchema } from '../shared/project-schema/authoring-project';
import { buildShaderMaterialProject } from '../shared/project-schema/shader-material-project';
import {
  projectWorkspaceFiles,
  type LoadedProjectWorkspaceSnapshot,
  type ProjectWorkspaceService,
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
import { cliDiagnostic, type NovelTeaCliDiagnostic } from './contracts';

export interface CliOpenedProject {
  readonly snapshot: LoadedProjectWorkspaceSnapshot;
  readonly editorState: LoadedProjectWorkspaceSnapshot['project']['editor'];
}

export interface CliMutationPlan {
  readonly writes: readonly string[];
  readonly deletes: readonly string[];
  readonly moves: readonly Readonly<{ from: string; to: string }>[];
  readonly referenceRepairs: readonly string[];
}

export interface CliSemanticResult {
  readonly ok: boolean;
  readonly diagnostics: readonly NovelTeaCliDiagnostic[];
  readonly fields?: Readonly<Record<string, unknown>>;
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
  options: Readonly<{ readOnly?: boolean }> = {},
): Promise<
  | Readonly<{ ok: true; opened: CliOpenedProject; diagnostics: readonly NovelTeaCliDiagnostic[] }>
  | Readonly<{ ok: false; diagnostics: readonly NovelTeaCliDiagnostic[] }>
> {
  const opened = await workspace.open(projectRoot, {
    recoverTransactions: options.readOnly ? false : true,
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
    opened: { snapshot: opened.snapshot, editorState: opened.snapshot.project.editor },
    diagnostics: opened.diagnostics.map((item) =>
      cliDiagnostic(item.code, item.path, item.message, item.severity),
    ),
  };
}

function graphSnapshot(
  workspace: ProjectWorkspaceService,
  snapshot: LoadedProjectWorkspaceSnapshot,
): AuthoringDependencyGraphSnapshot {
  return {
    projectInstanceId: 'noveltea-cli',
    projectRevision: 1,
    graphRevision: 1,
    graph: workspace.buildDependencyGraphWithSources(snapshot),
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
): CliMutationPlan {
  const beforeFiles = projectWorkspaceFiles(
    before.project,
    before.project.editor,
    before.scriptSourcePaths,
  );
  const afterFiles = projectWorkspaceFiles(after, after.editor, scriptSourcePaths);
  const writes: string[] = [];
  const deletes: string[] = [];
  for (const file of [
    ...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]),
  ].sort()) {
    if (beforeFiles[file] === afterFiles[file]) continue;
    if (afterFiles[file] === undefined) deletes.push(file);
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

export function usagesForEntity(
  workspace: ProjectWorkspaceService,
  snapshot: LoadedProjectWorkspaceSnapshot,
  collectionValue: string,
  id: string,
): CliSemanticResult {
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
  const graph = graphSnapshot(workspace, snapshot);
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
  nativeTools: NovelTeaCliNativeToolService,
): Promise<CliSemanticResult> {
  const diagnostics: NovelTeaCliDiagnostic[] = workspace
    .publishCompiledArtifact(snapshot)
    .diagnostics.map((item) =>
      cliDiagnostic(item.code, item.jsonPointer, item.message, item.severity),
    );
  diagnostics.push(
    ...workspace.buildDependencyGraphWithSources(snapshot).diagnostics.map((item) =>
      cliDiagnostic(item.code, item.path, item.message, item.severity, {
        sourceUrl: item.sourceUrl,
        line: item.line,
        column: item.column,
      }),
    ),
  );
  const hasShaders =
    Object.keys(snapshot.project.shaders).length > 0 ||
    Object.keys(snapshot.project.materials).length > 0;
  if (hasShaders && !diagnostics.some((item) => item.severity === 'error')) {
    const shaderProject = buildShaderMaterialProject(snapshot.project);
    diagnostics.push(
      ...shaderProject.diagnostics.map((item) =>
        cliDiagnostic('shader.material_project', item.path, item.message, item.severity),
      ),
    );
    if (!diagnostics.some((item) => item.severity === 'error')) {
      try {
        const response = await nativeTools.compileShaders(shaderProject.project, {
          projectRoot: snapshot.projectRoot,
          outputRoot: path.join(snapshot.projectRoot, '.noveltea', 'build'),
          cacheRoot: path.join(snapshot.projectRoot, '.noveltea', 'cache'),
          shaderVariants: ['glsl-120', 'essl-100', 'essl-300'],
        });
        diagnostics.push(
          ...(response.diagnostics ?? []).map((item) =>
            cliDiagnostic(
              `native.shader.${item.code ?? 'compile'}`,
              item.path ?? item.sourcePath ?? item.outputPath ?? '/shaders',
              item.message,
              item.severity,
            ),
          ),
        );
        if (!response.success && !response.diagnostics?.some((item) => item.severity === 'error'))
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
  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    diagnostics,
    fields: { projectRoot: snapshot.projectRoot },
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
          "Generic Asset creation is not supported; add/import Asset source files directly and run 'noveltea validate'.",
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
  );
  if (!dryRun) {
    await workspace.write(
      snapshot.projectRoot,
      snapshot.workspaceRevision,
      candidate,
      candidate.editor,
      snapshot.scriptSourcePaths,
      { operationLabel: `cli entity create ${collection}/${id}` },
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
  const graph = graphSnapshot(workspace, snapshot);
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
  );
  if (!options.dryRun) {
    await workspace.write(
      snapshot.projectRoot,
      snapshot.workspaceRevision,
      candidate,
      candidate.editor,
      sourcePaths,
      { operationLabel: `cli entity rename ${collection}/${fromId} -> ${toId}` },
    );
  }
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
  const graph = graphSnapshot(workspace, snapshot);
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
  );
  if (!options.dryRun) {
    await workspace.write(
      snapshot.projectRoot,
      snapshot.workspaceRevision,
      candidate,
      candidate.editor,
      snapshot.scriptSourcePaths,
      { operationLabel: `cli entity delete ${collection}/${id}` },
    );
  }
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
      dryRun: options.dryRun,
      force: options.force,
      plan,
      usages: usages.map(sourceUsageFields),
    },
  };
}

export const CLI_ENTITY_COLLECTIONS = authoringCollectionKeys;
