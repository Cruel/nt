import { describe, expect, it } from 'vitest';
import {
  buildAuthoringSymbolTables,
  compilerNestedNamespaces,
  compileAuthoringProject,
  resolveAuthoringSymbol,
  resolveNestedAuthoringSymbol,
} from '../../shared/authoring-compiler';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultDialogueBlock, defaultDialogueData, defaultDialogueSegment } from '../../shared/project-schema/authoring-dialogues';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import { defaultMapData } from '../../shared/project-schema/authoring-maps';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultRoomData, roomInteractableRef } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData, defaultSceneStep } from '../../shared/project-schema/authoring-scenes';
import { defaultTestAssertion, defaultTestData, defaultTestStep } from '../../shared/project-schema/authoring-tests';

function validProject(roomOrder: readonly string[] = ['foyer', 'hall']) {
  const project = createAuthoringProject({ id: 'compiler-demo', name: 'Compiler Demo' });
  for (const roomId of roomOrder) {
    const room = defaultRoomData(roomId);
    room.description.source = { kind: 'inline', text: roomId };
    project.rooms[roomId] = { id: roomId, label: roomId, data: room };
  }
  project.entrypoint = { kind: 'room', id: 'foyer' };
  return project;
}

describe('authoring compiler framework', () => {
  it('normalizes a detached input, reports every explicit stage, and never publishes a partial project', () => {
    const project = validProject();
    const before = JSON.stringify(project);

    const result = compileAuthoringProject(project);

    expect(JSON.stringify(project)).toBe(before);
    expect(result.ok).toBe(false);
    expect('project' in result).toBe(false);
    expect('canonicalJson' in result).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPILER_LOWERING_PENDING_PHASE_4C',
      severity: 'error',
      sourcePath: 'authoring-project',
      jsonPointer: '/',
    }));
    expect(result.stages).toEqual([
      { name: 'normalize', status: 'completed' },
      { name: 'semantic-validation', status: 'completed' },
      { name: 'link', status: 'completed' },
      { name: 'lower', status: 'failed' },
      { name: 'collect-resources', status: 'skipped' },
      { name: 'assemble', status: 'skipped' },
      { name: 'validate-wire', status: 'skipped' },
      { name: 'serialize', status: 'skipped' },
    ]);
  });

  it('strictly rejects invalid V2 boundary data and produces deterministic diagnostics independent of map insertion order', () => {
    const invalid = Object.assign(validProject(), { unknownWireInput: true });
    const invalidResult = compileAuthoringProject(invalid);
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.diagnostics).toContainEqual(expect.objectContaining({ code: 'AUTHORING_SCHEMA_UNRECOGNIZED_KEYS' }));

    const first = compileAuthoringProject(validProject(['foyer', 'hall']));
    const reordered = compileAuthoringProject(validProject(['hall', 'foyer']));
    expect(first.diagnostics).toEqual(reordered.diagnostics);
    expect(first.stages).toEqual(reordered.stages);
  });

  it('builds shared symbols for every collection and representative nested stable-ID namespaces', () => {
    const project = validProject();
    const room = project.rooms.foyer!;
    const roomData = room.data;
    roomData.placements = [{
      id: 'key-placement', interactable: roomInteractableRef('key'), bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
      presentation: { label: null, layout: null },
    }];
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    const scene = defaultSceneData('Opening');
    scene.steps = [{ ...defaultSceneStep('choice'), id: 'choice', options: [{ id: 'continue', label: { source: { kind: 'inline', text: 'Continue' }, markup: 'plain' }, effects: [], targetStepId: 'choice' }] }];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };

    const symbols = buildAuthoringSymbolTables(project);
    for (const collection of authoringCollectionKeys) expect(symbols.collections.has(collection)).toBe(true);
    expect(resolveAuthoringSymbol(symbols, 'rooms', 'foyer')).toEqual(project.rooms.foyer);
    expect(resolveNestedAuthoringSymbol(symbols, 'room-placement', 'foyer', 'key-placement')?.sourcePath).toBe('/rooms/foyer/data/placements/0');
    expect(resolveNestedAuthoringSymbol(symbols, 'scene-choice-option', 'opening', 'continue')?.sourcePath).toBe('/scenes/opening/data/steps/0/options/0');
  });

  it('indexes every declared nested stable-ID namespace', () => {
    const project = validProject();

    const character = defaultCharacterData('Hero');
    character.poses = [{ ...character.poses[0]!, id: 'standing' }];
    character.expressions = [{ ...character.expressions[0]!, id: 'neutral' }];
    project.characters.hero = { id: 'hero', label: 'Hero', data: character };

    const room = defaultRoomData('Foyer');
    room.overlays = [{ id: 'hud-overlay', layout: { $ref: { collection: 'layouts', id: 'hud' } }, enabled: true }];
    room.placements = [{
      id: 'key-placement', interactable: roomInteractableRef('key'), bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
      presentation: { label: null, layout: null },
    }];
    room.exits = [{
      id: 'north-exit', direction: 'north', target: { $ref: { collection: 'rooms', id: 'hall' } },
      label: 'North', condition: { kind: 'always' },
    }];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };

    const scene = defaultSceneData('Opening');
    scene.steps = [
      { ...defaultSceneStep('conditional-branch'), id: 'branch', branches: [{ id: 'true-branch', condition: { kind: 'always' }, targetStepId: 'choice' }], fallbackStepId: 'choice' },
      { ...defaultSceneStep('choice'), id: 'choice', options: [{ id: 'continue', label: { source: { kind: 'inline', text: 'Continue' }, markup: 'plain' }, effects: [], targetStepId: 'choice' }] },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };

    const dialogue = defaultDialogueData('Intro');
    dialogue.blocks = [{ ...defaultDialogueBlock('sequence', 'start'), segments: [defaultDialogueSegment('line', 'line-1')] }];
    dialogue.edges = [{ id: 'loop', kind: 'next', fromBlockId: 'start', toBlockId: 'start' }];
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };

    const interaction = defaultInteractionData();
    interaction.rules = [{
      id: 'look-rule',
      verb: { $ref: { collection: 'verbs', id: 'look' } },
      operands: [],
      context: { kind: 'any' },
      program: { instructions: [], completion: { kind: 'return' }, outcome: 'unhandled' },
    }];
    project.interactions.look = { id: 'look', label: 'Look', data: interaction };

    const map = defaultMapData();
    map.locations = [{ id: 'foyer-location', room: { $ref: { collection: 'rooms', id: 'foyer' } }, position: { x: 0, y: 0 }, shape: { kind: 'point' }, label: null }];
    map.connections = [{ id: 'north-connection', sourceLocation: 'foyer-location', targetLocation: 'foyer-location', exit: { room: 'foyer', exit: 'north-exit' } }];
    project.maps.house = { id: 'house', label: 'House', data: map };

    const test = defaultTestData('Smoke');
    const step = defaultTestStep('tick', 'Start');
    step.assertions = [{ ...defaultTestAssertion('mode'), id: 'mode-assertion' }];
    test.steps = [{ ...step, id: 'start' }];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data: test };

    const symbols = buildAuthoringSymbolTables(project);
    expect([...symbols.nested.keys()].sort()).toEqual([...compilerNestedNamespaces].sort());
    for (const namespace of compilerNestedNamespaces) expect(symbols.nested.get(namespace)?.size).toBeGreaterThan(0);
  });
});
