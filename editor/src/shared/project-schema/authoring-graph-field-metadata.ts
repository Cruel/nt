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

interface IndexedField {
  readonly field: AuthoringGraphFieldMetadata;
  readonly segments: readonly string[];
}

const fieldsByRoot = new Map<string, AuthoringGraphFieldMetadata[]>();
for (const field of AUTHORING_GRAPH_FIELD_METADATA) {
  const fields = fieldsByRoot.get(field.schemaRoot) ?? [];
  fields.push(field);
  fieldsByRoot.set(field.schemaRoot, fields);
}
const indexesByRoot = new Map<string, ReadonlyMap<number, readonly IndexedField[]>>();

function rootIndex(root: string): ReadonlyMap<number, readonly IndexedField[]> {
  const cached = indexesByRoot.get(root);
  if (cached) return cached;
  // Only parse roots that are queried; cold CLI startup needs no field lookup.
  const byDepth = new Map<number, IndexedField[]>();
  for (const field of fieldsByRoot.get(root) ?? []) {
    const segments = parseJsonPointer(field.path);
    const fields = byDepth.get(segments.length) ?? [];
    fields.push({ field, segments });
    byDepth.set(segments.length, fields);
  }
  indexesByRoot.set(root, byDepth);
  return byDepth;
}

export function classifyAuthoringGraphInputPath(
  path: JsonPointer,
): AuthoringGraphInputClassification | undefined {
  const segments = parseJsonPointer(path);
  if (segments.length === 0)
    return Object.freeze({ path, effect: { kind: 'structural' as const } });
  const matches = (field: IndexedField) =>
    segments.every(
      (segment, index) => field.segments[index] === '*' || field.segments[index] === segment,
    );
  const index = rootIndex(segments[0] ?? '');
  const direct = index.get(segments.length)?.find(matches);
  if (direct) return Object.freeze({ path, effect: direct.field.effect });
  for (const [depth, fields] of index)
    if (depth > segments.length && fields.some(matches))
      return Object.freeze({ path, effect: { kind: 'structural' as const } });
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
