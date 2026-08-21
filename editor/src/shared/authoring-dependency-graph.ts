import type {
  AuthoringDependencyDerivationDependency,
  AuthoringDependencyEdge,
  AuthoringDependencyEvidence,
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
  isJsonPointerAncestor,
  jsonPointerSegmentsOverlap,
  parseJsonPointer,
  type JsonPointer,
} from './json-pointer';
import {
  authoringCollectionKeys,
  type AuthoringCollectionKey,
} from './project-schema/authoring-collections';
import {
  AUTHORING_GRAPH_FIELD_METADATA,
  classifyAuthoringGraphInputPath,
} from './project-schema/authoring-graph-field-metadata';
import type {
  AuthoringProject,
  AuthoringRecordBase,
  ReferenceTarget,
} from './project-schema/authoring-project';
import { systemLayoutRoleValues } from './project-schema/authoring-layouts';
import { isVariableRef } from './project-schema/authoring-variables';
import type {
  LuaAnalysisInput,
  LuaExplicitDependencyTarget,
  LuaReferenceOccurrence,
} from './project-schema/authoring-lua-analysis';
import { serializeLuaExplicitDependencyTarget } from './project-schema/authoring-lua-analysis';
import {
  analyzeAuthoringSources,
  collectAuthoringLuaSources,
  type AuthoringLuaSourceDescriptor,
} from './authoring-source-analysis';
import {
  AUTHORING_SOURCE_REFERENCE_RECOGNIZERS,
  classifyRecognizedAuthoringSourceReference,
  type AuthoringSourceReferenceRecognizer,
} from './authoring-source-references';

export interface AuthoringStructuralAdapterDeclaration {
  collection: AuthoringCollectionKey;
  consumedPathPatterns: readonly string[];
  derivationDependencyKinds: readonly AuthoringDependencyDerivationDependency['kind'][];
}

export const AUTHORING_STRUCTURAL_ADAPTER_DECLARATIONS: readonly AuthoringStructuralAdapterDeclaration[] =
  Object.freeze(
    authoringCollectionKeys.map((collection) => ({
      collection,
      consumedPathPatterns: Object.freeze(
        AUTHORING_GRAPH_FIELD_METADATA.filter(
          (field) => field.schemaRoot === collection && field.effect.kind !== 'none',
        ).map((field) => field.path),
      ),
      derivationDependencyKinds: Object.freeze([
        ...(collection === 'layouts' || collection === 'scripts' || collection === 'rooms'
          ? (['source-asset'] as const)
          : []),
        ...((
          [
            'rooms',
            'verbs',
            'interactions',
            'dialogues',
            'scenes',
            'maps',
          ] as readonly AuthoringCollectionKey[]
        ).includes(collection)
          ? (['project-field', 'localization-lookup'] as const)
          : []),
        ...((['rooms', 'layouts'] as readonly AuthoringCollectionKey[]).includes(collection)
          ? (['property-resolution'] as const)
          : []),
      ] satisfies readonly AuthoringDependencyDerivationDependency['kind'][]),
    })),
  );

export const AUTHORING_INTRINSIC_GRAPH_INPUTS: readonly AuthoringGraphInputClassification[] =
  Object.freeze(
    AUTHORING_GRAPH_FIELD_METADATA.map((field) =>
      Object.freeze({ path: field.path, effect: field.effect }),
    ),
  );

export { classifyAuthoringGraphInputPath };

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

function serializeAuthoringDependencyEvidence(evidence: AuthoringDependencyEvidence): string {
  if (evidence.kind === 'explicit-lua-fallback')
    return JSON.stringify(['explicit-lua-fallback', evidence.declarationPath]);
  const occurrence = evidence.occurrence;
  return JSON.stringify([
    'lua-occurrence',
    occurrence.sourcePath,
    occurrence.sourceAssetId ?? '',
    occurrence.sourceContentHash,
    occurrence.regionOrdinal,
    occurrence.regionStartUtf16,
    occurrence.regionEndUtf16,
    occurrence.line,
    occurrence.column,
    occurrence.rawLiteral,
    occurrence.decodedValue,
    occurrence.literalKind,
    occurrence.sourceKind,
    occurrence.confidence,
    occurrence.candidateTargets.map(serializeAuthoringDependencyNodeKey),
  ]);
}

function canonicalEvidence(
  evidence: readonly AuthoringDependencyEvidence[] | undefined,
): readonly AuthoringDependencyEvidence[] | undefined {
  if (!evidence) return undefined;
  const byKey = new Map<string, AuthoringDependencyEvidence>();
  for (const item of evidence) byKey.set(serializeAuthoringDependencyEvidence(item), item);
  return Object.freeze(
    [...byKey]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, item]) => {
        if (item.kind === 'explicit-lua-fallback') return Object.freeze({ ...item });
        return Object.freeze({
          ...item,
          occurrence: Object.freeze({
            ...item.occurrence,
            candidateTargets: Object.freeze(
              item.occurrence.candidateTargets.map((target) => Object.freeze({ ...target })),
            ),
          }),
        });
      }),
  );
}

