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

export interface AuthoringGraphInputValueContext {
  previousProject?: unknown;
  project?: unknown;
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

function valuePresence(root: unknown, path: JsonPointer): { present: boolean; value: unknown } {
  let current = root;
  for (const segment of parseJsonPointer(path)) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment))
      return { present: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { present: true, value: current };
}

function reverseDependencyOwners(
  dependency: readonly unknown[],
  indexes: AuthoringGraphInputClassifierIndexes,
): readonly string[] {
  return sorted(indexes.contributionKeysByDerivationKey?.get(JSON.stringify(dependency)) ?? []);
}

function incrementalImpact(
  contributionKeys: readonly string[],
  sourceAnalysisOwnerKeys: readonly string[] = [],
  symbolProjectionOwnerKeys: readonly string[] = [],
): AuthoringDependencyGraphMutationImpact {
  return contributionKeys.length === 0 &&
    sourceAnalysisOwnerKeys.length === 0 &&
    symbolProjectionOwnerKeys.length === 0
    ? { kind: 'graph-stable' }
    : {
        kind: 'incremental',
        contributionKeys: sorted(contributionKeys),
        sourceAnalysisOwnerKeys: sorted(sourceAnalysisOwnerKeys),
        symbolProjectionOwnerKeys: sorted(symbolProjectionOwnerKeys),
      };
}

function valueDependentImpact(
  path: JsonPointer,
  classify: string,
  indexes: AuthoringGraphInputClassifierIndexes,
  context: AuthoringGraphInputValueContext,
): AuthoringDependencyGraphMutationImpact {
  const segments = parseJsonPointer(path);
  if (classify === 'asset-source-impact') {
    const assetId = segments[1];
    const changedLeaf = segments.slice(3).join('/');
    if (!assetId) return { kind: 'full-rebuild', reason: 'classifier-fallback' };
    const dependencyKind =
      changedLeaf === 'contentHash' ? 'source-asset' : 'source-resolution-asset';
    const owners = reverseDependencyOwners([dependencyKind, assetId], indexes);
    return incrementalImpact(owners, owners);
  }
  if (classify === 'localization-catalog-entry') {
    const key = segments[3];
    if (!key) return { kind: 'full-rebuild', reason: 'classifier-fallback' };
    const previous = valuePresence(context.previousProject, path);
    const next = valuePresence(context.project, path);
    if (previous.present && next.present) return { kind: 'graph-stable' };
    if (!previous.present && !next.present)
      return { kind: 'full-rebuild', reason: 'classifier-fallback' };
    return incrementalImpact(reverseDependencyOwners(['localization-lookup', key], indexes));
  }
  if (classify === 'property-assignment') {
    const previous = valuePresence(context.previousProject, path);
    const next = valuePresence(context.project, path);
    if (previous.present && next.present) return { kind: 'graph-stable' };
    if (previous.present !== next.present) {
      const ownerPath = ownerPathFor(path);
      const owners = ownerPath ? (indexes.contributionKeysByOwnerPath?.get(ownerPath) ?? []) : [];
      return owners.length > 0
        ? incrementalImpact(owners)
        : { kind: 'full-rebuild', reason: 'classifier-fallback' };
    }
    return { kind: 'full-rebuild', reason: 'classifier-fallback' };
  }
  if (classify === 'structural-variant') {
    const ownerPath = ownerPathFor(path);
    const owners = ownerPath ? (indexes.contributionKeysByOwnerPath?.get(ownerPath) ?? []) : [];
    return owners.length > 0
      ? incrementalImpact(owners)
      : { kind: 'full-rebuild', reason: 'classifier-fallback' };
  }
  return { kind: 'full-rebuild', reason: 'classifier-fallback' };
}

function impactForEffect(
  path: JsonPointer,
  effect: AuthoringFieldGraphEffect,
  indexes: AuthoringGraphInputClassifierIndexes,
  context: AuthoringGraphInputValueContext,
): AuthoringDependencyGraphMutationImpact {
  if (effect.kind === 'none') return { kind: 'graph-stable' };
  if (effect.kind === 'value-dependent')
    return valueDependentImpact(path, effect.classify, indexes, context);
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
  context: AuthoringGraphInputValueContext = {},
): AuthoringDependencyGraphMutationImpact {
  const impacts = affectedPaths.map((path) => {
    if (path === '/') return { kind: 'full-rebuild', reason: 'root-change' } as const;
    if (path === '/localization/defaultLocale' || path === '/localization/fallbackLocale')
      return incrementalImpact(reverseDependencyOwners(['project-field', path], indexes));
    const classification = classifyAuthoringGraphInputPath(path);
    return classification
      ? impactForEffect(path, classification.effect, indexes, context)
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
): readonly string[] {
  const dependencyKind =
    changedLeaf === 'contentHash' || changedLeaf === 'read'
      ? 'source-asset'
      : 'source-resolution-asset';
  const key = JSON.stringify([dependencyKind, assetId]);
  const owners = indexes.contributionKeysByDerivationKey?.get(key);
  return sorted(owners ?? []);
}
