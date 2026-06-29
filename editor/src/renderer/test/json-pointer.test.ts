import { describe, expect, it } from 'vitest';
import { buildJsonPointer, getJsonAtPointer, parseJsonPointer } from '@/project/json-pointer';

describe('json pointer helpers', () => {
  it('builds and parses escaped pointers', () => {
    const pointer = buildJsonPointer(['rooms/by/id', 'tilde~key']);
    expect(pointer).toBe('/rooms~1by~1id/tilde~0key');
    expect(parseJsonPointer(pointer)).toEqual(['rooms/by/id', 'tilde~key']);
  });

  it('reads values at pointers', () => {
    expect(getJsonAtPointer({ room: { foyer: ['foyer'] } }, '/room/foyer/0')).toBe('foyer');
  });
});
