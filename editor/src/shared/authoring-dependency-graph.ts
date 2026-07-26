import type {
  AuthoringDependencyDerivationDependency,
  AuthoringDependencyEdge,
  AuthoringDependencyGraph,
  AuthoringDependencyGraphContribution,
  AuthoringDependencyGraphContributionSet,
  AuthoringDependencyGraphDiagnostic,
  AuthoringDependencyNode,
  AuthoringDependencyNodeKey,
  AuthoringDependencyRole,
  DependencyImpactFacet,
} from './authoring-dependency-contracts';
import {
  buildJsonPointer,
  escapeJsonPointerSegment,
  jsonPointerSegmentsOverlap,
  type JsonPointer,
} from './json-pointer';
import {
  authoringCollectionKeys,
  type AuthoringCollectionKey,
} from './project-schema/authoring-collections';
import type {
  AuthoringProject,
  AuthoringRecordBase,
  ReferenceTarget,
} from './project-schema/authoring-project';
import { isVariableRef } from './project-schema/authoring-variables';

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: K): V | undefined {
    return this.#values.get(key);
  }

  has(key: K): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#values.entries();
  }

  keys(): MapIterator<K> {
    return this.#values.keys();
  }

  values(): MapIterator<V> {
    return this.#values.values();
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#values[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return 'ImmutableMap';
  }
}

function immutableMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new ImmutableMap(entries);
}

