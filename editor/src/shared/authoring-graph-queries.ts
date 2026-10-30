/** Queries over native-admitted graph projections; no Project analysis or source discovery. */
import type {
  AuthoringDependencyEdge,
  AuthoringDependencyGraph,
  AuthoringDependencyGraphDiagnostic,
  AuthoringDependencyNode,
  AuthoringDependencyNodeKey,
  AuthoringDependencyRole,
  DependencyImpactFacet,
} from './authoring-dependency-contracts';
import type { AuthoringCollectionKey } from './project-schema/authoring-collections';
import {
  isJsonPointerAncestor,
  jsonPointerSegmentsOverlap,
  type JsonPointer,
} from './json-pointer';
export function serializeAuthoringDependencyNodeKey(key: AuthoringDependencyNodeKey): string {
  switch (key.kind) {
    case 'record':
      return JSON.stringify(['record', key.collection, key.id]);
    case 'nested':
      return JSON.stringify(['nested', key.ownerCollection, key.ownerId, key.family, key.id]);
    case 'trait-definition':
      return JSON.stringify(['trait-definition', key.id]);
    case 'localization-message':
      return JSON.stringify(['localization-message', key.locale, key.messageId]);
    case 'project-field':
      return JSON.stringify(['project-field', key.path]);
  }
}

export function recordNodeKey(
  collection: AuthoringCollectionKey,
  id: string,
): AuthoringDependencyNodeKey {
  return Object.freeze({ kind: 'record', collection, id });
}

export function nestedNodeKey(
  ownerCollection: AuthoringCollectionKey,
  ownerId: string,
  family:
    | 'room-placement'
    | 'room-exit'
    | 'room-feature'
    | 'room-hotspot'
    | 'interactable-feature'
    | 'interactable-hotspot',
  id: string,
): AuthoringDependencyNodeKey {
  return Object.freeze({ kind: 'nested', ownerCollection, ownerId, family, id });
}

export function traitDefinitionNodeKey(id: string): AuthoringDependencyNodeKey {
  return Object.freeze({ kind: 'trait-definition', id });
}

export function localizationMessageNodeKey(
  locale: string,
  messageId: string,
): AuthoringDependencyNodeKey {
  return Object.freeze({ kind: 'localization-message', locale, messageId });
}

export function projectFieldNodeKey(path: JsonPointer): AuthoringDependencyNodeKey {
  return Object.freeze({ kind: 'project-field', path });
}

export function recordContributionKey(collection: AuthoringCollectionKey, id: string): string {
  return `record:${serializeAuthoringDependencyNodeKey(recordNodeKey(collection, id))}`;
}

export function projectFieldContributionKey(path: JsonPointer): string {
  return `project-field:${JSON.stringify(path)}`;
}

export function traitDefinitionContributionKey(id: string): string {
  return `trait-definition:${JSON.stringify(id)}`;
}

export function localizationMessageContributionKey(locale: string, messageId: string): string {
  return `localization-message:${JSON.stringify([locale, messageId])}`;
}

function compareEdges(left: AuthoringDependencyEdge, right: AuthoringDependencyEdge): number {
  return (
    serializeAuthoringDependencyNodeKey(left.source).localeCompare(
      serializeAuthoringDependencyNodeKey(right.source),
    ) ||
    left.sourcePath.localeCompare(right.sourcePath) ||
    left.role.localeCompare(right.role) ||
    serializeAuthoringDependencyNodeKey(left.target).localeCompare(
      serializeAuthoringDependencyNodeKey(right.target),
    ) ||
    left.id.localeCompare(right.id)
  );
}

export interface AuthoringDependencyTraversalFilter {
  facets?: readonly DependencyImpactFacet[];
  roles?: readonly AuthoringDependencyRole[];
  includeEdge?: (edge: AuthoringDependencyEdge) => boolean;
}

function matchesFilter(
  edge: AuthoringDependencyEdge,
  filter?: AuthoringDependencyTraversalFilter,
): boolean {
  if (!filter) return true;
  if (filter.facets && !filter.facets.some((facet) => edge.facets.includes(facet))) return false;
  if (filter.roles && !filter.roles.includes(edge.role)) return false;
  return filter.includeEdge?.(edge) ?? true;
}

