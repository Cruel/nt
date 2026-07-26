import { buildAuthoringStructuralDependencyGraph } from '../authoring-dependency-graph';
import type {
  AuthoringDependencyEdge,
  AuthoringDependencyGraph,
} from '../authoring-dependency-contracts';
import { authoringCollectionKeys, type AuthoringCollectionKey } from './authoring-collections';
import type { AuthoringProject, ReferenceTarget } from './authoring-project';

export type ReferenceUsageKind =
  | 'extends'
  | 'entrypoint'
  | 'explicit-ref'
  | 'flow-target'
  | 'variable-ref';

export interface ReferenceUsage {
  sourceCollection: AuthoringCollectionKey | 'project';
  sourceId: string;
  path: string;
  target: ReferenceTarget;
  kind: ReferenceUsageKind;
}

export interface ReferenceIndex {
  usages: ReferenceUsage[];
  byTarget: Map<string, ReferenceUsage[]>;
}

function compatibilityKind(edge: AuthoringDependencyEdge): ReferenceUsageKind | null {
  if (edge.role === 'extends') return 'extends';
  if (edge.role === 'entrypoint') return 'entrypoint';
  if (edge.role === 'flow-target') return 'flow-target';
  if (edge.role === 'variable-ref') return 'variable-ref';
  return edge.sourcePath.endsWith('/$ref') ? 'explicit-ref' : null;
}

function projectCompatibilityUsage(edge: AuthoringDependencyEdge): ReferenceUsage | null {
  if (!edge.facets.includes('reference-integrity') || edge.target.kind !== 'record') return null;
  const kind = compatibilityKind(edge);
  if (!kind) return null;

  if (edge.source.kind === 'record') {
    return {
      sourceCollection: edge.source.collection,
      sourceId: edge.source.id,
      path: edge.sourcePath,
      target: { collection: edge.target.collection, id: edge.target.id },
      kind,
    };
  }
  if (edge.source.kind === 'project-field') {
    return {
      sourceCollection: 'project',
      sourceId: edge.source.path === '/entrypoint' ? 'project' : 'settings',
      path: edge.sourcePath,
      target: { collection: edge.target.collection, id: edge.target.id },
      kind,
    };
  }
  return null;
}

function compareJsonPointerOrder(left: string, right: string): number {
  const leftSegments = left.split('/').slice(1);
  const rightSegments = right.split('/').slice(1);
  const count = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < count; index += 1) {
    const leftSegment = leftSegments[index]!;
    const rightSegment = rightSegments[index]!;
    const leftNumber = /^\d+$/.test(leftSegment) ? Number(leftSegment) : null;
    const rightNumber = /^\d+$/.test(rightSegment) ? Number(rightSegment) : null;
    const difference =
      leftNumber !== null && rightNumber !== null
        ? leftNumber - rightNumber
        : leftSegment.localeCompare(rightSegment);
    if (difference !== 0) return difference;
  }
  return leftSegments.length - rightSegments.length;
}

function legacyUsageOrder(project: AuthoringProject, usages: ReferenceUsage[]): ReferenceUsage[] {
  const collectionOrder = new Map(
    authoringCollectionKeys.map((collection, index) => [collection, index]),
  );
  const recordOrder = new Map<string, number>();
  for (const collection of authoringCollectionKeys) {
    Object.keys(project[collection]).forEach((id, index) =>
      recordOrder.set(`${collection}:${id}`, index),
    );
  }
  return usages.sort((left, right) => {
    const leftProjectRank =
      left.kind === 'entrypoint' ? 0 : left.sourceCollection === 'project' ? 1 : 2;
    const rightProjectRank =
      right.kind === 'entrypoint' ? 0 : right.sourceCollection === 'project' ? 1 : 2;
    if (leftProjectRank !== rightProjectRank) return leftProjectRank - rightProjectRank;
    if (left.sourceCollection !== 'project' && right.sourceCollection !== 'project') {
      const collectionDifference =
        collectionOrder.get(left.sourceCollection)! - collectionOrder.get(right.sourceCollection)!;
      if (collectionDifference !== 0) return collectionDifference;
      const recordDifference =
        recordOrder.get(`${left.sourceCollection}:${left.sourceId}`)! -
        recordOrder.get(`${right.sourceCollection}:${right.sourceId}`)!;
      if (recordDifference !== 0) return recordDifference;
      if (left.kind === 'extends' && right.kind !== 'extends') return -1;
      if (right.kind === 'extends' && left.kind !== 'extends') return 1;
    }
    return compareJsonPointerOrder(left.path, right.path);
  });
}

export function referenceTargetKey(target: ReferenceTarget): string {
  return `${target.collection}:${target.id}`;
}

export function buildReferenceIndexFromGraph(
  project: AuthoringProject,
  graph: AuthoringDependencyGraph,
): ReferenceIndex {
  const usages = legacyUsageOrder(
    project,
    [...graph.edgesById.values()]
      .map(projectCompatibilityUsage)
      .filter((usage): usage is ReferenceUsage => usage !== null),
  );
  const byTarget = new Map<string, ReferenceUsage[]>();
  for (const usage of usages) {
    const key = referenceTargetKey(usage.target);
    const group = byTarget.get(key) ?? [];
    group.push(usage);
    byTarget.set(key, group);
  }
  return { usages, byTarget };
}

export function buildReferenceIndex(project: AuthoringProject): ReferenceIndex {
  return buildReferenceIndexFromGraph(project, buildAuthoringStructuralDependencyGraph(project));
}

export function findUsages(index: ReferenceIndex, target: ReferenceTarget): ReferenceUsage[] {
  return index.byTarget.get(referenceTargetKey(target)) ?? [];
}
