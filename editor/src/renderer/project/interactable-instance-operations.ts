import { buildJsonPointer } from '@/project/json-pointer';
import type { JsonPatchOperation } from './json-patch';
import { toJsonValue } from './json-value';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';

function rewriteInstanceRefs(value: unknown, fromId: string, toId: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteInstanceRefs(item, fromId, toId));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const ref = record.$ref;
  if (
    ref &&
    typeof ref === 'object' &&
    !Array.isArray(ref) &&
    (ref as Record<string, unknown>).registry === 'interactableInstances' &&
    (ref as Record<string, unknown>).id === fromId
  )
    return { ...record, $ref: { ...(ref as Record<string, unknown>), id: toId } };
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, rewriteInstanceRefs(child, fromId, toId)]),
  );
}

function collectReferencePatches(
  value: unknown,
  fromId: string,
  toId: string,
  path: string[] = [],
  patches: JsonPatchOperation[] = [],
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectReferencePatches(item, fromId, toId, [...path, String(index)], patches),
    );
    return patches;
  }
  if (!value || typeof value !== 'object') return patches;
  const record = value as Record<string, unknown>;
  const ref = record.$ref;
  if (
    ref &&
    typeof ref === 'object' &&
    !Array.isArray(ref) &&
    (ref as Record<string, unknown>).registry === 'interactableInstances' &&
    (ref as Record<string, unknown>).id === fromId
  ) {
    patches.push({
      op: 'replace',
      path: buildJsonPointer([...path, '$ref', 'id']),
      value: toJsonValue(toId),
    });
    return patches;
  }
  for (const [key, child] of Object.entries(record))
    collectReferencePatches(child, fromId, toId, [...path, key], patches);
  return patches;
}

export function renameInteractableInstancePatches(
  project: AuthoringProject,
  fromId: string,
  toId: string,
): JsonPatchOperation[] {
  if (
    fromId === toId ||
    !project.interactableInstances[fromId] ||
    project.interactableInstances[toId]
  )
    return [];
  const source = rewriteInstanceRefs(
    { ...project.interactableInstances[fromId], id: toId },
    fromId,
    toId,
  );
  const patches: JsonPatchOperation[] = [
    {
      op: 'add',
      path: buildJsonPointer(['interactableInstances', toId]),
      value: toJsonValue(source),
    },
  ];
  for (const [key, value] of Object.entries(project)) {
    if (key === 'interactableInstances') {
      for (const [instanceId, instance] of Object.entries(project.interactableInstances)) {
        if (instanceId === fromId) continue;
        collectReferencePatches(instance, fromId, toId, [key, instanceId], patches);
      }
      continue;
    }
    collectReferencePatches(value, fromId, toId, [key], patches);
  }
  patches.push({ op: 'remove', path: buildJsonPointer(['interactableInstances', fromId]) });
  return patches;
}
