import { describe, expect, it } from 'vitest';
import {
  buildAuthoringSymbolTables,
  compilerNestedNamespaces,
  compileAuthoringProject,
  resolveAuthoringSymbol,
  resolveNestedAuthoringSymbol,
} from '../../shared/authoring-compiler';
import { lowerSharedAuthoringProject } from '../../shared/authoring-compiler-shared-lowering';
import { lowerSceneAndRoomPrograms } from '../../shared/authoring-compiler-scene-room-lowering';
import { lowerDialogueAndInteractionPrograms } from '../../shared/authoring-compiler-dialogue-interaction-lowering';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultDialogueBlock, defaultDialogueData, defaultDialogueSegment } from '../../shared/project-schema/authoring-dialogues';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import { defaultInteractionProgram } from '../../shared/project-schema/authoring-interaction-programs';
import { defaultMapData } from '../../shared/project-schema/authoring-maps';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData, defaultSceneStep } from '../../shared/project-schema/authoring-scenes';
import { defaultTestAssertion, defaultTestData, defaultTestStep } from '../../shared/project-schema/authoring-tests';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';
import { comprehensiveGoldenProject } from './fixtures/compiled-project-golden-projects';

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
  it('normalizes a detached input and publishes only a strict, canonical complete project', () => {
    const project = validProject();
    const before = JSON.stringify(project);

    const result = compileAuthoringProject(project);

    expect(JSON.stringify(project)).toBe(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.canonicalJson)).toEqual(result.project);
    expect(result.diagnostics).toEqual([]);
    expect(result.stages).toEqual([
      { name: 'normalize', status: 'completed' },
      { name: 'semantic-validation', status: 'completed' },
      { name: 'link', status: 'completed' },
      { name: 'lower', status: 'completed' },
      { name: 'collect-resources', status: 'completed' },
      { name: 'assemble', status: 'completed' },
      { name: 'validate-wire', status: 'completed' },
      { name: 'serialize', status: 'completed' },
    ]);
  });

  it('lowers every Phase 4C shared definition without flattening inheritance or retaining editor metadata', () => {
    const project = validProject();
    project.editor = {
      ...project.editor,
      tags: { records: { favorite: { name: 'Favorite', color: '#ff0000', sortKey: '1' } } },
      recordMetadata: { rooms: { foyer: { tags: ['favorite'], color: '#ff0000', sortKey: '1' } } },
    };
    project.properties.mood = {
      id: 'mood', label: 'Mood', description: 'Current mood', type: 'enum', nullable: false,
      defaultValue: 'calm', enumValues: ['calm', 'tense'], ownerKinds: ['room'], persistence: 'Save',
    };
    project.variables.visited = {
      id: 'visited', label: 'Visited', description: 'Editor-only label', data: defaultVariableData('boolean'),
    };
    project.assets.hero = {
      id: 'hero', label: 'Hero sprite', description: 'Import metadata is tooling-only',
      data: assetDataFromImportMetadata({ kind: 'image', projectRelativePath: 'assets/images/hero.png', aliases: ['hero.sprite'], contentHash: 'abc' }),
    };
    project.layouts.hud = { id: 'hud', label: 'HUD', data: defaultLayoutData('HUD', 'document') };

    const baseRoom = project.rooms.foyer!;
    baseRoom.properties = { mood: 'calm' };
    project.rooms.hall = {
      ...project.rooms.hall!,
      extends: 'foyer',
      properties: { mood: 'tense' },
    };
    const character = defaultCharacterData('Hero');
    character.poses[0]!.sprite = { $ref: { collection: 'assets', id: 'hero' } };
    project.characters.hero = { id: 'hero', label: 'Hero', description: 'Tooling description', data: character };
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    project.verbs.look = { id: 'look', label: 'Look', data: defaultVerbData('Look') };
    project.interactions.look = { id: 'look', label: 'Look rules', data: defaultInteractionData() };
    project.maps.house = { id: 'house', label: 'House', data: defaultMapData() };
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
    project.startupHook = { source: 'bootstrap()' };
    project.localization.catalogs.en = { greeting: 'Hello' };

    const result = lowerSharedAuthoringProject(project);

    expect(result.diagnostics).toEqual([]);
    expect(result.draft).toBeDefined();
    const draft = result.draft!;
    expect(draft.definitions.rooms.map((room) => room.id)).toEqual(['foyer', 'hall']);
    expect(draft.definitions.rooms[1]).toMatchObject({
      id: 'hall', extends: 'foyer', propertyAssignments: [{ propertyId: 'mood', value: 'tense' }],
    });
    expect(draft.definitions.characters[0]?.poses[0]?.sprite).toEqual({ kind: 'asset', id: 'hero' });
    expect(draft.properties).toEqual([expect.objectContaining({ id: 'mood', enumValues: ['calm', 'tense'] })]);
    expect(draft.variables).toEqual([{ id: 'visited', type: 'boolean', defaultValue: false, enumValues: [] }]);
    expect(draft.resources.assets).toEqual([{ id: 'hero', kind: 'image', path: 'assets/images/hero.png', aliases: ['hero.sprite'] }]);
    expect(draft.localization.catalogs).toEqual([{ locale: 'en', entries: [{ key: 'greeting', value: 'Hello' }] }]);
    expect(JSON.stringify(draft)).not.toContain('selection');
    expect(JSON.stringify(draft)).not.toContain('Tooling description');
    expect(JSON.stringify(draft)).not.toContain('Import metadata');
    expect(JSON.stringify(draft)).not.toContain('objects');
    expect(Object.keys(draft.definitions)).not.toContain('actions');
  });

  it('lowers every Scene instruction and ordered Room lifecycle hook without comments or disabled steps', () => {
    const project = validProject();
    project.assets.media = { id: 'media', label: 'Media', data: assetDataFromImportMetadata({ kind: 'image', projectRelativePath: 'assets/media.png', aliases: [], contentHash: 'hash' }) };
    project.layouts.hud = { id: 'hud', label: 'HUD', data: defaultLayoutData('HUD', 'document') };
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    project.characters.hero = { id: 'hero', label: 'Hero', data: defaultCharacterData('Hero') };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
    const scene = defaultSceneData('Opening');
    scene.steps = [
      { ...defaultSceneStep('set-background'), id: 'background', asset: { $ref: { collection: 'assets', id: 'media' } } },
      { ...defaultSceneStep('actor-cue'), id: 'actor', character: { $ref: { collection: 'characters', id: 'hero' } }, poseId: 'default', expressionId: 'neutral' },
      { ...defaultSceneStep('call-dialogue'), id: 'dialogue', dialogue: { $ref: { collection: 'dialogues', id: 'intro' } }, startBlockId: 'start' },
      { ...defaultSceneStep('show-text'), id: 'text' },
      { ...defaultSceneStep('audio-cue'), id: 'audio', asset: { $ref: { collection: 'assets', id: 'media' } } },
      { ...defaultSceneStep('set-variable'), id: 'variable', variable: { $ref: { collection: 'variables', id: 'flag' } }, value: true },
      { ...defaultSceneStep('run-lua'), id: 'lua' },
      { ...defaultSceneStep('wait'), id: 'duration' },
      { id: 'input', label: 'input', enabled: true, type: 'wait', waitKind: 'input', skippable: false },
      { ...defaultSceneStep('conditional-branch'), id: 'branch', branches: [{ id: 'yes', condition: { kind: 'always' }, targetStepId: 'layout' }], fallbackStepId: 'transition' },
      { ...defaultSceneStep('choice'), id: 'choice', options: [{ id: 'continue', label: { source: { kind: 'inline', text: 'Continue' }, markup: 'plain' }, effects: [{ kind: 'set-variable', variable: { $ref: { collection: 'variables', id: 'flag' } }, value: true }], targetStepId: 'layout' }] },
      { ...defaultSceneStep('set-layout'), id: 'layout', layout: { $ref: { collection: 'layouts', id: 'hud' } } },
      { ...defaultSceneStep('transition-group'), id: 'transition' },
      { ...defaultSceneStep('show-text'), id: 'disabled', enabled: false },
      { ...defaultSceneStep('comment'), id: 'note' },
    ];
    scene.continuation = { kind: 'room', id: 'foyer' };
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };
    const room = project.rooms.foyer!.data;
    room.lifecycle.beforeEnter = [{ kind: 'set-variable', variable: { $ref: { collection: 'variables', id: 'flag' } }, value: true }];
    room.lifecycle.afterEnter = [{ kind: 'run-lua-effect', source: 'after_enter()' }];
    room.lifecycle.beforeLeave = [{ kind: 'run-lua-effect', source: 'before_leave()' }];
    room.lifecycle.afterLeave = [{ kind: 'set-variable', variable: { $ref: { collection: 'variables', id: 'flag' } }, value: false }];

    const shared = lowerSharedAuthoringProject(project);
    expect(shared.diagnostics).toEqual([]);
    const result = lowerSceneAndRoomPrograms(project, shared.draft!);
    expect(result.diagnostics).toEqual([]);
    const lowered = result.draft!;
    expect(lowered.definitions.scenes[0]!.program.instructions.map((instruction) => instruction.kind)).toEqual([
      'set-background', 'actor-cue', 'call-dialogue', 'show-text', 'audio-cue', 'set-variable', 'run-lua',
      'wait-duration', 'wait-input', 'conditional-branch', 'choice', 'set-layout', 'transition-group',
    ]);
    expect(lowered.definitions.scenes[0]!.continuation).toEqual({ kind: 'room', room: { kind: 'room', id: 'foyer' } });
    expect(lowered.definitions.rooms.find((candidate) => candidate.id === 'foyer')!.lifecycle.hooks).toEqual([
      { hook: 'before-enter', effects: [{ kind: 'set-variable', variable: { kind: 'variable', id: 'flag' }, value: true }] },
      { hook: 'after-enter', effects: [{ kind: 'run-lua-effect', source: 'after_enter()' }] },
      { hook: 'before-leave', effects: [{ kind: 'run-lua-effect', source: 'before_leave()' }] },
      { hook: 'after-leave', effects: [{ kind: 'set-variable', variable: { kind: 'variable', id: 'flag' }, value: false }] },
    ]);
  });

  it('rejects Scene targets removed from runtime lowering and unresolved instruction-local nested references', () => {
    const project = validProject();
    project.characters.hero = { id: 'hero', label: 'Hero', data: defaultCharacterData('Hero') };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
    const scene = defaultSceneData('Broken');
    scene.steps = [
      { ...defaultSceneStep('conditional-branch'), id: 'branch', branches: [], fallbackStepId: 'note' },
      { ...defaultSceneStep('actor-cue'), id: 'actor', character: { $ref: { collection: 'characters', id: 'hero' } }, poseId: 'missing', expressionId: 'missing' },
      { ...defaultSceneStep('call-dialogue'), id: 'dialogue', dialogue: { $ref: { collection: 'dialogues', id: 'intro' } }, startBlockId: 'missing' },
      { ...defaultSceneStep('comment'), id: 'note' },
    ];
    project.scenes.broken = { id: 'broken', label: 'Broken', data: scene };
    const shared = lowerSharedAuthoringProject(project);
    const result = lowerSceneAndRoomPrograms(project, shared.draft!);
    expect(result.draft).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'COMPILER_SCENE_TARGET_NOT_EXECUTABLE',
      'COMPILER_SCENE_POSE_MISSING',
      'COMPILER_SCENE_EXPRESSION_MISSING',
      'COMPILER_SCENE_DIALOGUE_BLOCK_MISSING',
    ]);
  });

  it('rejects type-invalid variable conditions and effects before Scene and Room lowering', () => {
    const project = validProject();
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    const scene = defaultSceneData('Typed Scene');
    scene.steps = [{
      ...defaultSceneStep('show-text'),
      id: 'typed-text',
      condition: {
        kind: 'variable-comparison',
        variable: { $ref: { collection: 'variables', id: 'flag' } },
        operator: 'equal',
        value: 'not-a-boolean',
      },
    }];
    project.scenes.typed = { id: 'typed', label: 'Typed', data: scene };
    project.rooms.foyer!.data.lifecycle.beforeEnter = [{
      kind: 'set-variable',
      variable: { $ref: { collection: 'variables', id: 'flag' } },
      value: 'not-a-boolean',
    }];

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      jsonPointer: '/rooms/foyer/data/lifecycle/beforeEnter/0/value',
      message: "Value does not match variable 'flag'.",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      jsonPointer: '/scenes/typed/data/steps/0/condition/value',
      message: "Value does not match variable 'flag'.",
    }));
    expect(result.stages.find((stage) => stage.name === 'semantic-validation')).toEqual({
      name: 'semantic-validation',
      status: 'failed',
    });
  });

  it('losslessly lowers Dialogue graphs, Interaction instructions and retained Verb fallback chains', () => {
    const project = validProject();
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    project.rooms.foyer!.data.placements = [{ id: 'key-place', bounds: { x: 0, y: 0, width: 0.1, height: 0.1 }, presentation: { label: null, layout: null } }];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    const dialogue = defaultDialogueData('Intro');
    dialogue.blocks = [
      { ...defaultDialogueBlock('sequence', 'start'), segments: [
        { ...defaultDialogueSegment('line', 'welcome'), effects: [{ kind: 'set-variable', variable: { $ref: { collection: 'variables', id: 'flag' } }, value: true }], showOnce: true, logged: false, autosaveSafePoint: true },
        { ...defaultDialogueSegment('run-lua', 'script'), condition: { kind: 'always' }, mayYield: true },
        { ...defaultDialogueSegment('comment', 'note') },
      ] },
      defaultDialogueBlock('choice', 'choice'),
      { ...defaultDialogueBlock('redirect', 'redirect'), targetBlockId: 'start' },
      defaultDialogueBlock('comment', 'comment'),
    ];
    dialogue.edges = [
      { id: 'next', kind: 'next', fromBlockId: 'start', toBlockId: 'choice' },
      { id: 'choose', kind: 'choice', fromBlockId: 'choice', toBlockId: 'redirect', label: { source: { kind: 'inline', text: 'Again' }, markup: 'plain' }, condition: { kind: 'always' }, effects: [{ kind: 'run-lua-effect', source: 'again()' }], logged: true, autosaveSafePoint: true },
    ];
    dialogue.completion = { kind: 'scene', id: 'opening' };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };

    const baseVerb = defaultVerbData('Use');
    baseVerb.arity = 1; baseVerb.operandRoles = ['target']; baseVerb.availability = { kind: 'lua-predicate', source: 'base_available()' };
    baseVerb.defaultProgram = { instructions: [{ id: 'base-notify', kind: 'notify', message: { source: { kind: 'inline', text: 'Base' }, markup: 'plain' } }], completion: { kind: 'return' }, outcome: 'unhandled' };
    project.verbs.use = { id: 'use', label: 'Use', data: baseVerb };
    const childVerb = defaultVerbData('Unlock');
    childVerb.arity = 1; childVerb.operandRoles = ['target']; childVerb.availability = { kind: 'always' };
    childVerb.defaultProgram = { instructions: [{ id: 'child-call', kind: 'call-dialogue', dialogue: { $ref: { collection: 'dialogues', id: 'intro' } } }], completion: { kind: 'return' }, outcome: 'handled' };
    project.verbs.unlock = { id: 'unlock', label: 'Unlock', extends: 'use', data: childVerb };

    const interaction = defaultInteractionData();
    interaction.rules = [{
      id: 'unlock-key', verb: { $ref: { collection: 'verbs', id: 'unlock' } },
      operands: [{ kind: 'exact', subject: { kind: 'interactable', interactable: { $ref: { collection: 'interactables', id: 'key' } } } }],
      context: { kind: 'room-placement', placement: { room: 'foyer', placement: 'key-place' } },
      program: {
        instructions: [
          { id: 'effect', kind: 'apply-effect', effect: { kind: 'set-variable', variable: { $ref: { collection: 'variables', id: 'flag' } }, value: true } },
          { id: 'move', kind: 'move-interactable', interactable: { $ref: { collection: 'interactables', id: 'key' } }, target: { kind: 'inventory' } },
          { id: 'state', kind: 'set-interactable-state', interactable: { $ref: { collection: 'interactables', id: 'key' } }, visible: false },
          { id: 'notify', kind: 'notify', message: { source: { kind: 'inline', text: 'Unlocked' }, markup: 'plain' } },
          { id: 'scene', kind: 'call-scene', scene: { $ref: { collection: 'scenes', id: 'opening' } } },
          { id: 'dialogue', kind: 'call-dialogue', dialogue: { $ref: { collection: 'dialogues', id: 'intro' } } },
        ], completion: { kind: 'room', id: 'hall' }, outcome: 'handled',
      },
    }, {
      id: 'any-key', verb: { $ref: { collection: 'verbs', id: 'unlock' } },
      operands: [{ kind: 'any-interactable' }], context: { kind: 'predicate', condition: { kind: 'always' } },
      program: defaultInteractionProgram(),
    }];
    project.interactions.unlock = { id: 'unlock', label: 'Unlock', data: interaction };

    const shared = lowerSharedAuthoringProject(project).draft!;
    const sceneRoom = lowerSceneAndRoomPrograms(project, shared).draft!;
    const result = lowerDialogueAndInteractionPrograms(project, sceneRoom);
    expect(result.diagnostics).toEqual([]);
    const compiled = result.draft!;
    const loweredDialogue = compiled.definitions.dialogues[0]!;
    expect(loweredDialogue.program.blocks.map((block) => block.kind)).toEqual(['sequence', 'choice', 'redirect']);
    expect(loweredDialogue.program.blocks[0]).toMatchObject({ segments: [{ id: 'welcome', kind: 'line' }, { id: 'script', kind: 'run-lua' }] });
    expect(loweredDialogue.program.edges.map((edge) => edge.kind)).toEqual(['next', 'choice']);
    expect(loweredDialogue.completion).toEqual({ kind: 'scene', scene: { kind: 'scene', id: 'opening' } });
    expect(compiled.definitions.verbs.map((verb) => ({ id: verb.id, extends: verb.extends, availability: verb.availability.kind, outcome: verb.defaultProgram.outcome }))).toEqual([
      { id: 'unlock', extends: 'use', availability: 'always', outcome: 'handled' },
      { id: 'use', extends: null, availability: 'lua-predicate', outcome: 'unhandled' },
    ]);
    expect(compiled.definitions.interactions[0]!.rules[0]!.program.instructions.map((instruction) => instruction.id)).toEqual(['effect', 'move', 'state', 'notify', 'scene', 'dialogue']);
    expect(compiled.definitions.interactions[0]!.rules.map((rule) => rule.operands[0]!.kind)).toEqual(['exact', 'any-interactable']);
  });

  it('rejects type-invalid Dialogue, Interaction, and Verb variable usage before lowering', () => {
    const project = validProject();
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };

    const dialogue = defaultDialogueData('Typed Dialogue');
    dialogue.blocks = [{
      ...defaultDialogueBlock('sequence', 'start'),
      segments: [{
        ...defaultDialogueSegment('line', 'line'),
        condition: {
          kind: 'variable-comparison',
          variable: { $ref: { collection: 'variables', id: 'flag' } },
          operator: 'equal',
          value: 'not-a-boolean',
        },
      }],
    }];
    project.dialogues.typed = { id: 'typed', label: 'Typed', data: dialogue };

    const verb = defaultVerbData('Use');
    verb.availability = {
      kind: 'variable-comparison',
      variable: { $ref: { collection: 'variables', id: 'flag' } },
      operator: 'equal',
      value: 'not-a-boolean',
    };
    project.verbs.use = { id: 'use', label: 'Use', data: verb };

    const interaction = defaultInteractionData();
    interaction.rules = [{
      id: 'typed-rule',
      verb: { $ref: { collection: 'verbs', id: 'use' } },
      operands: [],
      context: {
        kind: 'predicate',
        condition: {
          kind: 'variable-comparison',
          variable: { $ref: { collection: 'variables', id: 'flag' } },
          operator: 'equal',
          value: 'not-a-boolean',
        },
      },
      program: {
        instructions: [{
          id: 'bad-effect',
          kind: 'apply-effect',
          effect: {
            kind: 'set-variable',
            variable: { $ref: { collection: 'variables', id: 'flag' } },
            value: 'not-a-boolean',
          },
        }],
        completion: { kind: 'return' },
        outcome: 'handled',
      },
    }];
    project.interactions.typed = { id: 'typed', label: 'Typed', data: interaction };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(false);
    for (const pointer of [
      '/dialogues/typed/data/blocks/0/segments/0/condition/value',
      '/interactions/typed/data/rules/0/context/condition/value',
      '/interactions/typed/data/rules/0/program/instructions/0/effect/value',
      '/verbs/use/data/availability/value',
    ]) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        jsonPointer: pointer,
        message: "Value does not match variable 'flag'.",
      }));
    }
  });

  it('produces identical specialized program drafts independently of collection map insertion order', () => {
    const buildDraft = (roomOrder: readonly string[]) => {
      const project = validProject(roomOrder);
      project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
      project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
      project.verbs.look = { id: 'look', label: 'Look', data: defaultVerbData('Look') };
      project.interactions.look = { id: 'look', label: 'Look', data: defaultInteractionData() };
      const shared = lowerSharedAuthoringProject(project).draft!;
      const sceneRoom = lowerSceneAndRoomPrograms(project, shared).draft!;
      return lowerDialogueAndInteractionPrograms(project, sceneRoom).draft!;
    };

    expect(buildDraft(['foyer', 'hall'])).toEqual(buildDraft(['hall', 'foyer']));
  });

  it('requires a strict compiled entrypoint before shared lowering', () => {
    const project = validProject();
    project.entrypoint = null;
    const result = lowerSharedAuthoringProject(project);
    expect(result.draft).toBeUndefined();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'COMPILER_ENTRYPOINT_REQUIRED', path: '/entrypoint' })]);
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
    expect(first.ok).toBe(true);
    expect(reordered.ok).toBe(true);
    if (first.ok && reordered.ok) expect(first.canonicalJson).toBe(reordered.canonicalJson);
  });

  it('emits typed Character idle and Room environment records only when configured', () => {
    const project = comprehensiveGoldenProject();
    const character = project.characters.hero!.data;
    character.idles = [{
      id: 'breathing', label: 'Breathing', kind: 'pulse', amplitude: 0.02,
      periodMs: 1800, clock: 'gameplay',
    }];
    character.defaults.idleId = 'breathing';
    const room = project.rooms.start!.data;
    room.environments = [{
      id: 'rain',
      condition: { kind: 'always' },
      asset: { $ref: { collection: 'assets', id: 'image-main' } },
      material: { $ref: { collection: 'materials', id: 'sprite-material' } },
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      plane: 'world-overlay',
      order: 4,
      clock: 'gameplay',
      scrollPerSecond: { x: 0, y: 0.1 },
      opacity: 0.6,
      visible: true,
    }];

    const result = compileAuthoringProject(project);

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    if (!result.ok) return;
    const compiledCharacter = result.project.definitions.characters.find((value) => value.id === 'hero');
    const compiledRoom = result.project.definitions.rooms.find((value) => value.id === 'start');
    expect(compiledCharacter?.defaults.idleId).toBe('breathing');
    expect(compiledCharacter?.idles).toEqual([{
      id: 'breathing', kind: 'pulse', amplitude: 0.02, periodMs: 1800, clock: 'gameplay',
    }]);
    expect(compiledRoom?.environments).toEqual([expect.objectContaining({
      id: 'rain', plane: 'world-overlay', order: 4, clock: 'gameplay',
      scrollPerSecond: { x: 0, y: 0.1 }, opacity: 0.6,
    })]);
  });

  it('builds shared symbols for every collection and representative nested stable-ID namespaces', () => {
    const project = validProject();
    const room = project.rooms.foyer!;
    const roomData = room.data;
    roomData.placements = [{
      id: 'key-placement', bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
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
    room.overlays = [{ id: 'hud-overlay', layout: { $ref: { collection: 'layouts', id: 'hud' } }, condition: { kind: 'always' }, visible: true, order: 0 }];
    room.placements = [{
      id: 'key-placement', bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
      presentation: { label: null, layout: null },
    }];
    room.cast = [{ id: 'hero-cast', character: { $ref: { collection: 'characters', id: 'hero' } }, condition: { kind: 'always' }, placementId: 'key-placement', poseId: 'standing', expressionId: 'neutral', idleId: null, visible: true, order: 0 }];
    room.props = [{ id: 'key-prop', condition: { kind: 'always' }, placementId: 'key-placement', asset: null, material: { $ref: { collection: 'materials', id: 'material' } }, visible: true, order: 0 }];
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
      program: { instructions: [{ id: 'notice', kind: 'notify', message: { source: { kind: 'inline', text: 'Look' }, markup: 'plain' } }], completion: { kind: 'return' }, outcome: 'unhandled' },
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
