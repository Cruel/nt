import { applyJsonPatch, type JsonPatchOperation } from './json-patch';
import {
  getJsonAtPointer,
  hasJsonAtPointer,
  parseJsonPointer,
  type JsonPointer,
} from './json-pointer';
import { cloneJsonValue, type JsonValue } from './json-value';
import { rebaseRecoveryOverlays } from './project-save-coordinator';
import { useProjectStore } from './project-store';
import {
  buildEditorProjectStateSnapshot,
  mergeEditorProjectState,
  setLoadedEditorProjectState,
} from '@/workbench/project-editor-state';
import {
  stripEditorProjectState,
  type EditorProjectState,
  type EditorRecoverySaveUnit,
  type EditorRecoveryState,
} from '../../shared/project-schema/editor-project-state';
import { decodeAuthoringProject } from '../../shared/project-schema/decode-authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import {
  collectProjectValidationDiagnostics,
  createProjectValidationDiagnostic,
  projectValidationDiagnosticKey,
  type ProjectValidationDiagnostic,
} from '../../shared/project-schema/project-validation';
import type { SaveUnitId } from './save-unit-types';
import type { ToolDiagnostic } from '../../shared/editor-tooling';
import type { ProjectAssetTrashMove } from '../../shared/project-asset-audit';

export type UnsafeRebasePolicy = 'reject-command' | 'convert-to-manual-save';
export type AutoCommitPersistenceTarget = 'project-content' | 'editor-metadata';

export interface AutoCommitIdentityRemap {
  fromPath: JsonPointer;
  toPath: JsonPointer;
  fromSaveUnitId?: SaveUnitId;
  toSaveUnitId?: SaveUnitId;
}

export type AutoCommitFilesystemOperation =
  | {
      kind: 'trash-project-assets';
      projectRelativePaths: string[];
      restoreOnUndo: true;
    }
  | {
      kind: 'staged-project-assets';
      projectRelativePaths: string[];
      trashOnUndo: true;
    }
  | {
      kind: 'preexisting-project-assets';
      projectRelativePaths: string[];
      reason: 'existing-project-file' | 'generated-project-file' | 'legacy-unspecified';
    };

export interface AutoCommitPlan {
  commandType: string;
  originSaveUnitId: SaveUnitId;
  persistenceTarget: AutoCommitPersistenceTarget;
  baselinePatches: JsonPatchOperation[];
  workingDocumentPatches: JsonPatchOperation[];
  forwardBaselinePatches: JsonPatchOperation[];
  inverseBaselinePatches: JsonPatchOperation[];
  affectedPaths: JsonPointer[];
  identityRemap: AutoCommitIdentityRemap[];
  filesystemOperations: AutoCommitFilesystemOperation[];
  unsafeRebasePolicy: UnsafeRebasePolicy;
}

export interface AutoCommitPlanBuildInput {
  commandType: string;
  originSaveUnitId: SaveUnitId;
  savedDocument: JsonValue | null;
  workingDocument: JsonValue;
  patches: JsonPatchOperation[];
  affectedPaths: JsonPointer[];
  payload: unknown;
}

export type AutoCommitPlanBuildResult =
  | { status: 'planned'; plan: AutoCommitPlan }
  | { status: 'convert-to-manual-save'; reason: string }
  | { status: 'rejected'; diagnostic: ToolDiagnostic };

export interface StructuralPersistenceResult {
  status: 'persisted' | 'converted-to-manual-save' | 'rejected' | 'failed';
  diagnostics: ToolDiagnostic[];
}

interface AutoCommitRule {
  commandType: string;
  unsafeRebasePolicy: UnsafeRebasePolicy;
  persistenceTarget?: AutoCommitPersistenceTarget;
  allowedOriginPrefixes?: string[];
  filesystem?: 'asset-delete' | 'asset-import';
  identityRemap?: 'entity-rename';
}

