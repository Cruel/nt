import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import type { ImportedAssetMetadata } from '../../shared/asset-import';
import {
  assetDataFromImportMetadata,
  defaultAssetIdFromFilename,
  parseAssetData,
  validateAssetAlias,
} from '../../shared/project-schema/authoring-assets';
import {
  buildAssetAliasIndex,
  findAssetAliasUsages,
  findAssetRecordByAlias,
} from '../../shared/project-schema/authoring-asset-references';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';
import {
  isAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';

export interface AssetOperationDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
}

export interface AssetOperationResult {
  patches: JsonPatchOperation[];
  diagnostics?: AssetOperationDiagnostic[];
  affectedPaths?: string[];
}

export interface AssetImportPayload {
  assets: ImportedAssetMetadata[];
}

export interface AssetAliasPayload {
  assetId: string;
  alias: string;
}

export interface AssetRenameAliasPayload {
  fromAlias: string;
  toAlias: string;
}

export interface AssetReimportPayload {
  assetId: string;
  asset: ImportedAssetMetadata;
}

export interface AssetDeletePayload {
  assetId: string;
  force?: boolean;
}

function error(message: string, path?: string): AssetOperationDiagnostic {
  return { severity: 'error', message, path };
}

function validateProject(
  document: JsonValue | unknown,
): AuthoringProject | AssetOperationDiagnostic {
  if (isAuthoringProject(document)) return document;
  return error('Current document is not a NovelTea project.');
}

function assetPath(assetId: string): string {
  return buildJsonPointer(['assets', assetId]);
}

function assetDataPath(assetId: string): string {
  return buildJsonPointer(['assets', assetId, 'data']);
}

function assetAliasesPath(assetId: string): string {
  return buildJsonPointer(['assets', assetId, 'data', 'aliases']);
}

function uniqueAssetId(project: AuthoringProject, filename: string): string {
  const base = defaultAssetIdFromFilename(filename);
  if (!project.assets[base]) return base;
  let index = 2;
  while (project.assets[`${base}-${index}`]) index += 1;
  return `${base}-${index}`;
}

function aliasConflict(
  project: AuthoringProject,
  alias: string,
  allowedAssetId?: string,
): string | null {
  const owner = findAssetRecordByAlias(project, alias);
  if (!owner) return null;
  return owner.entityId === allowedAssetId ? null : owner.entityId;
}

export function importAssetRecordsPatches(
  document: JsonValue | unknown,
  payload: AssetImportPayload,
): AssetOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  if (!payload.assets.length)
    return { patches: [], diagnostics: [error('No imported assets were provided.')] };
  const patches: JsonPatchOperation[] = [];
  const affectedPaths: string[] = [];
  const pendingIds = new Set<string>();
  for (const metadata of payload.assets) {
    let id = uniqueAssetId(project, metadata.originalName);
    while (pendingIds.has(id)) id = `${id}-copy`;
    pendingIds.add(id);
    const path = assetPath(id);
    patches.push({
      op: 'add',
      path,
      value: toJsonValue({
        id,
        label: metadata.originalName.replace(/\.[^.]*$/, ''),
        data: assetDataFromImportMetadata(metadata),
      }),
    });
    affectedPaths.push(path);
  }
  return { patches, affectedPaths };
}

export function assignAssetAliasPatches(
  document: JsonValue | unknown,
  payload: AssetAliasPayload,
): AssetOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const record = project.assets[payload.assetId];
  if (!record)
    return {
      patches: [],
      diagnostics: [error('Asset does not exist.', assetPath(payload.assetId))],
    };
  const aliasError = validateAssetAlias(payload.alias);
  if (aliasError)
    return { patches: [], diagnostics: [error(aliasError, assetAliasesPath(payload.assetId))] };
  const conflict = aliasConflict(project, payload.alias, payload.assetId);
  if (conflict)
    return {
      patches: [],
      diagnostics: [
        error(
          `Alias is already assigned to assets/${conflict}.`,
          assetAliasesPath(payload.assetId),
        ),
      ],
    };
  const data = parseAssetData(record.data);
  if (!data)
    return {
      patches: [],
      diagnostics: [error('Asset record has invalid asset data.', assetDataPath(payload.assetId))],
    };
  if (data.aliases.includes(payload.alias)) return { patches: [], affectedPaths: [] };
  const path = assetAliasesPath(payload.assetId);
  return {
    patches: [{ op: 'replace', path, value: toJsonValue([...data.aliases, payload.alias]) }],
    affectedPaths: [path],
  };
}