function freezeEdge(edge: AuthoringDependencyEdge): AuthoringDependencyEdge {
  return Object.freeze({
    ...edge,
    source: Object.freeze({ ...edge.source }),
    target: Object.freeze({ ...edge.target }),
    facets: sortedUnique(edge.facets) as readonly DependencyImpactFacet[],
    targetImpactPaths: sortedUnique(edge.targetImpactPaths),
    repair: Object.freeze({ ...edge.repair }),
    evidence: canonicalEvidence(edge.evidence),
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
    case 'trait-definition':
      return JSON.stringify(['trait-definition', key.id]);
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
  family: 'room-placement' | 'room-exit' | 'room-hotspot' | 'interactable-hotspot',
  id: string,
): AuthoringDependencyNodeKey {
  return Object.freeze({ kind: 'nested', ownerCollection, ownerId, family, id });
}

export function propertyDefinitionNodeKey(id: string): AuthoringDependencyNodeKey {
  return Object.freeze({ kind: 'property-definition', id });
}

export function traitDefinitionNodeKey(id: string): AuthoringDependencyNodeKey {
  return Object.freeze({ kind: 'trait-definition', id });
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

export function traitDefinitionContributionKey(id: string): string {
  return `trait-definition:${JSON.stringify(id)}`;
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
    case 'source-resolution-asset':
      return JSON.stringify(['source-resolution-asset', dependency.assetId]);
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
  edge: Pick<AuthoringDependencyEdge, 'source' | 'target' | 'sourcePath' | 'role'>,
): string {
  return JSON.stringify([
    serializeAuthoringDependencyNodeKey(edge.source),
    edge.sourcePath,
    serializeAuthoringDependencyNodeKey(edge.target),
    edge.role,
  ]);
}

function authoringDependencyRelationshipKey(
  edge: Pick<AuthoringDependencyEdge, 'source' | 'target' | 'sourcePath'>,
): string {
  return JSON.stringify([
    serializeAuthoringDependencyNodeKey(edge.source),
    edge.sourcePath,
    serializeAuthoringDependencyNodeKey(edge.target),
  ]);
}

function preferredEdge(
  current: AuthoringDependencyEdge,
  candidate: AuthoringDependencyEdge,
): AuthoringDependencyEdge {
  if (current.role === candidate.role) return current;
  if (current.role === 'explicit-ref') return candidate;
  if (candidate.role === 'explicit-ref') return current;
  if (current.role === 'variable-ref' && candidate.role === 'condition-variable') return candidate;
  if (candidate.role === 'variable-ref' && current.role === 'condition-variable') return current;
  throw new Error(
    `Conflicting graph edge roles for ${authoringDependencyRelationshipKey(current)}: ${current.role} versus ${candidate.role}`,
  );
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

  const preferred = preferredEdge(current, candidate);
  const other = preferred === current ? candidate : current;
  const isSemanticUpgrade = current.role !== candidate.role;
  if (
    !isSemanticUpgrade &&
    stableRecord(preferred.detail) !== stableRecord(other.detail) &&
    preferred.detail !== undefined &&
    other.detail !== undefined
  ) {
    throw new Error(`Conflicting graph edge metadata: ${current.id}`);
  }
  if (!isSemanticUpgrade && JSON.stringify(preferred.repair) !== JSON.stringify(other.repair)) {
    throw new Error(`Conflicting graph edge repair policy: ${current.id}`);
  }

  const merged = {
    ...preferred,
    facets: sortedUnique([
      ...current.facets,
      ...candidate.facets,
    ]) as readonly DependencyImpactFacet[],
    targetImpactPaths: sortedUnique([...current.targetImpactPaths, ...candidate.targetImpactPaths]),
    evidence:
      current.evidence || candidate.evidence
        ? canonicalEvidence([...(current.evidence ?? []), ...(candidate.evidence ?? [])])
        : undefined,
    detail: preferred.detail ?? other.detail,
  };
  return freezeEdge({ ...merged, id: createAuthoringDependencyEdgeId(merged) });
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

export function replaceAuthoringDependencyGraphContributions(
  current: AuthoringDependencyGraphContributionSet,
  replacements: Iterable<AuthoringDependencyGraphContribution>,
  removedKeys: Iterable<string> = [],
): AuthoringDependencyGraphContributionSet {
  const next = new Map(current.byKey);
  for (const key of removedKeys) next.delete(key);
  for (const replacement of replacements) next.set(replacement.key, replacement);
  return createAuthoringDependencyGraphContributionSet(next.values());
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
  const nodeOwnerContributionKeys = new Map<string, string>();
  const edgesByRelationship = new Map<string, AuthoringDependencyEdge>();
  const edgeOwnerContributionKeys = new Map<string, string>();
  const diagnostics: AuthoringDependencyGraphDiagnostic[] = [];

  // Iterate the map directly so custom ReadonlyMap implementations only need to preserve their
  // standard iterator contract; this also avoids allocating a separate values iterator.
  for (const [, contribution] of contributionSet.byKey) {
    for (const node of contribution.nodes) {
      const keyText = serializeAuthoringDependencyNodeKey(node.key);
      if (node.keyText !== keyText) {
        throw new Error(`Non-canonical graph node keyText: ${node.keyText}`);
      }
      const current = nodes.get(keyText);
      const currentOwner = nodeOwnerContributionKeys.get(keyText);
      if (currentOwner && currentOwner !== contribution.key) {
        throw new Error(
          `Conflicting graph node ownership: ${keyText} is owned by both ${currentOwner} and ${contribution.key}`,
        );
      }
      if (current && JSON.stringify(current) !== JSON.stringify(node)) {
        throw new Error(`Conflicting graph node ownership or metadata: ${keyText}`);
      }
      nodes.set(keyText, freezeNode(node));
      nodeOwnerContributionKeys.set(keyText, contribution.key);
    }
    for (const edge of contribution.edges) {
      const canonicalId = createAuthoringDependencyEdgeId(edge);
      if (edge.id !== canonicalId) throw new Error(`Non-canonical graph edge id: ${edge.id}`);
      const relationshipKey = authoringDependencyRelationshipKey(edge);
      const currentOwner = edgeOwnerContributionKeys.get(relationshipKey);
      if (currentOwner && currentOwner !== contribution.key) {
        throw new Error(
          `Conflicting graph edge ownership: ${relationshipKey} is owned by both ${currentOwner} and ${contribution.key}`,
        );
      }
      const current = edgesByRelationship.get(relationshipKey);
      edgesByRelationship.set(
        relationshipKey,
        current ? mergeEdges(current, edge) : freezeEdge(edge),
      );
      edgeOwnerContributionKeys.set(relationshipKey, contribution.key);
    }
    diagnostics.push(...contribution.diagnostics.map(freezeDiagnostic));
  }
  const sortedNodes = [...nodes].sort(([left], [right]) => left.localeCompare(right));
  const sortedEdges = [...edgesByRelationship.values()].sort(compareEdges);
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
  evidence?: AuthoringDependencyEdge['evidence'];
  detail?: Readonly<Record<string, string>>;
}

function defaultRepairPolicy(
  sourcePath: JsonPointer,
  _target: AuthoringDependencyNodeKey,
): AuthoringDependencyEdge['repair'] {
  const arrayItemMatch = sourcePath.match(/^(.*\/\d+)(?:\/.*)?$/);
  if (arrayItemMatch)
    return { kind: 'remove-array-item', itemPath: arrayItemMatch[1] as JsonPointer };
  return {
    kind: 'blocked',
    reason: 'This reference role has no safe automatic repair encoding.',
  };
}

export function structuralEdge(
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
    targetImpactPaths: Object.freeze(options.targetImpactPaths ?? []),
    repair: Object.freeze(options.repair ?? defaultRepairPolicy(sourcePath, target)),
    evidence: options.evidence,
    detail: options.detail,
  };
  return freezeEdge({ ...edge, id: createAuthoringDependencyEdgeId(edge) });
}

function recordImpactPaths(
  target: AuthoringDependencyNodeKey,
  suffixes: readonly string[],
): readonly JsonPointer[] {
  if (target.kind !== 'record') return [];
  const base = `/${target.collection}/${escapeJsonPointerSegment(target.id)}`;
  return suffixes.map((suffix) => `${base}${suffix}`);
}

function semanticEdgeOptions(
  path: JsonPointer,
  target: AuthoringDependencyNodeKey,
): StructuralEdgeOptions {
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
      /\/data\/(?:hotspots\/\d+|presentation\/hotspots\/(?:hotspot|hotspots\/\d+))\/activation\/verb\/\$ref$/,
      'hotspot-activation-verb',
      ['reference-integrity', 'tooling-reference', 'runtime-only'],
    ],
    [
      /\/data\/(?:hotspots\/\d+|presentation\/hotspots\/(?:hotspot|hotspots\/\d+))\/highlight\/material\/\$ref$/,
      'hotspot-material',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
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
      /\/data\/presentation\/sprite\/\$ref$/,
      'interactable-sprite',
      ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    ],
    [
      /\/data\/presentation\/material\/\$ref$/,
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
      /\/data\/stages\/[^/]+\/sourceAsset\/\$ref$/,
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
  if (!match) {
    if (
      target.kind === 'record' &&
      target.collection === 'variables' &&
      /\/(?:condition|availability|canEnter|canLeave)\/variable\/\$ref$/.test(path)
    ) {
      return {
        role: 'condition-variable',
        facets: ['reference-integrity', 'tooling-reference', 'validation', 'runtime-only'],
        targetImpactPaths: recordImpactPaths(target, [
          '/data/type',
          '/data/defaultValue',
          '/data/enumValues',
        ]),
      };
    }
    return {};
  }

  const role = match[1];
  let targetImpactPaths: readonly JsonPointer[] = [];
  if (
    [
      'room-background',
      'room-prop-asset',
      'room-environment-asset',
      'character-pose-sprite',
      'character-expression-sprite',
      'interactable-sprite',
      'material-texture',
      'shader-source',
      'script-source',
      'layout-rml-source',
      'layout-rcss-source',
      'layout-lua-source',
      'layout-image',
      'layout-font',
      'layout-stylesheet',
      'layout-script',
      'layout-template',
      'default-font',
    ].includes(role)
  ) {
    targetImpactPaths = recordImpactPaths(target, [
      '/data/source/path',
      '/data/contentHash',
      '/data/byteSize',
      '/data/kind',
      '/data/extension',
      '/data/sampling',
    ]);
  } else if (
    [
      'room-background-material',
      'room-prop-material',
      'room-environment-material',
      'character-pose-material',
      'character-expression-material',
      'interactable-material',
      'layout-material',
      'material-base',
    ].includes(role)
  ) {
    targetImpactPaths = recordImpactPaths(target, ['/data']);
  } else if (role === 'material-shader') {
    targetImpactPaths = recordImpactPaths(target, ['/data']);
  } else if (
    role === 'room-overlay-layout' ||
    role === 'room-placement-layout' ||
    role === 'system-layout'
  ) {
    targetImpactPaths = recordImpactPaths(target, [
      '/data/layoutKind',
      '/data/target',
      '/data/scalePolicy',
      '/data/rml',
      '/data/rcss',
      '/data/lua',
      '/data/script',
      '/data/mount',
      '/data/dependencies',
    ]);
  } else if (role === 'room-cast-character') {
    targetImpactPaths = recordImpactPaths(target, [
      '/data/defaults',
      '/data/poses',
      '/data/expressions',
      '/data/idles',
    ]);
  } else if (role === 'room-compose-script') {
    targetImpactPaths = recordImpactPaths(target, ['/data/source']);
  }

  const nullableReferenceRoles = new Set<AuthoringDependencyRole>([
    'room-background',
    'room-prop-asset',
    'room-environment-asset',
    'room-background-material',
    'room-prop-material',
  ]);
  let repair: AuthoringDependencyEdge['repair'] | undefined;
  if (role === 'room-cast-character' || role === 'room-overlay-layout') {
    repair = {
      kind: 'remove-array-item',
      itemPath: buildJsonPointer(parseJsonPointer(path).slice(0, -3)),
    };
  } else if (role === 'room-placement-layout' || role === 'system-layout') {
    repair = { kind: 'set-null', path: buildJsonPointer(parseJsonPointer(path).slice(0, -1)) };
  } else if (role === 'room-compose-script') {
    repair = { kind: 'set-null', path: buildJsonPointer(parseJsonPointer(path).slice(0, -2)) };
  } else if (nullableReferenceRoles.has(role)) {
    repair = { kind: 'set-null', path: buildJsonPointer(parseJsonPointer(path).slice(0, -1)) };
  } else if (role === 'room-environment-material') {
    repair = { kind: 'replacement-required', path, collection: 'materials' };
  } else if (role === 'room-exit-target') {
    repair = { kind: 'replacement-required', path, collection: 'rooms' };
  }

  const systemRoleSegments = role === 'system-layout' ? parseJsonPointer(path) : [];
  const systemRole = systemRoleSegments[3];
  return {
    role,
    facets: match[2],
    targetImpactPaths,
    repair,
    detail: systemRole ? { systemRole } : undefined,
  };
}

function scanStructuralReferences(
  value: unknown,
  path: JsonPointer,
  source: AuthoringDependencyNodeKey,
  edges: AuthoringDependencyEdge[],
  project: AuthoringProject,
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      scanStructuralReferences(child, `${path}/${index}`, source, edges, project),
    );
    return;
  }
  if (!isRecord(value)) return;
  const structuralValue: Record<string, unknown> = value;

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
          repair:
            role === 'character-room-placement' || role === 'interactable-room-placement'
              ? {
                  kind: 'set-nowhere',
                  path: buildJsonPointer(parseJsonPointer(path).slice(0, -1)),
                }
              : {
                  kind: 'blocked',
                  reason: 'Room-placement pair references require a role-specific replacement.',
                },
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
          repair: {
            kind: 'blocked',
            reason: 'Room-exit pair references require both Room and exit replacement IDs.',
          },
          detail: { roomId: value.room, exitId: value.exit },
        },
      ),
    );
  }

  if (
    value.kind === 'room-hotspot' &&
    isRecord(value.room) &&
    isReferenceTarget(value.room.$ref) &&
    typeof value.hotspotId === 'string'
  ) {
    edges.push(
      structuralEdge(
        source,
        nestedNodeKey('rooms', value.room.$ref.id, 'room-hotspot', value.hotspotId),
        path,
        `/rooms/${escapeJsonPointerSegment(value.room.$ref.id)}/data/hotspots`,
        {
          role: 'hotspot-context',
          facets: ['reference-integrity', 'tooling-reference', 'runtime-only'],
          repair: {
            kind: 'blocked',
            reason: 'Exact hotspot contexts require a valid hotspot replacement.',
          },
        },
      ),
    );
  }
  if (
    value.kind === 'interactable-hotspot' &&
    isRecord(value.interactable) &&
    isReferenceTarget(value.interactable.$ref) &&
    typeof value.hotspotId === 'string'
  ) {
    edges.push(
      structuralEdge(
        source,
        nestedNodeKey(
          'interactables',
          value.interactable.$ref.id,
          'interactable-hotspot',
          value.hotspotId,
        ),
        path,
        `/interactables/${escapeJsonPointerSegment(value.interactable.$ref.id)}/data/presentation/hotspots`,
        {
          role: 'hotspot-context',
          facets: ['reference-integrity', 'tooling-reference', 'runtime-only'],
          repair: {
            kind: 'blocked',
            reason: 'Exact hotspot contexts require a valid hotspot replacement.',
          },
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
        semanticEdgeOptions(`${path}/$ref`, target),
      ),
    );
  }
  if (isVariableRef(value)) {
    const variableId = value.$var;
    const target = recordNodeKey('variables', variableId);
    edges.push(
      structuralEdge(
        source,
        target,
        `${path}/$var`,
        `/variables/${escapeJsonPointerSegment(variableId)}`,
        {
          role: 'variable-ref',
          targetImpactPaths: recordImpactPaths(target, [
            '/data/type',
            '/data/defaultValue',
            '/data/enumValues',
          ]),
        },
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
  const localizedKey =
    structuralValue.kind === 'localized' && typeof structuralValue.key === 'string'
      ? structuralValue.key
      : null;
  if (localizedKey) {
    const defaultLocale = project.localization.defaultLocale;
    const fallbackLocale = project.localization.fallbackLocale;
    const locales = [defaultLocale];
    if (
      project.localization.catalogs[defaultLocale]?.[localizedKey] === undefined &&
      fallbackLocale !== null &&
      fallbackLocale !== defaultLocale
    ) {
      locales.push(fallbackLocale);
    }
    const projectFields = [
      '/localization/defaultLocale',
      ...(locales.length > 1 ? ['/localization/fallbackLocale'] : []),
    ] as JsonPointer[];
    for (const fieldPath of projectFields) {
      edges.push(
        structuralEdge(source, projectFieldNodeKey(fieldPath), path, fieldPath, {
          role: 'localization-text',
          facets: ['tooling-reference', 'preview-ui', 'validation'],
          targetImpactPaths: [fieldPath],
          repair: { kind: 'blocked', reason: 'Localization selection is project-owned.' },
        }),
      );
    }
    for (const locale of locales) {
      const targetPath = buildJsonPointer(['localization', 'catalogs', locale, localizedKey]);
      edges.push(
        structuralEdge(source, localizationKeyNodeKey(locale, localizedKey), path, targetPath, {
          role: 'localization-text',
          facets: ['tooling-reference', 'preview-ui', 'validation'],
          targetImpactPaths: [targetPath],
          repair: { kind: 'blocked', reason: 'Localized text requires a catalog entry.' },
        }),
      );
    }
  }
  for (const [key, child] of Object.entries(structuralValue)) {
    scanStructuralReferences(
      child,
      `${path}/${escapeJsonPointerSegment(key)}`,
      source,
      edges,
      project,
    );
  }
}

function collectDerivationDependencies(
  value: unknown,
  dependencies: AuthoringDependencyDerivationDependency[],
  project: AuthoringProject,
): void {
  if (Array.isArray(value)) {
    value.forEach((child) => collectDerivationDependencies(child, dependencies, project));
    return;
  }
  if (!isRecord(value)) return;
  if (value.kind === 'localized' && typeof value.key === 'string') {
    dependencies.push({ kind: 'localization-lookup', key: value.key });
    dependencies.push({ kind: 'project-field', path: '/localization/defaultLocale' });
    if (
      project.localization.catalogs[project.localization.defaultLocale]?.[value.key] ===
        undefined &&
      project.localization.fallbackLocale !== project.localization.defaultLocale
    ) {
      dependencies.push({ kind: 'project-field', path: '/localization/fallbackLocale' });
    }
  }
  Object.values(value).forEach((child) =>
    collectDerivationDependencies(child, dependencies, project),
  );
}

function tolerantObjectArray(value: unknown, key: string): readonly Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key].filter(isRecord);
}

function nestedRoomNodesAndEdges(
  id: string,
  record: AuthoringRecordBase,
  source: AuthoringDependencyNodeKey,
  owningPath: JsonPointer,
): { nodes: AuthoringDependencyNode[]; edges: AuthoringDependencyEdge[] } {
  const nodes: AuthoringDependencyNode[] = [];
  const edges: AuthoringDependencyEdge[] = [];
  const background = isRecord(record.data) ? record.data.background : null;
  const backgroundAsset = isRecord(background) ? background.asset : null;
  const backgroundAssetId =
    isRecord(backgroundAsset) &&
    isRecord(backgroundAsset.$ref) &&
    backgroundAsset.$ref.collection === 'assets' &&
    typeof backgroundAsset.$ref.id === 'string'
      ? backgroundAsset.$ref.id
      : null;
  tolerantObjectArray(record.data, 'placements').forEach((placement, index) => {
    if (typeof placement.id !== 'string') return;
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
  tolerantObjectArray(record.data, 'exits').forEach((exit, index) => {
    if (typeof exit.id !== 'string') return;
    const key = nestedNodeKey('rooms', id, 'room-exit', exit.id);
    const path = `${owningPath}/data/exits/${index}` as JsonPointer;
    nodes.push({
      key,
      keyText: serializeAuthoringDependencyNodeKey(key),
      owningPath: path,
      label: typeof exit.label === 'string' ? exit.label : exit.id,
    });
    edges.push(
      structuralEdge(source, key, path, path, {
        role: 'explicit-ref',
        facets: ['runtime-only', 'tooling-reference'],
        repair: { kind: 'blocked', reason: 'Room exit is owned by its Room.' },
      }),
    );
  });
  tolerantObjectArray(record.data, 'hotspots').forEach((hotspot, index) => {
    if (typeof hotspot.id !== 'string') return;
    const key = nestedNodeKey('rooms', id, 'room-hotspot', hotspot.id);
    const path = `${owningPath}/data/hotspots/${index}` as JsonPointer;
    nodes.push({
      key,
      keyText: serializeAuthoringDependencyNodeKey(key),
      owningPath: path,
      label: typeof hotspot.label === 'string' ? hotspot.label : hotspot.id,
    });
    edges.push(
      structuralEdge(source, key, path, path, {
        role: 'explicit-ref',
        facets: ['runtime-only', 'tooling-reference', 'preview-visual'],
        repair: { kind: 'blocked', reason: 'Room hotspot is owned by its Room.' },
      }),
    );
    if (backgroundAssetId) {
      edges.push(
        structuralEdge(
          key,
          recordNodeKey('assets', backgroundAssetId),
          `${owningPath}/data/background/asset/$ref`,
          `/assets/${escapeJsonPointerSegment(backgroundAssetId)}`,
          {
            role: 'hotspot-source-image',
            facets: ['reference-integrity', 'tooling-reference', 'runtime-only', 'preview-visual'],
            repair: {
              kind: 'replacement-required',
              path: `${owningPath}/data/background/asset` as JsonPointer,
              collection: 'assets',
            },
          },
        ),
      );
    }
    if (
      isRecord(hotspot.activation) &&
      hotspot.activation.kind === 'exit' &&
      typeof hotspot.activation.exitId === 'string'
    ) {
      edges.push(
        structuralEdge(
          key,
          nestedNodeKey('rooms', id, 'room-exit', hotspot.activation.exitId),
          `${path}/activation/exitId`,
          `${owningPath}/data/exits`,
          {
            role: 'hotspot-exit',
            facets: ['reference-integrity', 'tooling-reference', 'runtime-only'],
            repair: {
              kind: 'blocked',
              reason: 'Room hotspot exit activation requires an existing exit.',
            },
          },
        ),
      );
    }
  });
  return { nodes, edges };
}

function nestedInteractableNodesAndEdges(
  id: string,
  record: AuthoringRecordBase,
  source: AuthoringDependencyNodeKey,
  owningPath: JsonPointer,
): { nodes: AuthoringDependencyNode[]; edges: AuthoringDependencyEdge[] } {
  const nodes: AuthoringDependencyNode[] = [];
  const edges: AuthoringDependencyEdge[] = [];
  if (
    !isRecord(record.data) ||
    !isRecord(record.data.presentation) ||
    !isRecord(record.data.presentation.hotspots)
  )
    return { nodes, edges };
  const definition = record.data.presentation.hotspots;
  const sprite = record.data.presentation.sprite;
  const spriteId =
    isRecord(sprite) &&
    isRecord(sprite.$ref) &&
    sprite.$ref.collection === 'assets' &&
    typeof sprite.$ref.id === 'string'
      ? sprite.$ref.id
      : null;
  const hotspots =
    definition.kind === 'sprite-alpha' && isRecord(definition.hotspot)
      ? [definition.hotspot]
      : definition.kind === 'custom' && Array.isArray(definition.hotspots)
        ? definition.hotspots.filter(isRecord)
        : [];
  hotspots.forEach((hotspot, index) => {
    if (typeof hotspot.id !== 'string') return;
    const key = nestedNodeKey('interactables', id, 'interactable-hotspot', hotspot.id);
    const path = (
      definition.kind === 'sprite-alpha'
        ? `${owningPath}/data/presentation/hotspots/hotspot`
        : `${owningPath}/data/presentation/hotspots/hotspots/${index}`
    ) as JsonPointer;
    nodes.push({
      key,
      keyText: serializeAuthoringDependencyNodeKey(key),
      owningPath: path,
      label: typeof hotspot.label === 'string' ? hotspot.label : hotspot.id,
    });
    edges.push(
      structuralEdge(source, key, path, path, {
        role: 'explicit-ref',
        facets: ['runtime-only', 'tooling-reference', 'preview-visual'],
        repair: { kind: 'blocked', reason: 'Interactable hotspot is owned by its Interactable.' },
      }),
    );
    if (spriteId) {
      edges.push(
        structuralEdge(
          key,
          recordNodeKey('assets', spriteId),
          `${owningPath}/data/presentation/sprite/$ref`,
          `/assets/${escapeJsonPointerSegment(spriteId)}`,
          {
            role: 'hotspot-source-image',
            facets: ['reference-integrity', 'tooling-reference', 'runtime-only', 'preview-visual'],
            repair: {
              kind: 'replacement-required',
              path: `${owningPath}/data/presentation/sprite` as JsonPointer,
              collection: 'assets',
            },
          },
        ),
      );
    }
  });
  return { nodes, edges };
}

function ownerLocalDiagnostics(
  collection: AuthoringCollectionKey,
  record: AuthoringRecordBase,
  owningPath: JsonPointer,
): AuthoringDependencyGraphDiagnostic[] {
  const diagnostics: AuthoringDependencyGraphDiagnostic[] = [];
  const addMissing = (path: JsonPointer, family: string, id: string) =>
    diagnostics.push({
      severity: 'error',
      code: 'authoring_dependency.missing_owner_local_target',
      path,
      message: `${family} target '${id}' does not exist in its owning record.`,
    });

  if (collection === 'rooms') {
    const placements = new Set(
      tolerantObjectArray(record.data, 'placements')
        .map((item) => item.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    for (const [family, items] of [
      ['cast', tolerantObjectArray(record.data, 'cast')],
      ['props', tolerantObjectArray(record.data, 'props')],
    ] as const) {
      items.forEach((item, index) => {
        if (typeof item.placementId === 'string' && !placements.has(item.placementId)) {
          addMissing(
            `${owningPath}/data/${family}/${index}/placementId`,
            'Room placement',
            item.placementId,
          );
        }
      });
    }
  } else if (collection === 'dialogues' && isRecord(record.data)) {
    const blocks = tolerantObjectArray(record.data, 'blocks');
    const blockIds = new Set(
      blocks.map((item) => item.id).filter((id): id is string => typeof id === 'string'),
    );
    if (typeof record.data.entryBlockId === 'string' && !blockIds.has(record.data.entryBlockId)) {
      addMissing(`${owningPath}/data/entryBlockId`, 'Dialogue block', record.data.entryBlockId);
    }
    blocks.forEach((block, index) => {
      if (
        block.type === 'redirect' &&
        typeof block.targetBlockId === 'string' &&
        !blockIds.has(block.targetBlockId)
      ) {
        addMissing(
          `${owningPath}/data/blocks/${index}/targetBlockId`,
          'Dialogue block',
          block.targetBlockId,
        );
      }
    });
    tolerantObjectArray(record.data, 'edges').forEach((edge, index) => {
      for (const field of ['fromBlockId', 'toBlockId'] as const) {
        if (typeof edge[field] === 'string' && !blockIds.has(edge[field])) {
          addMissing(`${owningPath}/data/edges/${index}/${field}`, 'Dialogue block', edge[field]);
        }
      }
    });
  } else if (collection === 'scenes' && isRecord(record.data)) {
    const steps = tolerantObjectArray(record.data, 'steps');
    const stepIds = new Set(
      steps.map((item) => item.id).filter((id): id is string => typeof id === 'string'),
    );
    steps.forEach((step, stepIndex) => {
      const targets: { path: JsonPointer; id: string }[] = [];
      if (typeof step.fallbackStepId === 'string') {
        targets.push({
          path: `${owningPath}/data/steps/${stepIndex}/fallbackStepId`,
          id: step.fallbackStepId,
        });
      }
      for (const [family, items] of [
        ['branches', tolerantObjectArray(step, 'branches')],
        ['options', tolerantObjectArray(step, 'options')],
      ] as const) {
        items.forEach((item, itemIndex) => {
          if (typeof item.targetStepId === 'string') {
            targets.push({
              path: `${owningPath}/data/steps/${stepIndex}/${family}/${itemIndex}/targetStepId`,
              id: item.targetStepId,
            });
          }
        });
      }
      targets.forEach((target) => {
        if (!stepIds.has(target.id)) addMissing(target.path, 'Scene step', target.id);
      });
    });
  } else if (collection === 'maps' && isRecord(record.data)) {
    const locationIds = new Set(
      tolerantObjectArray(record.data, 'locations')
        .map((item) => item.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    tolerantObjectArray(record.data, 'connections').forEach((connection, index) => {
      for (const field of ['sourceLocation', 'targetLocation'] as const) {
        if (typeof connection[field] === 'string' && !locationIds.has(connection[field])) {
          addMissing(
            `${owningPath}/data/connections/${index}/${field}`,
            'Map location',
            connection[field],
          );
        }
      }
    });
  }
  return diagnostics;
}

function addRoomCastEdgeDetails(
  record: AuthoringRecordBase,
  owningPath: JsonPointer,
  edges: AuthoringDependencyEdge[],
): void {
  tolerantObjectArray(record.data, 'cast').forEach((cast, index) => {
    const sourcePath = `${owningPath}/data/cast/${index}/character/$ref`;
    const edgeIndex = edges.findIndex(
      (edge) => edge.role === 'room-cast-character' && edge.sourcePath === sourcePath,
    );
    if (edgeIndex < 0) return;
    const edge = edges[edgeIndex]!;
    const detail: Record<string, string> = { ...edge.detail };
    for (const key of ['id', 'placementId', 'poseId', 'expressionId', 'idleId'] as const) {
      if (typeof cast[key] === 'string') detail[key] = cast[key];
    }
    edges[edgeIndex] = freezeEdge({ ...edge, detail: Object.freeze(detail) });
  });
}

function roomProjectFieldEdges(
  source: AuthoringDependencyNodeKey,
  owningPath: JsonPointer,
): readonly AuthoringDependencyEdge[] {
  const fields: readonly {
    path: JsonPointer;
    facets: readonly DependencyImpactFacet[];
  }[] = [
    { path: '/settings/display', facets: ['preview-visual', 'preview-ui'] },
    { path: '/settings/accessibility', facets: ['preview-ui'] },
    { path: '/settings/text/defaultFont', facets: ['preview-ui', 'resource'] },
    { path: '/settings/ui/systemLayouts/game-hud', facets: ['preview-ui'] },
  ];
  return fields.map((field) =>
    structuralEdge(source, projectFieldNodeKey(field.path), owningPath, field.path, {
      role: 'explicit-ref',
      facets: field.facets,
      targetImpactPaths: [field.path],
      repair: {
        kind: 'blocked',
        reason: 'Room preview consumes this project-owned setting.',
      },
      detail: { projectField: field.path },
    }),
  );
}

function recordContribution(
  project: AuthoringProject,
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
      : collection === 'interactables'
        ? nestedInteractableNodesAndEdges(id, record, source, owningPath)
        : { nodes: [], edges: [] };
  for (const [index, traitId] of (record.traits ?? []).entries()) {
    edges.push(
      structuralEdge(
        source,
        traitDefinitionNodeKey(traitId),
        `${owningPath}/traits/${index}`,
        `/traits/${escapeJsonPointerSegment(traitId)}`,
        {
          role: 'trait-attachment',
          facets: ['reference-integrity', 'tooling-reference', 'validation', 'runtime-only'],
          targetImpactPaths: [`/traits/${escapeJsonPointerSegment(traitId)}`],
          repair: { kind: 'remove-array-item', itemPath: `${owningPath}/traits/${index}` },
        },
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
          targetImpactPaths: recordImpactPaths(
            recordNodeKey('materials', record.data.baseMaterialId),
            ['/data'],
          ),
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
          targetImpactPaths: [`/properties/${escapeJsonPointerSegment(propertyId)}`],
          repair: {
            kind: 'remove-map-entry',
            entryPath: `${owningPath}/properties/${escapeJsonPointerSegment(propertyId)}`,
          },
        },
      ),
    );
  }
  scanStructuralReferences(record.data, `${owningPath}/data`, source, edges, project);
  if (collection === 'rooms') {
    addRoomCastEdgeDetails(record, owningPath, edges);
    edges.push(...roomProjectFieldEdges(source, owningPath));
  }
  edges.push(...nested.edges);
  const derivationDependencies: AuthoringDependencyDerivationDependency[] = [];
  collectDerivationDependencies(record.data, derivationDependencies, project);
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
    diagnostics: ownerLocalDiagnostics(collection, record, owningPath),
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

function projectFieldSpecs(project: AuthoringProject): readonly {
  path: JsonPointer;
  value: unknown;
  label: string;
}[] {
  return Object.freeze([
    {
      path: '/localization/defaultLocale',
      value: project.localization.defaultLocale,
      label: 'Default locale',
    },
    {
      path: '/localization/fallbackLocale',
      value: project.localization.fallbackLocale,
      label: 'Fallback locale',
    },
    { path: '/startupHook', value: project.startupHook, label: 'Startup hook' },
    { path: '/entrypoint', value: project.entrypoint, label: 'Entrypoint' },
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
    ...systemLayoutRoleValues.map((role) => ({
      path: `/settings/ui/systemLayouts/${escapeJsonPointerSegment(role)}` as JsonPointer,
      value: project.settings.ui.systemLayouts[role] ?? null,
      label: `System layout: ${role}`,
    })),
  ]);
}

function deriveStructuralContributionByKey(
  project: AuthoringProject,
  contributionKey: string,
): AuthoringDependencyGraphContribution | null {
  if (contributionKey.startsWith('record:')) {
    const parsed = JSON.parse(contributionKey.slice('record:'.length)) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      parsed[0] !== 'record' ||
      !authoringCollectionKeys.includes(parsed[1] as AuthoringCollectionKey) ||
      typeof parsed[2] !== 'string'
    )
      return null;
    const collection = parsed[1] as AuthoringCollectionKey;
    const id = parsed[2];
    const record = project[collection][id];
    return record ? recordContribution(project, collection, id, record) : null;
  }
  if (contributionKey.startsWith('trait-definition:')) {
    const id = JSON.parse(contributionKey.slice('trait-definition:'.length)) as unknown;
    if (typeof id !== 'string') return null;
    const definition = project.traits[id];
    if (!definition) return null;
    const key = traitDefinitionNodeKey(id);
    const ownerPath = `/traits/${escapeJsonPointerSegment(id)}`;
    const edges = definition.properties.map((property, index) =>
      structuralEdge(
        key,
        propertyDefinitionNodeKey(property.propertyId),
        `${ownerPath}/properties/${index}/propertyId`,
        `/properties/${escapeJsonPointerSegment(property.propertyId)}`,
        {
          role: 'trait-property',
          facets: ['reference-integrity', 'tooling-reference', 'validation', 'runtime-only'],
          targetImpactPaths: [`/properties/${escapeJsonPointerSegment(property.propertyId)}`],
          repair: {
            kind: 'blocked',
            reason: 'Trait Property membership must be repaired explicitly.',
          },
        },
      ),
    );
    return {
      key: contributionKey,
      ownerPath,
      nodes: [
        {
          key,
          keyText: serializeAuthoringDependencyNodeKey(key),
          owningPath: ownerPath,
          label: definition.label,
        },
      ],
      edges,
      diagnostics: [],
      derivationDependencies: [],
      literalOccurrences: [],
    };
  }
  if (contributionKey.startsWith('property-definition:')) {
    const id = JSON.parse(contributionKey.slice('property-definition:'.length)) as unknown;
    if (typeof id !== 'string') return null;
    const definition = project.properties[id];
    if (!definition) return null;
    const key = propertyDefinitionNodeKey(id);
    const ownerPath = `/properties/${escapeJsonPointerSegment(id)}`;
    return {
      key: contributionKey,
      ownerPath,
      nodes: [
        {
          key,
          keyText: serializeAuthoringDependencyNodeKey(key),
          owningPath: ownerPath,
          label: definition.label,
        },
      ],
      edges: [],
      diagnostics: [],
      derivationDependencies: [],
      literalOccurrences: [],
    };
  }
  if (contributionKey.startsWith('localization-key:')) {
    const parsed = JSON.parse(contributionKey.slice('localization-key:'.length)) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      project.localization.catalogs[parsed[0]]?.[parsed[1]] === undefined
    )
      return null;
    const [locale, keyName] = parsed;
    const key = localizationKeyNodeKey(locale, keyName);
    const ownerPath = buildJsonPointer(['localization', 'catalogs', locale, keyName]);
    return {
      key: contributionKey,
      ownerPath,
      nodes: [
        {
          key,
          keyText: serializeAuthoringDependencyNodeKey(key),
          owningPath: ownerPath,
          label: keyName,
        },
      ],
      edges: [],
      diagnostics: [],
      derivationDependencies: [],
      literalOccurrences: [],
    };
  }
  if (contributionKey.startsWith('project-field:')) {
    const fieldPath = JSON.parse(contributionKey.slice('project-field:'.length)) as unknown;
    if (typeof fieldPath !== 'string') return null;
    const field = projectFieldSpecs(project).find((candidate) => candidate.path === fieldPath);
    if (!field) return null;
    const key = projectFieldNodeKey(field.path);
    const edges: AuthoringDependencyEdge[] = [];
    if (field.path === '/entrypoint' && project.entrypoint) {
      const targetCollection = `${project.entrypoint.kind}s` as 'rooms' | 'scenes' | 'dialogues';
      edges.push(
        structuralEdge(
          key,
          recordNodeKey(targetCollection, project.entrypoint.id),
          field.path,
          `/${targetCollection}/${escapeJsonPointerSegment(project.entrypoint.id)}`,
          'entrypoint',
        ),
      );
    } else if (field.path.startsWith('/settings/')) {
      scanStructuralReferences(field.value, field.path, key, edges, project);
    }
    return {
      key: contributionKey,
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
    };
  }
  return null;
}

export function enumerateAuthoringDependencyContributionKeys(
  project: AuthoringProject,
): readonly string[] {
  const keys: string[] = [];
  for (const id of Object.keys(project.properties))
    keys.push(propertyDefinitionContributionKey(id));
  for (const id of Object.keys(project.traits)) keys.push(traitDefinitionContributionKey(id));
  for (const [locale, catalog] of Object.entries(project.localization.catalogs))
    for (const key of Object.keys(catalog)) keys.push(localizationContributionKey(locale, key));
  for (const field of projectFieldSpecs(project))
    keys.push(projectFieldContributionKey(field.path));
  for (const collection of authoringCollectionKeys)
    for (const id of Object.keys(project[collection]))
      keys.push(recordContributionKey(collection, id));
  return Object.freeze(keys.sort());
}

export async function deriveAuthoringDependencyContribution(
  project: AuthoringProject,
  contributionKey: string,
  luaAnalysis: LuaAnalysisInput = { mode: 'disabled' },
): Promise<AuthoringDependencyGraphContribution | null> {
  const selectedKeys = new Set([contributionKey]);
  const descriptors = collectAuthoringLuaSources(project, selectedKeys);
  const analyses =
    luaAnalysis.mode === 'enabled'
      ? ((await analyzeAuthoringSources(project, luaAnalysis.sources, undefined, selectedKeys)).get(
          contributionKey,
        ) ?? [])
      : [];
  return deriveAuthoringDependencyContributionFromPrepared(
    project,
    contributionKey,
    descriptors,
    analyses,
    luaAnalysis.mode === 'enabled',
  );
}

export function deriveAuthoringStructuralDependencyGraphContributions(
  project: AuthoringProject,
): readonly AuthoringDependencyGraphContribution[] {
  return Object.freeze(
    enumerateAuthoringDependencyContributionKeys(project).map((key) => {
      const contribution = deriveStructuralContributionByKey(project, key);
      if (!contribution) throw new Error(`Unable to derive graph contribution '${key}'.`);
      return contribution;
    }),
  );
}

export function buildAuthoringStructuralDependencyGraphContributionSet(
  project: AuthoringProject,
): AuthoringDependencyGraphContributionSet {
  return createAuthoringDependencyGraphContributionSet(
    deriveAuthoringStructuralDependencyGraphContributions(project),
  );
}

export function buildAuthoringStructuralDependencyGraph(
  project: AuthoringProject,
): AuthoringDependencyGraph {
  return assembleAuthoringDependencyGraph(
    buildAuthoringStructuralDependencyGraphContributionSet(project),
  );
}

function luaTargetPath(target: AuthoringDependencyNodeKey): JsonPointer {
  if (target.kind === 'record')
    return `/${target.collection}/${escapeJsonPointerSegment(target.id)}`;
  if (target.kind === 'property-definition')
    return `/properties/${escapeJsonPointerSegment(target.id)}`;
  if (target.kind === 'trait-definition') return `/traits/${escapeJsonPointerSegment(target.id)}`;
  if (target.kind === 'localization-key')
    return buildJsonPointer(['localization', 'catalogs', target.locale, target.key]);
  if (target.kind === 'project-field') return target.path;
  return buildJsonPointer([
    target.ownerCollection,
    target.ownerId,
    'data',
    target.family === 'room-placement' ? 'placements' : 'exits',
    target.id,
  ]);
}

function explicitTargetNode(
  target: Exclude<LuaExplicitDependencyTarget, { kind: 'property-value' }>,
): AuthoringDependencyNodeKey {
  if (target.kind === 'record') return recordNodeKey(target.collection, target.id);
  if (target.kind === 'property-definition') return propertyDefinitionNodeKey(target.propertyId);
  if (target.kind === 'room-placement')
    return nestedNodeKey('rooms', target.roomId, 'room-placement', target.placementId);
  return nestedNodeKey('rooms', target.roomId, 'room-exit', target.exitId);
}

const focusedDefinitionCollections = new Set<AuthoringCollectionKey>([
  'rooms',
  'scenes',
  'dialogues',
  'characters',
  'interactables',
  'verbs',
  'interactions',
  'maps',
]);

function focusedPreviewFacet(
  descriptor: AuthoringLuaSourceDescriptor,
  target: AuthoringDependencyNodeKey,
): 'preview-visual' | 'preview-ui' | null {
  if (!descriptor.focusedAdmission || !descriptor.focusedFacet || target.kind !== 'record')
    return null;
  if (target.collection === 'variables' || focusedDefinitionCollections.has(target.collection))
    return descriptor.focusedFacet;
  return null;
}

function focusedQueryTargetImpactPaths(target: AuthoringDependencyNodeKey): readonly JsonPointer[] {
  if (target.kind !== 'record') return [];
  const base = `/${target.collection}/${escapeJsonPointerSegment(target.id)}`;
  if (target.collection === 'variables')
    return [`${base}/data/type`, `${base}/data/defaultValue`, `${base}/data/enumValues`];
  if (target.collection === 'interactables')
    return [`${base}/data/displayName`, `${base}/data/initialState/location`];
  if (
    target.collection === 'rooms' ||
    target.collection === 'scenes' ||
    target.collection === 'dialogues' ||
    target.collection === 'characters'
  )
    return [`${base}/data/displayName`];
  return [];
}

function luaFacets(
  descriptor: AuthoringLuaSourceDescriptor,
  target: AuthoringDependencyNodeKey,
  base: readonly DependencyImpactFacet[],
): readonly DependencyImpactFacet[] {
  const previewFacet = focusedPreviewFacet(descriptor, target);
  return previewFacet ? [...base, previewFacet] : base;
}

function propertyResolutionImpactPaths(
  project: AuthoringProject,
  collection: AuthoringCollectionKey,
  ownerId: string,
): readonly JsonPointer[] {
  const base = `/${collection}/${escapeJsonPointerSegment(ownerId)}`;
  const record = project[collection][ownerId] as AuthoringRecordBase | undefined;
  return [
    `${base}/properties`,
    `${base}/traits`,
    ...(record?.traits ?? []).map(
      (traitId) => `/traits/${escapeJsonPointerSegment(traitId)}` as JsonPointer,
    ),
  ];
}

function buildLuaSymbolProjection(
  project: AuthoringProject,
): ReadonlyMap<string, readonly AuthoringDependencyNodeKey[]> {
  const byLiteral = new Map<string, AuthoringDependencyNodeKey[]>();
  const add = (literal: string, key: AuthoringDependencyNodeKey) => {
    const values = byLiteral.get(literal) ?? [];
    values.push(key);
    byLiteral.set(literal, values);
  };
  for (const collection of authoringCollectionKeys)
    for (const id of Object.keys(project[collection])) add(id, recordNodeKey(collection, id));
  for (const id of Object.keys(project.properties)) add(id, propertyDefinitionNodeKey(id));
  for (const id of Object.keys(project.traits)) add(id, traitDefinitionNodeKey(id));
  return new Map(
    [...byLiteral].map(([literal, keys]) => [
      literal,
      Object.freeze(
        [...keys].sort((left, right) =>
          serializeAuthoringDependencyNodeKey(left).localeCompare(
            serializeAuthoringDependencyNodeKey(right),
          ),
        ),
      ),
    ]),
  );
}

export function projectAuthoringLiteralEvidence(
  project: AuthoringProject,
  occurrence: import('./project-schema/authoring-lua-analysis').AuthoringLiteralOccurrence,
  symbolProjection: ReadonlyMap<
    string,
    readonly AuthoringDependencyNodeKey[]
  > = buildLuaSymbolProjection(project),
): LuaReferenceOccurrence<AuthoringDependencyNodeKey> | null {
  const candidates = symbolProjection.get(occurrence.decodedValue);
  return candidates ? { ...occurrence, confidence: 'lexical', candidateTargets: candidates } : null;
}

export function classifyAuthoringLiteralEvidence(
  project: AuthoringProject,
  occurrence: import('./project-schema/authoring-lua-analysis').AuthoringLiteralOccurrence,
  region: import('./project-schema/authoring-lua-analysis').EmbeddedLuaSourceRegion,
  recognizers: readonly AuthoringSourceReferenceRecognizer[] = AUTHORING_SOURCE_REFERENCE_RECOGNIZERS,
  symbolProjection: ReadonlyMap<
    string,
    readonly AuthoringDependencyNodeKey[]
  > = buildLuaSymbolProjection(project),
) {
  const recognized = classifyRecognizedAuthoringSourceReference(
    { project, occurrence, region },
    recognizers,
  );
  if (recognized) return recognized;
  const lexical = projectAuthoringLiteralEvidence(project, occurrence, symbolProjection);
  return lexical
    ? { classification: 'possible-lexical' as const, occurrence: lexical }
    : { classification: 'unrelated' as const, occurrence };
}

function addLuaEvidenceToContribution(
  project: AuthoringProject,
  base: AuthoringDependencyGraphContribution,
  descriptors: readonly AuthoringLuaSourceDescriptor[],
  analyses: readonly import('./project-schema/authoring-lua-analysis').AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[],
  lexicalEnabled: boolean,
  recognizers: readonly AuthoringSourceReferenceRecognizer[] = AUTHORING_SOURCE_REFERENCE_RECOGNIZERS,
): AuthoringDependencyGraphContribution {
  const edges = [...base.edges];
  const diagnostics = [...base.diagnostics];
  const literals = [...base.literalOccurrences];
  const derivationDependencies = [...base.derivationDependencies];
  const symbolProjection = buildLuaSymbolProjection(project);
  for (const descriptor of descriptors) {
    if (descriptor.sourceAssetId) {
      derivationDependencies.push({ kind: 'source-asset', assetId: descriptor.sourceAssetId });
      if (descriptor.layoutId !== undefined)
        derivationDependencies.push({
          kind: 'source-resolution-asset',
          assetId: descriptor.sourceAssetId,
        });
    }
    const explicitDependencies = (descriptor.explicitDependencies ??
      []) as LuaExplicitDependencyTarget[];
    if (explicitDependencies.length > 0 && !descriptor.supportsExplicitFallback) {
      diagnostics.push({
        severity: 'warning',
        code: 'authoring.lua.unsupported_explicit_fallback_owner',
        path: descriptor.explicitDependenciesPath ?? descriptor.sourcePath,
        message:
          'Additional Lua dependencies are preserved but are not consumed for this authoring location yet.',
      });
      continue;
    }
    const uniqueExplicitDependencies = new Map<string, LuaExplicitDependencyTarget>();
    for (const target of explicitDependencies) {
      const key = serializeLuaExplicitDependencyTarget(target);
      if (uniqueExplicitDependencies.has(key)) {
        diagnostics.push({
          severity: 'error',
          code: 'authoring.lua.duplicate_explicit_fallback',
          path: descriptor.explicitDependenciesPath ?? descriptor.sourcePath,
          message: `Duplicate explicit Lua dependency ${key}.`,
        });
        continue;
      }
      uniqueExplicitDependencies.set(key, target);
    }
    for (const raw of [...uniqueExplicitDependencies.values()].sort((left, right) =>
      serializeLuaExplicitDependencyTarget(left).localeCompare(
        serializeLuaExplicitDependencyTarget(right),
      ),
    )) {
      const evidence = [
        {
          kind: 'explicit-lua-fallback' as const,
          declarationPath: descriptor.explicitDependenciesPath ?? descriptor.sourcePath,
        },
      ];
      if (raw.kind === 'property-value') {
        const propertyTarget = raw;
        const ownerCollection = `${propertyTarget.owner.kind}s` as AuthoringCollectionKey;
        const definitionTarget = propertyDefinitionNodeKey(propertyTarget.propertyId);
        const ownerTarget = recordNodeKey(ownerCollection, propertyTarget.owner.id);
        derivationDependencies.push({
          kind: 'property-resolution',
          ownerCollection,
          ownerId: propertyTarget.owner.id,
          propertyId: propertyTarget.propertyId,
        });
        const detail = {
          propertyId: propertyTarget.propertyId,
          propertyOwnerCollection: ownerCollection,
          propertyOwnerId: propertyTarget.owner.id,
        };
        const previewFacet =
          descriptor.focusedAdmission && descriptor.focusedFacet ? [descriptor.focusedFacet] : [];
        edges.push(
          structuralEdge(
            descriptor.semanticOwner,
            definitionTarget,
            descriptor.sourcePath,
            luaTargetPath(definitionTarget),
            {
              role: 'lua-explicit-reference',
              facets: ['tooling-reference', 'validation', ...previewFacet],
              targetImpactPaths: previewFacet.length > 0 ? [luaTargetPath(definitionTarget)] : [],
              repair: {
                kind: 'blocked',
                reason: 'Explicit Lua dependency fallback must be updated manually.',
              },
              evidence,
              detail,
            },
          ),
          structuralEdge(
            descriptor.semanticOwner,
            ownerTarget,
            descriptor.sourcePath,
            luaTargetPath(ownerTarget),
            {
              role: 'lua-explicit-reference',
              facets: ['tooling-reference', 'validation', ...previewFacet],
              targetImpactPaths:
                previewFacet.length > 0
                  ? propertyResolutionImpactPaths(project, ownerCollection, propertyTarget.owner.id)
                  : [],
              repair: {
                kind: 'blocked',
                reason: 'Explicit Lua dependency fallback must be updated manually.',
              },
              evidence,
              detail,
            },
          ),
        );
        continue;
      }
      const target = explicitTargetNode(raw);
      const facets = luaFacets(descriptor, target, ['tooling-reference', 'validation']);
      edges.push(
        structuralEdge(
          descriptor.semanticOwner,
          target,
          descriptor.sourcePath,
          luaTargetPath(target),
          {
            role: 'lua-explicit-reference',
            facets,
            targetImpactPaths:
              facets.includes('preview-visual') || facets.includes('preview-ui')
                ? focusedQueryTargetImpactPaths(target)
                : [],
            repair: {
              kind: 'blocked',
              reason: 'Explicit Lua dependency fallback must be updated manually.',
            },
            evidence,
          },
        ),
      );
    }
  }
  if (lexicalEnabled) {
    for (const analysis of analyses) {
      for (const sourceAssetId of analysis.sourceAssetIds)
        derivationDependencies.push({ kind: 'source-asset', assetId: sourceAssetId });
      diagnostics.push(...analysis.diagnostics);
      literals.push(...analysis.literalOccurrences);
      for (const occurrence of analysis.literalOccurrences) {
        const region = analysis.regions.find(
          (candidate) =>
            candidate.regionOrdinal === occurrence.regionOrdinal &&
            candidate.sourcePath === occurrence.sourcePath &&
            candidate.sourceUrl === occurrence.sourceUrl,
        );
        if (!region) continue;
        const classified = classifyAuthoringLiteralEvidence(
          project,
          occurrence,
          region,
          recognizers,
          symbolProjection,
        );
        if (classified.classification === 'unrelated') continue;
        const projected =
          classified.occurrence as LuaReferenceOccurrence<AuthoringDependencyNodeKey>;
        const descriptor =
          descriptors.find((item) => item.sourcePath === occurrence.sourcePath) ??
          descriptors.find((item) => item.sourceKind === 'rml' && item.layoutId !== undefined);
        if (!descriptor) continue;
        for (const target of projected.candidateTargets) {
          const exact = classified.classification !== 'possible-lexical';
          const facets = luaFacets(
            descriptor,
            target,
            exact ? ['tooling-reference', 'validation'] : ['validation'],
          );
          edges.push(
            structuralEdge(
              descriptor.semanticOwner,
              target,
              occurrence.sourcePath,
              luaTargetPath(target),
              {
                role: exact ? 'lua-recognized-reference' : 'lua-possible-reference',
                facets,
                targetImpactPaths:
                  facets.includes('preview-visual') || facets.includes('preview-ui')
                    ? focusedQueryTargetImpactPaths(target)
                    : [],
                repair:
                  classified.classification === 'exact-manual'
                    ? {
                        kind: 'blocked',
                        reason: 'Recognized source reference must be updated manually.',
                      }
                    : classified.classification === 'exact-rewriteable'
                      ? {
                          kind: 'warning-only',
                          reason: 'Recognized source reference is safely rewriteable.',
                        }
                      : { kind: 'warning-only', reason: 'Lexical Lua candidate.' },
                evidence: [
                  {
                    kind: 'lua-occurrence',
                    occurrence: projected,
                    classification: classified.classification,
                    ...(classified.recognizedBy ? { recognizedBy: classified.recognizedBy } : {}),
                    ...(classified.rewriteRange ? { rewriteRange: classified.rewriteRange } : {}),
                  },
                ],
              },
            ),
          );
        }
      }
    }
  }
  return {
    ...base,
    edges: Object.freeze(edges),
    diagnostics: Object.freeze(diagnostics),
    derivationDependencies: Object.freeze([
      ...new Map(
        derivationDependencies.map((item) => [
          serializeAuthoringDependencyDerivationDependency(item),
          item,
        ]),
      ).values(),
    ]),
    literalOccurrences: Object.freeze(literals),
  };
}

export function deriveAuthoringDependencyContributionFromPrepared(
  project: AuthoringProject,
  contributionKey: string,
  descriptors: readonly AuthoringLuaSourceDescriptor[],
  analyses: readonly import('./project-schema/authoring-lua-analysis').AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[],
  lexicalEnabled: boolean,
  recognizers: readonly AuthoringSourceReferenceRecognizer[] = AUTHORING_SOURCE_REFERENCE_RECOGNIZERS,
): AuthoringDependencyGraphContribution | null {
  const base = deriveStructuralContributionByKey(project, contributionKey);
  return base
    ? addLuaEvidenceToContribution(
        project,
        base,
        descriptors,
        analyses,
        lexicalEnabled,
        recognizers,
      )
    : null;
}

export function reprojectAuthoringDependencyContributionFromCachedSources(
  project: AuthoringProject,
  contributionKey: string,
  analyses: readonly import('./project-schema/authoring-lua-analysis').AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[],
  recognizers: readonly AuthoringSourceReferenceRecognizer[] = AUTHORING_SOURCE_REFERENCE_RECOGNIZERS,
): AuthoringDependencyGraphContribution | null {
  return deriveAuthoringDependencyContributionFromPrepared(
    project,
    contributionKey,
    collectAuthoringLuaSources(project, new Set([contributionKey])),
    analyses,
    true,
    recognizers,
  );
}

export async function buildAuthoringDependencyGraphContributionSet(
  project: AuthoringProject,
  luaAnalysis: LuaAnalysisInput = { mode: 'disabled' },
  recognizers: readonly AuthoringSourceReferenceRecognizer[] = AUTHORING_SOURCE_REFERENCE_RECOGNIZERS,
): Promise<AuthoringDependencyGraphContributionSet> {
  const descriptorsByKey = new Map<string, AuthoringLuaSourceDescriptor[]>();
  for (const descriptor of collectAuthoringLuaSources(project)) {
    const list = descriptorsByKey.get(descriptor.contributionKey) ?? [];
    list.push(descriptor);
    descriptorsByKey.set(descriptor.contributionKey, list);
  }
  const analyses =
    luaAnalysis.mode === 'enabled'
      ? await analyzeAuthoringSources(project, luaAnalysis.sources)
      : new Map<
          string,
          readonly import('./project-schema/authoring-lua-analysis').AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
        >();
  return createAuthoringDependencyGraphContributionSet(
    enumerateAuthoringDependencyContributionKeys(project).map((contributionKey) => {
      const contribution = deriveAuthoringDependencyContributionFromPrepared(
        project,
        contributionKey,
        descriptorsByKey.get(contributionKey) ?? [],
        analyses.get(contributionKey) ?? [],
        luaAnalysis.mode === 'enabled',
        recognizers,
      );
      if (!contribution)
        throw new Error(`Unable to derive graph contribution '${contributionKey}'.`);
      return contribution;
    }),
  );
}

export async function buildAuthoringDependencyGraph(
  project: AuthoringProject,
  luaAnalysis: LuaAnalysisInput = { mode: 'disabled' },
  recognizers: readonly AuthoringSourceReferenceRecognizer[] = AUTHORING_SOURCE_REFERENCE_RECOGNIZERS,
): Promise<AuthoringDependencyGraph> {
  return assembleAuthoringDependencyGraph(
    await buildAuthoringDependencyGraphContributionSet(project, luaAnalysis, recognizers),
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
  family: 'room-placement' | 'room-exit' | 'room-hotspot' | 'interactable-hotspot',
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

function incomingPlacementSourceImpactPaths(edge: AuthoringDependencyEdge): readonly JsonPointer[] {
  if (edge.source.kind !== 'record') return [];
  if (edge.role === 'character-room-placement') {
    return recordImpactPaths(edge.source, [
      '/data/initialWorldState',
      '/data/defaults',
      '/data/poses',
      '/data/expressions',
      '/data/idles',
    ]);
  }
  if (edge.role === 'interactable-room-placement') {
    return recordImpactPaths(edge.source, ['/data/initialState', '/data/presentation']);
  }
  return [];
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

    if (current.key.kind === 'nested' && current.key.family === 'room-placement') {
      for (const edge of incomingAuthoringDependencies(graph, currentKey, filter)) {
        if (
          edge.role !== 'character-room-placement' &&
          edge.role !== 'interactable-room-placement'
        ) {
          continue;
        }
        if (changedPathOverlapsAny(changedPaths, incomingPlacementSourceImpactPaths(edge))) {
          return true;
        }
        const sourceKey = serializeAuthoringDependencyNodeKey(edge.source);
        if (!visited.has(sourceKey)) pending.push(sourceKey);
      }
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