export const STRUCTURAL_AUTO_COMMIT_RULES: readonly AutoCommitRule[] = [
  {
    commandType: 'entity.createRecord',
    unsafeRebasePolicy: 'convert-to-manual-save',
    allowedOriginPrefixes: ['structure:', 'workflow:new-entity'],
  },
  {
    commandType: 'entity.duplicateRecord',
    unsafeRebasePolicy: 'convert-to-manual-save',
    allowedOriginPrefixes: ['structure:'],
  },
  {
    commandType: 'entity.renameId',
    unsafeRebasePolicy: 'reject-command',
    allowedOriginPrefixes: ['structure:'],
    identityRemap: 'entity-rename',
  },
  {
    commandType: 'entity.deleteRecord',
    unsafeRebasePolicy: 'reject-command',
    allowedOriginPrefixes: ['structure:'],
  },
  {
    commandType: 'asset.importFiles',
    unsafeRebasePolicy: 'convert-to-manual-save',
    allowedOriginPrefixes: [
      'workflow:asset-import',
      'workflow:image-generation-assets',
      'structure:assets',
    ],
    filesystem: 'asset-import',
  },
  {
    commandType: 'asset.deleteAsset',
    unsafeRebasePolicy: 'reject-command',
    allowedOriginPrefixes: ['structure:assets'],
    filesystem: 'asset-delete',
  },
  {
    commandType: 'project.setExplorerOptions',
    unsafeRebasePolicy: 'convert-to-manual-save',
    allowedOriginPrefixes: ['project:explorer-options'],
    persistenceTarget: 'editor-metadata',
  },
  {
    commandType: 'project.setHiddenCollections',
    unsafeRebasePolicy: 'convert-to-manual-save',
    allowedOriginPrefixes: ['project:explorer-options'],
    persistenceTarget: 'editor-metadata',
  },
  {
    commandType: 'project.applyPatch',
    unsafeRebasePolicy: 'reject-command',
    allowedOriginPrefixes: ['workflow:'],
  },
  {
    commandType: 'transaction',
    unsafeRebasePolicy: 'reject-command',
    allowedOriginPrefixes: ['workflow:new-entity'],
  },
] as const;

