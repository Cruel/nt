import type { ProjectMutationPathValue } from '../../shared/editor-tooling';
import { hasJsonAtPointer, type JsonPointer } from './json-pointer';
import { applyJsonPatch, type JsonPatchOperation } from './json-patch';
import { cloneJsonValue, type JsonValue } from './json-value';

export function applyProjectMutationValues(
  document: JsonValue,
  values: Readonly<Record<string, ProjectMutationPathValue>>,
): JsonValue {
  const operations: JsonPatchOperation[] = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, value]) =>
      value.exists
        ? hasJsonAtPointer(document, path as JsonPointer)
          ? { op: 'replace' as const, path, value: cloneJsonValue(value.value as JsonValue) }
          : { op: 'add' as const, path, value: cloneJsonValue(value.value as JsonValue) }
        : { op: 'remove' as const, path },
    );
  return operations.length > 0
    ? applyJsonPatch(document, operations).document
    : cloneJsonValue(document);
}
