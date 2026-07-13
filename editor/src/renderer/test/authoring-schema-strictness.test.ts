import { describe, expect, it } from 'vitest';
import { assetDataSchema } from '../../shared/project-schema/authoring-assets';
import { defaultCharacterData, characterDataSchema } from '../../shared/project-schema/authoring-characters';
import { defaultDialogueData, dialogueDataSchema } from '../../shared/project-schema/authoring-dialogues';
import { defaultInteractableData, interactableDataSchema } from '../../shared/project-schema/authoring-interactables';
import { defaultInteractionData, interactionDataSchema } from '../../shared/project-schema/authoring-interactions';
import { defaultLayoutData, layoutDataSchema } from '../../shared/project-schema/authoring-layouts';
import { defaultMapData, mapDataSchema } from '../../shared/project-schema/authoring-maps';
import { defaultMaterialData, materialDataSchema } from '../../shared/project-schema/authoring-materials';
import { defaultRoomData, roomDataSchema } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData, defaultSceneStep, sceneDataSchema } from '../../shared/project-schema/authoring-scenes';
import { defaultScriptModuleData, scriptModuleDataSchema } from '../../shared/project-schema/authoring-script-modules';
import { defaultShaderData, shaderDataSchema } from '../../shared/project-schema/authoring-shaders';
import { defaultTestData, testDataSchema } from '../../shared/project-schema/authoring-tests';
import { defaultVariableData, variableDataSchema } from '../../shared/project-schema/authoring-variables';
import { defaultVerbData, verbDataSchema } from '../../shared/project-schema/authoring-verbs';

describe('authoring schema strictness', () => {
  it('rejects unknown fields at representative nested data in every collection family', () => {
    const character = defaultCharacterData();
    const dialogue = defaultDialogueData();
    const interactable = defaultInteractableData();
    const layout = defaultLayoutData();
    const room = defaultRoomData();
    const scene = defaultSceneData();
    const shader = defaultShaderData();
    const test = defaultTestData();

    const cases: Array<{ name: string; accepted: boolean }> = [
      { name: 'assets', accepted: assetDataSchema.safeParse({ kind: 'binary', source: { type: 'project-file', path: 'assets/file.bin', unexpected: true }, aliases: [] }).success },
      { name: 'variables', accepted: variableDataSchema.safeParse({ ...defaultVariableData(), unexpected: true }).success },
      { name: 'shaders', accepted: shaderDataSchema.safeParse({ ...shader, stages: [{ ...shader.stages[0], unexpected: true }] }).success },
      { name: 'materials', accepted: materialDataSchema.safeParse({ ...defaultMaterialData(), preview: { geometry: 'quad', background: 'checker', unexpected: true } }).success },
      { name: 'layouts', accepted: layoutDataSchema.safeParse({ ...layout, rml: { ...layout.rml, unexpected: true } }).success },
      { name: 'characters', accepted: characterDataSchema.safeParse({ ...character, poses: [{ ...character.poses[0], unexpected: true }] }).success },
      { name: 'rooms', accepted: roomDataSchema.safeParse({ ...room, background: { ...room.background, unexpected: true } }).success },
      { name: 'interactables', accepted: interactableDataSchema.safeParse({ ...interactable, presentation: { ...interactable.presentation, unexpected: true } }).success },
      { name: 'verbs', accepted: verbDataSchema.safeParse({ ...defaultVerbData(), defaultProgram: { instructions: [], completion: { kind: 'return' }, outcome: 'handled', unexpected: true } }).success },
      { name: 'interactions', accepted: interactionDataSchema.safeParse({ ...defaultInteractionData(), unexpected: true }).success },
      { name: 'dialogues', accepted: dialogueDataSchema.safeParse({ ...dialogue, blocks: [{ ...dialogue.blocks[0], unexpected: true }] }).success },
      { name: 'scenes', accepted: sceneDataSchema.safeParse({ ...scene, steps: [{ ...defaultSceneStep('wait'), unexpected: true }] }).success },
      { name: 'maps', accepted: mapDataSchema.safeParse({ ...defaultMapData(), presentation: { ...defaultMapData().presentation, unexpected: true } }).success },
      { name: 'scripts', accepted: scriptModuleDataSchema.safeParse({ ...defaultScriptModuleData(), source: { kind: 'inline-lua', source: '', unexpected: true } }).success },
      { name: 'tests', accepted: testDataSchema.safeParse({ ...test, steps: [{ ...test.steps[0], tick: { ...test.steps[0]!.tick, unexpected: true } }] }).success },
    ];

    expect(cases.filter((item) => item.accepted)).toEqual([]);
  });
});