function uniqueSorted(paths: readonly JsonPointer[]): JsonPointer[] {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function pathOverlaps(left: string, right: string): boolean {
  if (left === '/' || right === '/') return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function ruleFor(commandType: string, originSaveUnitId: string): AutoCommitRule | null {
  return (
    STRUCTURAL_AUTO_COMMIT_RULES.find(
      (rule) =>
        rule.commandType === commandType &&
        (!rule.allowedOriginPrefixes ||
          rule.allowedOriginPrefixes.some((prefix) => originSaveUnitId.startsWith(prefix))),
    ) ?? null
  );
}

function rejection(message: string, path: string = '/'): AutoCommitPlanBuildResult {
  return {
    status: 'rejected',
    diagnostic: createProjectValidationDiagnostic({
      code: 'editor.auto-commit.plan-invalid',
      severity: 'error',
      category: 'Project structural persistence',
      path,
      message,
      boundaries: ['authoring'],
      ownerPaths: [path],
    }),
  };
}

function entityRenameRemap(payload: unknown): AutoCommitIdentityRemap[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const value = payload as Record<string, unknown>;
  const collection = typeof value.collection === 'string' ? value.collection : null;
  const fromId = typeof value.fromId === 'string' ? value.fromId : null;
  const toId = typeof value.toId === 'string' ? value.toId : null;
  if (!collection || !fromId || !toId) return [];
  const escape = (segment: string) => segment.replaceAll('~', '~0').replaceAll('/', '~1');
  return [
    {
      fromPath: `/${escape(collection)}/${escape(fromId)}`,
      toPath: `/${escape(collection)}/${escape(toId)}`,
      fromSaveUnitId: `record:${collection}:${fromId}`,
      toSaveUnitId: `record:${collection}:${toId}`,
    },
  ];
}

function assetDeleteFilesystemPlan(
  workingDocument: JsonValue,
  payload: unknown,
): AutoCommitFilesystemOperation[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const assetId = (payload as Record<string, unknown>).assetId;
  if (typeof assetId !== 'string') return [];
  const escape = assetId.replaceAll('~', '~0').replaceAll('/', '~1');
  const sourcePath = `/assets/${escape}/data/source/path` as JsonPointer;
  if (!hasJsonAtPointer(workingDocument, sourcePath)) return [];
  const value = getJsonAtPointer(workingDocument, sourcePath);
  return typeof value === 'string' && value.length > 0
    ? [{ kind: 'trash-project-assets', projectRelativePaths: [value], restoreOnUndo: true }]
    : [];
}

function assetImportFilesystemPlan(payload: unknown): AutoCommitFilesystemOperation[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const value = payload as Record<string, unknown>;
  const assets = Array.isArray(value.assets) ? value.assets : [];
  const projectRelativePaths = uniqueSorted(
    assets
      .map((asset) =>
        asset && typeof asset === 'object' && !Array.isArray(asset)
          ? (asset as Record<string, unknown>).projectRelativePath
          : null,
      )
      .filter((path): path is string => typeof path === 'string' && path.length > 0),
  );
  if (projectRelativePaths.length === 0) return [];
  if (value.fileOrigin === 'copied-by-import') {
    return [{ kind: 'staged-project-assets', projectRelativePaths, trashOnUndo: true }];
  }
  return [
    {
      kind: 'preexisting-project-assets',
      projectRelativePaths,
      reason:
        value.fileOrigin === 'existing-project-file' ||
        value.fileOrigin === 'generated-project-file'
          ? value.fileOrigin
          : 'legacy-unspecified',
    },
  ];
}

export function buildAutoCommitPlan(input: AutoCommitPlanBuildInput): AutoCommitPlanBuildResult {
  const rule = ruleFor(input.commandType, input.originSaveUnitId);
  if (!rule) {
    return rejection(
      `Auto-commit command '${input.commandType}' from '${input.originSaveUnitId}' is not classified.`,
      input.affectedPaths[0] ?? '/',
    );
  }
  if (!input.savedDocument) {
    if (rule.unsafeRebasePolicy === 'convert-to-manual-save') {
      return {
        status: 'convert-to-manual-save',
        reason: 'The project has no saved baseline yet.',
      };
    }
    return rejection(
      'Auto-commit requires a saved project baseline.',
      input.affectedPaths[0] ?? '/',
    );
  }

  const persistenceTarget = rule.persistenceTarget ?? 'project-content';
  let forwardBaselinePatches: JsonPatchOperation[] = [];
  let inverseBaselinePatches: JsonPatchOperation[] = [];
  if (persistenceTarget === 'project-content') {
    const savedContent = stripEditorProjectState(input.savedDocument) as JsonValue;
    try {
      const applied = applyJsonPatch(savedContent, input.patches);
      forwardBaselinePatches = input.patches.map((patch) => cloneJsonValue(patch));
      inverseBaselinePatches = applied.inversePatches;
    } catch (error) {
      if (rule.unsafeRebasePolicy === 'convert-to-manual-save') {
        return {
          status: 'convert-to-manual-save',
          reason:
            error instanceof Error
              ? error.message
              : 'Baseline patches could not be constructed safely.',
        };
      }
      return rejection(
        error instanceof Error
          ? error.message
          : 'Baseline patches could not be constructed safely.',
        input.affectedPaths[0] ?? '/',
      );
    }
  }

  const identityRemap =
    rule.identityRemap === 'entity-rename' ? entityRenameRemap(input.payload) : [];
  if (rule.identityRemap && identityRemap.length === 0) {
    return rejection(
      'The command did not provide a complete identity remap.',
      input.affectedPaths[0] ?? '/',
    );
  }
  const filesystemOperations =
    rule.filesystem === 'asset-delete'
      ? assetDeleteFilesystemPlan(input.workingDocument, input.payload)
      : rule.filesystem === 'asset-import'
        ? assetImportFilesystemPlan(input.payload)
        : [];

  return {
    status: 'planned',
    plan: {
      commandType: input.commandType,
      originSaveUnitId: input.originSaveUnitId,
      persistenceTarget,
      baselinePatches: forwardBaselinePatches,
      workingDocumentPatches: input.patches.map((patch) => cloneJsonValue(patch)),
      forwardBaselinePatches,
      inverseBaselinePatches,
      affectedPaths: uniqueSorted(input.affectedPaths),
      identityRemap,
      filesystemOperations,
      unsafeRebasePolicy: rule.unsafeRebasePolicy,
    },
  };
}

function remapPath(path: JsonPointer, remaps: readonly AutoCommitIdentityRemap[]): JsonPointer {
  for (const remap of remaps) {
    if (path === remap.fromPath) return remap.toPath;
    if (path.startsWith(`${remap.fromPath}/`)) {
      return `${remap.toPath}${path.slice(remap.fromPath.length)}`;
    }
  }
  return path;
}

export function remapRecoveryForAutoCommit(
  recovery: EditorRecoveryState,
  remaps: readonly AutoCommitIdentityRemap[],
): EditorRecoveryState {
  if (remaps.length === 0) return recovery;
  const saveUnitsById: Record<string, EditorRecoverySaveUnit> = {};
  for (const [saveUnitId, entry] of Object.entries(recovery.saveUnitsById)) {
    const remap = remaps.find((candidate) => candidate.fromSaveUnitId === saveUnitId);
    const nextId = remap?.toSaveUnitId ?? saveUnitId;
    const nextEntry: EditorRecoverySaveUnit = {
      ...entry,
      patches: entry.patches.map((patch) => ({ ...patch, path: remapPath(patch.path, remaps) })),
      affectedPaths: uniqueSorted(entry.affectedPaths.map((path) => remapPath(path, remaps))),
      pendingRawInputByPath: Object.fromEntries(
        Object.entries(entry.pendingRawInputByPath).map(([path, value]) => [
          remapPath(path, remaps),
          value,
        ]),
      ),
    };
    const existing = saveUnitsById[nextId];
    saveUnitsById[nextId] = existing
      ? {
          sequence: Math.min(existing.sequence, nextEntry.sequence),
          patches: [...existing.patches, ...nextEntry.patches],
          affectedPaths: uniqueSorted([...existing.affectedPaths, ...nextEntry.affectedPaths]),
          pendingRawInputByPath: {
            ...existing.pendingRawInputByPath,
            ...nextEntry.pendingRawInputByPath,
          },
          atomicTransactionGroupIds: uniqueSorted([
            ...existing.atomicTransactionGroupIds,
            ...nextEntry.atomicTransactionGroupIds,
          ]),
        }
      : nextEntry;
  }
  return { ...recovery, saveUnitsById };
}

function collectAuthoringDiagnostics(document: JsonValue): ProjectValidationDiagnostic[] {
  const decoded = decodeAuthoringProject(stripEditorProjectState(document));
  if (!decoded.project) return collectProjectValidationDiagnostics(decoded.structuralDiagnostics);
  return collectProjectValidationDiagnostics(
    decoded.semanticDiagnostics,
    validateAuthoringProject(decoded.project),
  );
}

function newAuthoringErrors(
  baseline: JsonValue,
  candidate: JsonValue,
): ProjectValidationDiagnostic[] {
  const baselineKeys = new Set(
    collectAuthoringDiagnostics(baseline)
      .filter(
        (diagnostic) =>
          diagnostic.severity === 'error' && diagnostic.boundaries.includes('authoring'),
      )
      .map(projectValidationDiagnosticKey),
  );
  return collectAuthoringDiagnostics(candidate).filter(
    (diagnostic) =>
      diagnostic.severity === 'error' &&
      diagnostic.boundaries.includes('authoring') &&
      !baselineKeys.has(projectValidationDiagnosticKey(diagnostic)),
  );
}

function unsafeRecoveryUnits(recovery: EditorRecoveryState, plan: AutoCommitPlan): SaveUnitId[] {
  const remappedSafeIds = new Set(
    plan.identityRemap
      .flatMap((remap) => [remap.fromSaveUnitId, remap.toSaveUnitId])
      .filter((value): value is string => Boolean(value)),
  );
  return Object.entries(recovery.saveUnitsById)
    .filter(([saveUnitId, entry]) => {
      if (saveUnitId === plan.originSaveUnitId || remappedSafeIds.has(saveUnitId)) return false;
      return entry.affectedPaths.some((dirtyPath) =>
        plan.affectedPaths.some((structuralPath) => pathOverlaps(dirtyPath, structuralPath)),
      );
    })
    .map(([saveUnitId]) => saveUnitId)
    .sort();
}

const filesystemStateByCommandId = new Map<string, ProjectAssetTrashMove[]>();

function normalizeToolDiagnostics(
  diagnostics: ReadonlyArray<{
    severity: 'info' | 'warning' | 'error';
    path?: string;
    message: string;
    category?: string;
  }>,
  fallbackPath = '/',
): ToolDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    severity: diagnostic.severity,
    path: diagnostic.path ?? fallbackPath,
    message: diagnostic.message,
    ...(diagnostic.category ? { category: diagnostic.category } : {}),
  }));
}