function resolveNodeKeyText(key: AuthoringDependencyNodeKey | string): string {
  return typeof key === 'string' ? key : serializeAuthoringDependencyNodeKey(key);
}

function edgeList(
  graph: AuthoringDependencyGraph,
  ids: readonly string[] | undefined,
  filter?: AuthoringDependencyTraversalFilter,
): readonly AuthoringDependencyEdge[] {
  return Object.freeze(
    (ids ?? [])
      .map((id) => graph.edgesById.get(id))
      .filter(
        (edge): edge is AuthoringDependencyEdge =>
          edge !== undefined && matchesFilter(edge, filter),
      )
      .sort(compareEdges),
  );
}

export function outgoingAuthoringDependencies(
  graph: AuthoringDependencyGraph,
  node: AuthoringDependencyNodeKey | string,
  filter?: AuthoringDependencyTraversalFilter,
): readonly AuthoringDependencyEdge[] {
  return edgeList(graph, graph.outgoingEdgeIdsByNodeKey.get(resolveNodeKeyText(node)), filter);
}

export function incomingAuthoringDependencies(
  graph: AuthoringDependencyGraph,
  node: AuthoringDependencyNodeKey | string,
  filter?: AuthoringDependencyTraversalFilter,
): readonly AuthoringDependencyEdge[] {
  return edgeList(graph, graph.incomingEdgeIdsByNodeKey.get(resolveNodeKeyText(node)), filter);
}

export function findAuthoringDependencyUsages(
  graph: AuthoringDependencyGraph,
  target: AuthoringDependencyNodeKey | string,
  filter?: AuthoringDependencyTraversalFilter,
): readonly AuthoringDependencyEdge[] {
  return incomingAuthoringDependencies(graph, target, filter);
}

function closure(
  graph: AuthoringDependencyGraph,
  roots: readonly (AuthoringDependencyNodeKey | string)[],
  direction: 'forward' | 'reverse',
  filter?: AuthoringDependencyTraversalFilter,
): readonly AuthoringDependencyNode[] {
  const pending = roots.map(resolveNodeKeyText).sort();
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const edges =
      direction === 'forward'
        ? outgoingAuthoringDependencies(graph, current, filter)
        : incomingAuthoringDependencies(graph, current, filter);
    const next = edges.map((edge) =>
      resolveNodeKeyText(direction === 'forward' ? edge.target : edge.source),
    );
    pending.push(...next.filter((key) => !visited.has(key)).sort());
  }
  return Object.freeze(
    [...visited]
      .sort()
      .map((key) => graph.nodesByKey.get(key))
      .filter((node): node is AuthoringDependencyNode => node !== undefined),
  );
}

export function authoringDependencyForwardClosure(
  graph: AuthoringDependencyGraph,
  roots: readonly (AuthoringDependencyNodeKey | string)[],
  filter?: AuthoringDependencyTraversalFilter,
): readonly AuthoringDependencyNode[] {
  return closure(graph, roots, 'forward', filter);
}

export function authoringDependencyReverseImpactClosure(
  graph: AuthoringDependencyGraph,
  roots: readonly (AuthoringDependencyNodeKey | string)[],
  filter?: AuthoringDependencyTraversalFilter,
): readonly AuthoringDependencyNode[] {
  return closure(graph, roots, 'reverse', filter);
}

export function findAuthoringDependencyOwnersByPath(
  graph: AuthoringDependencyGraph,
  path: JsonPointer,
): readonly AuthoringDependencyNode[] {
  const keys = new Set<string>();
  for (const [ownedPath, nodeKeys] of graph.sourceNodeKeysByOwnedPath) {
    if (jsonPointerSegmentsOverlap(ownedPath, path)) nodeKeys.forEach((key) => keys.add(key));
  }
  return Object.freeze(
    [...keys]
      .sort()
      .map((key) => graph.nodesByKey.get(key)!)
      .filter(Boolean),
  );
}

