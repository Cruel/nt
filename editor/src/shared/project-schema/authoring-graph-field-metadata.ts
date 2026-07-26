import type {
  AuthoringFieldGraphEffect,
  AuthoringGraphInputClassification,
} from '../authoring-dependency-contracts';
import { parseJsonPointer, type JsonPointer } from '../json-pointer';
import { authoringCollectionKeys, type AuthoringCollectionKey } from './authoring-collections';
import { authoringProjectSchema } from './authoring-project';

interface ZodDefinition {
  type?: string;
  shape?: Record<string, unknown>;
  element?: unknown;
  valueType?: unknown;
  options?: readonly unknown[];
  items?: readonly unknown[];
  innerType?: unknown;
  left?: unknown;
  right?: unknown;
  getter?: () => unknown;
}
export interface AuthoringGraphFieldMetadata extends AuthoringGraphInputClassification {
  schemaRoot: string;
}

const NONE = Object.freeze({ kind: 'none' } as const);
const OWNER = Object.freeze({ kind: 'owner-contribution' } as const);
const SOURCE = Object.freeze({ kind: 'source-analysis' } as const);
const SYMBOL = Object.freeze({ kind: 'symbol-definition' } as const);

function valueDependent(classify: string): AuthoringFieldGraphEffect {
  return Object.freeze({ kind: 'value-dependent', classify });
}

function schemaDefinition(schema: unknown): ZodDefinition | undefined {
  return (schema as { _zod?: { def?: ZodDefinition } })._zod?.def;
}