function sortedUnique(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function stableRecord(value: Readonly<Record<string, string>> | undefined): string {
  if (!value) return '';
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function freezeNode(node: AuthoringDependencyNode): AuthoringDependencyNode {
  return Object.freeze({ ...node, key: Object.freeze({ ...node.key }) });
}

function freezeDiagnostic(
  diagnostic: AuthoringDependencyGraphDiagnostic,
): AuthoringDependencyGraphDiagnostic {
  return Object.freeze({ ...diagnostic });
}

function freezeEdge(edge: AuthoringDependencyEdge): AuthoringDependencyEdge {
  return Object.freeze({
    ...edge,
    source: Object.freeze({ ...edge.source }),
    target: Object.freeze({ ...edge.target }),
    facets: sortedUnique(edge.facets) as readonly DependencyImpactFacet[],
    targetImpactPaths: sortedUnique(edge.targetImpactPaths),
    repair: Object.freeze({ ...edge.repair }),
    evidence: edge.evidence ? Object.freeze([...edge.evidence]) : undefined,
    detail: edge.detail ? Object.freeze({ ...edge.detail }) : undefined,
  });
}

export function serializeAuthoringDependencyNodeKey(key: AuthoringDependencyNodeKey): string {
  switch (key.kind) {
    case 'record':
      return JSON.stringify(['record', key.collection, key.id]);
    case 'nested':
      return JSON.stringify(['nested', key.ownerCollection, key.ownerId, key.family, key.id]);
    case 'property-definition':
      return JSON.stringify(['property-definition', key.id]);
    case 'localization-key':
      return JSON.stringify(['localization-key', key.locale, key.key]);
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
  family: 'room-placement' | 'room-exit',
  id: string,
): AuthoringDependencyNodeKey {
  return Object.freeze({ kind: 'nested', ownerCollection, ownerId, family, id });
}

export function propertyDefinitionNodeKey(id: string): AuthoringDependencyNodeKey {
  return Object.freeze({ kind: 'property-definition', id });
}

export function localizationKeyNodeKey(locale: string, key: string): AuthoringDependencyNodeKey {
  return Object.freeze({ kind: 'localization-key', locale, key });
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

export function propertyDefinitionContributionKey(id: string): string {
  return `property-definition:${JSON.stringify(id)}`;
}

export function localizationContributionKey(locale: string, key: string): string {
  return `localization-key:${JSON.stringify([locale, key])}`;
}

export function serializeAuthoringDependencyDerivationDependency(
  dependency: AuthoringDependencyDerivationDependency,
): string {
  switch (dependency.kind) {
    case 'source-asset':
      return JSON.stringify(['source-asset', dependency.assetId]);
    case 'project-field':
      return JSON.stringify(['project-field', dependency.path]);
    case 'localization-lookup':
      return JSON.stringify(['localization-lookup', dependency.key]);
    case 'property-resolution':
      return JSON.stringify([
        'property-resolution',
        dependency.ownerCollection,
        dependency.ownerId,
        dependency.propertyId,
      ]);
  }
}

export function createAuthoringDependencyEdgeId(
  edge: Pick<AuthoringDependencyEdge, 'source' | 'target' | 'sourcePath' | 'targetPath'>,
): string {
  return JSON.stringify([
    serializeAuthoringDependencyNodeKey(edge.source),
    edge.sourcePath,
    serializeAuthoringDependencyNodeKey(edge.target),
    edge.targetPath,
  ]);
}

function roleSpecificity(role: AuthoringDependencyRole): number {
  if (role === 'explicit-ref') return 0;
  if (role === 'variable-ref' || role === 'flow-target') return 1;
  return 2;
}

function mergeEdges(
  current: AuthoringDependencyEdge,
  candidate: AuthoringDependencyEdge,
): AuthoringDependencyEdge {
  const sameEndpoints =
    serializeAuthoringDependencyNodeKey(current.source) ===
      serializeAuthoringDependencyNodeKey(candidate.source) &&
    serializeAuthoringDependencyNodeKey(current.target) ===
      serializeAuthoringDependencyNodeKey(candidate.target) &&
    current.sourcePath === candidate.sourcePath &&
    current.targetPath === candidate.targetPath;
  if (!sameEndpoints) throw new Error(`Conflicting graph edge identity: ${current.id}`);

  const preferred =
    roleSpecificity(candidate.role) > roleSpecificity(current.role) ? candidate : current;
  const other = preferred === current ? candidate : current;
  if (
    stableRecord(preferred.detail) !== stableRecord(other.detail) &&
    preferred.detail !== undefined &&
    other.detail !== undefined
  ) {
    throw new Error(`Conflicting graph edge metadata: ${current.id}`);
  }
  if (JSON.stringify(preferred.repair) !== JSON.stringify(other.repair)) {
    throw new Error(`Conflicting graph edge repair policy: ${current.id}`);
  }

  return freezeEdge({
    ...preferred,
    facets: sortedUnique([
      ...current.facets,
      ...candidate.facets,
    ]) as readonly DependencyImpactFacet[],
    targetImpactPaths: sortedUnique([...current.targetImpactPaths, ...candidate.targetImpactPaths]),
    evidence:
      current.evidence || candidate.evidence
        ? Object.freeze([...(current.evidence ?? []), ...(candidate.evidence ?? [])])
        : undefined,
    detail: preferred.detail ?? other.detail,
  });
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

function missingTargetDiagnostic(
  edge: AuthoringDependencyEdge,
): AuthoringDependencyGraphDiagnostic {
  return freezeDiagnostic({
    severity: edge.facets.includes('reference-integrity') ? 'error' : 'warning',
    code: 'authoring_dependency.missing_target',
    path: edge.sourcePath,
    message: `Dependency target ${serializeAuthoringDependencyNodeKey(edge.target)} does not exist.`,
  });
}

export function createAuthoringDependencyGraphContributionSet(
  contributions: Iterable<AuthoringDependencyGraphContribution>,
): AuthoringDependencyGraphContributionSet {
  const sorted = [...contributions].sort((left, right) => left.key.localeCompare(right.key));
  const byKey = new Map<string, AuthoringDependencyGraphContribution>();
  const byDerivationKey = new Map<string, string[]>();
  const byDecodedLiteral = new Map<string, string[]>();

  for (const contribution of sorted) {
    if (byKey.has(contribution.key)) {
      throw new Error(`Duplicate graph contribution key: ${contribution.key}`);
    }
    const frozen = Object.freeze({
      ...contribution,
      nodes: Object.freeze(contribution.nodes.map(freezeNode)),
      edges: Object.freeze(contribution.edges.map(freezeEdge)),
      diagnostics: Object.freeze(contribution.diagnostics.map(freezeDiagnostic)),
      derivationDependencies: Object.freeze(
        contribution.derivationDependencies.map((dependency) => Object.freeze({ ...dependency })),
      ),
      literalOccurrences: Object.freeze([...contribution.literalOccurrences]),
    });
    byKey.set(contribution.key, frozen);

    for (const dependency of frozen.derivationDependencies) {
      const key = serializeAuthoringDependencyDerivationDependency(dependency);
      const owners = byDerivationKey.get(key) ?? [];
      owners.push(frozen.key);
      byDerivationKey.set(key, owners);
    }
    for (const occurrence of frozen.literalOccurrences) {
      const owners = byDecodedLiteral.get(occurrence.decodedValue) ?? [];
      owners.push(frozen.key);
      byDecodedLiteral.set(occurrence.decodedValue, owners);
    }
  }

  return Object.freeze({
    byKey: immutableMap(byKey),
    contributionKeysByDerivationKey: immutableMap(
      [...byDerivationKey]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, owners]) => [key, sortedUnique(owners)]),
    ),
    contributionKeysByDecodedLiteral: immutableMap(
      [...byDecodedLiteral]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, owners]) => [key, sortedUnique(owners)]),
    ),
  });
}

