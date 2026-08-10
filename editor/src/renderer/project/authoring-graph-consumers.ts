import type {
  AuthoringDependencyEdge,
  AuthoringDependencyGraphSnapshot,
  AuthoringDependencyNodeKey,
} from '../../shared/authoring-dependency-contracts';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import type { ReferenceTarget } from '../../shared/project-schema/authoring-project';
import {
  buildReferenceIndexFromGraph,
  findUsages,
} from '../../shared/project-schema/authoring-references';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';

export interface SemanticGraphUsage {
  edgeId: string;
  role: AuthoringDependencyEdge['role'];
  label: string;
  sourceLabel: string;
  targetLabel: string;
  sourcePath: string;
  sourceUrl?: string;
  sourceReferenceClassification?: 'exact-rewriteable' | 'exact-manual' | 'possible-lexical';
  sourceLocation?: { line: number; column: number; endLine: number; endColumn: number };
  ambiguousGroup?: string;
  edge: AuthoringDependencyEdge;
}

export type GraphCommandPreflight =
  | {
      kind: 'ready';
      usages: readonly SemanticGraphUsage[];
      warnings: readonly SemanticGraphUsage[];
    }
  | { kind: 'blocked'; reason: string; usages: readonly SemanticGraphUsage[] };

function keyEquals(left: AuthoringDependencyNodeKey, right: AuthoringDependencyNodeKey): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function targetKey(target: ReferenceTarget): AuthoringDependencyNodeKey {
  return { kind: 'record', collection: target.collection, id: target.id };
}

