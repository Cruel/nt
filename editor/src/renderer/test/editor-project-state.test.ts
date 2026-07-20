import { describe, expect, it } from 'vite-plus/test';
import {
  EDITOR_PROJECT_STATE_SCHEMA_VERSION,
  emptyEditorProjectState,
  editorProjectStateSchema,
  legacyLastSuccessfulPlatformExportIdentity,
  parseEditorProjectState,
  parseEditorProjectStateWithDiagnostics,
  stripEditorProjectState,
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
    expect(parsed.schemaVersion).toBe(EDITOR_PROJECT_STATE_SCHEMA_VERSION);
    expect(parsed.recovery).toEqual({ sequence: 0, saveUnitsById: {} });
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

  it('isolates invalid recovery entries while preserving valid entries', () => {
    const value = {
      ...emptyEditorProjectState('a'.repeat(64)),
      recovery: {
        sequence: 4,
        saveUnitsById: {
          'record:rooms:foyer': {
            sequence: 3,
            patches: [
              {
                op: 'replace',
                path: '/rooms/foyer/label',
                value: 'Recovered Foyer',
              },
            ],
            affectedPaths: ['/rooms/foyer/label'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: ['atomic:3'],
          },
          'record:rooms:broken': {
            sequence: 4,
            patches: [{ op: 'replace', path: '/editor/tags', value: {} }],
            affectedPaths: ['/editor/tags'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
        },
      },
    };

    const parsed = parseEditorProjectStateWithDiagnostics(value, 'a'.repeat(64));

    expect(Object.keys(parsed.state.recovery.saveUnitsById)).toEqual(['record:rooms:foyer']);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'editor.recovery.entry.invalid',
        severity: 'warning',
        path: '/editor/recovery/saveUnitsById/record:rooms:broken',
      }),
    );
  });

  it('round-trips complete v2 recovery and export identity metadata', () => {
    const state = {
      ...emptyEditorProjectState('d'.repeat(64)),
      lastSuccessfulPlatformExportIdentity: {
        applicationId: 'com.example.story',
        saveNamespace: 'story-save',
        completedAt: '2026-07-19T20:00:00.000Z',
      },
      recovery: {
        sequence: 7,
        saveUnitsById: {
          'record:rooms:foyer': {
            sequence: 7,
            patches: [{ op: 'remove' as const, path: '/rooms/foyer/data/exits/0' }],
            affectedPaths: ['/rooms/foyer/data/exits/0'],
            pendingRawInputByPath: {
              '/rooms/foyer/data/exits/0/label': {
                value: '',
                diagnosticCode: 'authoring.schema.too_small',
              },
            },
            atomicTransactionGroupIds: ['atomic:7'],
          },
        },
      },
    };

    const serialized = JSON.parse(JSON.stringify(editorProjectStateSchema.parse(state)));
    const parsed = parseEditorProjectStateWithDiagnostics(serialized, 'd'.repeat(64));

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.state).toEqual(state);
  });

  it('migrates legacy content identity into metadata without retaining a content field', () => {
    const legacy = {
      schema: 'noveltea.authoring.project',
      schemaVersion: 2,
      settings: {
        app: {
          applicationId: 'org.example.legacy',
          saveNamespace: 'legacy-saves',
          lastExportedIdentity: {
            applicationId: 'org.example.previous',
            saveNamespace: 'previous-saves',
          },
        },
      },
    };

    expect(legacyLastSuccessfulPlatformExportIdentity(legacy)).toEqual({
      applicationId: 'org.example.previous',
      saveNamespace: 'previous-saves',
    });
    expect(stripEditorProjectState(legacy)).not.toHaveProperty('settings.app.lastExportedIdentity');
  });

  it('rejects recovery operations outside content paths or with unsupported operations', () => {
    const base = emptyEditorProjectState('b'.repeat(64));
    expect(
      editorProjectStateSchema.safeParse({
        ...base,
        recovery: {
          sequence: 1,
          saveUnitsById: {
            invalid: {
              sequence: 1,
              patches: [{ op: 'replace', path: '/editor/workbench', value: {} }],
              affectedPaths: ['/editor/workbench'],
              pendingRawInputByPath: {},
              atomicTransactionGroupIds: [],
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      editorProjectStateSchema.safeParse({
        ...base,
        recovery: {
          sequence: 1,
          saveUnitsById: {
            invalid: {
              sequence: 1,
              patches: [{ op: 'move', path: '/rooms/a', from: '/rooms/b' }],
              affectedPaths: ['/rooms/a'],
              pendingRawInputByPath: {},
              atomicTransactionGroupIds: [],
            },
          },
        },
      }).success,
    ).toBe(false);
  });
});