export function removeAssetAliasPatches(
  document: JsonValue | unknown,
  payload: AssetAliasPayload,
): AssetOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const record = project.assets[payload.assetId];
  if (!record)
    return {
      patches: [],
      diagnostics: [error('Asset does not exist.', assetPath(payload.assetId))],
    };
  const data = parseAssetData(record.data);
  if (!data)
    return {
      patches: [],
      diagnostics: [error('Asset record has invalid asset data.', assetDataPath(payload.assetId))],
    };
  const usages = findAssetAliasUsages(buildAssetAliasIndex(project), payload.alias);
  if (usages.length > 0) {
    return {
      patches: [],
      diagnostics: [
        error(
          `Alias is referenced by ${usages.length} usage${usages.length === 1 ? '' : 's'}.`,
          assetAliasesPath(payload.assetId),
        ),
      ],
    };
  }
  const path = assetAliasesPath(payload.assetId);
  return {
    patches: [
      {
        op: 'replace',
        path,
        value: toJsonValue(data.aliases.filter((alias) => alias !== payload.alias)),
      },
    ],
    affectedPaths: [path],
  };
}

export function renameAssetAliasPatches(
  document: JsonValue | unknown,
  payload: AssetRenameAliasPayload,
): AssetOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const aliasError = validateAssetAlias(payload.toAlias);
  if (aliasError) return { patches: [], diagnostics: [error(aliasError)] };
  if (payload.fromAlias === payload.toAlias)
    return { patches: [], diagnostics: [error('New alias must be different.')] };
  const owner = findAssetRecordByAlias(project, payload.fromAlias);
  if (!owner) return { patches: [], diagnostics: [error('Source alias does not exist.')] };
  const conflict = aliasConflict(project, payload.toAlias, owner.entityId);
  if (conflict)
    return {
      patches: [],
      diagnostics: [error(`Alias is already assigned to assets/${conflict}.`)],
    };
  const record = project.assets[owner.entityId]!;
  const data = parseAssetData(record.data)!;
  const patches: JsonPatchOperation[] = [
    {
      op: 'replace',
      path: assetAliasesPath(owner.entityId),
      value: toJsonValue(
        data.aliases.map((alias) => (alias === payload.fromAlias ? payload.toAlias : alias)),
      ),
    },
  ];
  const affectedPaths = [assetAliasesPath(owner.entityId)];
  for (const usage of findAssetAliasUsages(buildAssetAliasIndex(project), payload.fromAlias)) {
    patches.push({ op: 'replace', path: usage.path, value: toJsonValue(payload.toAlias) });
    affectedPaths.push(usage.path);
  }
  return { patches, affectedPaths };
}

export function reimportAssetPatches(
  document: JsonValue | unknown,
  payload: AssetReimportPayload,
): AssetOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const record = project.assets[payload.assetId];
  if (!record)
    return {
      patches: [],
      diagnostics: [error('Asset does not exist.', assetPath(payload.assetId))],
    };
  const current = parseAssetData(record.data);
  if (!current)
    return {
      patches: [],
      diagnostics: [error('Asset record has invalid asset data.', assetDataPath(payload.assetId))],
    };
  const next = { ...assetDataFromImportMetadata(payload.asset), aliases: current.aliases };
  return {
    patches: [{ op: 'replace', path: assetDataPath(payload.assetId), value: toJsonValue(next) }],
    affectedPaths: [assetDataPath(payload.assetId)],
  };
}

export function deleteAssetPatches(
  document: JsonValue | unknown,
  payload: AssetDeletePayload,
): AssetOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const record = project.assets[payload.assetId];
  if (!record)
    return {
      patches: [],
      diagnostics: [error('Asset does not exist.', assetPath(payload.assetId))],
    };
  const stableUsages = findUsages(buildReferenceIndex(project), {
    collection: 'assets',
    id: payload.assetId,
  }).filter(
    (usage) => !(usage.sourceCollection === 'assets' && usage.sourceId === payload.assetId),
  );
  const data = parseAssetData(record.data);
  const aliasUsages = data
    ? data.aliases.flatMap((alias) => findAssetAliasUsages(buildAssetAliasIndex(project), alias))
    : [];
  const usageCount = stableUsages.length + aliasUsages.length;
  if (!payload.force && usageCount > 0) {
    return {
      patches: [],
      diagnostics: [
        error(
          `Asset is referenced by ${usageCount} usage${usageCount === 1 ? '' : 's'}.`,
          assetPath(payload.assetId),
        ),
      ],
    };
  }
  return {
    patches: [{ op: 'remove', path: assetPath(payload.assetId) }],
    affectedPaths: [assetPath(payload.assetId)],
  };
}
