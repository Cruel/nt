import { describe, expect, it } from 'vitest';
import { buildProjectTree } from '@/stores/workspace-store';

describe('workspace project tree', () => {
  it('groups project entities and playback tests', () => {
    const tree = buildProjectTree(
      {
        room: { foyer: ['foyer'] },
        object: { lamp: ['lamp'] },
      },
      [{ id: 'smoke', steps: 2 }],
    );

    expect(tree.find((node) => node.id === 'room')?.children?.[0]?.id).toBe('room:foyer');
    expect(tree.find((node) => node.id === 'object')?.children?.[0]?.id).toBe('object:lamp');
    expect(tree.find((node) => node.id === 'tests')?.children?.[0]?.label).toBe('smoke (2)');
  });
});
