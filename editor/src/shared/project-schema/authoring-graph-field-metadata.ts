import type {
  AuthoringFieldGraphEffect,
  AuthoringGraphInputClassification,
} from '../authoring-dependency-contracts';
import { parseJsonPointer, type JsonPointer } from '../json-pointer';
import {
  GRAPH_FIELD_PATHS,
  GRAPH_FIELD_EFFECT_CODES,
  GENERATED_GRAPH_FIELD_FINGERPRINTS,
  REVIEWED_GRAPH_FIELD_FINGERPRINTS,
} from './authoring-graph-field-metadata.generated';

export interface AuthoringGraphFieldMetadata extends AuthoringGraphInputClassification {
  schemaRoot: string;
}

// The reviewed schema walk is intentionally performed by
// scripts/generate-authoring-graph-field-metadata.mjs, not during CLI startup.
// All entries and their order are checked against the live Zod schema at build time.
const effects: Readonly<Record<string, AuthoringFieldGraphEffect>> = Object.freeze({
  n: Object.freeze({ kind: 'none' }),
  o: Object.freeze({ kind: 'owner-contribution' }),
  s: Object.freeze({ kind: 'source-analysis' }),
  y: Object.freeze({ kind: 'symbol-definition' }),
  t: Object.freeze({ kind: 'structural' }),
  a: Object.freeze({ kind: 'value-dependent', classify: 'asset-source-impact' }),
  l: Object.freeze({ kind: 'value-dependent', classify: 'localization-catalog-entry' }),
  p: Object.freeze({ kind: 'value-dependent', classify: 'property-assignment' }),
  v: Object.freeze({ kind: 'value-dependent', classify: 'structural-variant' }),
});

export const AUTHORING_GRAPH_FIELD_METADATA: readonly AuthoringGraphFieldMetadata[] = Object.freeze(
  GRAPH_FIELD_PATHS.map((path, index) => {
    const effect = effects[GRAPH_FIELD_EFFECT_CODES[index]!];
    if (!effect) throw new Error(`Missing generated graph field effect for '${path}'.`);
    return Object.freeze({
      path: path as JsonPointer,
      effect,
      schemaRoot: path.split('/')[1] ?? '',
    });
  }),
);

export const CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS: Readonly<Record<string, string>> =
  GENERATED_GRAPH_FIELD_FINGERPRINTS;
export const EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS: Readonly<Record<string, string>> =
  REVIEWED_GRAPH_FIELD_FINGERPRINTS;

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
