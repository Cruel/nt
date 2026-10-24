import type { NativeSemanticGraph } from './native-authoring-worker-contract';

type NodeKey = NativeSemanticGraph['nodes'][number]['key'];
type Edge = NativeSemanticGraph['edges'][number];
type Occurrence = NativeSemanticGraph['occurrences'][number];

function sameKey(left: NodeKey, right: NodeKey): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'record':
      return (
        right.kind === 'record' && left.collection === right.collection && left.id === right.id
      );
    case 'nested':
      return (
        right.kind === 'nested' &&
        left.ownerCollection === right.ownerCollection &&
        left.ownerId === right.ownerId &&
        left.family === right.family &&
        left.id === right.id
      );
    case 'trait-definition':
      return right.kind === 'trait-definition' && left.id === right.id;
    case 'project-field':
      return right.kind === 'project-field' && left.path === right.path;
    case 'localization-message':
      return (
        right.kind === 'localization-message' &&
        left.locale === right.locale &&
        left.messageId === right.messageId
      );
  }
}

/**
 * Read-only projections of C++-derived edges. No TS validation, lexical
 * classification, reference inference or fallback Project reconstruction.
 */
export function nativeGraphUsages(
  graph: NativeSemanticGraph,
  target: NodeKey,
): {
  confirmed: readonly Edge[];
  possible: readonly Occurrence[];
  recognized: readonly Occurrence[];
} {
  return {
    confirmed: graph.edges.filter((edge) => sameKey(edge.target, target)),
    possible: graph.occurrences.filter(
      (occurrence) =>
        occurrence.classification === 'possible-lexical' && sameKey(occurrence.target, target),
    ),
    recognized: graph.occurrences.filter(
      (occurrence) =>
        occurrence.classification !== 'possible-lexical' && sameKey(occurrence.target, target),
    ),
  };
}

export function nativeGraphUsageCounts(
  graph: NativeSemanticGraph,
  target: NodeKey,
): {
  confirmed: number;
  possible: number;
  recognized: number;
} {
  const usages = nativeGraphUsages(graph, target);
  return {
    confirmed: usages.confirmed.length,
    possible: usages.possible.length,
    recognized: usages.recognized.length,
  };
}

export function requireNativeGraphPreflight(
  graph: NativeSemanticGraph,
  projectSessionId: string,
  workingRevision: number,
  workerGeneration: number,
): NativeSemanticGraph {
  if (
    graph.projectSessionId !== projectSessionId ||
    graph.workingRevision !== workingRevision ||
    graph.generation !== workerGeneration ||
    !graph.complete ||
    graph.incompleteOwners.length !== 0 ||
    !graph.sourceRevisions['project.yaml']
  )
    throw new Error(
      'Native Project graph is stale or incomplete; refresh before changing references.',
    );
  return graph;
}

export type NativeGraphCommandPreflight =
  | {
      kind: 'ready';
      confirmed: readonly Edge[];
      rewriteable: readonly Occurrence[];
      warnings: readonly Occurrence[];
    }
  | {
      kind: 'blocked';
      reason: string;
      confirmed: readonly Edge[];
      manual: readonly Occurrence[];
      warnings: readonly Occurrence[];
    };

export function nativeGraphCommandPreflight(input: {
  graph: NativeSemanticGraph;
  projectSessionId: string;
  workingRevision: number;
  workerGeneration: number;
  target: NodeKey;
  operation: 'rename' | 'delete' | 'repair';
  forceDelete?: boolean;
  confirmManualRename?: boolean;
}): NativeGraphCommandPreflight {
  const graph = requireNativeGraphPreflight(
    input.graph,
    input.projectSessionId,
    input.workingRevision,
    input.workerGeneration,
  );
  const usages = nativeGraphUsages(graph, input.target);
  const manual = usages.recognized.filter((item) => item.classification === 'exact-manual');
  const rewriteable = usages.recognized.filter(
    (item) => item.classification === 'exact-rewriteable' && item.rewriteRange !== undefined,
  );
  if (
    input.operation === 'delete' &&
    !input.forceDelete &&
    (usages.confirmed.length > 0 || usages.recognized.length > 0)
  )
    return {
      kind: 'blocked',
      reason: 'Deletion has confirmed native dependencies; explicit force is required.',
      confirmed: usages.confirmed,
      manual,
      warnings: usages.possible,
    };
  if (
    input.operation !== 'delete' &&
    usages.confirmed.some((edge) => edge.repair.kind === 'blocked')
  )
    return {
      kind: 'blocked',
      reason: 'A confirmed structural dependency has no proven native automatic repair.',
      confirmed: usages.confirmed,
      manual,
      warnings: usages.possible,
    };
  if (input.operation !== 'delete' && manual.length > 0 && !input.confirmManualRename)
    return {
      kind: 'blocked',
      reason: 'Exact source references require author review before a rename or repair.',
      confirmed: usages.confirmed,
      manual,
      warnings: usages.possible,
    };
  return {
    kind: 'ready',
    confirmed: usages.confirmed,
    rewriteable,
    warnings: usages.possible,
  };
}

export type NativeGraphReferenceSearchHit =
  | { kind: 'node'; key: NodeKey; ownerPath: string; label: string }
  | { kind: 'source'; occurrence: Occurrence };

/**
 * Reference evidence usable by Project Search and Find Usages. General
 * free-text search requires a separate native text-index query; never infer
 * matches by rebuilding the full authoring Project in JS.
 */
export function nativeGraphReferenceSearch(
  graph: NativeSemanticGraph,
  query: string,
): readonly NativeGraphReferenceSearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);
  return [
    ...graph.nodes
      .filter((node) => matches(node.label) || matches(node.owningPath))
      .map((node) => ({
        kind: 'node' as const,
        key: node.key,
        ownerPath: node.owningPath,
        label: node.label,
      })),
    ...graph.occurrences
      .filter((occurrence) => matches(occurrence.value) || matches(occurrence.sourceUrl))
      .map((occurrence) => ({ kind: 'source' as const, occurrence })),
  ];
}

function overlaps(changed: string, watched: string): boolean {
  return (
    changed === watched || changed.startsWith(`${watched}/`) || watched.startsWith(`${changed}/`)
  );
}

export function nativeGraphImpactedOwnerPaths(
  graph: NativeSemanticGraph,
  changedPaths: readonly string[],
  facet: 'preview-visual' | 'preview-ui' | 'resource',
): readonly string[] {
  // Targets and native-declared impact paths drive this projection. Do not
  // promote all record fields to preview dependencies.
  const impacted = new Set<string>();
  const frontier = [...changedPaths];
  // Native keyText is emitted by the C++ JSON serializer. Comparing its
  // spelling to JS JSON.stringify(object) is not stable across field order.
  const byKey = new Map(graph.nodes.map((node) => [JSON.stringify(node.key), node.owningPath]));
  while (frontier.length) {
    const current = frontier.shift()!;
    for (const edge of graph.edges) {
      if (
        !edge.facets.includes(facet) ||
        !edge.targetImpactPaths.some((watched) => overlaps(current, watched))
      )
        continue;
      const owner = byKey.get(JSON.stringify(edge.source));
      if (owner && !impacted.has(owner)) {
        impacted.add(owner);
        frontier.push(owner);
      }
    }
  }
  return [...impacted].sort();
}
