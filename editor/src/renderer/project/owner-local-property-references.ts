import { buildJsonPointer, parseJsonPointer } from '@/project/json-pointer';
import type { JsonPatchOperation } from '@/project/json-patch';
import {
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from '../../shared/project-schema/authoring-collections';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { ReferenceUsage } from '../../shared/project-schema/authoring-references';

export type OwnerLocalPropertyOwnerKind = 'room' | 'character' | 'interactable';

export interface OwnerLocalPropertyOwner {
  kind: OwnerLocalPropertyOwnerKind;
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sceneOwnerMatches(value: unknown, owner: OwnerLocalPropertyOwner): boolean {
  if (!isRecord(value) || value.kind !== owner.kind) return false;
  const reference = value[owner.kind];
  if (!isRecord(reference) || !isRecord(reference.$ref)) return false;
  return reference.$ref.id === owner.id;
}

function luaOwnerMatches(value: unknown, owner: OwnerLocalPropertyOwner): boolean {
  return isRecord(value) && value.kind === owner.kind && value.id === owner.id;
}

function sourceForPath(path: string): {
  sourceCollection: AuthoringCollectionKey | 'project';
  sourceId: string;
} {
  const [collection, id] = parseJsonPointer(path);
  if (isAuthoringCollectionKey(collection) && id) {
    return { sourceCollection: collection, sourceId: id };
  }
  return { sourceCollection: 'project', sourceId: 'project' };
}

function referenceTargetForOwner(project: AuthoringProject, owner: OwnerLocalPropertyOwner) {
  if (owner.kind === 'room') return { collection: 'rooms' as const, id: owner.id };
  if (owner.kind === 'character') return { collection: 'characters' as const, id: owner.id };
  return {
    collection: 'interactables' as const,
    id: project.interactableInstances[owner.id]?.definition.$ref.id ?? owner.id,
  };
}

export function ownerLocalPropertyReferences(
  project: AuthoringProject,
  owner: OwnerLocalPropertyOwner,
  propertyId: string,
): ReferenceUsage[] {
  const target = referenceTargetForOwner(project, owner);
  return ownerLocalPropertyReferencePaths(project, owner, propertyId).map((path) => ({
    ...sourceForPath(path),
    path,
    target,
    kind: 'explicit-ref',
  }));
}

export function ownerLocalPropertyReferencePaths(
  project: AuthoringProject,
  owner: OwnerLocalPropertyOwner,
  propertyId: string,
): string[] {
  const paths: string[] = [];

  function visit(value: unknown, segments: string[]) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...segments, String(index)]));
      return;
    }
    if (!isRecord(value)) return;

    if (
      (value.kind === 'set-property' || value.kind === 'unset-property') &&
      sceneOwnerMatches(value.owner, owner) &&
      isRecord(value.property) &&
      value.property.key === propertyId
    ) {
      paths.push(buildJsonPointer([...segments, 'property', 'key']));
    }

    if (
      value.kind === 'property-value' &&
      luaOwnerMatches(value.owner, owner) &&
      value.propertyId === propertyId
    ) {
      paths.push(buildJsonPointer([...segments, 'propertyId']));
    }

    for (const [key, child] of Object.entries(value)) visit(child, [...segments, key]);
  }

  visit(project, []);
  return paths.sort();
}

export function renameOwnerLocalPropertyReferencePatches(
  project: AuthoringProject,
  owner: OwnerLocalPropertyOwner,
  fromId: string,
  toId: string,
): JsonPatchOperation[] {
  if (fromId === toId) return [];
  return ownerLocalPropertyReferencePaths(project, owner, fromId).map((path) => ({
    op: 'replace',
    path,
    value: toId,
  }));
}
