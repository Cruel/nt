import type { JsonPointer } from './json-pointer';

export type SaveUnitId = string;

export type SaveUnitKind =
  | 'record'
  | 'collection'
  | 'project-settings'
  | 'project-tool'
  | 'project-structure'
  | 'workflow'
  | 'non-content-tool';

export type SaveUnitPersistencePolicy = 'manual-save' | 'auto-commit';

export interface SaveUnitDependency {
  saveUnitId: SaveUnitId;
  kind: 'requires' | 'atomic-with';
}

export interface SaveUnitDescriptor {
  id: SaveUnitId;
  kind: SaveUnitKind;
  ownedPaths: JsonPointer[];
  dependencies: SaveUnitDependency[];
  associatedTabIds: string[];
  associatedResourceIds: string[];
  associatedEditorTypes: string[];
  pendingRawInputPaths: JsonPointer[];
  atomicTransactionGroupIds: string[];
  persistencePolicy: SaveUnitPersistencePolicy;
}

export interface SavableSaveUnitResolution {
  status: 'savable';
  descriptor: SaveUnitDescriptor;
}

export interface NonContentSaveUnitResolution {
  status: 'non-content';
  descriptor: SaveUnitDescriptor;
}

export interface UnsupportedSaveUnitResolution {
  status: 'unsupported';
  editorType: string;
  resourceId: string | null;
  reason: string;
}

export type SaveUnitResolution =
  | SavableSaveUnitResolution
  | NonContentSaveUnitResolution
  | UnsupportedSaveUnitResolution;

export interface SaveUnitCommandAttribution {
  originSaveUnitId: SaveUnitId;
  persistencePolicy: SaveUnitPersistencePolicy;
  atomicTransactionGroupId?: string;
}
