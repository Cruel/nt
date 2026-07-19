import { describe, expect, it } from 'vite-plus/test';
import { applyJsonPatch } from '@/project/json-patch';

describe('json patch helpers', () => {
  it('applies and inverts object replacements without mutating input', () => {
    const document = { room: { foyer: ['foyer', 'old'] } };
    const applied = applyJsonPatch(document, [
      { op: 'replace', path: '/room/foyer/1', value: 'new' },
    ]);

    expect(document.room.foyer[1]).toBe('old');
    expect(applied.document).toEqual({ room: { foyer: ['foyer', 'new'] } });
    expect(applyJsonPatch(applied.document, applied.inversePatches).document).toEqual(document);
  });

  it('adds and removes object children', () => {
    const applied = applyJsonPatch({ room: {} }, [
      { op: 'add', path: '/room/foyer', value: ['foyer'] },
    ]);
    expect(applied.document).toEqual({ room: { foyer: ['foyer'] } });
    expect(applyJsonPatch(applied.document, applied.inversePatches).document).toEqual({ room: {} });
  });
});