function roleLabel(role: AuthoringDependencyEdge['role']): string {
  return role
    .split('-')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function readonlyMapValues<K, V>(map: ReadonlyMap<K, V>): V[] {
  const values: V[] = [];
  for (const [, value] of map) values.push(value);
  return values;
}

function nodeLabel(snapshot: AuthoringDependencyGraphSnapshot, key: AuthoringDependencyNodeKey) {
  const node = readonlyMapValues(snapshot.graph.nodesByKey).find((candidate) =>
    keyEquals(candidate.key, key),
  );
  if (node) return node.label;
  if (key.kind === 'nested') return `${key.ownerId} · ${key.family} · ${key.id}`;
  if (key.kind === 'record') return `${key.collection.slice(0, -1)} · ${key.id}`;
  if (key.kind === 'property-definition') return `Property · ${key.id}`;
  if (key.kind === 'localization-key') return `${key.locale} · ${key.key}`;
  return key.path;
}

function occurrenceLocation(edge: AuthoringDependencyEdge) {
  const evidence = edge.evidence?.find((item) => item.kind === 'lua-occurrence');
  if (!evidence || evidence.kind !== 'lua-occurrence') return undefined;
  const occurrence = evidence.occurrence;
  return {
    line: occurrence.line,
    column: occurrence.column,
    endLine: occurrence.line,
    endColumn: occurrence.column + occurrence.rawLiteral.length,
  };
}

function occurrenceEvidence(edge: AuthoringDependencyEdge) {
  const evidence = edge.evidence?.find((item) => item.kind === 'lua-occurrence');
  return evidence?.kind === 'lua-occurrence' ? evidence : undefined;
}

export function semanticUsagesForTarget(
  snapshot: AuthoringDependencyGraphSnapshot,
  target: ReferenceTarget | AuthoringDependencyNodeKey,
): readonly SemanticGraphUsage[] {
  const key = 'collection' in target ? targetKey(target) : target;
  const usages = readonlyMapValues(snapshot.graph.edgesById)
    .filter((edge) => keyEquals(edge.target, key))
    .map((edge) => {
      const sourceLocation = occurrenceLocation(edge);
      const occurrence = occurrenceEvidence(edge);
      return {
        edgeId: edge.id,
        role: edge.role,
        label: roleLabel(edge.role),
        sourceLabel: nodeLabel(snapshot, edge.source),
        targetLabel: nodeLabel(snapshot, edge.target),
        sourcePath: occurrence?.occurrence.sourceUrl ?? edge.sourcePath,
        ...(occurrence ? { sourceUrl: occurrence.occurrence.sourceUrl } : {}),
        ...(occurrence ? { sourceReferenceClassification: occurrence.classification } : {}),
        ...(sourceLocation ? { sourceLocation } : {}),
        ...(edge.role === 'lua-possible-reference'
          ? {
              ambiguousGroup: `${occurrence?.occurrence.sourceUrl ?? edge.sourcePath}:${edge.targetPath}`,
            }
          : {}),
        edge,
      } satisfies SemanticGraphUsage;
    });
  return Object.freeze(
    usages.sort(
      (a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.edgeId.localeCompare(b.edgeId),
    ),
  );
}

export function referenceIndexFromCurrentGraph(
  project: AuthoringProject,
  snapshot: AuthoringDependencyGraphSnapshot,
) {
  return buildReferenceIndexFromGraph(project, snapshot.graph);
}

export function confirmedUsagesFromCurrentGraph(
  project: AuthoringProject,
  snapshot: AuthoringDependencyGraphSnapshot,
  target: ReferenceTarget,
) {
  return findUsages(referenceIndexFromCurrentGraph(project, snapshot), target);
}

export function preflightGraphCommand(input: {
  snapshot: AuthoringDependencyGraphSnapshot | null;
  projectInstanceId: string | null;
  projectRevision: number;
  target: ReferenceTarget | AuthoringDependencyNodeKey;
  operation: 'rename' | 'delete';
  force?: boolean;
  confirmRenameWithoutLuaRewrite?: boolean;
}): GraphCommandPreflight {
  if (
    !input.snapshot ||
    !input.projectInstanceId ||
    input.snapshot.projectInstanceId !== input.projectInstanceId ||
    input.snapshot.projectRevision !== input.projectRevision
  ) {
    return {
      kind: 'blocked',
      reason: 'The dependency graph is not ready for the current project revision.',
      usages: [],
    };
  }
  const usages = semanticUsagesForTarget(input.snapshot, input.target);
  const explicit = usages.filter((usage) => usage.role === 'lua-explicit-reference');
  const exactSource = usages.filter(
    (usage) =>
      usage.sourceReferenceClassification === 'exact-rewriteable' ||
      usage.sourceReferenceClassification === 'exact-manual',
  );
  const exactManual = usages.filter(
    (usage) => usage.sourceReferenceClassification === 'exact-manual',
  );
  const possible = usages.filter((usage) => usage.role === 'lua-possible-reference');
  if (input.operation === 'delete' && !input.force && explicit.length + exactSource.length > 0) {
    return {
      kind: 'blocked',
      reason:
        'Deletion is blocked by exact source references that require manual repair. Use Force Delete to continue.',
      usages,
    };
  }
  if (
    input.operation === 'rename' &&
    explicit.length + exactManual.length > 0 &&
    !input.confirmRenameWithoutLuaRewrite
  ) {
    return {
      kind: 'blocked',
      reason: 'Confirm rename without rewriting Lua before continuing.',
      usages,
    };
  }
  return { kind: 'ready', usages, warnings: possible };
}

export function roomPlacementTarget(
  roomId: string,
  placementId: string,
): AuthoringDependencyNodeKey {
  return {
    kind: 'nested',
    ownerCollection: 'rooms' as AuthoringCollectionKey,
    ownerId: roomId,
    family: 'room-placement',
    id: placementId,
  };
}

export function preflightRoomPlacementDeletion(input: {
  snapshot: AuthoringDependencyGraphSnapshot | null;
  projectInstanceId: string | null;
  projectRevision: number;
  roomId: string;
  placementId: string;
}): GraphCommandPreflight {
  const preflight = preflightGraphCommand({
    snapshot: input.snapshot,
    projectInstanceId: input.projectInstanceId,
    projectRevision: input.projectRevision,
    target: roomPlacementTarget(input.roomId, input.placementId),
    operation: 'delete',
  });
  if (preflight.kind === 'blocked') return preflight;
  if (preflight.usages.length > 0) {
    return {
      kind: 'blocked',
      reason: `Room placement deletion is blocked by ${preflight.usages.length} structural usage${preflight.usages.length === 1 ? '' : 's'}.`,
      usages: preflight.usages,
    };
  }
  return preflight;
}
