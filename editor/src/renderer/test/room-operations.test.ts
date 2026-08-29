import { describe, expect, it } from 'vite-plus/test';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import { defaultInteractionProgram } from '../../shared/project-schema/authoring-interaction-programs';
import { defaultRoomData, roomRoomRef } from '../../shared/project-schema/authoring-rooms';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';

describe('room commands', () => {
  it('creates typed room data through entity.createRecord', () => {
    const project = createAuthoringProject();
    const state = createInitialCommandBusState(toJsonValue(project));

    const result = executeCommand(state, {
      type: 'entity.createRecord',
      payload: { collection: 'rooms', entityId: 'foyer', label: 'Foyer' },
    });

    expect(result.ok).toBe(true);
    expect(result.document).toMatchObject({
      rooms: { foyer: { data: { kind: 'room', displayName: 'Foyer', exits: [], placements: [] } } },
    });
  });

  it('patches valid room data and rejects error diagnostics', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    let state = createInitialCommandBusState(toJsonValue(project));

    const invalidData = defaultRoomData('Foyer');
    invalidData.exits = [
      {
        id: 'north',
        label: 'North',
        direction: 'north',
        target: roomRoomRef('missing'),
        condition: { kind: 'always' },
        onRejected: [],
      },
    ];
    const invalid = executeCommand(state, {
      type: 'room.replaceData',
      payload: { roomId: 'foyer', data: invalidData },
    });
    expect(invalid.ok).toBe(false);

    const next = defaultRoomData('Foyer');
    next.description.source = { kind: 'inline', text: 'Welcome to the foyer.' };
    const valid = executeCommand(state, {
      type: 'room.replaceData',
      label: 'Set room description',
      payload: { roomId: 'foyer', data: next },
    });
    expect(valid.ok).toBe(true);
    expect(valid.document).toMatchObject({
      rooms: { foyer: { data: { description: { source: { text: 'Welcome to the foyer.' } } } } },
    });

    state = valid.state;
    expect(undoCommand(state).document).toMatchObject({
      rooms: { foyer: { data: { description: { source: { text: '' } } } } },
    });
  });

  it('repairs Room presentation occurrences without rewriting semantic Locations', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'lamp-placement',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    const lamp = defaultInteractableData('Lamp');
    room.interactables = [
      {
        id: 'lamp',
        interactable: { $ref: { registry: 'interactableInstances', id: 'lamp' } },
        condition: { kind: 'always' },
        placementId: 'lamp-placement',
        visible: true,
        order: 0,
      },
    ];
    const guard = defaultCharacterData('Guard');
    guard.initialWorldState.location = {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'foyer' } },
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.lamp = { id: 'lamp', label: 'Lamp', data: lamp };
    project.interactableInstances.lamp = defaultInteractableInstanceData('lamp', 'lamp', {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'foyer' } },
    });
    project.characters.guard = { id: 'guard', label: 'Guard', data: guard };
    let state = createInitialCommandBusState(toJsonValue(project));

    const renamed = structuredClone(room);
    renamed.placements[0].id = 'lamp-anchor';
    const renameResult = executeCommand(state, {
      type: 'room.replaceData',
      payload: { roomId: 'foyer', data: renamed },
    });
    expect(renameResult.ok, JSON.stringify(renameResult.diagnostics, null, 2)).toBe(true);
    expect(renameResult.document).toMatchObject({
      rooms: {
        foyer: {
          data: {
            interactables: [expect.objectContaining({ id: 'lamp', placementId: 'lamp-anchor' })],
          },
        },
      },
    });
    expect(renameResult.document).toMatchObject({
      characters: {
        guard: {
          data: {
            initialWorldState: {
              location: {
                kind: 'room',
                room: { $ref: { collection: 'rooms', id: 'foyer' } },
              },
            },
          },
        },
      },
    });

    state = renameResult.state;
    const removed = structuredClone(renamed);
    removed.placements = [];
    const removeResult = executeCommand(state, {
      type: 'room.replaceData',
      payload: { roomId: 'foyer', data: removed },
    });
    expect(removeResult.ok).toBe(true);
    expect(removeResult.document).toMatchObject({
      rooms: { foyer: { data: { interactables: [] } } },
    });
    expect(removeResult.document).toMatchObject({
      characters: {
        guard: {
          data: {
            initialWorldState: {
              location: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
            },
          },
        },
      },
    });
  });

  it('repairs Room-local placement references without coupling Interaction resolution to placement state', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'anchor',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.cast = [
      {
        id: 'guard-cast',
        character: { $ref: { collection: 'characters', id: 'guard' } },
        condition: { kind: 'always' },
        placementId: 'anchor',
        poseId: null,
        expressionId: null,
        idleId: null,
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.characters.guard = { id: 'guard', label: 'Guard', data: defaultCharacterData('Guard') };

    const verb = defaultVerbData('Use');
    const slotText = {
      source: { kind: 'inline' as const, text: 'subject' },
      markup: 'plain' as const,
    };
    verb.slots = [
      {
        id: 'subject',
        label: slotText,
        prompt: slotText,
        selectors: [{ kind: 'family', family: 'interactable' }],
      },
    ];
    verb.bindingOrder = ['subject'];
    project.verbs.use = { id: 'use', label: 'Use', data: verb };
    const interaction = defaultInteractionData();
    const program = defaultInteractionProgram();
    program.instructions = [
      {
        id: 'move',
        kind: 'move-instance',
        subject: {
          kind: 'interactable',
          interactable: { $ref: { registry: 'interactableInstances', id: 'lamp' } },
        },
        location: {
          kind: 'room',
          room: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
        },
      },
    ];
    interaction.rules = [
      {
        id: 'use-lamp',
        verb: { $ref: { collection: 'verbs', id: 'use' } },
        slots: [
          {
            slotId: 'subject',
            selectors: [{ kind: 'family', family: 'interactable' }],
          },
        ],
        offer: null,
        guard: { kind: 'always' },
        priority: 0,
        program,
      },
    ];
    project.interactions['use-lamp'] = { id: 'use-lamp', label: 'Use Lamp', data: interaction };
    project.interactables.lamp = {
      id: 'lamp',
      label: 'Lamp',
      data: defaultInteractableData('Lamp'),
    };
    let state = createInitialCommandBusState(toJsonValue(project));

    const renamed = structuredClone(room);
    renamed.placements[0].id = 'renamed-anchor';
    const renameResult = executeCommand(state, {
      type: 'room.replaceData',
      payload: { roomId: 'foyer', data: renamed },
    });
    expect(renameResult.ok, JSON.stringify(renameResult.diagnostics, null, 2)).toBe(true);
    expect(renameResult.document).toMatchObject({
      rooms: { foyer: { data: { cast: [{ placementId: 'renamed-anchor' }] } } },
      interactions: {
        'use-lamp': {
          data: {
            rules: [
              {
                guard: { kind: 'always' },
                program: {
                  instructions: [
                    {
                      location: {
                        kind: 'room',
                        room: {
                          kind: 'room',
                          room: { $ref: { collection: 'rooms', id: 'foyer' } },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    state = renameResult.state;
    const removed = structuredClone(renamed);
    removed.placements = [];
    removed.cast = [];
    const removeResult = executeCommand(state, {
      type: 'room.replaceData',
      payload: { roomId: 'foyer', data: removed },
    });
    expect(removeResult.ok, JSON.stringify(removeResult.diagnostics, null, 2)).toBe(true);
  });
});
