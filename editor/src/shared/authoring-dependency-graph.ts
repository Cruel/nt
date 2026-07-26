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
  AuthoringGraphInputClassification,
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
import { parseRoomData } from './project-schema/authoring-rooms';
import { isVariableRef } from './project-schema/authoring-variables';

export interface AuthoringStructuralAdapterDeclaration {
  collection: AuthoringCollectionKey;
  consumedPathPatterns: readonly string[];
  derivationDependencyKinds: readonly AuthoringDependencyDerivationDependency['kind'][];
}

export const AUTHORING_STRUCTURAL_ADAPTER_DECLARATIONS: readonly AuthoringStructuralAdapterDeclaration[] =
  Object.freeze(
    authoringCollectionKeys.map((collection) => ({
      collection,
      consumedPathPatterns: Object.freeze([
        `/${collection}/*/extends`,
        `/${collection}/*/properties/*`,
        `/${collection}/*/data/**/$ref`,
        `/${collection}/*/data/**/$var`,
        `/${collection}/*/data/**/continuation`,
        `/${collection}/*/data/**/completion`,
      ]),
      derivationDependencyKinds: Object.freeze([
        'source-asset',
        'project-field',
        'localization-lookup',
        'property-resolution',
      ] as const),
    })),
  );

export const AUTHORING_INTRINSIC_GRAPH_INPUTS: readonly AuthoringGraphInputClassification[] =
  Object.freeze([
    { path: '/startupHook', effect: { kind: 'source-analysis' } },
    { path: '/entrypoint', effect: { kind: 'owner-contribution' } },
    { path: '/settings/display', effect: { kind: 'owner-contribution' } },
    { path: '/settings/accessibility', effect: { kind: 'owner-contribution' } },
    { path: '/settings/text/defaultFont', effect: { kind: 'owner-contribution' } },
    { path: '/settings/ui/systemLayouts', effect: { kind: 'structural' } },
    { path: '/localization/defaultLocale', effect: { kind: 'symbol-definition' } },
    { path: '/localization/fallbackLocale', effect: { kind: 'symbol-definition' } },
    { path: '/localization/catalogs', effect: { kind: 'structural' } },
    { path: '/properties', effect: { kind: 'structural' } },
    ...authoringCollectionKeys.map((collection) => ({
      path: `/${collection}`,
      effect: { kind: 'structural' as const },
    })),
  ]);

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

interface StructuralEdgeOptions {
  role?: AuthoringDependencyRole;
  facets?: readonly DependencyImpactFacet[];
  targetImpactPaths?: readonly JsonPointer[];
  repair?: AuthoringDependencyEdge['repair'];
  detail?: Readonly<Record<string, string>>;
}

function defaultRepairPolicy(
  sourcePath: JsonPointer,
  target: AuthoringDependencyNodeKey,
): AuthoringDependencyEdge['repair'] {
  const arrayItemMatch = sourcePath.match(/^(.*\/\d+)(?:\/.*)?$/);
  if (arrayItemMatch)
    return { kind: 'remove-array-item', itemPath: arrayItemMatch[1] as JsonPointer };
  return {
    kind: 'replacement-required',
    path: sourcePath,
    collection: target.kind === 'record' ? target.collection : 'rooms',
  };
}

function structuralEdge(
  source: AuthoringDependencyNodeKey,
  target: AuthoringDependencyNodeKey,
  sourcePath: JsonPointer,
  targetPath: JsonPointer,
  roleOrOptions: AuthoringDependencyRole | StructuralEdgeOptions,
): AuthoringDependencyEdge {
  const options: StructuralEdgeOptions =
    typeof roleOrOptions === 'string' ? { role: roleOrOptions } : roleOrOptions;
  const edge = {
    id: '',
    source,
    target,
    sourcePath,
    targetPath,
    role: options.role ?? 'explicit-ref',
    facets: options.facets ?? (['reference-integrity', 'tooling-reference'] as const),
    targetImpactPaths: Object.freeze(options.targetImpactPaths ?? [targetPath]),
    repair: Object.freeze(options.repair ?? defaultRepairPolicy(sourcePath, target)),
    detail: options.detail,
  };
  return freezeEdge({ ...edge, id: createAuthoringDependencyEdgeId(edge) });
}