function collectSchemaLeafPaths(
  schema: unknown,
  path: readonly string[],
  output: Set<JsonPointer>,
  ancestors: ReadonlySet<unknown> = new Set(),
): void {
  if (ancestors.has(schema)) {
    output.add(`/${path.join('/')}`);
    return;
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(schema);
  const definition = schemaDefinition(schema);
  if (!definition) {
    output.add(`/${path.join('/')}`);
    return;
  }
  if (definition.type === 'object' && definition.shape) {
    for (const [key, child] of Object.entries(definition.shape)) {
      if (path.length === 0 && key === 'editor') continue;
      collectSchemaLeafPaths(child, [...path, key], output, nextAncestors);
    }
    return;
  }
  if (definition.type === 'array' && definition.element) {
    collectSchemaLeafPaths(definition.element, [...path, '*'], output, nextAncestors);
    return;
  }
  if (definition.type === 'record' && definition.valueType) {
    collectSchemaLeafPaths(definition.valueType, [...path, '*'], output, nextAncestors);
    return;
  }
  if (definition.type === 'union' && definition.options) {
    definition.options.forEach((option) =>
      collectSchemaLeafPaths(option, path, output, nextAncestors),
    );
    return;
  }
  if (definition.type === 'tuple' && definition.items) {
    definition.items.forEach((item) =>
      collectSchemaLeafPaths(item, [...path, '*'], output, nextAncestors),
    );
    return;
  }
  if (definition.type === 'intersection' && definition.left && definition.right) {
    collectSchemaLeafPaths(definition.left, path, output, nextAncestors);
    collectSchemaLeafPaths(definition.right, path, output, nextAncestors);
    return;
  }
  if (definition.innerType) {
    collectSchemaLeafPaths(definition.innerType, path, output, nextAncestors);
    return;
  }
  if (definition.getter) {
    collectSchemaLeafPaths(definition.getter(), path, output, nextAncestors);
    return;
  }
  output.add(`/${path.join('/')}`);
}

function schemaRootForPath(path: JsonPointer): string {
  return parseJsonPointer(path)[0] ?? '';
}

function recordPathEffect(
  path: JsonPointer,
  collection: AuthoringCollectionKey,
): AuthoringFieldGraphEffect {
  const segments = parseJsonPointer(path);
  const relative = segments.slice(2);
  const relativePath = `/${relative.join('/')}`;
  const leaf = relative.at(-1) ?? '';

  if (relativePath === '/id') return SYMBOL;
  if (relativePath === '/label') return OWNER;
  if (relativePath === '/description') return NONE;
  if (relativePath === '/extends') return OWNER;
  if (relativePath.startsWith('/properties/')) {
    return valueDependent('property-assignment');
  }

  if (relative.includes('$ref') || relative.includes('$var')) return OWNER;
  if (relative.includes('additionalDependencies')) return SOURCE;
  if (
    leaf === 'initScript' ||
    leaf === 'checkScript' ||
    leaf === 'sourceText' ||
    (leaf === 'source' &&
      !relativePath.endsWith('/data/source') &&
      !relativePath.endsWith('/source/path'))
  ) {
    return SOURCE;
  }
  if (
    relativePath.includes('/source/key') ||
    relativePath.endsWith('/continuation/id') ||
    relativePath.endsWith('/continuation/kind') ||
    relativePath.endsWith('/completion/id') ||
    relativePath.endsWith('/completion/kind')
  ) {
    return OWNER;
  }
  if (
    leaf === 'targetStepId' ||
    leaf === 'fallbackStepId' ||
    leaf === 'entryBlockId' ||
    leaf === 'targetBlockId' ||
    leaf === 'fromBlockId' ||
    leaf === 'toBlockId' ||
    leaf === 'sourceLocation' ||
    leaf === 'targetLocation' ||
    leaf === 'placementId' ||
    leaf === 'exitId'
  ) {
    return OWNER;
  }
  if (
    (leaf === 'room' || leaf === 'placement' || leaf === 'exit') &&
    (relative.includes('location') ||
      relative.includes('placement') ||
      relative.includes('target') ||
      relative.includes('context') ||
      relative.includes('connections'))
  ) {
    return OWNER;
  }
  if (leaf === 'id' && relative.includes('*')) return OWNER;
  if (collection === 'materials' && leaf === 'baseMaterialId') return OWNER;
  if (
    collection === 'assets' &&
    (relativePath === '/data/source/path' ||
      relativePath === '/data/contentHash' ||
      relativePath === '/data/kind')
  ) {
    return valueDependent('asset-source-impact');
  }
  if (
    leaf === 'kind' &&
    (relative.includes('source') ||
      relative.includes('condition') ||
      relative.includes('location') ||
      relative.includes('completion') ||
      relative.includes('continuation'))
  ) {
    return valueDependent('structural-variant');
  }
  return NONE;
}

function projectPathEffect(path: JsonPointer): AuthoringFieldGraphEffect {
  const segments = parseJsonPointer(path);
  const [root] = segments;
  if (authoringCollectionKeys.includes(root as AuthoringCollectionKey)) {
    return recordPathEffect(path, root as AuthoringCollectionKey);
  }
  if (root === 'startupHook') return SOURCE;
  if (root === 'entrypoint') return OWNER;
  if (root === 'properties') {
    if (segments.length <= 2) return Object.freeze({ kind: 'structural' });
    if (segments[2] === 'id') return SYMBOL;
    if (segments[2] === 'label') return OWNER;
    return NONE;
  }
  if (root === 'localization') {
    if (segments[1] === 'defaultLocale' || segments[1] === 'fallbackLocale') return SYMBOL;
    if (segments[1] === 'catalogs') return valueDependent('localization-catalog-entry');
    return NONE;
  }
  if (root === 'settings') {
    if (segments[1] === 'text' && segments[2] === 'defaultFont') return OWNER;
    if (segments[1] === 'ui' && segments[2] === 'systemLayouts') return OWNER;
    return NONE;
  }
  return NONE;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const schemaLeafPaths = new Set<JsonPointer>();
collectSchemaLeafPaths(authoringProjectSchema, [], schemaLeafPaths);

export const AUTHORING_GRAPH_FIELD_METADATA: readonly AuthoringGraphFieldMetadata[] = Object.freeze(
  [...schemaLeafPaths]
    .sort()
    .map((path) =>
      Object.freeze({ path, effect: projectPathEffect(path), schemaRoot: schemaRootForPath(path) }),
    ),
);

export const CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      [...new Set(AUTHORING_GRAPH_FIELD_METADATA.map((field) => field.schemaRoot))]
        .sort()
        .map((root) => [
          root,
          fnv1a(
            AUTHORING_GRAPH_FIELD_METADATA.filter((field) => field.schemaRoot === root)
              .map((field) => field.path)
              .join('\n'),
          ),
        ]),
    ),
  );