function fileOperationFailure(
  diagnostics: ToolDiagnostic[],
  error: string | undefined,
  fallbackMessage: string,
): ToolDiagnostic[] {
  return diagnostics.length > 0
    ? diagnostics
    : [
        {
          severity: 'error',
          category: 'Project structural persistence',
          path: '/assets',
          message: error ?? fallbackMessage,
        },
      ];
}

async function trashAssetPaths(
  commandId: string,
  projectFilePath: string,
  projectRelativePaths: string[],
): Promise<ToolDiagnostic[]> {
  const result = await window.noveltea.trashProjectAssetFiles(
    projectFilePath,
    projectRelativePaths,
  );
  const moved = result.moved ?? [];
  if (moved.length > 0) filesystemStateByCommandId.set(commandId, moved);
  if (!result.ok || moved.length !== projectRelativePaths.length) {
    return fileOperationFailure(
      normalizeToolDiagnostics(result.diagnostics, '/assets'),
      result.error,
      'Failed to move every project asset file to trash.',
    );
  }
  return [];
}

async function restoreAssetMoves(commandId: string, projectFilePath: string) {
  const moves = filesystemStateByCommandId.get(commandId) ?? [];
  if (moves.length === 0) return [];
  const result = await window.noveltea.restoreProjectAssetFiles(projectFilePath, moves);
  if (result.ok && (result.restored?.length ?? 0) === moves.length) return [];
  return fileOperationFailure(
    normalizeToolDiagnostics(result.diagnostics, '/assets'),
    result.error,
    'Failed to restore every project asset file.',
  );
}