export function findNestedAuthoringDependencyTarget(
  graph: AuthoringDependencyGraph,
  ownerCollection: AuthoringCollectionKey,
  ownerId: string,
  family:
    | 'room-placement'
    | 'room-exit'
    | 'room-feature'
    | 'room-hotspot'
    | 'interactable-feature'
    | 'interactable-hotspot',
  id: string,
): AuthoringDependencyNode | undefined {
  return graph.nodesByKey.get(
    serializeAuthoringDependencyNodeKey(nestedNodeKey(ownerCollection, ownerId, family, id)),
  );
}

function changedPathOverlapsAny(
  changedPaths: readonly JsonPointer[],
  consumedPaths: readonly JsonPointer[],
): boolean {
  return changedPaths.some((changedPath) =>
    consumedPaths.some((consumedPath) => jsonPointerSegmentsOverlap(changedPath, consumedPath)),
  );
}

function edgeTargetIsImpacted(
  edge: AuthoringDependencyEdge,
  changedPaths: readonly JsonPointer[],
): boolean {
  if (changedPathOverlapsAny(changedPaths, edge.targetImpactPaths)) return true;
  return (
    edge.facets.includes('reference-integrity') &&
    changedPaths.some((changedPath) => isJsonPointerAncestor(changedPath, edge.targetPath))
  );
}

function previewRootIsImpacted(
  graph: AuthoringDependencyGraph,
  rootKeyText: string,
  changedPaths: readonly JsonPointer[],
  filter: AuthoringDependencyTraversalFilter,
): boolean {
  const root = graph.nodesByKey.get(rootKeyText);
  if (!root) return false;
  if (changedPaths.some((path) => jsonPointerSegmentsOverlap(root.owningPath, path))) return true;

  const pending = [rootKeyText];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const currentKey = pending.shift()!;
    if (visited.has(currentKey)) continue;
    visited.add(currentKey);
    const current = graph.nodesByKey.get(currentKey);
    if (!current) continue;

    for (const edge of outgoingAuthoringDependencies(graph, currentKey, filter)) {
      if (edgeTargetIsImpacted(edge, changedPaths)) return true;
      const targetKey = serializeAuthoringDependencyNodeKey(edge.target);
      if (!visited.has(targetKey)) pending.push(targetKey);
    }
  }
  return false;
}

export function findPreviewRootsImpactedByPaths(
  graph: AuthoringDependencyGraph,
  previewRoots: readonly (AuthoringDependencyNodeKey | string)[],
  changedPaths: readonly JsonPointer[],
  filter: AuthoringDependencyTraversalFilter = {
    facets: ['preview-visual', 'preview-ui', 'resource'],
  },
): readonly AuthoringDependencyNode[] {
  return Object.freeze(
    previewRoots
      .map(resolveNodeKeyText)
      .sort()
      .filter((root) => previewRootIsImpacted(graph, root, changedPaths, filter))
      .map((key) => graph.nodesByKey.get(key))
      .filter((node): node is AuthoringDependencyNode => node !== undefined),
  );
}

export function findPreviewRootsImpactedByPathUnion(
  previousGraph: AuthoringDependencyGraph,
  currentGraph: AuthoringDependencyGraph,
  previewRoots: readonly (AuthoringDependencyNodeKey | string)[],
  changedPaths: readonly JsonPointer[],
  filter: AuthoringDependencyTraversalFilter = {
    facets: ['preview-visual', 'preview-ui', 'resource'],
  },
): readonly AuthoringDependencyNode[] {
  const nodesByKey = new Map<string, AuthoringDependencyNode>();
  for (const node of findPreviewRootsImpactedByPaths(
    previousGraph,
    previewRoots,
    changedPaths,
    filter,
  )) {
    nodesByKey.set(node.keyText, node);
  }
  for (const node of findPreviewRootsImpactedByPaths(
    currentGraph,
    previewRoots,
    changedPaths,
    filter,
  )) {
    nodesByKey.set(node.keyText, node);
  }
  return Object.freeze(
    [...nodesByKey.values()].sort((left, right) => left.keyText.localeCompare(right.keyText)),
  );
}

export function findMissingAuthoringDependencyTargets(
  graph: AuthoringDependencyGraph,
): readonly AuthoringDependencyGraphDiagnostic[] {
  return Object.freeze(
    graph.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'authoring_dependency.missing_target',
    ),
  );
}