function semanticEdgeOptions(path: JsonPointer): StructuralEdgeOptions {
  const rules: readonly [RegExp, AuthoringDependencyRole, readonly DependencyImpactFacet[]][] = [
    [
      /\/data\/background\/asset\/\$ref$/,
      'room-background',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/background\/material\/\$ref$/,
      'room-background-material',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/cast\/\d+\/character\/\$ref$/,
      'room-cast-character',
      ['reference-integrity', 'tooling-reference', 'preview-visual'],
    ],
    [
      /\/data\/overlays\/\d+\/layout\/\$ref$/,
      'room-overlay-layout',
      ['reference-integrity', 'tooling-reference', 'preview-ui'],
    ],
    [
      /\/data\/placements\/\d+\/presentation\/layout\/\$ref$/,
      'room-placement-layout',
      ['reference-integrity', 'tooling-reference', 'preview-ui'],
    ],
    [
      /\/data\/props\/\d+\/asset\/\$ref$/,
      'room-prop-asset',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/props\/\d+\/material\/\$ref$/,
      'room-prop-material',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/environments\/\d+\/asset\/\$ref$/,
      'room-environment-asset',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/environments\/\d+\/material\/\$ref$/,
      'room-environment-material',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/compose\/script\/\$ref$/,
      'room-compose-script',
      ['reference-integrity', 'tooling-reference', 'runtime-only'],
    ],
    [
      /\/data\/exits\/\d+\/target\/\$ref$/,
      'room-exit-target',
      ['reference-integrity', 'tooling-reference', 'runtime-only'],
    ],
    [
      /\/data\/poses\/[^/]+\/sprite\/\$ref$/,
      'character-pose-sprite',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/poses\/[^/]+\/material\/\$ref$/,
      'character-pose-material',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/expressions\/[^/]+\/sprite\/\$ref$/,
      'character-expression-sprite',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/expressions\/[^/]+\/material\/\$ref$/,
      'character-expression-material',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/sprite\/\$ref$/,
      'interactable-sprite',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/material\/\$ref$/,
      'interactable-material',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/shader\/\$ref$/,
      'material-shader',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/textures\/[^/]+\/source\/\$ref$/,
      'material-texture',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/stages\/[^/]+\/source\/\$ref$/,
      'shader-source',
      ['reference-integrity', 'tooling-reference', 'resource'],
    ],
    [
      /\/scripts\/[^/]+\/data\/source\/asset\/\$ref$/,
      'script-source',
      ['reference-integrity', 'tooling-reference', 'resource', 'runtime-only'],
    ],
    [
      /\/layouts\/[^/]+\/data\/rml\/sourceAsset\/\$ref$/,
      'layout-rml-source',
      ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
    ],
    [
      /\/layouts\/[^/]+\/data\/rcss\/sourceAsset\/\$ref$/,
      'layout-rcss-source',
      ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
    ],
    [
      /\/layouts\/[^/]+\/data\/lua\/sourceAsset\/\$ref$/,
      'layout-lua-source',
      ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
    ],
    [
      /\/layouts\/[^/]+\/data\/dependencies\/images\/\d+\/\$ref$/,
      'layout-image',
      ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
    ],
    [
      /\/layouts\/[^/]+\/data\/dependencies\/fonts\/\d+\/\$ref$/,
      'layout-font',
      ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
    ],
    [
      /\/layouts\/[^/]+\/data\/dependencies\/stylesheets\/\d+\/\$ref$/,
      'layout-stylesheet',
      ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
    ],
    [
      /\/layouts\/[^/]+\/data\/dependencies\/scripts\/\d+\/\$ref$/,
      'layout-script',
      ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
    ],
    [
      /\/layouts\/[^/]+\/data\/dependencies\/templates\/\d+\/\$ref$/,
      'layout-template',
      ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
    ],
    [
      /\/layouts\/[^/]+\/data\/dependencies\/materials\/\d+\/\$ref$/,
      'layout-material',
      ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
    ],
    [
      /^\/settings\/ui\/systemLayouts\//,
      'system-layout',
      ['reference-integrity', 'tooling-reference', 'preview-ui'],
    ],
    [
      /^\/settings\/text\/defaultFont\/\$ref$/,
      'default-font',
      ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
    ],
  ];
  const match = rules.find(([pattern]) => pattern.test(path));
  return match ? { role: match[1], facets: match[2] } : {};
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

  if (typeof value.room === 'string' && typeof value.placement === 'string') {
    const role: AuthoringDependencyRole = path.includes('/characters/')
      ? 'character-room-placement'
      : path.includes('/interactables/')
        ? 'interactable-room-placement'
        : 'explicit-ref';
    edges.push(
      structuralEdge(
        source,
        nestedNodeKey('rooms', value.room, 'room-placement', value.placement),
        path,
        `/rooms/${escapeJsonPointerSegment(value.room)}/data/placements`,
        {
          role,
          facets: ['reference-integrity', 'tooling-reference', 'preview-visual'],
          repair: { kind: 'replacement-required', path, collection: 'rooms' },
          detail: { roomId: value.room, placementId: value.placement },
        },
      ),
    );
  }
  if (typeof value.room === 'string' && typeof value.exit === 'string') {
    edges.push(
      structuralEdge(
        source,
        nestedNodeKey('rooms', value.room, 'room-exit', value.exit),
        path,
        `/rooms/${escapeJsonPointerSegment(value.room)}/data/exits`,
        {
          role: 'explicit-ref',
          facets: ['reference-integrity', 'tooling-reference', 'runtime-only'],
          repair: { kind: 'replacement-required', path, collection: 'rooms' },
          detail: { roomId: value.room, exitId: value.exit },
        },
      ),
    );
  }

  if (isReferenceTarget(value.$ref)) {
    const target = recordNodeKey(value.$ref.collection, value.$ref.id);
    edges.push(
      structuralEdge(
        source,
        target,
        `${path}/$ref`,
        `/${value.$ref.collection}/${escapeJsonPointerSegment(value.$ref.id)}`,
        semanticEdgeOptions(`${path}/$ref`),
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

function collectDerivationDependencies(
  value: unknown,
  ownerCollection: AuthoringCollectionKey,
  ownerId: string,
  dependencies: AuthoringDependencyDerivationDependency[],
): void {
  if (Array.isArray(value)) {
    value.forEach((child) =>
      collectDerivationDependencies(child, ownerCollection, ownerId, dependencies),
    );
    return;
  }
  if (!isRecord(value)) return;
  if (isReferenceTarget(value.$ref) && value.$ref.collection === 'assets')
    dependencies.push({ kind: 'source-asset', assetId: value.$ref.id });
  if (value.kind === 'localized' && typeof value.key === 'string') {
    dependencies.push({ kind: 'localization-lookup', key: value.key });
    dependencies.push({ kind: 'project-field', path: '/localization/defaultLocale' });
  }
  for (const propertyId of Object.keys(value.properties ?? {}))
    dependencies.push({ kind: 'property-resolution', ownerCollection, ownerId, propertyId });
  Object.values(value).forEach((child) =>
    collectDerivationDependencies(child, ownerCollection, ownerId, dependencies),
  );
}

function nestedRoomNodesAndEdges(
  id: string,
  record: AuthoringRecordBase,
  source: AuthoringDependencyNodeKey,
  owningPath: JsonPointer,
): { nodes: AuthoringDependencyNode[]; edges: AuthoringDependencyEdge[] } {
  const room = parseRoomData(record.data);
  if (!room) return { nodes: [], edges: [] };
  const nodes: AuthoringDependencyNode[] = [];
  const edges: AuthoringDependencyEdge[] = [];
  room.placements.forEach((placement, index) => {
    const key = nestedNodeKey('rooms', id, 'room-placement', placement.id);
    const path = `${owningPath}/data/placements/${index}` as JsonPointer;
    nodes.push({
      key,
      keyText: serializeAuthoringDependencyNodeKey(key),
      owningPath: path,
      label: placement.id,
    });
    edges.push(
      structuralEdge(source, key, path, path, {
        role: 'explicit-ref',
        facets: ['preview-visual', 'tooling-reference'],
        repair: { kind: 'blocked', reason: 'Room placement is owned by its Room.' },
      }),
    );
  });
  room.exits.forEach((exit, index) => {
    const key = nestedNodeKey('rooms', id, 'room-exit', exit.id);
    const path = `${owningPath}/data/exits/${index}` as JsonPointer;
    nodes.push({
      key,
      keyText: serializeAuthoringDependencyNodeKey(key),
      owningPath: path,
      label: exit.label,
    });
    edges.push(
      structuralEdge(source, key, path, path, {
        role: 'explicit-ref',
        facets: ['runtime-only', 'tooling-reference'],
        repair: { kind: 'blocked', reason: 'Room exit is owned by its Room.' },
      }),
    );
  });
  return { nodes, edges };
}

function recordContribution(
  collection: AuthoringCollectionKey,
  id: string,
  record: AuthoringRecordBase,
): AuthoringDependencyGraphContribution {
  const owningPath = `/${collection}/${escapeJsonPointerSegment(id)}`;
  const source = recordNodeKey(collection, id);
  const edges: AuthoringDependencyEdge[] = [];
  const nested =
    collection === 'rooms'
      ? nestedRoomNodesAndEdges(id, record, source, owningPath)
      : { nodes: [], edges: [] };
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
  if (
    collection === 'materials' &&
    isRecord(record.data) &&
    typeof record.data.baseMaterialId === 'string'
  ) {
    edges.push(
      structuralEdge(
        source,
        recordNodeKey('materials', record.data.baseMaterialId),
        `${owningPath}/data/baseMaterialId`,
        `/materials/${escapeJsonPointerSegment(record.data.baseMaterialId)}`,
        {
          role: 'material-base',
          facets: ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
          repair: { kind: 'set-null', path: `${owningPath}/data/baseMaterialId` },
        },
      ),
    );
  }
  for (const propertyId of Object.keys(record.properties ?? {}).sort()) {
    edges.push(
      structuralEdge(
        source,
        propertyDefinitionNodeKey(propertyId),
        `${owningPath}/properties/${escapeJsonPointerSegment(propertyId)}`,
        `/properties/${escapeJsonPointerSegment(propertyId)}`,
        {
          role: 'property-assignment',
          facets: ['reference-integrity', 'tooling-reference', 'validation'],
          repair: {
            kind: 'remove-map-entry',
            entryPath: `${owningPath}/properties/${escapeJsonPointerSegment(propertyId)}`,
          },
        },
      ),
    );
  }
  scanStructuralReferences(record.data, `${owningPath}/data`, source, edges);
  edges.push(...nested.edges);
  const derivationDependencies: AuthoringDependencyDerivationDependency[] = [];
  collectDerivationDependencies(record.data, collection, id, derivationDependencies);
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
      ...nested.nodes,
    ],
    edges,
    diagnostics: [],
    derivationDependencies: Object.freeze([
      ...new Map(
        derivationDependencies.map((item) => [
          serializeAuthoringDependencyDerivationDependency(item),
          item,
        ]),
      ).values(),
    ]),
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

  for (const path of ['/localization/defaultLocale', '/localization/fallbackLocale'] as const) {
    const key = projectFieldNodeKey(path);
    contributions.push({
      key: projectFieldContributionKey(path),
      ownerPath: path,
      nodes: [
        {
          key,
          keyText: serializeAuthoringDependencyNodeKey(key),
          owningPath: path,
          label: path.endsWith('defaultLocale') ? 'Default locale' : 'Fallback locale',
        },
      ],
      edges: [],
      diagnostics: [],
      derivationDependencies: [],
      literalOccurrences: [],
    });
  }

  const startupSource = projectFieldNodeKey('/startupHook');
  contributions.push({
    key: projectFieldContributionKey('/startupHook'),
    ownerPath: '/startupHook',
    nodes: [
      {
        key: startupSource,
        keyText: serializeAuthoringDependencyNodeKey(startupSource),
        owningPath: '/startupHook',
        label: 'Startup hook',
      },
    ],
    edges: [],
    diagnostics: [],
    derivationDependencies: [],
    literalOccurrences: [],
  });

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

  const settingsFields: readonly { path: JsonPointer; value: unknown; label: string }[] = [
    { path: '/settings/display', value: project.settings.display, label: 'Display settings' },
    {
      path: '/settings/accessibility',
      value: project.settings.accessibility,
      label: 'Accessibility settings',
    },
    {
      path: '/settings/text/defaultFont',
      value: project.settings.text.defaultFont,
      label: 'Default font',
    },
    ...Object.entries(project.settings.ui.systemLayouts).map(([role, value]) => ({
      path: `/settings/ui/systemLayouts/${escapeJsonPointerSegment(role)}` as JsonPointer,
      value,
      label: `System layout: ${role}`,
    })),
  ];
  for (const field of settingsFields) {
    const key = projectFieldNodeKey(field.path);
    const edges: AuthoringDependencyEdge[] = [];
    scanStructuralReferences(field.value, field.path, key, edges);
    contributions.push({
      key: projectFieldContributionKey(field.path),
      ownerPath: field.path,
      nodes: [
        {
          key,
          keyText: serializeAuthoringDependencyNodeKey(key),
          owningPath: field.path,
          label: field.label,
        },
      ],
      edges,
      diagnostics: [],
      derivationDependencies: [],
      literalOccurrences: [],
    });
  }

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
