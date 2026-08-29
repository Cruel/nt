import { describe, expect, it } from 'vite-plus/test';
import {
  emptyEditorProjectState,
  editorProjectStateSchema,
  parseEditorProjectState,
  parseEditorProjectStateWithDiagnostics,
} from '../../shared/project-schema/editor-project-state';

describe('editor project state defaults', () => {
  it('creates fresh metadata without a warning when metadata is absent', () => {
    const parsed = parseEditorProjectStateWithDiagnostics(undefined);

    expect(parsed.state).toEqual(emptyEditorProjectState());
    expect(parsed.diagnostics).toEqual([]);
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

  it('accepts the persisted Asset Performance bottom-panel identity', () => {
    const state = emptyEditorProjectState();
    state.bottomPanel = {
      visible: true,
      activePanelId: 'asset-performance',
      sizePercent: 36,
    };

    expect(editorProjectStateSchema.parse(state).bottomPanel).toEqual({
      visible: true,
      activePanelId: 'asset-performance',
      sizePercent: 36,
    });
  });

  it('accepts persisted image-generation tab resources in current metadata', () => {
    const parsed = parseEditorProjectState({
      ...emptyEditorProjectState(),
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
    });

    expect(parsed.workbench?.tabsById['tab:image-generation']?.resource?.generationMode).toBe(
      'generate',
    );
  });

  it('discards metadata carrying the retired version field', () => {
    const parsed = parseEditorProjectStateWithDiagnostics({
      schema: 'noveltea.editor.project-state',
      schemaVersion: 1,
      explorer: { searchQuery: 'must not survive' },
    });

    expect(parsed.state).toEqual(emptyEditorProjectState());
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'editor.metadata.invalid',
        severity: 'warning',
        path: '/editor',
        ownerPaths: ['/editor'],
      }),
    );
  });

  it.each([undefined, 2, 4])(
    'discards metadata with retired schemaVersion value %s',
    (schemaVersion) => {
      const parsed = parseEditorProjectStateWithDiagnostics({
        schema: 'noveltea.editor.project-state',
        schemaVersion,
      });

      expect(parsed.state).toEqual(emptyEditorProjectState());
      expect(parsed.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'editor.metadata.invalid',
          path: '/editor',
          ownerPaths: ['/editor'],
        }),
      );
    },
  );

  it.each([
    { ...emptyEditorProjectState(), schema: 'other.editor.state' },
    { ...emptyEditorProjectState(), unexpected: true },
    { ...emptyEditorProjectState(), recovery: { sequence: 'invalid', saveUnitsById: {} } },
    {
      ...emptyEditorProjectState(),
      explorer: { ...emptyEditorProjectState().explorer, searchQuery: 'must not survive' },
      recovery: { sequence: 0, saveUnitsById: [] },
    },
  ])('discards malformed current metadata without salvaging fields', (value) => {
    const parsed = parseEditorProjectStateWithDiagnostics(value);

    expect(parsed.state).toEqual(emptyEditorProjectState());
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'editor.metadata.invalid',
        severity: 'warning',
        path: '/editor',
        ownerPaths: ['/editor'],
      }),
    );
  });

  it('isolates invalid recovery entries while preserving valid entries', () => {
    const value = {
      ...emptyEditorProjectState(),
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
            patches: [{ op: 'replace', path: '/editor/workbench', value: {} }],
            affectedPaths: ['/editor/workbench'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
          '': {
            sequence: 4,
            patches: [],
            affectedPaths: [],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
        },
      },
    };

    const parsed = parseEditorProjectStateWithDiagnostics(value);

    expect(Object.keys(parsed.state.recovery.saveUnitsById)).toEqual(['record:rooms:foyer']);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'editor.recovery.entry.invalid',
        severity: 'warning',
        path: '/editor/recovery/saveUnitsById/record:rooms:broken',
      }),
    );
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'editor.recovery.entry.invalid',
        severity: 'warning',
        path: '/editor/recovery/saveUnitsById/',
      }),
    );
  });

  it('accepts recovery patches for tracked editor.json organization paths', () => {
    const value = {
      ...emptyEditorProjectState(),
      recovery: {
        sequence: 1,
        saveUnitsById: {
          'project:tags': {
            sequence: 1,
            patches: [{ op: 'replace', path: '/editor/tags', value: { records: {} } }],
            affectedPaths: ['/editor/tags'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
        },
      },
    };

    const parsed = parseEditorProjectStateWithDiagnostics(value);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.state.recovery.saveUnitsById['project:tags']).toMatchObject({
      affectedPaths: ['/editor/tags'],
    });
  });

  it('round-trips complete recovery and export identity metadata', () => {
    const state = {
      ...emptyEditorProjectState(),
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
    const parsed = parseEditorProjectStateWithDiagnostics(serialized);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.state).toEqual(state);
  });

  it('rejects recovery operations outside content paths or with unsupported operations', () => {
    const base = emptyEditorProjectState();
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