export function assembleAuthoringDependencyGraph(
  contributions:
    | AuthoringDependencyGraphContributionSet
    | Iterable<AuthoringDependencyGraphContribution>,
): AuthoringDependencyGraph {
  const contributionSet =
    Symbol.iterator in Object(contributions)
      ? createAuthoringDependencyGraphContributionSet(
          contributions as Iterable<AuthoringDependencyGraphContribution>,
        )
      : (contributions as AuthoringDependencyGraphContributionSet);
  const nodes = new Map<string, AuthoringDependencyNode>();
  const edges = new Map<string, AuthoringDependencyEdge>();
  const diagnostics: AuthoringDependencyGraphDiagnostic[] = [];

  for (const contribution of contributionSet.byKey.values()) {
    for (const node of contribution.nodes) {
      const keyText = serializeAuthoringDependencyNodeKey(node.key);
      if (node.keyText !== keyText) {
        throw new Error(`Non-canonical graph node keyText: ${node.keyText}`);
      }
      const current = nodes.get(keyText);
      if (current && JSON.stringify(current) !== JSON.stringify(node)) {
        throw new Error(`Conflicting graph node ownership or metadata: ${keyText}`);
      }
      nodes.set(keyText, freezeNode(node));
    }
    for (const edge of contribution.edges) {
      const canonicalId = createAuthoringDependencyEdgeId(edge);
      if (edge.id !== canonicalId) throw new Error(`Non-canonical graph edge id: ${edge.id}`);
      const current = edges.get(edge.id);
      edges.set(edge.id, current ? mergeEdges(current, edge) : freezeEdge(edge));
    }
    diagnostics.push(...contribution.diagnostics.map(freezeDiagnostic));
  }

  const sortedNodes = [...nodes].sort(([left], [right]) => left.localeCompare(right));
  const sortedEdges = [...edges.values()].sort(compareEdges);
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const ownedPaths = new Map<JsonPointer, string[]>();

  for (const [key, node] of sortedNodes) {
    const owners = ownedPaths.get(node.owningPath) ?? [];
    owners.push(key);
    ownedPaths.set(node.owningPath, owners);
  }
  for (const edge of sortedEdges) {
    const sourceKey = serializeAuthoringDependencyNodeKey(edge.source);
    const targetKey = serializeAuthoringDependencyNodeKey(edge.target);
    const outgoingIds = outgoing.get(sourceKey) ?? [];
    outgoingIds.push(edge.id);
    outgoing.set(sourceKey, outgoingIds);
    const incomingIds = incoming.get(targetKey) ?? [];
    incomingIds.push(edge.id);
    incoming.set(targetKey, incomingIds);
    if (!nodes.has(targetKey)) diagnostics.push(missingTargetDiagnostic(edge));
  }

  diagnostics.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message),
  );

  return Object.freeze({
    nodesByKey: immutableMap(sortedNodes),
    edgesById: immutableMap(sortedEdges.map((edge) => [edge.id, edge])),
    outgoingEdgeIdsByNodeKey: immutableMap(
      [...outgoing]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, ids]) => [key, Object.freeze(ids)]),
    ),
    incomingEdgeIdsByNodeKey: immutableMap(
      [...incoming]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, ids]) => [key, Object.freeze(ids)]),
    ),
    sourceNodeKeysByOwnedPath: immutableMap(
      [...ownedPaths]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, keys]) => [path, sortedUnique(keys)]),
    ),
    diagnostics: Object.freeze(diagnostics),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReferenceTarget(value: unknown): value is ReferenceTarget {
  return (
    isRecord(value) &&
    typeof value.collection === 'string' &&
    authoringCollectionKeys.includes(value.collection as AuthoringCollectionKey) &&
    typeof value.id === 'string'
  );
}

