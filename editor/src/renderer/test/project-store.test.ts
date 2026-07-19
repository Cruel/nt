import { describe, expect, it } from 'vite-plus/test';
import { selectProjectDirty, useProjectStore } from '@/project/project-store';

describe('project store selectors', () => {
  it('derives dirty state from the saved document baseline', () => {
    expect(selectProjectDirty({ document: { room: {} }, savedDocument: { room: {} } })).toBe(false);
    expect(
      selectProjectDirty({
        document: { room: { foyer: {} } },
        savedDocument: { room: {} },
      }),
    ).toBe(true);
    expect(selectProjectDirty({ document: null, savedDocument: { room: {} } })).toBe(false);
    expect(selectProjectDirty({ document: { room: {} }, savedDocument: null })).toBe(true);
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

  it('does not replace the live document with save-only metadata snapshots', () => {
    const store = useProjectStore.getState();
    store.loadProjectDocument({
      document: {
        schema: 'noveltea.authoring.project',
        editor: { workbench: null },
        rooms: { foyer: { label: 'Foyer' } },
      },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    store.markSaved({
      document: {
        schema: 'noveltea.authoring.project',
        editor: { workbench: { tabsById: { stale: {} } } },
        rooms: { foyer: { label: 'Foyer' } },
      },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    expect(useProjectStore.getState().document).toEqual({
      schema: 'noveltea.authoring.project',
      editor: { workbench: null },
      rooms: { foyer: { label: 'Foyer' } },
    });
    expect(useProjectStore.getState().savedDocument).toEqual({
      schema: 'noveltea.authoring.project',
      editor: { workbench: { tabsById: { stale: {} } } },
      rooms: { foyer: { label: 'Foyer' } },
    });
  });

  it('uses no saved baseline for unsaved new projects', () => {
    useProjectStore.getState().loadUnsavedProjectDocument({ room: { foyer: ['foyer'] } });
    expect(useProjectStore.getState().savedDocument).toBeNull();
    expect(selectProjectDirty(useProjectStore.getState())).toBe(true);
  });
});
