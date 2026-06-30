import { describe, expect, it } from 'vitest';
import { selectProjectDirty, useProjectStore } from '@/project/project-store';

describe('project store selectors', () => {
  it('derives dirty state from history cursor and saved cursor', () => {
    expect(selectProjectDirty({ document: { room: {} }, historyCursor: -1, savedHistoryCursor: -1 })).toBe(false);
    expect(selectProjectDirty({ document: { room: {} }, historyCursor: 0, savedHistoryCursor: -1 })).toBe(true);
    expect(selectProjectDirty({ document: { room: {} }, historyCursor: 0, savedHistoryCursor: 0 })).toBe(false);
    expect(selectProjectDirty({ document: null, historyCursor: 0, savedHistoryCursor: -1 })).toBe(false);
  });

  it('tracks a saved document snapshot separately from the current document', () => {
    const store = useProjectStore.getState();
    store.loadProjectDocument({
      document: { room: { foyer: ['foyer', 'old'] } },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    expect(useProjectStore.getState().savedDocument).toEqual({ room: { foyer: ['foyer', 'old'] } });

    useProjectStore.getState().replaceDocumentFromCommand({ room: { foyer: ['foyer', 'new'] } }, 0);
    expect(useProjectStore.getState().document).toEqual({ room: { foyer: ['foyer', 'new'] } });
    expect(useProjectStore.getState().savedDocument).toEqual({ room: { foyer: ['foyer', 'old'] } });

    useProjectStore.getState().markSaved();
    expect(useProjectStore.getState().savedDocument).toEqual({ room: { foyer: ['foyer', 'new'] } });
  });

  it('uses no saved baseline for unsaved new projects', () => {
    useProjectStore.getState().loadUnsavedProjectDocument({ room: { foyer: ['foyer'] } });
    expect(useProjectStore.getState().savedDocument).toBeNull();
    expect(selectProjectDirty(useProjectStore.getState())).toBe(true);
  });
});
