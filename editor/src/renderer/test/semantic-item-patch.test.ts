import { describe, expect, it } from 'vite-plus/test';
import { applySemanticItemPatch } from '@/commands/semantic-collection-planner';

describe('stable-ID field-granular collection patches', () => {
  const before = {
    id: 'door',
    visible: true,
    condition: { kind: 'always' },
    layout: { nested: { x: 1, y: 2 } },
  };

  it('rebases disjoint fields and other items after a native reorder', () => {
    const latest = [
      { id: 'desk', visible: false, condition: { kind: 'always' } },
      { ...before, visible: false, layout: { nested: { x: 1, y: 99 } } },
    ];
    const after = { ...before, condition: { kind: 'never' } };
    expect(applySemanticItemPatch(latest, { id: 'door', before, after })).toEqual([
      latest[0],
      { ...latest[1], condition: { kind: 'never' } },
    ]);
    expect(latest[1]!.condition).toEqual({ kind: 'always' });
  });

  it('preserves nested disjoint mutations within one entry', () => {
    const latest = [{ ...before, layout: { nested: { x: 1, y: 8 } } }];
    const after = { ...before, layout: { nested: { x: 4, y: 2 } } };
    expect(applySemanticItemPatch(latest, { id: 'door', before, after })).toMatchObject([
      { id: 'door', layout: { nested: { x: 4, y: 8 } } },
    ]);
  });

  it('fails closed for conflicts, deletion, duplicates and invalid baseline IDs', () => {
    const after = { ...before, visible: false };
    expect(() =>
      applySemanticItemPatch([{ ...before, visible: false }], { id: 'door', before, after }),
    ).toThrow(/field '\/visible' changed/u);
    expect(() => applySemanticItemPatch([], { id: 'door', before, after })).toThrow(/removed/u);
    expect(() =>
      applySemanticItemPatch([before, { ...before, id: 'desk' }], {
        id: 'door',
        before,
        after: { ...before, id: 'desk' },
      }),
    ).toThrow(/already exists/u);
    expect(() => applySemanticItemPatch([before, before], { id: 'door', before, after })).toThrow(
      /duplicate/u,
    );
    expect(() => applySemanticItemPatch([before], { id: 'wrong', before, after })).toThrow(
      /invalid event-time baseline/u,
    );
  });

  it('preserves item identity when a patch leaves content unchanged', () => {
    const latest = [before];
    expect(applySemanticItemPatch(latest, { id: 'door', before, after: before })).toBe(latest);
  });
});
