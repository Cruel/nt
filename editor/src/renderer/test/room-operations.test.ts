import { describe, expect, it } from 'vite-plus/test';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
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

  it('repairs Character and Interactable initial locations when placements are renamed or removed', () => {
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
    lamp.initialState.location = {
      kind: 'room-placement',
      placement: { room: 'foyer', placement: 'lamp-placement' },
    };
    const guard = defaultCharacterData('Guard');
    guard.initialWorldState.location = {
      kind: 'room-placement',
      placement: { room: 'foyer', placement: 'lamp-placement' },
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.lamp = { id: 'lamp', label: 'Lamp', data: lamp };
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
      interactables: {
        lamp: {
          data: {
            initialState: {
              location: {
                kind: 'room-placement',
                placement: { room: 'foyer', placement: 'lamp-anchor' },
              },
            },
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
                kind: 'room-placement',
                placement: { room: 'foyer', placement: 'lamp-anchor' },
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
      interactables: { lamp: { data: { initialState: { location: { kind: 'nowhere' } } } } },
    });
    expect(removeResult.document).toMatchObject({
      characters: { guard: { data: { initialWorldState: { location: { kind: 'nowhere' } } } } },
    });
  });

  it('repairs Room-local and Interaction placement references on rename and rejects unsafe removal', () => {
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
    verb.arity = 1;
    verb.operandRoles = ['subject'];
    project.verbs.use = { id: 'use', label: 'Use', data: verb };
    const interaction = defaultInteractionData();
    const program = defaultInteractionProgram();
    program.instructions = [
      {
        id: 'move',
        kind: 'move-interactable',
        interactable: { $ref: { collection: 'interactables', id: 'lamp' } },
        target: { kind: 'room-placement', placement: { room: 'foyer', placement: 'anchor' } },
      },
    ];
    interaction.rules = [
      {
        id: 'use-lamp',
        verb: { $ref: { collection: 'verbs', id: 'use' } },
        operands: [{ kind: 'any-interactable' }],
        context: { kind: 'room-placement', placement: { room: 'foyer', placement: 'anchor' } },
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
                context: { placement: { placement: 'renamed-anchor' } },
                program: {
                  instructions: [{ target: { placement: { placement: 'renamed-anchor' } } }],
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
    expect(removeResult.ok).toBe(false);
    expect(removeResult.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('cannot be removed') }),
      ]),
    );
  });
});
