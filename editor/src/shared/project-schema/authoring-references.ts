import { authoringCollectionKeys, type AuthoringCollectionKey } from './authoring-collections';
import type { AuthoringProject, ReferenceTarget } from './authoring-project';
import { isVariableRef } from './authoring-variables';

export type ReferenceUsageKind = 'extends' | 'entrypoint' | 'explicit-ref' | 'variable-ref';

export interface ReferenceUsage {
  sourceCollection: AuthoringCollectionKey | 'project';
  sourceId: string;
  path: string;
  target: ReferenceTarget;
  kind: ReferenceUsageKind;
}

export interface ReferenceIndex {
  usages: ReferenceUsage[];
  byTarget: Map<string, ReferenceUsage[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReferenceTarget(value: unknown): value is ReferenceTarget {
  return isRecord(value) && typeof value.collection === 'string' && typeof value.id === 'string';
}

function addUsage(usages: ReferenceUsage[], usage: ReferenceUsage) {
  usages.push(usage);
}

function scanDataForExplicitRefs(
  value: unknown,
  path: string,
  sourceCollection: AuthoringCollectionKey | 'project',
  sourceId: string,
  usages: ReferenceUsage[],
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanDataForExplicitRefs(item, `${path}/${index}`, sourceCollection, sourceId, usages));
    return;
  }
  if (!isRecord(value)) return;

  const ref = value.$ref;
  if (isReferenceTarget(ref)) {
    addUsage(usages, {
      sourceCollection,
      sourceId,
      path: `${path}/$ref`,
      target: ref,
      kind: 'explicit-ref',
    });
  }

  if (isVariableRef(value)) {
    addUsage(usages, {
      sourceCollection,
      sourceId,
      path: `${path}/$var`,
      target: { collection: 'variables', id: value.$var },
      kind: 'variable-ref',
    });
  }

  for (const [key, child] of Object.entries(value)) {
    scanDataForExplicitRefs(child, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, sourceCollection, sourceId, usages);
  }
}

export function referenceTargetKey(target: ReferenceTarget): string {
  return `${target.collection}:${target.id}`;
}

export function buildReferenceIndex(project: AuthoringProject): ReferenceIndex {
  const usages: ReferenceUsage[] = [];

  if (project.entrypoint) {
    addUsage(usages, {
      sourceCollection: 'project',
      sourceId: 'project',
      path: '/entrypoint',
      target: { collection: `${project.entrypoint.kind}s` as 'rooms' | 'scenes' | 'dialogues', id: project.entrypoint.id },
      kind: 'entrypoint',
    });
  }

  scanDataForExplicitRefs(project.settings, '/settings', 'project', 'settings', usages);

  for (const collection of authoringCollectionKeys) {
    const records = project[collection];
    for (const [id, record] of Object.entries(records)) {
      if (record.extends) {
        addUsage(usages, {
          sourceCollection: collection,
          sourceId: id,
          path: `/${collection}/${id}/extends`,
          target: { collection, id: record.extends },
          kind: 'extends',
        });
      }
      scanDataForExplicitRefs(record.data, `/${collection}/${id}/data`, collection, id, usages);
    }
  }

  const byTarget = new Map<string, ReferenceUsage[]>();
  for (const usage of usages) {
    const key = referenceTargetKey(usage.target);
    const group = byTarget.get(key) ?? [];
    group.push(usage);
    byTarget.set(key, group);
  }

  return { usages, byTarget };
}

export function findUsages(index: ReferenceIndex, target: ReferenceTarget): ReferenceUsage[] {
  return index.byTarget.get(referenceTargetKey(target)) ?? [];
}
