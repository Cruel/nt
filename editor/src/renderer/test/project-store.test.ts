import { describe, expect, it } from 'vite-plus/test';
import { selectProjectDirty, useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { toJsonValue } from '@/project/json-value';

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
        editor: { workbench: null },
        rooms: { foyer: { label: 'Foyer' } },
      },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    store.markSaved({
      document: {
        editor: { workbench: { tabsById: { stale: {} } } },
        rooms: { foyer: { label: 'Foyer' } },
      },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    expect(useProjectStore.getState().document).toEqual({
      editor: { workbench: null },
      rooms: { foyer: { label: 'Foyer' } },
    });
    expect(useProjectStore.getState().savedDocument).toEqual({
      editor: { workbench: { tabsById: { stale: {} } } },
      rooms: { foyer: { label: 'Foyer' } },
    });
  });

  it('does not advance the saved content baseline for metadata-only markSaved updates', () => {
    const savedDocument = { rooms: { foyer: { label: 'Foyer' } } };
    const document = { rooms: { foyer: { label: 'Dirty Foyer' } } };
    useProjectStore.setState({
      document,
      savedDocument,
      workspaceRevision: `sha256:${'a'.repeat(64)}`,
      fileRevisions: {},
      scriptSourcePaths: {},
    });

    useProjectStore.getState().markSaved({
      workspaceRevision: `sha256:${'b'.repeat(64)}`,
      fileRevisions: { 'editor.json': `sha256:${'c'.repeat(64)}` },
    });

    expect(useProjectStore.getState().document).toEqual(document);
    expect(useProjectStore.getState().savedDocument).toEqual(savedDocument);
    expect(selectProjectDirty(useProjectStore.getState())).toBe(true);
  });

  it('persists local editor metadata without advancing tracked editor.json content', () => {
    const saved = createAuthoringProject();
    saved.editor.recordMetadata.rooms = {
      hall: { tags: [], color: null },
    };
    const working = structuredClone(saved);
    working.editor.recordMetadata.rooms!.hall!.tags = ['dirty'];
    working.editor.bottomPanel = {
      ...working.editor.bottomPanel,
      visible: false,
    };
    useProjectStore.getState().loadProjectDocument({
      document: saved,
      savedDocument: saved,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 0);

    useProjectStore.getState().markEditorMetadataPersisted(working.editor);

    const state = useProjectStore.getState();
    expect((state.document as typeof working).editor.recordMetadata.rooms?.hall?.tags).toEqual([
      'dirty',
    ]);
    expect((state.savedDocument as typeof saved).editor.recordMetadata.rooms?.hall?.tags).toEqual(
      [],
    );
    expect((state.document as typeof working).editor.bottomPanel.visible).toBe(false);
    expect((state.savedDocument as typeof saved).editor.bottomPanel.visible).toBe(false);
    expect(selectProjectDirty(state)).toBe(true);
  });

  it('refreshes workspace revisions without changing the working or saved document', () => {
    const document = { rooms: { foyer: { label: 'Dirty foyer' } } };
    const savedDocument = { rooms: { foyer: { label: 'Foyer' } } };
    useProjectStore.setState({
      document,
      savedDocument,
      workspaceRevision: `sha256:${'a'.repeat(64)}`,
      fileRevisions: {},
      scriptSourcePaths: {},
    });

    useProjectStore.getState().refreshWorkspaceMetadata({
      workspaceRevision: `sha256:${'b'.repeat(64)}`,
      fileRevisions: { 'assets/images/logo.png': `sha256:${'c'.repeat(64)}` },
      scriptSourcePaths: { startup: 'scripts/startup.lua' },
    });

    expect(useProjectStore.getState().document).toEqual(document);
    expect(useProjectStore.getState().savedDocument).toEqual(savedDocument);
    expect(selectProjectDirty(useProjectStore.getState())).toBe(true);
    expect(useProjectStore.getState().workspaceRevision).toBe(`sha256:${'b'.repeat(64)}`);
    expect(useProjectStore.getState().fileRevisions).toEqual({
      'assets/images/logo.png': `sha256:${'c'.repeat(64)}`,
    });
    expect(useProjectStore.getState().scriptSourcePaths).toEqual({
      startup: 'scripts/startup.lua',
    });
  });

  it('uses no saved baseline for unsaved new projects', () => {
    useProjectStore.getState().loadUnsavedProjectDocument({ room: { foyer: ['foyer'] } });
    expect(useProjectStore.getState().savedDocument).toBeNull();
    expect(selectProjectDirty(useProjectStore.getState())).toBe(true);
  });
});
