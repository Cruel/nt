import type { JsonValue } from './json-value';

export type JsonPointer = string;

export class JsonPointerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonPointerError';
  }
}

export function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function unescapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function buildJsonPointer(segments: string[]): JsonPointer {
  if (segments.length === 0) return '';
  return `/${segments.map(escapeJsonPointerSegment).join('/')}`;
}

export function parseJsonPointer(pointer: JsonPointer): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new JsonPointerError(`JSON pointer must be empty or start with '/': ${pointer}`);
  }
  return pointer.slice(1).split('/').map(unescapeJsonPointerSegment);
}

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
