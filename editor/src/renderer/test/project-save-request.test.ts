import { describe, expect, it } from 'vite-plus/test';
import { buildRecoveryFileOwnershipHints } from '@/project/project-save-request';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import type { EditorRecoveryState } from '../../shared/project-schema/editor-project-state';
import { toJsonValue } from '@/project/json-value';

function recoveryFor(saveUnitId: string, affectedPaths: string[]): EditorRecoveryState {
  return {
    sequence: 1,
    saveUnitsById: {
      [saveUnitId]: {
        sequence: 1,
        patches: [],
        affectedPaths,
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
        baselineFileRevisions: {},
      },
    },
  };
}

describe('project save request ownership hints', () => {
  it('includes project.json for a Room-owned exact Interactable Instance mutation', () => {
    const baseline = createAuthoringProject();
    baseline.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    baseline.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
    };
    const candidate = structuredClone(baseline);
    candidate.interactableInstances['key-instance'] = defaultInteractableInstanceData(
      'key-instance',
      'key',
      { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
    );

    expect(
      buildRecoveryFileOwnershipHints({
        recovery: recoveryFor('record:rooms:foyer', ['/interactableInstances/key-instance']),
        baselineDocument: toJsonValue(baseline),
        candidateDocument: toJsonValue(candidate),
      })['record:rooms:foyer'],
    ).toEqual(['editor.json', 'project.json', 'records/rooms/foyer.json']);
  });

  it('uses traits.json for the Traits collection save unit', () => {
    const baseline = createAuthoringProject();
    const candidate = structuredClone(baseline);
    candidate.traits.inspectable = {
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['interactable'],
      properties: [],
    };

    expect(
      buildRecoveryFileOwnershipHints({
        recovery: recoveryFor('collection:traits', ['/traits/inspectable']),
        baselineDocument: toJsonValue(baseline),
        candidateDocument: toJsonValue(candidate),
      })['collection:traits'],
    ).toEqual(['traits.json']);
  });
});
