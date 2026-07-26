import type { AuthoringCollectionKey } from './project-schema/authoring-collections';
import type {
  AuthoringLiteralOccurrence,
  LuaReferenceOccurrence,
} from './project-schema/authoring-lua-analysis';
import type { JsonPointer } from './json-pointer';

export type AuthoringDependencyNodeKey =
  | { kind: 'record'; collection: AuthoringCollectionKey; id: string }
  | {
      kind: 'nested';
      ownerCollection: AuthoringCollectionKey;
      ownerId: string;
      family: 'room-placement' | 'room-exit';
      id: string;
    }
  | { kind: 'property-definition'; id: string }
  | { kind: 'localization-key'; locale: string; key: string }
  | { kind: 'project-field'; path: JsonPointer };
export type DependencyImpactFacet =
  | 'reference-integrity'
  | 'tooling-reference'
  | 'preview-visual'
  | 'preview-ui'
  | 'resource'
  | 'validation'
  | 'runtime-only';
export const AUTHORING_DEPENDENCY_ROLES = [
  'explicit-ref',
  'variable-ref',
  'condition-variable',
  'extends',
  'entrypoint',
  'flow-target',
  'property-assignment',
  'localization-text',
  'layout-rml-source',
  'layout-rcss-source',
  'layout-lua-source',
  'layout-image',
  'layout-font',
  'layout-stylesheet',
  'layout-script',
  'layout-template',
  'layout-material',
  'shader-source',
  'script-source',
  'material-base',
  'material-shader',
  'material-texture',
  'character-pose-sprite',
  'character-pose-material',
  'character-expression-sprite',
  'character-expression-material',
  'character-room-placement',
  'room-background',
  'room-background-material',
  'room-cast-character',
  'room-overlay-layout',
  'room-placement-layout',
  'room-prop-asset',
  'room-prop-material',
  'room-environment-asset',
  'room-environment-material',
  'room-compose-script',
  'room-exit-target',
  'interactable-sprite',
  'interactable-material',
  'interactable-room-placement',
  'lua-possible-reference',
  'lua-explicit-reference',
  'system-layout',
  'default-font',
] as const;
export type AuthoringDependencyRole = (typeof AUTHORING_DEPENDENCY_ROLES)[number];
export type AuthoringReferenceRepairPolicy =
  | { kind: 'set-null'; path: JsonPointer }
  | { kind: 'clear-field'; path: JsonPointer }
  | { kind: 'remove-array-item'; itemPath: JsonPointer }
  | { kind: 'remove-map-entry'; entryPath: JsonPointer }
  | { kind: 'replacement-required'; path: JsonPointer; collection: AuthoringCollectionKey }
  | { kind: 'warning-only'; reason: string }
  | { kind: 'blocked'; reason: string };
export type AuthoringDependencyEvidence =
  | { kind: 'lua-occurrence'; occurrence: LuaReferenceOccurrence<AuthoringDependencyNodeKey> }
  | { kind: 'explicit-lua-fallback'; declarationPath: JsonPointer };
export interface AuthoringDependencyEdge {
  id: string;
  source: AuthoringDependencyNodeKey;
  target: AuthoringDependencyNodeKey;
  sourcePath: JsonPointer;
  targetPath: JsonPointer;
  role: AuthoringDependencyRole;
  facets: readonly DependencyImpactFacet[];
  targetImpactPaths: readonly JsonPointer[];
  repair: AuthoringReferenceRepairPolicy;
  evidence?: readonly AuthoringDependencyEvidence[];
  detail?: Readonly<Record<string, string>>;
}
export interface AuthoringDependencyNode {
  key: AuthoringDependencyNodeKey;
  keyText: string;
  owningPath: JsonPointer;
  label: string;
}
export interface AuthoringDependencyGraphDiagnostic {
  severity: 'warning' | 'error';
  code: string;
  path: JsonPointer;
  message: string;
}
export type AuthoringDependencyContributionKey = string;
export type AuthoringDependencyDerivationKey = string;
export type AuthoringDependencyDerivationDependency =
  | { kind: 'source-asset'; assetId: string }
  | { kind: 'project-field'; path: JsonPointer }
  | { kind: 'localization-lookup'; key: string }
  | {
      kind: 'property-resolution';
      ownerCollection: AuthoringCollectionKey;
      ownerId: string;
      propertyId: string;
    };
export interface AuthoringDependencyGraphContribution {
  key: AuthoringDependencyContributionKey;
  ownerPath: JsonPointer;
  nodes: readonly AuthoringDependencyNode[];
  edges: readonly AuthoringDependencyEdge[];
  diagnostics: readonly AuthoringDependencyGraphDiagnostic[];
  derivationDependencies: readonly AuthoringDependencyDerivationDependency[];
  literalOccurrences: readonly AuthoringLiteralOccurrence[];
}
export interface AuthoringDependencyGraphContributionSet {
  byKey: ReadonlyMap<AuthoringDependencyContributionKey, AuthoringDependencyGraphContribution>;
  contributionKeysByDerivationKey: ReadonlyMap<
    AuthoringDependencyDerivationKey,
    readonly AuthoringDependencyContributionKey[]
  >;
  contributionKeysByDecodedLiteral: ReadonlyMap<
    string,
    readonly AuthoringDependencyContributionKey[]
  >;
}
export interface AuthoringDependencyGraph {
  nodesByKey: ReadonlyMap<string, AuthoringDependencyNode>;
  edgesById: ReadonlyMap<string, AuthoringDependencyEdge>;
  outgoingEdgeIdsByNodeKey: ReadonlyMap<string, readonly string[]>;
  incomingEdgeIdsByNodeKey: ReadonlyMap<string, readonly string[]>;
  sourceNodeKeysByOwnedPath: ReadonlyMap<JsonPointer, readonly string[]>;
  diagnostics: readonly AuthoringDependencyGraphDiagnostic[];
}
export interface AuthoringDependencyGraphSnapshot {
  projectInstanceId: string;
  projectRevision: number;
  graphRevision: number;
  graph: AuthoringDependencyGraph;
}
export type AuthoringFieldGraphValueClassifierId = string;
export type AuthoringFieldGraphEffect =
  | { kind: 'none' }
  | { kind: 'owner-contribution' }
  | { kind: 'source-analysis' }
  | { kind: 'symbol-definition' }
  | { kind: 'structural' }
  | { kind: 'value-dependent'; classify: AuthoringFieldGraphValueClassifierId };
export interface AuthoringGraphInputClassification {
  path: JsonPointer;
  effect: AuthoringFieldGraphEffect;
  ownerPath?: JsonPointer;
}
export interface ProjectMutationChangeSet {
  projectInstanceId: string;
  projectRevision: number;
  kind:
    | 'load'
    | 'command'
    | 'transaction-step'
    | 'transaction-cancel'
    | 'persistence-rollback'
    | 'undo'
    | 'redo'
    | 'replace';
  affectedPaths: readonly JsonPointer[];
}
export interface ProjectMutationPublication<TProject> {
  previousProject: TProject | null;
  project: TProject;
  changeSet: ProjectMutationChangeSet;
}
export type AuthoringDependencyGraphMutationImpact =
  | { kind: 'graph-stable' }
  | {
      kind: 'incremental';
      contributionKeys: readonly string[];
      sourceAnalysisOwnerKeys: readonly string[];
      symbolProjectionOwnerKeys: readonly string[];
    }
  | { kind: 'full-rebuild'; reason: 'load' | 'replace' | 'root-change' | 'classifier-fallback' };