async function applyFilesystemTransition(
  commandId: string,
  projectFilePath: string,
  plan: AutoCommitPlan,
  direction: 'forward' | 'undo' | 'redo',
): Promise<ToolDiagnostic[]> {
  for (const operation of plan.filesystemOperations) {
    if (operation.kind === 'preexisting-project-assets') continue;
    const diagnostics =
      operation.kind === 'trash-project-assets'
        ? direction === 'undo'
          ? await restoreAssetMoves(commandId, projectFilePath)
          : await trashAssetPaths(commandId, projectFilePath, operation.projectRelativePaths)
        : direction === 'forward'
          ? []
          : direction === 'undo'
            ? await trashAssetPaths(commandId, projectFilePath, operation.projectRelativePaths)
            : await restoreAssetMoves(commandId, projectFilePath);
    if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return diagnostics;
  }
  return [];
}

async function rollbackFilesystemTransition(
  commandId: string,
  projectFilePath: string,
  plan: AutoCommitPlan,
  direction: 'forward' | 'undo' | 'redo',
) {
  for (const operation of [...plan.filesystemOperations].reverse()) {
    if (operation.kind === 'preexisting-project-assets') continue;
    if (operation.kind === 'trash-project-assets') {
      if (direction === 'undo') {
        await trashAssetPaths(commandId, projectFilePath, operation.projectRelativePaths);
      } else {
        await restoreAssetMoves(commandId, projectFilePath);
        filesystemStateByCommandId.delete(commandId);
      }
      continue;
    }
    if (direction === 'undo') {
      await restoreAssetMoves(commandId, projectFilePath);
      filesystemStateByCommandId.delete(commandId);
    } else {
      await trashAssetPaths(commandId, projectFilePath, operation.projectRelativePaths);
      if (direction === 'forward') filesystemStateByCommandId.delete(commandId);
    }
  }
}

