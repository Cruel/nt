import { describe, expect, it } from 'vite-plus/test';
import {
  buildJsonPointer,
  getJsonAtPointer,
  jsonPointerSegmentsOverlap,
  parseJsonPointer,
} from '@/project/json-pointer';

describe('json pointer helpers', () => {
  it('builds and parses escaped pointers', () => {
    const pointer = buildJsonPointer(['rooms/by/id', 'tilde~key']);
    expect(pointer).toBe('/rooms~1by~1id/tilde~0key');
    expect(parseJsonPointer(pointer)).toEqual(['rooms/by/id', 'tilde~key']);
  });

  it('reads values at pointers', () => {
    expect(getJsonAtPointer({ room: { foyer: ['foyer'] } }, '/room/foyer/0')).toBe('foyer');
  });

  it('compares decoded path segments rather than string prefixes', () => {
    expect(jsonPointerSegmentsOverlap('/rooms/a', '/rooms/a/data')).toBe(true);
    expect(jsonPointerSegmentsOverlap('/rooms/a', '/rooms/ab')).toBe(false);
    expect(jsonPointerSegmentsOverlap('/rooms/a~1b', '/rooms/a~1b/data')).toBe(true);
    expect(jsonPointerSegmentsOverlap('/rooms/a~1b', '/rooms/a/b')).toBe(false);
    expect(jsonPointerSegmentsOverlap('/rooms/a~0b', '/rooms/a~0b/data')).toBe(true);
  });
});
