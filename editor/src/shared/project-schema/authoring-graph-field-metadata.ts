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

function collectSchemaLeafPaths(schema: unknown, output: Set<JsonPointer>): void {
  // Keep this iterative so deeply composed schema graphs do not depend on host recursion depth.
  const pending: Array<{
    schema: unknown;
    path: readonly string[];
    ancestors: ReadonlySet<unknown>;
  }> = [{ schema, path: [], ancestors: new Set() }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;

    if (current.ancestors.has(current.schema)) {
      output.add(`/${current.path.join('/')}`);
      continue;
    }

    const nextAncestors = new Set(current.ancestors);
    nextAncestors.add(current.schema);
    const definition = schemaDefinition(current.schema);
    if (!definition) {
      output.add(`/${current.path.join('/')}`);
      continue;
    }

    if (definition.type === 'object' && definition.shape) {
      for (const key of Object.keys(definition.shape)) {
        if (current.path.length === 0 && key === 'editor') continue;
        pending.push({
          schema: definition.shape[key],
          path: [...current.path, key],
          ancestors: nextAncestors,
        });
      }
      continue;
    }
    if (definition.type === 'array' && definition.element) {
      pending.push({
        schema: definition.element,
        path: [...current.path, '*'],
        ancestors: nextAncestors,
      });
      continue;
    }
    if (definition.type === 'record' && definition.valueType) {
      pending.push({
        schema: definition.valueType,
        path: [...current.path, '*'],
        ancestors: nextAncestors,
      });
      continue;
    }
    if (definition.type === 'union' && definition.options) {
      for (const option of definition.options) {
        pending.push({ schema: option, path: current.path, ancestors: nextAncestors });
      }
      continue;
    }
    if (definition.type === 'tuple' && definition.items) {
      for (const item of definition.items) {
        pending.push({ schema: item, path: [...current.path, '*'], ancestors: nextAncestors });
      }
      continue;
    }
    if (definition.type === 'intersection' && definition.left && definition.right) {
      pending.push({ schema: definition.left, path: current.path, ancestors: nextAncestors });
      pending.push({ schema: definition.right, path: current.path, ancestors: nextAncestors });
      continue;
    }
    if (definition.innerType) {
      pending.push({ schema: definition.innerType, path: current.path, ancestors: nextAncestors });
      continue;
    }
    if (definition.getter) {
      pending.push({ schema: definition.getter(), path: current.path, ancestors: nextAncestors });
      continue;
    }
    output.add(`/${current.path.join('/')}`);
  }
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
  'yyooooononsssssssssovsnnnoonnnnoonoonsssssssssovsnnoyoponnnnnnnoonnoonnnnnnnnnnyonnnnnnnnyonnnoonno' +
  'ooosssssssssvnsnoononnonnsssssssssoonsssssssssovsnnoonnnnnsssssssssvnsnooooonnnnnnsssssssssvnsnoonon' +
  'oonnnnsssssssssvnsnoonooononnnsnoonsnoonsnoonsnoosssssssssnnsnoosssssssssnnsnoosssssssssvnsnooooonnn' +
  'nnnonnsssssssssovsnoooosssssssssvnsnooooononnoyopoooonnoooonnnoonsssssssssvnsnoooonoonoooonnnooooonn' +
  'nnnnnnnnnsssssssssvnsnoooonnnnononoonoonnnsssssssssvnsnoonsnooonsssssssssovsnonnnsssssssssovsnnnnnnn' +
  'soonnnsssssssssovsnnnnnoonnnnnoyopnnnoovsnyonnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn' +
  'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnoonnnnnnoooooooooooooooooonnoonoonnnnnnoonnnnnnnnnnnnnnnyossnoonsnn' +
  'nnoonoonnonnnnoosnnnosnnnnnnoooooonoooooonoonnnnnyonnnnnnyonsssssssssovsnnsssssssssnnsnoooooonsnoono' +
  'oonnsssssssssovssnoonoonnnnnnoyop';

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
collectSchemaLeafPaths(authoringProjectSchema, schemaLeafPaths);
const sortedSchemaLeafPaths = [...schemaLeafPaths].sort();

// Export configuration moved from /settings/{export,platformExport} to /export. It has no
// dependency-graph effect, but the reviewed code sequence predates that top-level reclassification.
// Relocate the old export-config code block to the new schema position and normalize it to `none` so
// unrelated field classifications retain their reviewed alignment.
const exportLeafCount = sortedSchemaLeafPaths.filter((path) => path.startsWith('/export/')).length;
const retiredExportLeafCount = 2; // capabilityOverrides and signingProfileId
const legacyExportLeafCount = exportLeafCount + retiredExportLeafCount;
const exportFirstLeafIndex = sortedSchemaLeafPaths.findIndex((path) => path.startsWith('/export/'));
const settingsPresentationLeafIndex = sortedSchemaLeafPaths.findIndex((path) =>
  path.startsWith('/settings/presentation/'),
);
const reviewedCountBefore = (leafIndex: number) =>
  sortedSchemaLeafPaths.slice(0, leafIndex).filter((path) => !explicitFieldEffect(path)).length;
const exportInsertReviewedIndex = reviewedCountBefore(exportFirstLeafIndex);
const legacyExportReviewedIndex =
  reviewedCountBefore(settingsPresentationLeafIndex) - legacyExportLeafCount;
const reviewedWithoutLegacyExport =
  REVIEWED_FIELD_EFFECT_CODES.slice(0, legacyExportReviewedIndex) +
  REVIEWED_FIELD_EFFECT_CODES.slice(legacyExportReviewedIndex + legacyExportLeafCount);
const PRE_TRAIT_REVIEWED_FIELD_EFFECT_CODES =
  reviewedWithoutLegacyExport.slice(0, exportInsertReviewedIndex) +
  'n'.repeat(exportLeafCount) +
  reviewedWithoutLegacyExport.slice(exportInsertReviewedIndex);

// #68 replaces the universal same-type `extends` leaf on Property-bearing records with a Trait
// attachment array and adds top-level Trait declarations. Preserve every previously reviewed field
// effect by path, then classify only the new Trait leaves explicitly as owner contributions. This is
// deliberately a one-time atomic contract replacement at the already-selected authoring version.
const legacyTraitBearingRoots = new Set([
  'characters',
  'dialogues',
  'interactables',
  'interactions',
  'maps',
  'rooms',
  'scenes',
  'verbs',
]);
const retiredPropertyBearingRoots = [
  'dialogues',
  'interactions',
  'maps',
  'scenes',
  'verbs',
] as const;
const legacySchemaLeafPaths = [
  ...sortedSchemaLeafPaths
    .filter((path) => !path.startsWith('/traits/'))
    .map((path) => {
      const segments = parseJsonPointer(path);
      return segments.length === 4 &&
        legacyTraitBearingRoots.has(segments[0] ?? '') &&
        segments[1] === '*' &&
        segments[2] === 'traits' &&
        segments[3] === '*'
        ? (`/${segments[0]}/*/extends` as JsonPointer)
        : path;
    }),
  ...retiredPropertyBearingRoots.flatMap((root) => [
    `/${root}/*/extends` as JsonPointer,
    `/${root}/*/properties/*` as JsonPointer,
  ]),
].sort();
const legacyReviewedPaths = legacySchemaLeafPaths.filter((path) => !explicitFieldEffect(path));
if (legacyReviewedPaths.length !== PRE_TRAIT_REVIEWED_FIELD_EFFECT_CODES.length) {
  throw new Error(
    `Authoring graph Trait contract replacement changed the legacy reviewed leaf set: expected ${PRE_TRAIT_REVIEWED_FIELD_EFFECT_CODES.length}, received ${legacyReviewedPaths.length}.`,
  );
}
const legacyReviewedEffects = new Map(
  legacyReviewedPaths.map(
    (path, index) => [path, PRE_TRAIT_REVIEWED_FIELD_EFFECT_CODES[index]!] as const,
  ),
);
const ACTIVE_REVIEWED_FIELD_EFFECT_CODES = sortedSchemaLeafPaths
  .filter((path) => !explicitFieldEffect(path))
  .map((path) => {
    if (path.startsWith('/traits/')) return 'o';
    const segments = parseJsonPointer(path);
    if (
      segments.length === 4 &&
      legacyTraitBearingRoots.has(segments[0] ?? '') &&
      segments[1] === '*' &&
      segments[2] === 'traits' &&
      segments[3] === '*'
    )
      return 'o';
    const preserved = legacyReviewedEffects.get(path);
    if (!preserved)
      throw new Error(
        `Authoring graph field '${path}' has no preserved pre-Trait effect declaration.`,
      );
    return preserved;
  })
  .join('');

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
    characters: 'f9e51e22',
    dialogues: 'bfadec81',
    entrypoint: 'a61673d4',
    export: 'b9fd529f',
    interactables: 'c2651b54',
    interactions: '27039017',
    layouts: '87e0b859',
    localization: '3f6d0d11',
    maps: '9b969995',
    materials: '546711ca',
    project: 'da3be83d',
    properties: 'c35941e2',
    rooms: 'ccd353f5',
    scenes: '911d4458',
    schema: '63fb9bb9',
    schemaVersion: '4b5325a3',
    scripts: 'f3482815',
    settings: 'faa09891',
    shaders: '94d3aa6e',
    startupHook: '4fa45604',
    tests: '2dead819',
    traits: 'e06af863',
    variables: '9ac2af8d',
    verbs: 'b5afbce6',
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
