import type { JsonValue } from './json-value';
import {
  buildJsonPointer,
  JsonPointerError,
  parseJsonPointer,
  type JsonPointer,
} from '../../shared/json-pointer';

export {
  buildJsonPointer,
  escapeJsonPointerSegment,
  isJsonPointerAncestor,
  jsonPointerSegmentsOverlap,
  JsonPointerError,
  parseJsonPointer,
  unescapeJsonPointerSegment,
  type JsonPointer,
} from '../../shared/json-pointer';

export function getJsonAtPointer(document: JsonValue, pointer: JsonPointer): JsonValue {
  let current: JsonValue = document;
  for (const segment of parseJsonPointer(pointer)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new JsonPointerError(`Array index does not exist at ${pointer}: ${segment}`);
      }
      current = current[index]!;
      continue;
    }
    if (typeof current === 'object' && current !== null) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        throw new JsonPointerError(`Object key does not exist at ${pointer}: ${segment}`);
      }
      current = (current as Record<string, JsonValue>)[segment]!;
      continue;
    }
    throw new JsonPointerError(`Cannot traverse primitive value at ${pointer}`);
  }
  return current;
}

export function hasJsonAtPointer(document: JsonValue, pointer: JsonPointer): boolean {
  try {
    getJsonAtPointer(document, pointer);
    return true;
  } catch {
    return false;
  }
}

export function splitJsonPointerParent(pointer: JsonPointer): { parent: JsonPointer; key: string } {
  const segments = parseJsonPointer(pointer);
  if (segments.length === 0) {
    throw new JsonPointerError('Root pointer has no parent.');
  }
  const key = segments.at(-1)!;
  return { parent: buildJsonPointer(segments.slice(0, -1)), key };
}
