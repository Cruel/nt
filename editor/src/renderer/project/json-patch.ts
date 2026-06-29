import type { JsonPointer } from './json-pointer';
import { getJsonAtPointer, splitJsonPointerParent } from './json-pointer';
import { cloneJsonValue, isJsonObject, type JsonValue } from './json-value';

export type JsonPatchOperation =
  | { op: 'add'; path: JsonPointer; value: JsonValue }
  | { op: 'replace'; path: JsonPointer; value: JsonValue }
  | { op: 'remove'; path: JsonPointer };

export interface JsonPatchApplyResult {
  document: JsonValue;
  inversePatches: JsonPatchOperation[];
}

export class JsonPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonPatchError';
  }
}

function replaceAtRoot(operation: JsonPatchOperation): JsonPatchApplyResult {
  if (operation.op === 'remove') {
    throw new JsonPatchError('Cannot remove the document root.');
  }
  return {
    document: cloneJsonValue(operation.value),
    inversePatches: [{ op: 'replace', path: '', value: null }],
  };
}

function applyChildOperation(document: JsonValue, operation: JsonPatchOperation): JsonPatchApplyResult {
  const next = cloneJsonValue(document);
  const { parent, key } = splitJsonPointerParent(operation.path);
  const parentValue = getJsonAtPointer(next, parent);

  if (Array.isArray(parentValue)) {
    const index = key === '-' ? parentValue.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index > parentValue.length) {
      throw new JsonPatchError(`Invalid array index '${key}' for ${operation.path}.`);
    }
    if (operation.op === 'add') {
      parentValue.splice(index, 0, cloneJsonValue(operation.value));
      const insertedPath = key === '-' ? `${parent === '' ? '' : parent}/${index}` : operation.path;
      return { document: next, inversePatches: [{ op: 'remove', path: insertedPath }] };
    }
    if (index >= parentValue.length) {
      throw new JsonPatchError(`Array index does not exist for ${operation.path}.`);
    }
    const oldValue = cloneJsonValue(parentValue[index]!);
    if (operation.op === 'replace') {
      parentValue[index] = cloneJsonValue(operation.value);
      return { document: next, inversePatches: [{ op: 'replace', path: operation.path, value: oldValue }] };
    }
    parentValue.splice(index, 1);
    return { document: next, inversePatches: [{ op: 'add', path: operation.path, value: oldValue }] };
  }

  if (isJsonObject(parentValue)) {
    const hadKey = Object.prototype.hasOwnProperty.call(parentValue, key);
    const oldValue = hadKey ? cloneJsonValue(parentValue[key]!) : null;
    if (operation.op === 'add') {
      if (hadKey) {
        throw new JsonPatchError(`Object key already exists for add operation: ${operation.path}`);
      }
      parentValue[key] = cloneJsonValue(operation.value);
      return { document: next, inversePatches: [{ op: 'remove', path: operation.path }] };
    }
    if (!hadKey) {
      throw new JsonPatchError(`Object key does not exist for ${operation.op} operation: ${operation.path}`);
    }
    if (operation.op === 'replace') {
      parentValue[key] = cloneJsonValue(operation.value);
      return { document: next, inversePatches: [{ op: 'replace', path: operation.path, value: oldValue }] };
    }
    delete parentValue[key];
    return { document: next, inversePatches: [{ op: 'add', path: operation.path, value: oldValue }] };
  }

  throw new JsonPatchError(`Parent path is not an object or array: ${parent}`);
}

export function applyJsonPatchOperation(
  document: JsonValue,
  operation: JsonPatchOperation,
): JsonPatchApplyResult {
  if (operation.path === '') {
    if (operation.op === 'replace') {
      return {
        document: cloneJsonValue(operation.value),
        inversePatches: [{ op: 'replace', path: '', value: cloneJsonValue(document) }],
      };
    }
    return replaceAtRoot(operation);
  }
  return applyChildOperation(document, operation);
}

export function applyJsonPatch(
  document: JsonValue,
  patches: JsonPatchOperation[],
): JsonPatchApplyResult {
  let current = cloneJsonValue(document);
  const inversePatches: JsonPatchOperation[] = [];
  for (const patch of patches) {
    const applied = applyJsonPatchOperation(current, patch);
    current = applied.document;
    inversePatches.unshift(...applied.inversePatches);
  }
  return { document: current, inversePatches };
}