function flowReferenceTarget(value: unknown): ReferenceTarget | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  if (value.kind === 'scene') return { collection: 'scenes', id: value.id };
  if (value.kind === 'dialogue') return { collection: 'dialogues', id: value.id };
  if (value.kind === 'room') return { collection: 'rooms', id: value.id };
  return null;
}

function structuralEdge(
  source: AuthoringDependencyNodeKey,
  target: AuthoringDependencyNodeKey,
  sourcePath: JsonPointer,
  targetPath: JsonPointer,
  role: AuthoringDependencyRole,
): AuthoringDependencyEdge {
  const edge = {
    id: '',
    source,
    target,
    sourcePath,
    targetPath,
    role,
    facets: ['reference-integrity', 'tooling-reference'] as const,
    targetImpactPaths: Object.freeze([targetPath]),
    repair: Object.freeze({
      kind: 'replacement-required',
      path: sourcePath,
      collection: target.kind === 'record' ? target.collection : 'assets',
    }) as AuthoringDependencyEdge['repair'],
  };
  return freezeEdge({ ...edge, id: createAuthoringDependencyEdgeId(edge) });
}

function scanStructuralReferences(
  value: unknown,
  path: JsonPointer,
  source: AuthoringDependencyNodeKey,
  edges: AuthoringDependencyEdge[],
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      scanStructuralReferences(child, `${path}/${index}`, source, edges),
    );
    return;
  }
  if (!isRecord(value)) return;

  if (isReferenceTarget(value.$ref)) {
    const target = recordNodeKey(value.$ref.collection, value.$ref.id);
    edges.push(
      structuralEdge(
        source,
        target,
        `${path}/$ref`,
        `/${value.$ref.collection}/${escapeJsonPointerSegment(value.$ref.id)}`,
        'explicit-ref',
      ),
    );
  }
  if (isVariableRef(value)) {
    edges.push(
      structuralEdge(
        source,
        recordNodeKey('variables', value.$var),
        `${path}/$var`,
        `/variables/${escapeJsonPointerSegment(value.$var)}`,
        'variable-ref',
      ),
    );
  }
  if (path.endsWith('/continuation') || path.endsWith('/completion')) {
    const flowTarget = flowReferenceTarget(value);
    if (flowTarget) {
      edges.push(
        structuralEdge(
          source,
          recordNodeKey(flowTarget.collection, flowTarget.id),
          path,
          `/${flowTarget.collection}/${escapeJsonPointerSegment(flowTarget.id)}`,
          'flow-target',
        ),
      );
    }
  }
  for (const [key, child] of Object.entries(value)) {
    scanStructuralReferences(child, `${path}/${escapeJsonPointerSegment(key)}`, source, edges);
  }
}

function recordContribution(
  collection: AuthoringCollectionKey,
  id: string,
  record: AuthoringRecordBase,
): AuthoringDependencyGraphContribution {
  const owningPath = `/${collection}/${escapeJsonPointerSegment(id)}`;
  const source = recordNodeKey(collection, id);
  const edges: AuthoringDependencyEdge[] = [];
  if (record.extends) {
    edges.push(
      structuralEdge(
        source,
        recordNodeKey(collection, record.extends),
        `${owningPath}/extends`,
        `/${collection}/${escapeJsonPointerSegment(record.extends)}`,
        'extends',
      ),
    );
  }
  scanStructuralReferences(record.data, `${owningPath}/data`, source, edges);
  return {
    key: recordContributionKey(collection, id),
    ownerPath: owningPath,
    nodes: [
      {
        key: source,
        keyText: serializeAuthoringDependencyNodeKey(source),
        owningPath,
        label: record.label,
      },
    ],
    edges,
    diagnostics: [],
    derivationDependencies: [],
    literalOccurrences: [],
  };
}

