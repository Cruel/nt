import { describe, expect, it } from 'vite-plus/test';
import { applyJsonPatch } from '@/project/json-patch';
import { toJsonValue } from '@/project/json-value';
import { renameInteractableInstancePatches } from '@/project/interactable-instance-operations';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';

describe('Interactable Instance operations', () => {
  it('renames an exact identity and rewrites registry references without changing its definition', () => {
    const project = createAuthoringProject();
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    project.interactables.note = {
      id: 'note',
      label: 'Note',
      data: defaultInteractableData('Note'),
    };
    project.interactableInstances.key = defaultInteractableInstanceData('key', 'key', {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'foyer' } },
    });
    project.interactableInstances.note = defaultInteractableInstanceData('note', 'note', {
      kind: 'inventory',
      inventory: {
        owner: {
          kind: 'interactable',
          interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
        },
        inventoryId: 'pocket',
      },
    });
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        order: 0,
        presentation: { label: null, layout: null },
      },
    ];
    room.interactables = [
      {
        id: 'key-occurrence',
        interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
        condition: { kind: 'always' },
        placementId: 'key-placement',
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };

    const patches = renameInteractableInstancePatches(project, 'key', 'brass-key');
    const renamed = applyJsonPatch(toJsonValue(project), patches).document as typeof project;

    expect(renamed.interactableInstances.key).toBeUndefined();
    expect(renamed.interactableInstances['brass-key']?.id).toBe('brass-key');
    expect(renamed.interactableInstances['brass-key']?.definition.$ref.id).toBe('key');
    expect(renamed.rooms.foyer?.data.interactables[0]?.interactable.$ref.id).toBe('brass-key');
    expect(renamed.interactableInstances.note?.location).toMatchObject({
      kind: 'inventory',
      inventory: {
        owner: {
          kind: 'interactable',
          interactable: { $ref: { registry: 'interactableInstances', id: 'brass-key' } },
        },
      },
    });
    expect(
      validateAuthoringProject(renamed).filter(
        (diagnostic) => diagnostic.code === 'authoring.record.id.key-mismatch',
      ),
    ).toEqual([]);
  });

  it('refuses a rename onto an existing exact identity', () => {
    const project = createAuthoringProject();
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    project.interactableInstances.key = defaultInteractableInstanceData('key', 'key');
    project.interactableInstances.other = defaultInteractableInstanceData('other', 'key');

    expect(renameInteractableInstancePatches(project, 'key', 'other')).toEqual([]);
  });
});
