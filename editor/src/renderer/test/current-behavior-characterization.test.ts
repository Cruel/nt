import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { useCommandStore } from '@/commands/command-store';
import { deleteEntityRecordPreflight } from '@/project/entity-operations';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';
import { defaultRoomData, roomRoomRef } from '../../shared/project-schema/authoring-rooms';

describe('current-behavior characterization', () => {
  it('pins ReferenceIndex output and delete preflight to the same usage records', () => {
    const project = createAuthoringProject();
    const foyer = defaultRoomData('Foyer');
    foyer.exits = [
      {
        id: 'north',
        label: 'North',
        direction: 'north',
        target: roomRoomRef('hall'),
        condition: { kind: 'always' },
        onRejected: [],
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: foyer };
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };

    const referenceIndex = buildReferenceIndex(project);
    const usages = findUsages(referenceIndex, { collection: 'rooms', id: 'hall' });
    expect(usages).toEqual([
      {
        sourceCollection: 'rooms',
        sourceId: 'foyer',
        path: '/rooms/foyer/data/exits/0/target/$ref',
        kind: 'explicit-ref',
        target: { collection: 'rooms', id: 'hall' },
      },
    ]);
    expect(
      deleteEntityRecordPreflight({ collection: 'rooms', id: 'hall' }, referenceIndex),
    ).toEqual({
      target: { collection: 'rooms', id: 'hall' },
      usages,
      canDeleteWithoutForce: false,
    });
  });
});

describe('authoritative document route behavior', () => {
  beforeEach(() => {
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
  });

  it('publishes command, transaction cancel, undo, and redo replacements through the project store', () => {
    useProjectStore.getState().loadProjectDocument({
      document: { rooms: { foyer: { label: 'Foyer' } } },
      projectPath: '/project',
      projectFilePath: '/project/game.json',
    });
    const first = useCommandStore.getState().executeCommand({
      type: 'project.replaceAtPath',
      label: 'Rename',
      payload: { path: '/rooms/foyer/label', value: 'Hall' },
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    expect(first.ok).toBe(true);
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Hall' } },
    });

    useCommandStore.getState().beginTransaction({
      label: 'Temporary rename',
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    const step = useCommandStore.getState().executeCommand({
      type: 'project.replaceAtPath',
      label: 'Temporary rename',
      payload: { path: '/rooms/foyer/label', value: 'Temporary' },
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    expect(step.ok).toBe(true);
    useCommandStore.getState().cancelTransaction();
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Hall' } },
    });

    expect(useCommandStore.getState().undo().ok).toBe(true);
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Foyer' } },
    });
    expect(useCommandStore.getState().redo().ok).toBe(true);
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Hall' } },
    });
  });
});