export async function persistAutoCommitPlan(
  commandId: string,
  plan: AutoCommitPlan,
  direction: 'forward' | 'undo' | 'redo',
): Promise<StructuralPersistenceResult> {
  const projectState = useProjectStore.getState();
  if (!projectState.document || !projectState.savedDocument || !projectState.projectFilePath) {
    return {
      status:
        direction === 'forward' && plan.unsafeRebasePolicy === 'convert-to-manual-save'
          ? 'converted-to-manual-save'
          : 'rejected',
      diagnostics: [],
    };
  }
  const snapshot = buildEditorProjectStateSnapshot();
  const remappedRecovery = remapRecoveryForAutoCommit(snapshot.recovery, plan.identityRemap);
  const unsafeUnits = unsafeRecoveryUnits(remappedRecovery, plan);
  if (unsafeUnits.length > 0) {
    const diagnostic = createProjectValidationDiagnostic({
      code: 'editor.auto-commit.unsafe-rebase',
      severity: 'error',
      category: 'Project structural persistence',
      path: plan.affectedPaths[0] ?? '/',
      message: `The structural command overlaps dirty save ${unsafeUnits.length === 1 ? 'unit' : 'units'} ${unsafeUnits.join(', ')} and cannot be rebased safely.`,
      boundaries: ['authoring'],
      ownerPaths: plan.affectedPaths.length > 0 ? plan.affectedPaths : ['/'],
    });
    return {
      status:
        direction === 'forward' && plan.unsafeRebasePolicy === 'convert-to-manual-save'
          ? 'converted-to-manual-save'
          : 'rejected',
      diagnostics: [diagnostic],
    };
  }

  if (plan.persistenceTarget === 'editor-metadata') {
    const editorState: EditorProjectState = { ...snapshot, recovery: remappedRecovery };
    const response = await window.noveltea.saveProjectEditorMetadata(
      projectState.projectFilePath,
      editorState.contentFingerprint,
      editorState,
    );
    if (!response.success) {
      return {
        status: 'failed',
        diagnostics:
          response.diagnostics.length > 0
            ? normalizeToolDiagnostics(response.diagnostics, '/editor')
            : [],
      };
    }
    const persisted = {
      ...editorState,
      contentFingerprint: response.contentFingerprint ?? editorState.contentFingerprint,
    };
    setLoadedEditorProjectState(persisted);
    useProjectStore.getState().markEditorMetadataPersisted(persisted);
    return { status: 'persisted', diagnostics: [] };
  }

  const baselineContent = stripEditorProjectState(projectState.savedDocument) as JsonValue;
  const patches = direction === 'undo' ? plan.inverseBaselinePatches : plan.forwardBaselinePatches;
  let candidateContent: JsonValue;
  try {
    candidateContent = applyJsonPatch(baselineContent, patches).document;
  } catch (error) {
    return {
      status: 'failed',
      diagnostics: [
        createProjectValidationDiagnostic({
          code: 'editor.auto-commit.baseline-patch-failed',
          severity: 'error',
          category: 'Project structural persistence',
          path: plan.affectedPaths[0] ?? '/',
          message: error instanceof Error ? error.message : 'The saved baseline patch failed.',
          boundaries: ['authoring'],
          ownerPaths: plan.affectedPaths.length > 0 ? plan.affectedPaths : ['/'],
        }),
      ],
    };
  }
  const candidateErrors = newAuthoringErrors(baselineContent, candidateContent);
  if (candidateErrors.length > 0) {
    return {
      status:
        direction === 'forward' && plan.unsafeRebasePolicy === 'convert-to-manual-save'
          ? 'converted-to-manual-save'
          : 'rejected',
      diagnostics: candidateErrors,
    };
  }

  const filesystemDiagnostics = await applyFilesystemTransition(
    commandId,
    projectState.projectFilePath,
    plan,
    direction,
  );
  if (filesystemDiagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    await rollbackFilesystemTransition(commandId, projectState.projectFilePath, plan, direction);
    return { status: 'failed', diagnostics: filesystemDiagnostics };
  }

  const rebasedRecovery = rebaseRecoveryOverlays(
    remappedRecovery,
    candidateContent,
    projectState.document,
    new Set([plan.originSaveUnitId]),
  );
  const editorState: EditorProjectState = { ...snapshot, recovery: rebasedRecovery };
  const response = await window.noveltea.saveProjectContent(
    projectState.projectFilePath,
    snapshot.contentFingerprint,
    candidateContent,
    editorState,
  );
  if (!response.success) {
    await rollbackFilesystemTransition(commandId, projectState.projectFilePath, plan, direction);
    return {
      status: 'failed',
      diagnostics: fileOperationFailure(
        normalizeToolDiagnostics(response.diagnostics ?? []),
        response.error,
        'Structural project content persistence failed.',
      ),
    };
  }
  const persistedEditorState: EditorProjectState = {
    ...editorState,
    contentFingerprint: response.contentFingerprint ?? editorState.contentFingerprint,
  };
  useProjectStore.getState().markSaved({
    document: mergeEditorProjectState(candidateContent, persistedEditorState),
    projectPath: response.projectPath,
    projectFilePath: response.projectFilePath,
  });
  setLoadedEditorProjectState(persistedEditorState);
  useProjectStore.getState().markEditorMetadataPersisted(persistedEditorState);
  return { status: 'persisted', diagnostics: filesystemDiagnostics };
}

export function structuralRuleForTests(commandType: string, originSaveUnitId: string) {
  return ruleFor(commandType, originSaveUnitId);
}

export function parseStructuralPathForTests(path: string) {
  return parseJsonPointer(path);
}