// Changing an authoring schema field requires reviewing its intrinsic graph effect and updating the
// corresponding fingerprint in the same change. This intentionally has no generated fallback.
export const EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS: Readonly<Record<string, string>> =
  Object.freeze({
    assets: '308ff406',
    characters: '249ac48b',
    dialogues: 'e674338a',
    entrypoint: 'a61673d4',
    interactables: '9b8092c2',
    interactions: '88147a4a',
    layouts: '87e0b859',
    localization: '3f6d0d11',
    maps: '67896f92',
    materials: '546711ca',
    project: 'da3be83d',
    properties: '1ff9b7f3',
    rooms: 'd3845edc',
    scenes: 'd05f7981',
    schema: '63fb9bb9',
    schemaVersion: '4b5325a3',
    scripts: 'f3482815',
    settings: '88ac0f8d',
    shaders: '63e6cbf8',
    startupHook: '4fa45604',
    tests: 'c4de6b91',
    variables: '9ac2af8d',
    verbs: 'f605dc9b',
  });

function patternSegmentMatches(pattern: string, actual: string): boolean {
  return pattern === '*' || pattern === actual;
}

function patternMatchesConcretePath(pattern: JsonPointer, path: JsonPointer): boolean {
  const patternSegments = parseJsonPointer(pattern);
  const pathSegments = parseJsonPointer(path);
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, index) =>
    patternSegmentMatches(segment, pathSegments[index]!),
  );
}

function concretePathIsSchemaAncestor(path: JsonPointer, pattern: JsonPointer): boolean {
  const pathSegments = parseJsonPointer(path);
  const patternSegments = parseJsonPointer(pattern);
  if (pathSegments.length >= patternSegments.length) return false;
  return pathSegments.every((segment, index) =>
    patternSegmentMatches(patternSegments[index]!, segment),
  );
}

export function classifyAuthoringGraphInputPath(
  path: JsonPointer,
): AuthoringGraphInputClassification | undefined {
  const direct = AUTHORING_GRAPH_FIELD_METADATA.filter((field) =>
    patternMatchesConcretePath(field.path, path),
  ).sort(
    (left, right) => parseJsonPointer(right.path).length - parseJsonPointer(left.path).length,
  )[0];
  if (direct) return Object.freeze({ path, effect: direct.effect });
  if (
    AUTHORING_GRAPH_FIELD_METADATA.some((field) => concretePathIsSchemaAncestor(path, field.path))
  ) {
    return Object.freeze({ path, effect: { kind: 'structural' as const } });
  }
  return undefined;
}
export function assertAuthoringGraphFieldMetadataComplete(): void {
  const expectedRoots = Object.keys(EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS).sort();
  const currentRoots = Object.keys(CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS).sort();
  if (JSON.stringify(expectedRoots) !== JSON.stringify(currentRoots)) {
    throw new Error(
      `Authoring graph field metadata roots changed. Expected ${JSON.stringify(expectedRoots)}, received ${JSON.stringify(currentRoots)}.`,
    );
  }
  for (const root of currentRoots) {
    const expected = EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS[root];
    const current = CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS[root];
    if (expected !== current) {
      throw new Error(
        `Authoring graph field metadata for '${root}' changed: expected ${expected}, received ${current}. Review every new or removed field effect and update the fingerprint.`,
      );
    }
  }
}
