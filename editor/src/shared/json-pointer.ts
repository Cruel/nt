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

export function buildJsonPointer(segments: readonly string[]): JsonPointer {
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

export function jsonPointerSegmentsOverlap(left: JsonPointer, right: JsonPointer): boolean {
  const leftSegments = parseJsonPointer(left);
  const rightSegments = parseJsonPointer(right);
  const sharedLength = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftSegments[index] !== rightSegments[index]) return false;
  }
  return true;
}

export function isJsonPointerAncestor(ancestor: JsonPointer, descendant: JsonPointer): boolean {
  const ancestorSegments = parseJsonPointer(ancestor);
  const descendantSegments = parseJsonPointer(descendant);
  return (
    ancestorSegments.length <= descendantSegments.length &&
    ancestorSegments.every((segment, index) => descendantSegments[index] === segment)
  );
}
