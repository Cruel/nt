import { buildJsonPointer } from '@/project/json-pointer';
import type { JsonPatchOperation } from '@/project/json-patch';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';

export type MigratedPropertyOwnerKind = 'room' | 'character';

export interface MigratedPropertyOwner {
  kind: MigratedPropertyOwnerKind;
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sceneOwnerMatches(value: unknown, owner: MigratedPropertyOwner): boolean {
  if (!isRecord(value) || value.kind !== owner.kind) return false;
  const reference = value[owner.kind];
  if (!isRecord(reference) || !isRecord(reference.$ref)) return false;
  return reference.$ref.id === owner.id;
}

function luaOwnerMatches(value: unknown, owner: MigratedPropertyOwner): boolean {
  return isRecord(value) && value.kind === owner.kind && value.id === owner.id;
}

export function ownerLocalPropertyReferencePaths(
  project: AuthoringProject,
  owner: MigratedPropertyOwner,
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
  owner: MigratedPropertyOwner,
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
