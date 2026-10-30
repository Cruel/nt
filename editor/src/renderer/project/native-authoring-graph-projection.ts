import type { NativeSemanticGraph } from '../../main/services/native-authoring-worker-contract';
import type {
  AuthoringDependencyEdge,
  AuthoringDependencyGraph,
  AuthoringDependencyGraphSnapshot,
  AuthoringDependencyNode,
  AuthoringDependencyNodeKey,
  AuthoringDependencyRole,
  DependencyImpactFacet,
} from '../../shared/authoring-dependency-contracts';
import { AUTHORING_DEPENDENCY_ROLES } from '../../shared/authoring-dependency-contracts';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import { serializeAuthoringDependencyNodeKey } from '../../shared/authoring-graph-queries';

export type NativeRendererGraphSnapshot = AuthoringDependencyGraphSnapshot & {
  readonly nativeGraph: NativeSemanticGraph;
};

const roles = new Set<string>(AUTHORING_DEPENDENCY_ROLES);
const facets = new Set<string>([
  'reference-integrity',
  'tooling-reference',
  'preview-visual',
  'preview-ui',
  'resource',
  'validation',
  'runtime-only',
]);

class ImmutableGraphMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: Map<K, V>;
  constructor(values: Iterable<readonly [K, V]>) {
    this.#entries = new Map(values);
    Object.freeze(this);
  }
  get size() {
    return this.#entries.size;
  }
  get(key: K) {
    return this.#entries.get(key);
  }
  has(key: K) {
    return this.#entries.has(key);
  }
  entries() {
    return this.#entries.entries();
  }
  keys() {
    return this.#entries.keys();
  }
  values() {
    return this.#entries.values();
  }
  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
    for (const [key, value] of this.#entries) callback.call(thisArg, value, key, this);
  }
  [Symbol.iterator]() {
    return this.#entries[Symbol.iterator]();
  }
  get [Symbol.toStringTag]() {
    return 'ImmutableGraphMap';
  }
}

function key(input: NativeSemanticGraph['nodes'][number]['key']): AuthoringDependencyNodeKey {
  if (input.kind === 'record')
    return { ...input, collection: input.collection as AuthoringCollectionKey };
  if (input.kind === 'nested')
    return {
      ...input,
      ownerCollection: input.ownerCollection as AuthoringCollectionKey,
      family: input.family as Extract<AuthoringDependencyNodeKey, { kind: 'nested' }>['family'],
    };
  return input;
}

function insert(
  edges: Map<string, AuthoringDependencyEdge>,
  incoming: Map<string, string[]>,
  outgoing: Map<string, string[]>,
  edge: AuthoringDependencyEdge,
) {
  edges.set(edge.id, edge);
  const source = serializeAuthoringDependencyNodeKey(edge.source);
  const target = serializeAuthoringDependencyNodeKey(edge.target);
  outgoing.set(source, [...(outgoing.get(source) ?? []), edge.id]);
  incoming.set(target, [...(incoming.get(target) ?? []), edge.id]);
}

/**
 * Index the native DTO for existing renderer presentation interfaces.
 * This is an identity/ordering projection: no project traversal, field
 * classification, reference discovery, or source parsing occurs here.
 */
export function projectNativeGraphForRenderer(
  nativeGraph: NativeSemanticGraph,
  projectInstanceId: string,
  projectRevision: number,
): NativeRendererGraphSnapshot {
  if (
    !nativeGraph.complete ||
    nativeGraph.incompleteOwners.length ||
    !nativeGraph.sourceRevisions['project.yaml']
  )
    throw new Error('Native semantic graph is incomplete; unsafe editor actions are blocked.');

  const nodes = new Map<string, AuthoringDependencyNode>();
  const edges = new Map<string, AuthoringDependencyEdge>();
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const owned = new Map<string, string[]>();
  for (const node of nativeGraph.nodes) {
    const resolved = key(node.key);
    const keyText = serializeAuthoringDependencyNodeKey(resolved);
    nodes.set(keyText, { key: resolved, keyText, owningPath: node.owningPath, label: node.label });
    owned.set(node.owningPath, [...(owned.get(node.owningPath) ?? []), keyText]);
  }
  for (const edge of nativeGraph.edges) {
    if (!roles.has(edge.role) || edge.facets.some((facet) => !facets.has(facet)))
      throw new Error('Native graph contains unsupported edge semantics.');
    // One physical reference can have an aggregate dependency edge as well
    // as one or more occurrence records. Find Usages presents the precise
    // occurrences once; retain the aggregate only in the native DTO for
    // dependency/preview impact calculations.
    if (edge.role === 'source-recognized-reference') continue;
    insert(edges, incoming, outgoing, {
      ...edge,
      source: key(edge.source),
      target: key(edge.target),
      role: edge.role as AuthoringDependencyRole,
      facets: edge.facets as DependencyImpactFacet[],
    });
  }

  // Source occurrences are distinct native evidence, not inferred structural
  // edges. Adapt them only for the existing Find Usages and warning panels.
  for (const [index, occurrence] of nativeGraph.occurrences.entries()) {
    const owner = [...nodes.values()].find((node) => node.owningPath === occurrence.ownerPath);
    if (!owner) continue;
    const role =
      occurrence.classification === 'possible-lexical'
        ? 'lua-possible-reference'
        : 'source-recognized-reference';
    insert(edges, incoming, outgoing, {
      id: `native-source-occurrence:${index}`,
      source: owner.key,
      target: key(occurrence.target),
      sourcePath: occurrence.ownerPath,
      targetPath:
        [...nodes.values()].find(
          (node) => node.keyText === serializeAuthoringDependencyNodeKey(key(occurrence.target)),
        )?.owningPath ?? occurrence.ownerPath,
      role,
      facets: ['tooling-reference'],
      targetImpactPaths: [],
      repair: { kind: 'blocked', reason: 'Source references require author review.' },
      evidence: [
        {
          kind: 'source-occurrence',
          sourceUrl: occurrence.sourceUrl,
          classification: occurrence.classification,
          line: occurrence.line,
          column: occurrence.column,
          endLine: occurrence.line,
          endColumn: occurrence.column + occurrence.value.length,
          ...(occurrence.rewriteRange ? { rewriteRange: occurrence.rewriteRange } : {}),
        },
      ],
    });
  }
  const freezeIndices = (map: Map<string, string[]>) =>
    new ImmutableGraphMap(
      [...map].map(([key, values]) => [key, Object.freeze([...values])] as const),
    );
  const graph: AuthoringDependencyGraph = Object.freeze({
    nodesByKey: new ImmutableGraphMap(nodes),
    edgesById: new ImmutableGraphMap(edges),
    incomingEdgeIdsByNodeKey: freezeIndices(incoming),
    outgoingEdgeIdsByNodeKey: freezeIndices(outgoing),
    sourceNodeKeysByOwnedPath: freezeIndices(owned),
    diagnostics: Object.freeze([...nativeGraph.diagnostics]),
  });
  return Object.freeze({
    projectInstanceId,
    projectRevision,
    graphRevision: nativeGraph.generation,
    graph,
    nativeGraph,
  });
}
