import { authoringCollectionKeys } from '../project-schema/authoring-collections';
import type { AuthoringCollectionKey } from '../project-schema/authoring-collections';
import { parseAssetData } from '../project-schema/authoring-assets';
import { buildAssetAliasIndex } from '../project-schema/authoring-asset-references';
import type { AuthoringProject, AuthoringRecordBase } from '../project-schema/authoring-project';
import { buildReferenceIndex, referenceTargetKey } from '../project-schema/authoring-references';
import { recordEditorMetadata } from '../project-schema/authoring-tags';
import type { ReferenceIndex } from '../project-schema/authoring-references';
import type { AssetAliasIndex } from '../project-schema/authoring-asset-references';
import type { ProjectSearchDocument, ProjectSearchField } from './project-search-types';

export interface ProjectSearchIndex {
  documents: ProjectSearchDocument[];
  referenceIndex: ReferenceIndex;
  assetAliasIndex: AssetAliasIndex;
}

function escapePathSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function addField(fields: ProjectSearchField[], field: ProjectSearchField) {
  if (!field.value.trim()) return;
  fields.push(field);
}

function addStringContentFields(fields: ProjectSearchField[], value: unknown, path: string) {
  if (typeof value === 'string') {
    addField(fields, {
      kind: 'content',
      label: 'Content',
      value,
      path,
      weight: 0.75,
      defaultSearchable: false,
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => addStringContentFields(fields, item, path + '/' + index));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    addStringContentFields(fields, child, path + '/' + escapePathSegment(key));
  }
}

function fieldsForRecord(
  project: AuthoringProject,
  collection: AuthoringCollectionKey,
  entityId: string,
  record: AuthoringRecordBase,
): ProjectSearchField[] {
  const base = `/${collection}/${escapePathSegment(entityId)}`;
  const fields: ProjectSearchField[] = [];
  addField(fields, {
    kind: 'id',
    label: 'ID',
    value: entityId,
    path: `${base}/id`,
    weight: 4,
    defaultSearchable: true,
  });
  addField(fields, {
    kind: 'label',
    label: 'Name',
    value: record.label || entityId,
    path: `${base}/label`,
    weight: 4,
    defaultSearchable: true,
  });
  recordEditorMetadata(project, collection, entityId).tags.forEach((tag, index) =>
    addField(fields, {
      kind: 'tag',
      label: 'Tag',
      value: tag,
      path: `/editor/recordMetadata/${collection}/${escapePathSegment(entityId)}/tags/${index}`,
      weight: 3,
      defaultSearchable: true,
    }),
  );
  addField(fields, {
    kind: 'description',
    label: 'Description',
    value: record.description ?? '',
    path: `${base}/description`,
    weight: 1,
    defaultSearchable: false,
  });

  if (collection === 'assets') {
    const data = parseAssetData(record.data);
    if (data) {
      addField(fields, {
        kind: 'type',
        label: 'Asset Type',
        value: data.kind,
        path: `${base}/data/kind`,
        weight: 2.5,
        defaultSearchable: false,
      });
      addField(fields, {
        kind: 'content',
        label: 'Asset Path',
        value: data.source.path,
        path: `${base}/data/source/path`,
        weight: 0.75,
        defaultSearchable: false,
      });
      data.aliases.forEach((alias, index) =>
        addField(fields, {
          kind: 'alias',
          label: 'Asset Alias',
          value: alias,
          path: `${base}/data/aliases/${index}`,
          weight: 2.5,
          defaultSearchable: false,
        }),
      );
    }
  } else {
    addStringContentFields(fields, record.data, `${base}/data`);
  }

  return fields;
}

export function buildProjectSearchIndex(project: AuthoringProject): ProjectSearchIndex {
  const referenceIndex = buildReferenceIndex(project);
  const assetAliasIndex = buildAssetAliasIndex(project);
  const usagesBySource = new Map<string, ReturnType<typeof referenceIndex.usages.filter>>();
  for (const usage of referenceIndex.usages) {
    if (usage.sourceCollection === 'project') continue;
    const key = `${usage.sourceCollection}:${usage.sourceId}`;
    const group = usagesBySource.get(key) ?? [];
    group.push(usage);
    usagesBySource.set(key, group);
  }
  const assetAliasesBySource = new Map<string, ReturnType<typeof assetAliasIndex.usages.filter>>();
  for (const usage of assetAliasIndex.usages) {
    const key = `${usage.sourceCollection}:${usage.sourceId}`;
    const group = assetAliasesBySource.get(key) ?? [];
    group.push(usage);
    assetAliasesBySource.set(key, group);
  }

  const documents: ProjectSearchDocument[] = [];
  for (const collection of authoringCollectionKeys) {
    for (const [entityId, record] of Object.entries(project[collection])) {
      const key = `${collection}:${entityId}`;
      const data = collection === 'assets' ? parseAssetData(record.data) : null;
      documents.push({
        id: `record:${collection}:${entityId}`,
        kind: 'record',
        collection,
        entityId,
        label: record.label || entityId,
        sourcePath: `/${collection}/${escapePathSegment(entityId)}`,
        fields: fieldsForRecord(project, collection, entityId, record),
        facets: {
          collection,
          assetType: data?.kind,
          tags: recordEditorMetadata(project, collection, entityId).tags,
        },
        references: usagesBySource.get(key) ?? [],
        assetAliasUsages: assetAliasesBySource.get(key) ?? [],
      });
    }
  }
  return { documents, referenceIndex, assetAliasIndex };
}

export function referenceTargetKeys(
  targets: import('../project-schema/authoring-project').ReferenceTarget[] | undefined,
): Set<string> {
  return new Set((targets ?? []).map(referenceTargetKey));
}
