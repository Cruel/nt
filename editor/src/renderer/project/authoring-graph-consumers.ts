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
import {
  nativeGraphCommandPreflight,
  nativeGraphUsages,
} from '../../main/services/native-semantic-graph-queries';
import type { NativeRendererGraphSnapshot } from './native-authoring-graph-projection';

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
  if (key.kind === 'trait-definition') return `Trait · ${key.id}`;
  if (key.kind === 'localization-message') return `${key.locale} · ${key.messageId}`;
  return key.path;
}

function occurrenceLocation(edge: AuthoringDependencyEdge) {
  const evidence = edge.evidence?.find(
    (item) => item.kind === 'lua-occurrence' || item.kind === 'source-occurrence',
  );
  if (!evidence) return undefined;
  if (evidence.kind === 'source-occurrence') {
    if (
      evidence.line === undefined ||
      evidence.column === undefined ||
      evidence.endLine === undefined ||
      evidence.endColumn === undefined
    )
      return undefined;
    return {
      line: evidence.line,
      column: evidence.column,
      endLine: evidence.endLine,
      endColumn: evidence.endColumn,
    };
  }
  const occurrence = evidence.occurrence;
  return {
    line: occurrence.line,
    column: occurrence.column,
    endLine: occurrence.line,
    endColumn: occurrence.column + occurrence.rawLiteral.length,
  };
}

function occurrenceEvidence(edge: AuthoringDependencyEdge) {
  return edge.evidence?.find(
    (item) => item.kind === 'lua-occurrence' || item.kind === 'source-occurrence',
  );
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
        sourcePath:
          occurrence?.kind === 'lua-occurrence'
            ? occurrence.occurrence.sourceUrl
            : occurrence?.kind === 'source-occurrence'
              ? occurrence.sourceUrl
              : edge.sourcePath,
        ...(occurrence?.kind === 'lua-occurrence'
          ? { sourceUrl: occurrence.occurrence.sourceUrl }
          : occurrence?.kind === 'source-occurrence'
            ? { sourceUrl: occurrence.sourceUrl }
            : {}),
        ...(occurrence ? { sourceReferenceClassification: occurrence.classification } : {}),
        ...(sourceLocation ? { sourceLocation } : {}),
        ...(edge.role === 'lua-possible-reference'
          ? {
              ambiguousGroup: `${
                occurrence?.kind === 'lua-occurrence'
                  ? occurrence.occurrence.sourceUrl
                  : occurrence?.kind === 'source-occurrence'
                    ? occurrence.sourceUrl
                    : edge.sourcePath
              }:${edge.targetPath}`,
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
  return buildReferenceIndexFromGraph(project, snapshot.graph, 'nativeGraph' in snapshot);
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
  if ('nativeGraph' in input.snapshot) {
    const native = (input.snapshot as NativeRendererGraphSnapshot).nativeGraph;
    let nativeDecision: ReturnType<typeof nativeGraphCommandPreflight>;
    try {
      nativeDecision = nativeGraphCommandPreflight({
        graph: native,
        projectSessionId: native.projectSessionId,
        workingRevision: native.workingRevision,
        workerGeneration: native.generation,
        target: 'collection' in input.target ? targetKey(input.target) : input.target,
        operation: input.operation,
        forceDelete: input.force,
        confirmManualRename: input.confirmRenameWithoutLuaRewrite,
      });
    } catch {
      return {
        kind: 'blocked',
        reason: 'Native Project graph evidence is incomplete or stale.',
        usages: [],
      };
    }
    const usages = semanticUsagesForTarget(input.snapshot, input.target);
    const target = 'collection' in input.target ? targetKey(input.target) : input.target;
    const nativeUsages = nativeGraphUsages(native, target);
    if (nativeDecision.kind === 'blocked')
      return { kind: 'blocked', reason: nativeDecision.reason, usages };
    if (
      input.operation === 'rename' &&
      !input.confirmRenameWithoutLuaRewrite &&
      nativeUsages.recognized.length > 0
    )
      return {
        kind: 'blocked',
        reason: 'Confirm rename without automatic physical source rewriting before continuing.',
        usages,
      };
    // The native graph is an evidence reader, not a physical text writer.
    // Even exact native source ranges cannot authorize JSON patch rewrites.
    const displayUsages = usages.map((usage) =>
      usage.sourceReferenceClassification === 'exact-rewriteable'
        ? {
            ...usage,
            sourceReferenceClassification: 'exact-manual' as const,
          }
        : usage,
    );
    return {
      kind: 'ready',
      usages: displayUsages,
      warnings: displayUsages.filter((usage) => usage.role === 'lua-possible-reference'),
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
      reason: 'Confirm rename without rewriting exact source references before continuing.',
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
