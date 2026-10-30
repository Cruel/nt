import type { ToolDiagnostic } from '../../shared/editor-tooling';
import {
  isTrackedEditorProjectStatePath,
  stripLocalEditorProjectState,
  type EditorRecoverySaveUnit,
  type EditorRecoveryState,
} from '../../shared/project-schema/editor-project-state';
import { createProjectValidationDiagnostic } from '../../shared/project-schema/project-diagnostic-projection';
import { applyJsonPatch, type JsonPatchOperation } from './json-patch';
import {
  getJsonAtPointer,
  hasJsonAtPointer,
  parseJsonPointer,
  type JsonPointer,
} from './json-pointer';
import { cloneJsonValue, type JsonValue } from './json-value';
import { recordSaveUnitId, SAVE_UNIT_IDS } from './save-unit-registry';
import type { SaveUnitId } from './save-unit-types';

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
  discardRecoverySaveUnitIds: SaveUnitId[];
  allowNewAuthoringErrors: boolean;
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
  status: 'persisted' | 'converted-to-manual-save' | 'rejected' | 'failed' | 'cancelled';
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
    commandType: 'asset.reimportFile',
    unsafeRebasePolicy: 'reject-command',
    allowedOriginPrefixes: ['structure:assets'],
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
    allowedOriginPrefixes: ['workflow:', 'editor-local:'],
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

function isPersistedProjectContentPath(path: JsonPointer): boolean {
  return (
    path !== '/editor' && (!path.startsWith('/editor/') || isTrackedEditorProjectStatePath(path))
  );
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
  const assets = Array.isArray(value.assets) ? value.assets : value.asset ? [value.asset] : [];
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

function discardedRecoverySaveUnits(commandType: string, payload: unknown): SaveUnitId[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const value = payload as Record<string, unknown>;
  if (commandType === 'entity.deleteRecord') {
    const collection = typeof value.collection === 'string' ? value.collection : null;
    const entityId = typeof value.entityId === 'string' ? value.entityId : null;
    return collection && entityId ? [recordSaveUnitId(collection, entityId)] : [];
  }
  if (commandType === 'asset.deleteAsset') {
    const assetId = typeof value.assetId === 'string' ? value.assetId : null;
    return assetId ? [recordSaveUnitId('assets', assetId)] : [];
  }
  return [];
}

function allowsNewAuthoringErrors(commandType: string, payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return (
    (commandType === 'entity.deleteRecord' || commandType === 'asset.deleteAsset') &&
    value.force === true
  );
}

export function buildAutoCommitPlan(input: AutoCommitPlanBuildInput): AutoCommitPlanBuildResult {
  const rule = ruleFor(input.commandType, input.originSaveUnitId);
  if (!rule) {
    return rejection(
      `Auto-commit command '${input.commandType}' from '${input.originSaveUnitId}' is not classified.`,
      input.affectedPaths[0] ?? '/',
    );
  }
  const persistenceTarget =
    input.commandType === 'project.applyPatch' && input.originSaveUnitId.startsWith('editor-local:')
      ? 'editor-metadata'
      : (rule.persistenceTarget ?? 'project-content');
  if (!input.savedDocument && persistenceTarget !== 'editor-metadata') {
    // New-entity transactions also contain follow-up setup operations. An
    // unsaved Project has no disk baseline to auto-commit against, but these
    // newly-authored in-memory records can remain a single manual Save unit.
    if (
      rule.unsafeRebasePolicy === 'convert-to-manual-save' ||
      (input.commandType === 'transaction' &&
        input.originSaveUnitId === SAVE_UNIT_IDS.newEntityWorkflow)
    ) {
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

  let forwardBaselinePatches: JsonPatchOperation[] = [];
  let inverseBaselinePatches: JsonPatchOperation[] = [];
  if (persistenceTarget === 'project-content') {
    const savedContent = stripLocalEditorProjectState(input.savedDocument) as JsonValue;
    // Tracked editor organization is part of project content even though it lives in editor.yaml;
    // only ignored/session editor paths are excluded from the structural content baseline.
    const contentPatches = input.patches.filter((patch) =>
      isPersistedProjectContentPath(patch.path),
    );
    try {
      const applied = applyJsonPatch(savedContent, contentPatches);
      forwardBaselinePatches = contentPatches.map((patch) => cloneJsonValue(patch));
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
      discardRecoverySaveUnitIds: discardedRecoverySaveUnits(input.commandType, input.payload),
      allowNewAuthoringErrors: allowsNewAuthoringErrors(input.commandType, input.payload),
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

export function structuralRuleForTests(commandType: string, originSaveUnitId: string) {
  return ruleFor(commandType, originSaveUnitId);
}

export function parseStructuralPathForTests(path: string) {
  return parseJsonPointer(path);
}
