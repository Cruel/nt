import { authoringCollectionKeys, type AuthoringCollectionKey } from './authoring-collections';
import type { AuthoringProject } from './authoring-project';
import { parseAssetData } from './authoring-assets';

const ASSET_REF_KEY = '$asset';

export interface AssetAliasUsage {
  alias: string;
  sourceCollection: AuthoringCollectionKey;
  sourceId: string;
  path: string;
  kind: 'asset-alias';
}

export interface AssetAliasIndex {
  usages: AssetAliasUsage[];
  byAlias: Map<string, AssetAliasUsage[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapePathSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function scanForAssetAliases(value: unknown, path: string, sourceCollection: AuthoringCollectionKey, sourceId: string, usages: AssetAliasUsage[]) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForAssetAliases(item, `${path}/${index}`, sourceCollection, sourceId, usages));
    return;
  }
  if (!isRecord(value)) return;
  const asset = value[ASSET_REF_KEY];
  if (isRecord(asset) && typeof asset.alias === 'string') {
    usages.push({ alias: asset.alias, sourceCollection, sourceId, path: `${path}/${ASSET_REF_KEY}/alias`, kind: 'asset-alias' });
  }
  for (const [key, child] of Object.entries(value)) {
    scanForAssetAliases(child, `${path}/${escapePathSegment(key)}`, sourceCollection, sourceId, usages);
  }
}

export function buildAssetAliasIndex(project: AuthoringProject): AssetAliasIndex {
  const usages: AssetAliasUsage[] = [];
  for (const collection of authoringCollectionKeys) {
    for (const [id, record] of Object.entries(project[collection])) {
      scanForAssetAliases(record.data, `/${collection}/${escapePathSegment(id)}/data`, collection, id, usages);
    }
  }
  const byAlias = new Map<string, AssetAliasUsage[]>();
  for (const usage of usages) {
    const group = byAlias.get(usage.alias) ?? [];
    group.push(usage);
    byAlias.set(usage.alias, group);
  }
  return { usages, byAlias };
}

export function findAssetAliasUsages(index: AssetAliasIndex, alias: string): AssetAliasUsage[] {
  return index.byAlias.get(alias) ?? [];
}

export function findAssetRecordByAlias(project: AuthoringProject, alias: string): { entityId: string } | null {
  for (const [entityId, record] of Object.entries(project.assets)) {
    const data = parseAssetData(record.data);
    if (data?.aliases.includes(alias)) return { entityId };
  }
  return null;
}

export function rewriteAssetAliasReferences(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteAssetAliasReferences(item, from, to));
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === ASSET_REF_KEY && isRecord(child) && child.alias === from) {
      next[key] = { ...child, alias: to };
    } else {
      next[key] = rewriteAssetAliasReferences(child, from, to);
    }
  }
  return next;
}
