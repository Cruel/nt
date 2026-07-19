import type { JsonValue } from './json-value';
import { buildJsonPointer, parseJsonPointer, type JsonPointer } from './json-pointer';
import type {
  SaveUnitCommandAttribution,
  SaveUnitDescriptor,
  SaveUnitId,
  SaveUnitPersistencePolicy,
  SaveUnitResolution,
} from './save-unit-types';
import type { WorkbenchResource, WorkbenchTab } from '@/workbench/workbench-types';

export const PROJECT_SETTINGS_SAVE_UNIT_ID: SaveUnitId = 'project:settings';
export const PROJECT_SETTINGS_OWNED_PATHS: JsonPointer[] = [
  '/project',
  '/settings',
  '/startupHook',
  '/entrypoint',
];

export const SAVE_UNIT_IDS = {
  assetCollection: 'collection:assets',
  testCollection: 'collection:tests',
  variableCollection: 'collection:variables',
  projectSettings: PROJECT_SETTINGS_SAVE_UNIT_ID,
  platformExportProfiles: 'project:platform-export-profiles',
  projectChapters: 'project:chapters',
  projectTags: 'project:tags',
  projectExplorerOptions: 'project:explorer-options',
  assetImportWorkflow: 'workflow:asset-import',
  imageGenerationAssetWorkflow: 'workflow:image-generation-assets',
  shaderCompiledOutputWorkflow: 'workflow:shader-compiled-output',
  successfulExportIdentityWorkflow: 'workflow:successful-export-identity',
  playRecorderWorkflow: 'workflow:play-recorder',
  newEntityWorkflow: 'workflow:new-entity',
  discardWorkflow: 'workflow:discard-dirty-units',
} as const satisfies Record<string, SaveUnitId>;

export const MUTATION_SURFACE_ATTRIBUTIONS = {
  explorerStructuralChanges: {
    originSaveUnitId: 'structure:<collection>',
    persistencePolicy: 'auto-commit',
  },
  explorerOptionsAndVisibility: {
    originSaveUnitId: SAVE_UNIT_IDS.projectExplorerOptions,
    persistencePolicy: 'auto-commit',
  },
  assetImport: {
    originSaveUnitId: SAVE_UNIT_IDS.assetImportWorkflow,
    persistencePolicy: 'auto-commit',
  },
  imageGenerationAssets: {
    originSaveUnitId: SAVE_UNIT_IDS.imageGenerationAssetWorkflow,
    persistencePolicy: 'auto-commit',
  },
  exportProfileEditing: {
    originSaveUnitId: SAVE_UNIT_IDS.platformExportProfiles,
    persistencePolicy: 'manual-save',
  },
  shaderCompiledOutputs: {
    originSaveUnitId: SAVE_UNIT_IDS.shaderCompiledOutputWorkflow,
    persistencePolicy: 'manual-save',
  },
  successfulExportIdentity: {
    originSaveUnitId: SAVE_UNIT_IDS.successfulExportIdentityWorkflow,
    persistencePolicy: 'auto-commit',
  },
  playRecorderTests: {
    originSaveUnitId: SAVE_UNIT_IDS.playRecorderWorkflow,
    persistencePolicy: 'manual-save',
  },
  newEntity: {
    originSaveUnitId: SAVE_UNIT_IDS.newEntityWorkflow,
    persistencePolicy: 'auto-commit',
  },
  discardDirtyUnits: {
    originSaveUnitId: SAVE_UNIT_IDS.discardWorkflow,
    persistencePolicy: 'manual-save',
  },
  layoutSystemRole: {
    originSaveUnitId: SAVE_UNIT_IDS.projectSettings,
    persistencePolicy: 'manual-save',
  },
} as const satisfies Record<
  string,
  { originSaveUnitId: SaveUnitId; persistencePolicy: SaveUnitPersistencePolicy }
>;

const RECORD_EDITOR_TYPES = new Set([
  'asset-detail',
  'shader-detail',
  'material-detail',
  'layout-detail',
  'character-detail',
  'room-detail',
  'interactable-detail',
  'dialogue-detail',
  'scene-detail',
  'test-detail',
  'placeholder-entity',
  'verb-detail',
  'interaction-detail',
  'map-detail',
  'script-module-detail',
]);

const NON_CONTENT_EDITOR_TYPES = new Set([
  'engine-preview',
  'full-game-preview',
  'image-generation',
  'comfyui-workflows',
  'components',
  'settings',
  'platform-export',
]);

