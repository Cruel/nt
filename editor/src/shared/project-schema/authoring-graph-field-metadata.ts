import type {
  AuthoringFieldGraphEffect,
  AuthoringGraphInputClassification,
} from '../authoring-dependency-contracts';
import { parseJsonPointer, type JsonPointer } from '../json-pointer';
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

type ReviewedFieldEffectCode = 'n' | 'o' | 's' | 'y' | 't' | 'a' | 'l' | 'p' | 'v';

// One explicitly reviewed effect code for every sorted schema leaf. The shape fingerprints below
// pin the leaf ordering. There is deliberately no inferred leaf-name rule and no implicit `none`.
// n=none, o=owner, s=source, y=symbol, t=structural, a=asset reverse impact,
// l=localization reverse impact, p=property assignment, v=structural variant.
const REVIEWED_FIELD_EFFECT_CODES =
  'nnaanannnnnnannyonnnnnnnnonoonoonnonnnnvoonnnnonoonnnoonoyopooonnsssssssssvnsnoonsnooonnnsoonnssssss' +
  'sssovsnnonnoooonnsssssssssvnsnoonsnoooonnsssssssssovsnnoonnnnoyopoonnnnoooonoyopnsssssssssvnsnoonooo' +
  'oonoooonoooonsnoonooonnsssssssssovsnoonoonnoonoyopoooooooooooonnnoonsnnnoonnoonsnnnnsssssssssnnnnyol' +
  'yyooooononsssssssssovsnnnoonnnnoonoonsssssssssovsnnoyoponnnnnnnoonnoonnnnnnnnnnyonnnnnnnnyonnnnoonno' +
  'ooosssssssssvnsnoononnonnsssssssssoonsssssssssovsnnoonnnnnsssssssssvnsnooooonnnnnnsssssssssvnsnoonon' +
  'oonnnnsssssssssvnsnoonooononnnsnoonsnoonsnoonsnoosssssssssnnsnoosssssssssnnsnoosssssssssvnsnooooonnn' +
  'nnnonnsssssssssovsnoooosssssssssvnsnooooononnoyopoooonnoooonnnoonsssssssssvnsnoooonoonoooonnnooooonn' +
  'nnnnnnnnnsssssssssvnsnoooonnnnononoonoonnnsssssssssvnsnoonsnooonsssssssssovsnonnnsssssssssovsnnnnnnn' +
  'soonnnsssssssssovsnnnnnoonnnnnoyopnnnoovsnyonnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn' +
  'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnoonnnnnnoooooooooooooooooonnoonoonnnnnnoonnnnnnnnnnnnnnnyossnoonsnn' +
  'nnoonoonnonnnnoosnnnosnnnnnnoooooonoooooonoonnnnnyonnnnnnyonsssssssssovsnnsssssssssnnsnoooooonsnoono' +
  'oonnsssssssssovssnoonoonnnnnnoyop';

const ACTIVE_REVIEWED_FIELD_EFFECT_CODES = REVIEWED_FIELD_EFFECT_CODES;

const EXPLICIT_FIELD_EFFECTS: readonly [RegExp, AuthoringFieldGraphEffect][] = Object.freeze([
  [/^\/assets\/\*\/data\/imageMetadata\//, OWNER],
  [/^\/interactables\/\*\/data\/presentation\/hotspots\//, OWNER],
  [/^\/interactions\/\*\/data\/rules\/\*\/context\/hotspot\//, OWNER],
  [/^\/rooms\/\*\/data\/hotspots\//, OWNER],
  [/^\/tests\/\*\/data\/steps\/\*\/activateHotspot\/hotspot\//, OWNER],
  [/^\/shaders\/\*\/data\/samplers\/\*\/binding$/, OWNER],
]);

function explicitFieldEffect(path: JsonPointer): AuthoringFieldGraphEffect | undefined {
  return EXPLICIT_FIELD_EFFECTS.find(([pattern]) => pattern.test(path))?.[1];
}

function reviewedFieldEffect(
  code: string | undefined,
  path: JsonPointer,
): AuthoringFieldGraphEffect {
  switch (code as ReviewedFieldEffectCode | undefined) {
    case 'n':
      return NONE;
    case 'o':
      return OWNER;
    case 's':
      return SOURCE;
    case 'y':
      return SYMBOL;
    case 't':
      return Object.freeze({ kind: 'structural' });
    case 'a':
      return valueDependent('asset-source-impact');
    case 'l':
      return valueDependent('localization-catalog-entry');
    case 'p':
      return valueDependent('property-assignment');
    case 'v':
      return valueDependent('structural-variant');
    default:
      throw new Error(`Authoring graph field '${path}' has no reviewed effect declaration.`);
  }
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
const sortedSchemaLeafPaths = [...schemaLeafPaths].sort();
const explicitLeafCount = sortedSchemaLeafPaths.filter((path) => explicitFieldEffect(path)).length;
if (
  ACTIVE_REVIEWED_FIELD_EFFECT_CODES.length + explicitLeafCount !==
  sortedSchemaLeafPaths.length
) {
  throw new Error(
    `Authoring graph field effect declarations changed: expected ${ACTIVE_REVIEWED_FIELD_EFFECT_CODES.length + explicitLeafCount} schema leaves, received ${sortedSchemaLeafPaths.length}. Review every leaf and update the declaration sequence.`,
  );
}

export const AUTHORING_GRAPH_FIELD_METADATA: readonly AuthoringGraphFieldMetadata[] = Object.freeze(
  (() => {
    let reviewedIndex = 0;
    return sortedSchemaLeafPaths.map((path) => {
      const explicitEffect = explicitFieldEffect(path);
      const effect =
        explicitEffect ??
        reviewedFieldEffect(ACTIVE_REVIEWED_FIELD_EFFECT_CODES[reviewedIndex++], path);
      return Object.freeze({ path, effect, schemaRoot: schemaRootForPath(path) });
    });
  })(),
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
    assets: 'e718127a',
    characters: '249ac48b',
    dialogues: 'e674338a',
    entrypoint: 'a61673d4',
    interactables: '9e7a7329',
    interactions: '42041028',
    layouts: '87e0b859',
    localization: '3f6d0d11',
    maps: '67896f92',
    materials: '546711ca',
    project: 'da3be83d',
    properties: '1ff9b7f3',
    rooms: '075a2c6a',
    scenes: 'd05f7981',
    schema: '63fb9bb9',
    schemaVersion: '4b5325a3',
    scripts: 'f3482815',
    settings: '88ac0f8d',
    shaders: '94d3aa6e',
    startupHook: '4fa45604',
    tests: '2dead819',
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