export function buildAuthoringStructuralDependencyGraph(
  project: AuthoringProject,
): AuthoringDependencyGraph {
  const contributions: AuthoringDependencyGraphContribution[] = [];

  for (const [id, definition] of Object.entries(project.properties).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const key = propertyDefinitionNodeKey(id);
    const path = `/properties/${escapeJsonPointerSegment(id)}`;
    contributions.push({
      key: propertyDefinitionContributionKey(id),
      ownerPath: path,
      nodes: [
        {
          key,
          keyText: serializeAuthoringDependencyNodeKey(key),
          owningPath: path,
          label: definition.label,
        },
      ],
      edges: [],
      diagnostics: [],
      derivationDependencies: [],
      literalOccurrences: [],
    });
  }
  for (const [locale, catalog] of Object.entries(project.localization.catalogs).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    for (const [keyName] of Object.entries(catalog).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const key = localizationKeyNodeKey(locale, keyName);
      const path = buildJsonPointer(['localization', 'catalogs', locale, keyName]);
      contributions.push({
        key: localizationContributionKey(locale, keyName),
        ownerPath: path,
        nodes: [
          {
            key,
            keyText: serializeAuthoringDependencyNodeKey(key),
            owningPath: path,
            label: keyName,
          },
        ],
        edges: [],
        diagnostics: [],
        derivationDependencies: [],
        literalOccurrences: [],
      });
    }
  }

  if (project.entrypoint) {
    const source = projectFieldNodeKey('/entrypoint');
    const targetCollection = `${project.entrypoint.kind}s` as 'rooms' | 'scenes' | 'dialogues';
    contributions.push({
      key: projectFieldContributionKey('/entrypoint'),
      ownerPath: '/entrypoint',
      nodes: [
        {
          key: source,
          keyText: serializeAuthoringDependencyNodeKey(source),
          owningPath: '/entrypoint',
          label: 'Entrypoint',
        },
      ],
      edges: [
        structuralEdge(
          source,
          recordNodeKey(targetCollection, project.entrypoint.id),
          '/entrypoint',
          `/${targetCollection}/${escapeJsonPointerSegment(project.entrypoint.id)}`,
          'entrypoint',
        ),
      ],
      diagnostics: [],
      derivationDependencies: [],
      literalOccurrences: [],
    });
  }

  const settingsSource = projectFieldNodeKey('/settings');
  const settingsEdges: AuthoringDependencyEdge[] = [];
  scanStructuralReferences(project.settings, '/settings', settingsSource, settingsEdges);
  contributions.push({
    key: projectFieldContributionKey('/settings'),
    ownerPath: '/settings',
    nodes: [
      {
        key: settingsSource,
        keyText: serializeAuthoringDependencyNodeKey(settingsSource),
        owningPath: '/settings',
        label: 'Project settings',
      },
    ],
    edges: settingsEdges,
    diagnostics: [],
    derivationDependencies: [],
    literalOccurrences: [],
  });

  for (const collection of authoringCollectionKeys) {
    for (const [id, record] of Object.entries(project[collection]).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      contributions.push(recordContribution(collection, id, record));
    }
  }
  return assembleAuthoringDependencyGraph(contributions);
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
  family: 'room-placement' | 'room-exit',
  id: string,
): AuthoringDependencyNode | undefined {
  return graph.nodesByKey.get(
    serializeAuthoringDependencyNodeKey(nestedNodeKey(ownerCollection, ownerId, family, id)),
  );
}

export function findPreviewRootsImpactedByPaths(
  graph: AuthoringDependencyGraph,
  previewRoots: readonly (AuthoringDependencyNodeKey | string)[],
  changedPaths: readonly JsonPointer[],
  filter: AuthoringDependencyTraversalFilter = {
    facets: ['preview-visual', 'preview-ui', 'resource'],
  },
): readonly AuthoringDependencyNode[] {
  const changedKeys = new Set(
    changedPaths.flatMap((path) =>
      findAuthoringDependencyOwnersByPath(graph, path).map((node) => node.keyText),
    ),
  );
  return Object.freeze(
    previewRoots
      .map(resolveNodeKeyText)
      .sort()
      .filter((root) =>
        authoringDependencyForwardClosure(graph, [root], filter).some((node) =>
          changedKeys.has(node.keyText),
        ),
      )
      .map((key) => graph.nodesByKey.get(key))
      .filter((node): node is AuthoringDependencyNode => node !== undefined),
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
