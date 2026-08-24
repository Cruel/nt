import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import {
  classifyAssetReverseDependencies,
  classifyAuthoringGraphMutation,
} from '../../shared/authoring-graph-input-classifier';

describe('authoritative project publication', () => {
  beforeEach(() => {
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
  });

  it('rejects structurally invalid project-file candidates atomically', () => {
    expect(
      useProjectStore.getState().loadProjectDocument({
        document: { schema: 'noveltea.authoring.project', rooms: [] },
        projectPath: '/mock',
        projectFilePath: '/mock/game.json',
      }),
    ).toBe(false);
    expect(useProjectStore.getState()).toMatchObject({
      document: null,
      savedDocument: null,
      projectRevision: 0,
      projectInstanceId: null,
      lastMutationPublication: null,
      historyCursor: -1,
    });
  });

  it('publishes immutable exact old/new documents and monotonic revisions', () => {
    expect(
      useProjectStore
        .getState()
        .loadUnsavedProjectDocument({ rooms: { foyer: { label: 'Foyer' } } }),
    ).toBe(true);
    const load = useProjectStore.getState();
    expect(load.projectRevision).toBe(1);
    expect(load.lastMutationPublication?.changeSet.kind).toBe('load');
    const firstProject = load.admittedProject;

    const result = useCommandStore.getState().executeCommand({
      type: 'project.replaceAtPath',
      payload: { path: '/rooms/foyer/label', value: 'Hall' },
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    expect(result.ok).toBe(true);
    const changed = useProjectStore.getState();
    expect(changed.projectRevision).toBe(2);
    expect(changed.lastMutationPublication).toMatchObject({
      previousProject: firstProject,
      changeSet: {
        kind: 'command',
        projectRevision: 2,
        affectedPaths: ['/rooms/foyer/label'],
      },
    });
    expect(Object.isFrozen(changed.document)).toBe(true);

    changed.markSaved({ projectPath: '/new', projectFilePath: '/new/game.json' });
    expect(useProjectStore.getState().projectRevision).toBe(2);
    expect(useProjectStore.getState().lastMutationPublication).toBe(
      changed.lastMutationPublication,
    );
  });

  it('publishes an external create/delete candidate as one normal replace revision', () => {
    expect(
      useProjectStore.getState().loadProjectDocument({
        document: { rooms: { foyer: { label: 'Foyer' } } },
        savedDocument: { rooms: { foyer: { label: 'Foyer' } } },
        projectPath: '/mock',
        projectFilePath: '/mock/project.json',
        workspaceRevision: `sha256:${'0'.repeat(64)}`,
        fileRevisions: {},
      }),
    ).toBe(true);
    const before = useProjectStore.getState();

    expect(
      before.publishExternalReconciliation({
        document: { rooms: { hall: { label: 'Hall' } } },
        savedDocument: { rooms: { hall: { label: 'Hall' } } },
        workspaceRevision: `sha256:${'1'.repeat(64)}`,
        fileRevisions: {},
        scriptSourcePaths: {},
        affectedPaths: ['/rooms/foyer', '/rooms/hall'],
      }),
    ).toBe(true);

    const published = useProjectStore.getState();
    expect(published.projectRevision).toBe(before.projectRevision + 1);
    expect(published.document).toEqual({ rooms: { hall: { label: 'Hall' } } });
    expect(published.savedDocument).toEqual({ rooms: { hall: { label: 'Hall' } } });
    expect(published.lastMutationPublication).toMatchObject({
      previousProject: before.admittedProject,
      changeSet: {
        kind: 'replace',
        affectedPaths: ['/rooms/foyer', '/rooms/hall'],
      },
    });
  });

  it("publishes each transaction step with only that step's exact affected paths", () => {
    expect(
      useProjectStore.getState().loadUnsavedProjectDocument({
        rooms: { foyer: { label: 'Foyer', description: 'Before' } },
      }),
    ).toBe(true);
    useCommandStore.getState().beginTransaction({
      label: 'Edit room metadata',
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });

    expect(
      useCommandStore.getState().executeCommand({
        type: 'project.replaceAtPath',
        payload: { path: '/rooms/foyer/label', value: 'Hall' },
        originSaveUnitId: 'record:rooms:foyer',
        persistencePolicy: 'manual-save',
      }).ok,
    ).toBe(true);
    expect(useProjectStore.getState().lastMutationPublication?.changeSet).toMatchObject({
      kind: 'transaction-step',
      projectRevision: 2,
      affectedPaths: ['/rooms/foyer/label'],
    });

    expect(
      useCommandStore.getState().executeCommand({
        type: 'project.replaceAtPath',
        payload: { path: '/rooms/foyer/description', value: 'After' },
        originSaveUnitId: 'record:rooms:foyer',
        persistencePolicy: 'manual-save',
      }).ok,
    ).toBe(true);
    const beforeCommit = useProjectStore.getState().lastMutationPublication;
    expect(beforeCommit?.changeSet).toMatchObject({
      kind: 'transaction-step',
      projectRevision: 3,
      affectedPaths: ['/rooms/foyer/description'],
    });

    expect(useCommandStore.getState().commitTransaction().ok).toBe(true);
    expect(useProjectStore.getState().projectRevision).toBe(3);
    expect(useProjectStore.getState().lastMutationPublication).toBe(beforeCommit);
  });

  it('classifies exact field and reverse source-resolution impacts without graph diffing', () => {
    const indexes = {
      contributionKeysByOwnerPath: new Map([
        ['/layouts/main', ['record:layouts:main']],
        ['/shaders/world', ['record:shaders:world']],
      ]),
      contributionKeysByDerivationKey: new Map([
        [JSON.stringify(['source-resolution-asset', 'layout-script']), ['record:layouts:main']],
        [JSON.stringify(['source-asset', 'layout-script']), ['record:layouts:main']],
      ]),
    };
    expect(classifyAuthoringGraphMutation(['/layouts/main/description'], indexes)).toEqual({
      kind: 'graph-stable',
    });
    expect(classifyAuthoringGraphMutation(['/layouts/main/data/rml/sourceText'], indexes)).toEqual({
      kind: 'incremental',
      contributionKeys: ['record:layouts:main'],
      sourceAnalysisOwnerKeys: ['record:layouts:main'],
      symbolProjectionOwnerKeys: [],
    });
    expect(classifyAuthoringGraphMutation(['/layouts/main/data/lua/sourceText'], indexes)).toEqual({
      kind: 'incremental',
      contributionKeys: ['record:layouts:main'],
      sourceAnalysisOwnerKeys: ['record:layouts:main'],
      symbolProjectionOwnerKeys: [],
    });
    expect(classifyAuthoringGraphMutation(['/layouts/main/data/rcss/sourceText'], indexes)).toEqual(
      { kind: 'graph-stable' },
    );
    expect(
      classifyAuthoringGraphMutation(['/shaders/world/data/stages/0/sourceText'], indexes),
    ).toEqual({ kind: 'graph-stable' });
    expect(classifyAssetReverseDependencies('layout-script', 'path', indexes)).toEqual([
      'record:layouts:main',
    ]);
    expect(classifyAssetReverseDependencies('layout-script', 'contentHash', indexes)).toEqual([
      'record:layouts:main',
    ]);
    expect(classifyAssetReverseDependencies('layout-script', 'extension', indexes)).toEqual([
      'record:layouts:main',
    ]);
  });

  it('executes value-dependent classifiers from old and new admitted values', () => {
    const indexes = {
      contributionKeysByOwnerPath: new Map([['/rooms/foyer', ['record:rooms:foyer']]]),
      contributionKeysByDerivationKey: new Map([
        [JSON.stringify(['localization-lookup', 'room.foyer']), ['record:rooms:foyer']],
        [JSON.stringify(['project-field', '/localization/defaultLocale']), ['record:rooms:foyer']],
      ]),
    };
    const previousProject = {
      rooms: { foyer: { properties: { mood: 'calm' } } },
      assets: { background: { data: { contentHash: `sha256:${'0'.repeat(64)}` } } },
      localization: { defaultLocale: 'en', catalogs: { en: { 'room.foyer': 'Foyer' } } },
    };
    const project = {
      rooms: { foyer: { properties: { mood: 'tense', pose: 'standing' } } },
      assets: { background: { data: { contentHash: `sha256:${'1'.repeat(64)}` } } },
      localization: {
        defaultLocale: 'fr',
        catalogs: { en: { 'room.foyer': 'Entry hall' }, fr: { 'room.foyer': 'Vestibule' } },
      },
    };
    expect(
      classifyAuthoringGraphMutation(['/rooms/foyer/properties/mood'], indexes, {
        previousProject,
        project,
      }),
    ).toEqual({ kind: 'graph-stable' });
    expect(
      classifyAuthoringGraphMutation(['/rooms/foyer/properties/pose'], indexes, {
        previousProject,
        project,
      }),
    ).toEqual({
      kind: 'incremental',
      contributionKeys: ['record:rooms:foyer'],
      sourceAnalysisOwnerKeys: [],
      symbolProjectionOwnerKeys: [],
    });
    expect(
      classifyAuthoringGraphMutation(['/localization/catalogs/en/room.foyer'], indexes, {
        previousProject,
        project,
      }),
    ).toEqual({ kind: 'graph-stable' });
    expect(
      classifyAuthoringGraphMutation(['/localization/defaultLocale'], indexes, {
        previousProject,
        project,
      }),
    ).toEqual({
      kind: 'incremental',
      contributionKeys: ['record:rooms:foyer'],
      sourceAnalysisOwnerKeys: [],
      symbolProjectionOwnerKeys: [],
    });
    expect(
      classifyAuthoringGraphMutation(['/assets/background/data/contentHash'], indexes, {
        previousProject,
        project,
      }),
    ).toEqual({ kind: 'graph-stable' });
  });
});
