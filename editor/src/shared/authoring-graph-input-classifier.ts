import type {
  AuthoringDependencyGraphMutationImpact,
  AuthoringFieldGraphEffect,
} from './authoring-dependency-contracts';
import { parseJsonPointer, type JsonPointer } from './json-pointer';
import { authoringCollectionKeys } from './project-schema/authoring-collections';
import { classifyAuthoringGraphInputPath } from './project-schema/authoring-graph-field-metadata';

export interface AuthoringGraphInputClassifierIndexes {
  contributionKeysByOwnerPath?: ReadonlyMap<JsonPointer, readonly string[]>;
  contributionKeysByDerivationKey?: ReadonlyMap<string, readonly string[]>;
}

function sorted(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort((a, b) => a.localeCompare(b)));
}

function ownerPathFor(path: JsonPointer): JsonPointer | undefined {
  const segments = parseJsonPointer(path);
  const root = segments[0];
  if (root && authoringCollectionKeys.includes(root as (typeof authoringCollectionKeys)[number])) {
    return segments[1] === undefined
      ? (`/${root}` as JsonPointer)
      : (`/${root}/${segments[1]}` as JsonPointer);
  }
  if (root === 'properties')
    return segments[1] ? (`/properties/${segments[1]}` as JsonPointer) : '/properties';
  if (root === 'localization') return '/localization';
  if (root) return `/${root}` as JsonPointer;
  return undefined;
}

function impactForEffect(
  path: JsonPointer,
  effect: AuthoringFieldGraphEffect,
  indexes: AuthoringGraphInputClassifierIndexes,
): AuthoringDependencyGraphMutationImpact {
  if (effect.kind === 'none') return { kind: 'graph-stable' };
  const ownerPath = ownerPathFor(path);
  if (!ownerPath) return { kind: 'full-rebuild', reason: 'root-change' };
  const ownerKeys = indexes.contributionKeysByOwnerPath?.get(ownerPath);
  if (!ownerKeys) return { kind: 'full-rebuild', reason: 'classifier-fallback' };
  if (effect.kind === 'source-analysis') {
    return {
      kind: 'incremental',
      contributionKeys: sorted(ownerKeys),
      sourceAnalysisOwnerKeys: sorted(ownerKeys),
      symbolProjectionOwnerKeys: [],
    };
  }
  if (effect.kind === 'symbol-definition') {
    return {
      kind: 'incremental',
      contributionKeys: sorted(ownerKeys),
      sourceAnalysisOwnerKeys: [],
      symbolProjectionOwnerKeys: sorted(ownerKeys),
    };
  }
  return {
    kind: 'incremental',
    contributionKeys: sorted(ownerKeys),
    sourceAnalysisOwnerKeys: [],
    symbolProjectionOwnerKeys: [],
  };
}

export function classifyAuthoringGraphMutation(
  affectedPaths: readonly JsonPointer[],
  indexes: AuthoringGraphInputClassifierIndexes,
): AuthoringDependencyGraphMutationImpact {
  const impacts = affectedPaths.map((path) => {
    if (path === '/') return { kind: 'full-rebuild', reason: 'root-change' } as const;
    const classification = classifyAuthoringGraphInputPath(path);
    return classification
      ? impactForEffect(path, classification.effect, indexes)
      : ({ kind: 'full-rebuild', reason: 'classifier-fallback' } as const);
  });
  const fallback = impacts.find((impact) => impact.kind === 'full-rebuild');
  if (fallback) return fallback;
  const incremental = impacts.filter((impact) => impact.kind === 'incremental');
  if (incremental.length === 0) return { kind: 'graph-stable' };
  return {
    kind: 'incremental',
    contributionKeys: sorted(incremental.flatMap((impact) => impact.contributionKeys)),
    sourceAnalysisOwnerKeys: sorted(
      incremental.flatMap((impact) => impact.sourceAnalysisOwnerKeys),
    ),
    symbolProjectionOwnerKeys: sorted(
      incremental.flatMap((impact) => impact.symbolProjectionOwnerKeys),
    ),
  };
}

export function classifyAssetReverseDependencies(
  assetId: string,
  changedLeaf: 'path' | 'kind' | 'extension' | 'contentHash' | 'read',
  indexes: AuthoringGraphInputClassifierIndexes,
): readonly string[] | null {
  const dependencyKind =
    changedLeaf === 'contentHash' || changedLeaf === 'read'
      ? 'source-asset'
      : 'source-resolution-asset';
  const key = JSON.stringify([dependencyKind, assetId]);
  const owners = indexes.contributionKeysByDerivationKey?.get(key);
  return owners ? sorted(owners) : null;
}
