import { describe, expect, it } from 'vite-plus/test';
import {
  emptyEditorProjectState,
  parseEditorProjectState,
} from '../../shared/project-schema/editor-project-state';

describe('editor project state defaults', () => {
  it('parses old editor state with explorer, chapter, and bottom panel defaults', () => {
    const parsed = parseEditorProjectState({
      schema: 'noveltea.editor.project-state',
      schemaVersion: 1,
      tabStatesById: {},
      draftsByKey: {},
    });
    expect(parsed.explorer).toEqual({
      expandedNodeIds: [],
      hiddenCollectionKeys: [],
      followActiveTab: true,
      organizeByChapter: true,
      groupUnassignedItems: true,
      hideEmptyCategories: false,
      showInfoOnHover: true,
      searchQuery: '',
      filterTags: [],
      showTagFilter: false,
      exactMatch: false,
    });
    expect(parsed.chapters).toEqual({ records: {}, assignments: {} });
    expect(parsed.bottomPanel).toEqual({
      visible: true,
      activePanelId: 'problems',
      sizePercent: 30,
    });
  });

  it('empty editor state includes explorer, chapters, and bottom panel', () => {
    expect(emptyEditorProjectState()).toMatchObject({
      explorer: {
        followActiveTab: true,
        organizeByChapter: true,
        groupUnassignedItems: true,
        hideEmptyCategories: false,
      },
      chapters: { records: {}, assignments: {} },
      bottomPanel: { visible: true, activePanelId: 'problems' },
    });
  });

  it('accepts persisted image-generation tab resources', () => {
    const parsed = parseEditorProjectState({
      schema: 'noveltea.editor.project-state',
      schemaVersion: 1,
      workbench: {
        layout: { kind: 'group', groupId: 'group:main' },
        groupsById: {
          'group:main': {
            id: 'group:main',
            tabIds: ['tab:image-generation'],
            activeTabId: 'tab:image-generation',
          },
        },
        tabsById: {
          'tab:image-generation': {
            id: 'tab:image-generation',
            title: 'Generate Image',
            editorType: 'image-generation',
            resource: {
              kind: 'project',
              stableId: 'utility:image-generation',
              collection: 'assets',
              generationMode: 'generate',
            },
          },
        },
        activeGroupId: 'group:main',
      },
      tabStatesById: {},
      draftsByKey: {},
    });

    expect(parsed.workbench?.tabsById['tab:image-generation']?.resource?.generationMode).toBe(
      'generate',
    );
  });
});
