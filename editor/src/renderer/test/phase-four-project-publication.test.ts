import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import {
  classifyAssetReverseDependencies,
  classifyAuthoringGraphMutation,
} from '../../shared/authoring-graph-input-classifier';

describe('Phase 4 authoritative project publication', () => {
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

  it('classifies exact field and reverse source-resolution impacts without graph diffing', () => {
    const indexes = {
      contributionKeysByOwnerPath: new Map([['/layouts/main', ['record:layouts:main']]]),
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
    expect(classifyAssetReverseDependencies('layout-script', 'path', indexes)).toEqual([
      'record:layouts:main',
    ]);
    expect(classifyAssetReverseDependencies('layout-script', 'contentHash', indexes)).toEqual([
      'record:layouts:main',
    ]);
  });
});