function canonicalPaths(paths: JsonPointer[]): JsonPointer[] {
  return [...new Set(paths.map((path) => buildJsonPointer(parseJsonPointer(path))))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function descriptor(options: {
  id: SaveUnitId;
  kind: SaveUnitDescriptor['kind'];
  ownedPaths?: JsonPointer[];
  persistencePolicy?: SaveUnitPersistencePolicy;
  resource?: WorkbenchResource;
  editorType: string;
  tabId?: string;
}): SaveUnitDescriptor {
  const ownedPaths = canonicalPaths(options.ownedPaths ?? []);
  return {
    id: options.id,
    kind: options.kind,
    ownedPaths,
    dependencies: [],
    associatedTabIds: options.tabId ? [options.tabId] : [],
    associatedResourceIds: options.resource ? [options.resource.stableId] : [],
    associatedEditorTypes: [options.editorType],
    pendingRawInputPaths: ownedPaths,
    atomicTransactionGroupIds: [],
    persistencePolicy: options.persistencePolicy ?? 'manual-save',
  };
}

function unsupported(
  resource: WorkbenchResource | undefined,
  editorType: string,
  reason: string,
): SaveUnitResolution {
  return {
    status: 'unsupported',
    editorType,
    resourceId: resource?.stableId ?? null,
    reason,
  };
}

export function recordSaveUnitId(collection: string, entityId: string): SaveUnitId {
  return `record:${collection}:${entityId}`;
}

export function collectionSaveUnitId(collection: string): SaveUnitId {
  return `collection:${collection}`;
}

export function structuralSaveUnitId(collection: string): SaveUnitId {
  return `structure:${collection}`;
}

export function manualSaveAttribution(originSaveUnitId: SaveUnitId): SaveUnitCommandAttribution {
  return { originSaveUnitId, persistencePolicy: 'manual-save' };
}

export function autoCommitAttribution(originSaveUnitId: SaveUnitId): SaveUnitCommandAttribution {
  return { originSaveUnitId, persistencePolicy: 'auto-commit' };
}

export function resolveSaveUnitForResource(
  resource: WorkbenchResource | undefined,
  editorType: string,
  document: JsonValue | null,
  tabId?: string,
): SaveUnitResolution {
  void document;

  if (RECORD_EDITOR_TYPES.has(editorType)) {
    if (!resource?.collection || !resource.entityId) {
      return unsupported(
        resource,
        editorType,
        'Record editor is missing its collection or entity ID.',
      );
    }
    return {
      status: 'savable',
      descriptor: descriptor({
        id: recordSaveUnitId(resource.collection, resource.entityId),
        kind: 'record',
        ownedPaths: [buildJsonPointer([resource.collection, resource.entityId])],
        resource,
        editorType,
        tabId,
      }),
    };
  }

  const collectionEditor =
    editorType === 'asset-library'
      ? { id: SAVE_UNIT_IDS.assetCollection, path: '/assets' }
      : editorType === 'test-suite'
        ? { id: SAVE_UNIT_IDS.testCollection, path: '/tests' }
        : editorType === 'variables'
          ? { id: SAVE_UNIT_IDS.variableCollection, path: '/variables' }
          : null;
  if (collectionEditor) {
    return {
      status: 'savable',
      descriptor: descriptor({
        id: collectionEditor.id,
        kind: 'collection',
        ownedPaths: [collectionEditor.path],
        resource,
        editorType,
        tabId,
      }),
    };
  }

  const projectEditor =
    editorType === 'project-settings'
      ? {
          id: SAVE_UNIT_IDS.projectSettings,
          kind: 'project-settings' as const,
          paths: PROJECT_SETTINGS_OWNED_PATHS,
        }
      : editorType === 'platform-export-profiles'
        ? {
            id: SAVE_UNIT_IDS.platformExportProfiles,
            kind: 'project-tool' as const,
            paths: ['/settings/platformExport'],
          }
        : editorType === 'project-chapters'
          ? {
              id: SAVE_UNIT_IDS.projectChapters,
              kind: 'project-tool' as const,
              paths: ['/editor/chapters'],
            }
          : editorType === 'project-tags'
            ? {
                id: SAVE_UNIT_IDS.projectTags,
                kind: 'project-tool' as const,
                paths: ['/editor/tags'],
              }
            : null;
  if (projectEditor) {
    return {
      status: 'savable',
      descriptor: descriptor({
        id: projectEditor.id,
        kind: projectEditor.kind,
        ownedPaths: projectEditor.paths,
        resource,
        editorType,
        tabId,
      }),
    };
  }

  if (NON_CONTENT_EDITOR_TYPES.has(editorType)) {
    return {
      status: 'non-content',
      descriptor: descriptor({
        id: `tool:${editorType}`,
        kind: 'non-content-tool',
        persistencePolicy: 'auto-commit',
        resource,
        editorType,
        tabId,
      }),
    };
  }

  return unsupported(resource, editorType, `Editor type '${editorType}' has no save-unit mapping.`);
}

export function resolveSaveUnitForTab(
  tab: WorkbenchTab,
  document: JsonValue | null,
): SaveUnitResolution {
  return resolveSaveUnitForResource(tab.resource, tab.editorType, document, tab.id);
}
