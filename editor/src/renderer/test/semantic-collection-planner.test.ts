import { describe, expect, it } from 'vite-plus/test';
import { applySemanticCollectionOperation } from '@/commands/semantic-collection-planner';

const original = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta' },
  { id: 'gamma', label: 'Gamma' },
];

describe('semantic collection planning', () => {
  it('targets the same item after another operation reorders and inserts before it', () => {
    const moved = applySemanticCollectionOperation(original, {
      kind: 'move',
      id: 'gamma',
      beforeId: 'alpha',
    });
    const inserted = applySemanticCollectionOperation(moved, {
      kind: 'insert',
      item: { id: 'new', label: 'New' },
      beforeId: 'beta',
    });
    const replaced = applySemanticCollectionOperation(inserted, {
      kind: 'replace',
      id: 'beta',
      before: original[1]!,
      after: { id: 'beta', label: 'Edited' },
    });
    expect(replaced.map((item) => (item as { id: string }).id)).toEqual([
      'gamma',
      'alpha',
      'new',
      'beta',
    ]);
    expect(replaced.at(-1)).toEqual({ id: 'beta', label: 'Edited' });
    const removed = applySemanticCollectionOperation(replaced, {
      kind: 'remove',
      id: 'alpha',
      before: original[0]!,
    });
    expect(removed.map((item) => (item as { id: string }).id)).toEqual(['gamma', 'new', 'beta']);
  });

  it('rejects stale item edits, deleted items, removed anchors and duplicate IDs', () => {
    const latest = applySemanticCollectionOperation(original, {
      kind: 'remove',
      id: 'beta',
      before: original[1]!,
    });
    expect(() =>
      applySemanticCollectionOperation(latest, {
        kind: 'replace',
        id: 'beta',
        before: original[1]!,
        after: { id: 'beta', label: 'Lost' },
      }),
    ).toThrow(/removed/u);
    expect(() =>
      applySemanticCollectionOperation(latest, {
        kind: 'move',
        id: 'gamma',
        beforeId: 'beta',
      }),
    ).toThrow(/anchor/u);
    expect(() =>
      applySemanticCollectionOperation(original, {
        kind: 'replace',
        id: 'alpha',
        before: { id: 'alpha', label: 'Old' },
        after: { id: 'alpha', label: 'Stale' },
      }),
    ).toThrow(/changed/u);
    expect(() =>
      applySemanticCollectionOperation(original, {
        kind: 'insert',
        item: { id: 'alpha', label: 'Duplicate' },
      }),
    ).toThrow(/already exists/u);
    expect(original).toHaveLength(3);
  });
});
