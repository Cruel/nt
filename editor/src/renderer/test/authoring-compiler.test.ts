import { describe, expect, it } from 'vite-plus/test';
import {
  buildAuthoringSymbolTables,
  compilerNestedNamespaces,
  compileAuthoringProject,
  resolveAuthoringSymbol,
  resolveNestedAuthoringSymbol,
} from '../../shared/authoring-compiler';
import {
  compileSubjectSelector,
  lowerSharedAuthoringProject,
} from '../../shared/authoring-compiler-shared-lowering';
import { lowerSceneAndRoomPrograms } from '../../shared/authoring-compiler-scene-room-lowering';
import { lowerDialogueAndInteractionPrograms } from '../../shared/authoring-compiler-dialogue-interaction-lowering';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultArchetypeData } from '../../shared/project-schema/authoring-archetypes';
import {
  defaultDialogueBlock,
  defaultDialogueData,
  defaultDialogueSegment,
} from '../../shared/project-schema/authoring-dialogues';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import { defaultInteractionProgram } from '../../shared/project-schema/authoring-interaction-programs';
import { defaultMapData } from '../../shared/project-schema/authoring-maps';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { defaultHotspotBehavior } from '../../shared/project-schema/authoring-hotspots';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData, defaultSceneStep } from '../../shared/project-schema/authoring-scenes';
import { defaultTestData, defaultTestStep } from '../../shared/project-schema/authoring-tests';
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
  it('publishes generated Flow Prediction metadata without mutating authoring data', () => {
    const project = validProject();
    project.assets['next-background'] = {
      id: 'next-background',
      label: 'Next background',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/next-background.png',
        aliases: [],
        contentHash: 'next-background-hash',
        sampling: 'linear',
        imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
      }),
    };

    const opening = defaultSceneData('Opening');
    opening.terminal = {
      kind: 'continue-scene',
      scene: { $ref: { collection: 'scenes', id: 'followup' } },
      inputs: [],
    };
    project.scenes.opening = { id: 'opening', label: 'Opening', data: opening };

    const followup = defaultSceneData('Followup');
    if (followup.stage.kind !== 'blank')
      throw new Error('Expected the default Scene Stage to be blank.');
    followup.stage.background.asset = { $ref: { collection: 'assets', id: 'next-background' } };
    project.scenes.followup = { id: 'followup', label: 'Followup', data: followup };
    project.entrypoint = { kind: 'scene', id: 'opening' };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.flowPrediction).toBeDefined();
    expect('flowPrediction' in project).toBe(false);
  });

  it('lowers prospective Room lifecycle Flow into prediction summaries without rejection programs', () => {
    const project = validProject();
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    project.scenes.arrival = {
      id: 'arrival',
      label: 'Arrival',
      data: defaultSceneData('Arrival'),
    };
    project.dialogues.greeting = {
      id: 'greeting',
      label: 'Greeting',
      data: defaultDialogueData('Greeting'),
    };

    const hall = project.rooms.hall!.data;
    hall.lifecycle.afterEnter = [
      {
        id: 'project-flag',
        kind: 'set-global-property',
        variable: { $ref: { collection: 'variables', id: 'flag' } },
        value: true,
      },
      {
        id: 'branch',
        kind: 'if',
        condition: {
          kind: 'variable-comparison',
          variable: { $ref: { collection: 'variables', id: 'flag' } },
          operator: 'truthy',
        },
        // oxlint-disable-next-line unicorn/no-thenable -- canonical authored Gameplay Command field.
        then: [
          {
            id: 'arrival-scene',
            kind: 'call-scene',
            scene: { $ref: { collection: 'scenes', id: 'arrival' } },
          },
        ],
        else: [
          {
            id: 'greeting-dialogue',
            kind: 'call-dialogue',
            dialogue: { $ref: { collection: 'dialogues', id: 'greeting' } },
          },
        ],
      },
    ];
    hall.lifecycle.onEnterRejected = [
      {
        id: 'rejected-dialogue',
        kind: 'call-dialogue',
        dialogue: { $ref: { collection: 'dialogues', id: 'greeting' } },
      },
    ];
    hall.scriptHooks = [
      {
        hook: 'after-enter',
        handler: {
          module: { $ref: { collection: 'scripts', id: 'bootstrap' } },
          export: 'after_enter',
        },
      },
    ];

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prediction = result.project.flowPrediction;
    expect(prediction).toBeDefined();
    const afterEnter = prediction!.slices.find(
      (slice) =>
        slice.point.kind === 'room-lifecycle' &&
        slice.point.room.id === 'hall' &&
        slice.point.stage === 'after-enter',
    );
    expect(afterEnter?.program).toEqual([
      {
        kind: 'set-global-property',
        property: { kind: 'property', id: 'flag' },
        value: true,
      },
      {
        kind: 'if',
        condition: {
          kind: 'global-property-comparison',
          property: { kind: 'property', id: 'flag' },
          operator: 'truthy',
        },
        thenCommands: [{ kind: 'call-scene', scene: { kind: 'scene', id: 'arrival' } }],
        elseCommands: [{ kind: 'call-dialogue', dialogue: { kind: 'dialogue', id: 'greeting' } }],
      },
      { kind: 'opaque' },
    ]);
    expect(
      prediction!.slices.some(
        (slice) =>
          slice.point.kind === 'room-lifecycle' &&
          !['before-leave', 'before-enter', 'presentation', 'after-leave', 'after-enter'].includes(
            slice.point.stage,
          ),
      ),
    ).toBe(false);
  });

  it('compiles the implicit Project Inventory and default Inventory Layout', () => {
    const project = validProject();
    project.interactables.coin = {
      id: 'coin',
      label: 'Coin',
      data: defaultInteractableData('Coin'),
    };
    project.interactableInstances.coin = defaultInteractableInstanceData('coin', 'coin', {
      kind: 'inventory',
      inventory: { owner: { kind: 'project' }, inventoryId: 'inventory' },
    });
    project.layouts.inventory = {
      id: 'inventory',
      label: 'Inventory',
      data: defaultLayoutData('Inventory'),
    };
    project.settings.inventory = {
      defaultLayout: { $ref: { collection: 'layouts', id: 'inventory' } },
    };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.settings.inventory).toEqual({
      playerInventory: null,
      defaultLayout: { kind: 'layout', id: 'inventory' },
    });
    expect(result.project.inventories).toEqual([{ id: 'player', label: 'Player Inventory' }]);
    expect(result.project.interactableInstances).toContainEqual(
      expect.objectContaining({
        id: 'coin',
        location: {
          kind: 'inventory',
          inventory: { owner: { kind: 'project' }, inventoryId: 'player' },
        },
      }),
    );
  });

  it('lowers the complete reusable Subject Selector vocabulary without positional rewriting', () => {
    const selectors = [
      { kind: 'any-subject' as const },
      { kind: 'family' as const, family: 'feature' as const },
      {
        kind: 'trait' as const,
        trait: { $ref: { collection: 'traits' as const, id: 'portable' } },
      },
      {
        kind: 'interactable-definition' as const,
        interactableDefinition: { $ref: { collection: 'interactables' as const, id: 'key' } },
      },
      {
        kind: 'interactable-feature' as const,
        interactableDefinition: { $ref: { collection: 'interactables' as const, id: 'key' } },
        featureId: 'lock',
      },
      { kind: 'qualified-pattern' as const, family: 'interactable' as const, pattern: 'runtime-*' },
      {
        kind: 'exact' as const,
        subject: {
          kind: 'interactable' as const,
          interactable: { $ref: { registry: 'interactableInstances' as const, id: 'key' } },
        },
      },
    ];

    expect(selectors.map(compileSubjectSelector)).toEqual([
      { kind: 'any-subject' },
      { kind: 'family', family: 'feature' },
      { kind: 'trait', trait: { kind: 'trait', id: 'portable' } },
      {
        kind: 'interactable-definition',
        interactableDefinition: { kind: 'interactable-definition', id: 'key' },
      },
      {
        kind: 'interactable-feature',
        interactableDefinition: { kind: 'interactable-definition', id: 'key' },
        featureId: 'lock',
      },
      { kind: 'qualified-pattern', family: 'interactable', pattern: 'runtime-*' },
      {
        kind: 'exact',
        subject: { kind: 'interactable', interactable: { kind: 'interactable', id: 'key' } },
      },
    ]);
  });

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

  it('rejects unattached Interactable Archetypes whose effective hotspot presentation requires a missing sprite', () => {
    const project = validProject();
    project.archetypes['invalid-interactable'] = {
      id: 'invalid-interactable',
      label: 'Invalid Interactable',
      data: {
        ...defaultArchetypeData('interactable'),
        overrides: {
          '/data/presentation/hotspots': {
            kind: 'sprite-alpha',
            hotspot: defaultHotspotBehavior('Invalid Interactable'),
          },
        },
      },
    };
    project.archetypes['invalid-custom-interactable'] = {
      id: 'invalid-custom-interactable',
      label: 'Invalid Custom Interactable',
      data: {
        ...defaultArchetypeData('interactable'),
        overrides: {
          '/data/presentation/hotspots': {
            kind: 'custom',
            hotspots: [
              {
                ...defaultHotspotBehavior('Invalid Custom Interactable'),
                shape: {
                  kind: 'rect',
                  bounds: { x: 0, y: 0, width: 1, height: 1 },
                },
              },
            ],
          },
        },
      },
    };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'AUTHORING_HOTSPOT_AUTHORING_SOURCE_IMAGE_REQUIRED',
          jsonPointer:
            '/archetypes/invalid-interactable/data/effectiveConfiguration/data/presentation/hotspots/kind',
        }),
        expect.objectContaining({
          severity: 'error',
          code: 'AUTHORING_HOTSPOT_AUTHORING_SOURCE_IMAGE_REQUIRED',
          jsonPointer:
            '/archetypes/invalid-custom-interactable/data/effectiveConfiguration/data/presentation/hotspots/kind',
        }),
      ]),
    );
  });

  it('lowers typed Layout contracts deterministically without emitting empty contracts', () => {
    const project = validProject();
    const empty = defaultLayoutData('Empty', 'document');
    const contracted = defaultLayoutData('Contracted', 'document');
    contracted.contract = {
      inputs: {
        title: { type: 'string', nullable: false, defaultValue: 'Untitled' },
        count: { type: 'integer', nullable: false },
      },
      signals: {
        confirm: {
          fields: {
            accepted: { type: 'boolean', nullable: false, required: true },
          },
        },
      },
      state: {
        type: 'object',
        nullable: false,
        fields: {
          page: { required: true, shape: { type: 'integer', nullable: false } },
        },
        defaultValue: { page: 1 },
      },
    };
    project.layouts.empty = { id: 'empty', label: 'Empty', data: empty };
    project.layouts.contracted = { id: 'contracted', label: 'Contracted', data: contracted };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const emptyLayout = result.project.resources.layouts.find((layout) => layout.id === 'empty');
    const contractedLayout = result.project.resources.layouts.find(
      (layout) => layout.id === 'contracted',
    );
    expect(emptyLayout).not.toHaveProperty('contract');
    expect(contractedLayout?.contract).toEqual({
      inputs: [
        {
          id: 'count',
          type: 'integer',
          nullable: false,
          hasDefault: false,
          defaultValue: null,
        },
        {
          id: 'title',
          type: 'string',
          nullable: false,
          hasDefault: true,
          defaultValue: 'Untitled',
        },
      ],
      signals: [
        {
          id: 'confirm',
          fields: [{ id: 'accepted', type: 'boolean', nullable: false, required: true }],
        },
      ],
      state: {
        type: 'object',
        nullable: false,
        hasDefault: true,
        defaultValue: { page: 1 },
        fields: [
          {
            id: 'page',
            required: true,
            shape: {
              type: 'integer',
              nullable: false,
              hasDefault: false,
              defaultValue: null,
            },
          },
        ],
      },
    });
  });

  it('derives a deterministic Save Contract from persistent executable structure only', () => {
    const baseline = compileAuthoringProject(validProject());
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.project.saveContract).toMatch(/^sc1:[0-9a-f]{32}$/u);

    const metadataOnly = validProject();
    metadataOnly.project.name = 'Renamed Project';
    metadataOnly.project.description = 'Changed display metadata';
    const renamed = compileAuthoringProject(metadataOnly);
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.project.saveContract).toBe(baseline.project.saveContract);

    const stateShapeChange = validProject();
    const statefulLayout = defaultLayoutData('Stateful', 'document');
    statefulLayout.contract.state = {
      type: 'integer',
      nullable: false,
      defaultValue: 1,
    };
    stateShapeChange.layouts.stateful = {
      id: 'stateful',
      label: 'Stateful',
      data: statefulLayout,
    };
    const stateChanged = compileAuthoringProject(stateShapeChange);
    expect(stateChanged.ok).toBe(true);
    if (!stateChanged.ok) return;
    expect(stateChanged.project.saveContract).not.toBe(baseline.project.saveContract);

    const executableChange = validProject();
    executableChange.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return { contract_changed = true }\n',
    };
    const changed = compileAuthoringProject(executableChange);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.project.saveContract).not.toBe(baseline.project.saveContract);
  });

  it('lowers every shared definition without flattening inheritance or retaining editor metadata', () => {
    const project = validProject();
    project.editor = {
      ...project.editor,
      tags: { records: { favorite: { name: 'Favorite', color: '#ff0000', sortKey: '1' } } },
      recordMetadata: { rooms: { foyer: { tags: ['favorite'], color: '#ff0000', sortKey: '1' } } },
    };
    project.variables.visited = {
      id: 'visited',
      label: 'Visited',
      description: 'Editor-only label',
      data: defaultVariableData('boolean'),
    };
    project.assets.hero = {
      id: 'hero',
      label: 'Hero sprite',
      description: 'Import metadata is tooling-only',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/hero.png',
        aliases: ['hero.sprite'],
        contentHash: 'abc',
        sampling: 'nearest',
        imageMetadata: { width: 640, height: 960, hasAlpha: true, orientation: 1 },
      }),
    };
    project.layouts.hud = { id: 'hud', label: 'HUD', data: defaultLayoutData('HUD', 'document') };

    const baseRoom = project.rooms.foyer!;
    baseRoom.localProperties = [
      {
        id: 'mood',
        label: 'Mood',
        description: 'Current mood',
        type: 'enum',
        nullable: false,
        enumValues: ['calm', 'tense'],
        value: 'calm',
      },
    ];
    project.traits['tense-room'] = {
      id: 'tense-room',
      label: 'Tense Room',
      ownerKinds: ['room'],
      properties: [{ id: 'mood', type: 'string', nullable: false, defaultValue: 'tense' }],
    };
    project.rooms.hall = {
      ...project.rooms.hall!,
      traits: ['tense-room'],
    };
    const character = defaultCharacterData('Hero');
    character.profiles[0]!.poses[0]!.layers[0]!.sprite = {
      $ref: { collection: 'assets', id: 'hero' },
    };
    project.characters.hero = {
      id: 'hero',
      label: 'Hero',
      description: 'Tooling description',
      data: character,
    };
    const key = defaultInteractableData('Key');
    key.presentation.hotspots = { kind: 'custom', hotspots: [] };
    project.interactables.key = { id: 'key', label: 'Key', data: key };
    project.verbs.look = { id: 'look', label: 'Look', data: defaultVerbData('Look') };
    project.interactions.look = { id: 'look', label: 'Look rules', data: defaultInteractionData() };
    project.maps.house = { id: 'house', label: 'House', data: defaultMapData() };
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
    project.scripts.bootstrap!.data = {
      kind: 'script-module',
      source: { kind: 'inline-lua', source: 'bootstrap()\nreturn {}\n' },
    };
    project.localization.catalogs.en = { greeting: 'Hello' };

    const result = lowerSharedAuthoringProject(project);

    expect(result.diagnostics).toEqual([]);
    expect(result.draft).toBeDefined();
    const draft = result.draft!;
    expect(draft.definitions.rooms.map((room) => room.id)).toEqual(['foyer', 'hall']);
    expect(draft.traits).toEqual([
      {
        id: 'tense-room',
        label: 'Tense Room',
        description: '',
        ownerKinds: ['room'],
        properties: [
          {
            id: 'mood',
            label: 'mood',
            description: '',
            type: 'string',
            nullable: false,
            enumValues: [],
            defaultValue: 'tense',
          },
        ],
      },
    ]);
    expect(draft.definitions.rooms[1]).toMatchObject({
      id: 'hall',
      traits: ['tense-room'],
      propertyAssignments: [],
    });
    expect(draft.definitions.characters[0]?.profiles[0]?.poses[0]?.layers[0]?.sprite).toEqual({
      kind: 'asset',
      id: 'hero',
    });
    expect(draft.properties).toEqual([
      expect.objectContaining({
        id: 'mood',
        scope: 'identity',
        owner: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
        enumValues: ['calm', 'tense'],
      }),
      expect.objectContaining({
        id: 'mood',
        scope: 'identity',
        owner: { kind: 'room', room: { kind: 'room', id: 'hall' } },
        type: 'string',
        enumValues: [],
      }),
      expect.objectContaining({
        id: 'visited',
        scope: 'global',
        type: 'boolean',
        defaultValue: false,
        enumValues: [],
      }),
    ]);
    expect(draft.resources.assets).toEqual([
      {
        id: 'hero',
        kind: 'image',
        path: 'assets/images/hero.png',
        aliases: ['hero.sprite'],
        sampling: 'nearest',
        width: 640,
        height: 960,
      },
    ]);
    expect(draft.localization.catalogs).toEqual([
      { locale: 'en', entries: [{ key: 'greeting', value: 'Hello' }] },
    ]);
    expect(JSON.stringify(draft)).not.toContain('selection');
    expect(JSON.stringify(draft)).not.toContain('Tooling description');
    expect(JSON.stringify(draft)).not.toContain('Import metadata');
    expect(JSON.stringify(draft)).not.toContain('objects');
    expect(Object.keys(draft.definitions)).not.toContain('actions');
  });

  it('publishes explicit linear sampling for default image assets', () => {
    const project = validProject();
    project.assets.media = {
      id: 'media',
      label: 'Media',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/media.png',
        contentHash: 'hash',
        imageMetadata: { width: 320, height: 180, hasAlpha: true, orientation: 1 },
      }),
    };

    const result = lowerSharedAuthoringProject(project);

    expect(result.diagnostics).toEqual([]);
    expect(result.draft?.resources.assets).toEqual([
      {
        id: 'media',
        kind: 'image',
        path: 'assets/media.png',
        aliases: [],
        sampling: 'linear',
        width: 320,
        height: 180,
      },
    ]);
  });

  it('lowers every Scene instruction and ordered Room lifecycle hook without comments or disabled steps', () => {
    const project = validProject();
    project.assets.media = {
      id: 'media',
      label: 'Media',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/media.png',
        aliases: [],
        contentHash: 'hash',
        imageMetadata: { width: 320, height: 180, hasAlpha: true, orientation: 1 },
      }),
    };
    project.layouts.hud = { id: 'hud', label: 'HUD', data: defaultLayoutData('HUD', 'document') };
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    project.characters.hero = { id: 'hero', label: 'Hero', data: defaultCharacterData('Hero') };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
    const scene = defaultSceneData('Opening');
    scene.events = [
      {
        ...defaultSceneStep('set-background'),
        id: 'background',
        asset: { $ref: { collection: 'assets', id: 'media' } },
      },
      {
        ...defaultSceneStep('actor-cue'),
        id: 'actor',
        character: { $ref: { collection: 'characters', id: 'hero' } },
        poseId: 'default',
        expressionId: 'neutral',
      },
      {
        ...defaultSceneStep('call-dialogue'),
        id: 'dialogue',
        dialogue: { $ref: { collection: 'dialogues', id: 'intro' } },
        startBlockId: 'start',
      },
      { ...defaultSceneStep('resume-dialogue'), id: 'resume-dialogue' },
      { ...defaultSceneStep('show-text'), id: 'text' },
      {
        ...defaultSceneStep('audio-cue'),
        id: 'audio',
        asset: { $ref: { collection: 'assets', id: 'media' } },
      },
      {
        ...defaultSceneStep('set-variable'),
        id: 'variable',
        variable: { $ref: { collection: 'variables', id: 'flag' } },
        value: true,
      },
      { ...defaultSceneStep('run-lua'), id: 'lua' },
      { ...defaultSceneStep('wait'), id: 'duration' },
      {
        id: 'input',
        label: 'input',
        enabled: true,
        type: 'wait',
        timeline: { trackId: 'main', startMs: 0, durationMs: 0 },
        completionDependencies: [],
        waitKind: 'input',
        skippable: false,
      },
      {
        ...defaultSceneStep('conditional-branch'),
        id: 'branch',
        branches: [{ id: 'yes', condition: { kind: 'always' }, targetStepId: 'layout' }],
        fallbackStepId: 'transition',
      },
      {
        ...defaultSceneStep('choice'),
        id: 'choice',
        options: [
          {
            id: 'continue',
            label: { source: { kind: 'inline', text: 'Continue' }, markup: 'plain' },
            effects: [
              {
                id: 'set-flag',
                kind: 'set-global-property',
                variable: { $ref: { collection: 'variables', id: 'flag' } },
                value: true,
              },
            ],
            targetStepId: 'layout',
          },
        ],
      },
      {
        ...defaultSceneStep('set-layout'),
        id: 'layout',
        layout: { $ref: { collection: 'layouts', id: 'hud' } },
      },
      { ...defaultSceneStep('transition-group'), id: 'transition' },
      { ...defaultSceneStep('show-text'), id: 'disabled', enabled: false },
      { ...defaultSceneStep('comment'), id: 'note' },
    ];
    scene.terminal = { kind: 'release-to-exploration' };
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };
    const room = project.rooms.foyer!.data;
    room.scriptHooks = [
      {
        hook: 'before-enter',
        handler: {
          module: { $ref: { collection: 'scripts', id: 'bootstrap' } },
          export: 'before_enter',
        },
      },
      {
        hook: 'after-enter',
        handler: {
          module: { $ref: { collection: 'scripts', id: 'bootstrap' } },
          export: 'after_enter',
        },
      },
    ];

    const shared = lowerSharedAuthoringProject(project);
    expect(shared.diagnostics).toEqual([]);
    const result = lowerSceneAndRoomPrograms(project, shared.draft!);
    expect(result.diagnostics).toEqual([]);
    const lowered = result.draft!;
    expect(
      lowered.definitions.scenes[0]!.program.events.map((event) => event.instruction.kind),
    ).toEqual([
      'set-background',
      'actor-cue',
      'call-dialogue',
      'resume-dialogue',
      'show-text',
      'audio-cue',
      'gameplay-effect-batch',
      'run-lua',
      'wait-duration',
      'wait-input',
      'conditional-branch',
      'choice',
      'set-layout',
      'transition-group',
    ]);
    expect(lowered.definitions.scenes[0]!.program.events[6]!.instruction).toEqual({
      id: 'variable',
      kind: 'gameplay-effect-batch',
      operations: [
        {
          id: 'variable',
          kind: 'set-global-property',
          property: { kind: 'property', id: 'flag' },
          value: true,
        },
      ],
    });
    expect(lowered.definitions.scenes[0]!.terminal).toEqual({ kind: 'release-to-exploration' });
    expect(
      lowered.definitions.rooms.find((candidate) => candidate.id === 'foyer')!.scriptHooks,
    ).toEqual([
      {
        hook: 'before-enter',
        handler: { module: { kind: 'script', id: 'bootstrap' }, export: 'before_enter' },
      },
      {
        hook: 'after-enter',
        handler: { module: { kind: 'script', id: 'bootstrap' }, export: 'after_enter' },
      },
    ]);
  });

  it('rejects Scene targets removed from runtime lowering and unresolved instruction-local nested references', () => {
    const project = validProject();
    project.characters.hero = { id: 'hero', label: 'Hero', data: defaultCharacterData('Hero') };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
    const scene = defaultSceneData('Broken');
    scene.events = [
      {
        ...defaultSceneStep('conditional-branch'),
        id: 'branch',
        branches: [],
        fallbackStepId: 'note',
      },
      {
        ...defaultSceneStep('actor-cue'),
        id: 'actor',
        character: { $ref: { collection: 'characters', id: 'hero' } },
        poseId: 'missing',
        expressionId: 'missing',
      },
      {
        ...defaultSceneStep('call-dialogue'),
        id: 'dialogue',
        dialogue: { $ref: { collection: 'dialogues', id: 'intro' } },
        startBlockId: 'missing',
      },
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

  it('rejects type-invalid variable conditions before Scene and Room lowering', () => {
    const project = validProject();
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    const scene = defaultSceneData('Typed Scene');
    scene.events = [
      {
        ...defaultSceneStep('show-text'),
        id: 'typed-text',
        condition: {
          kind: 'variable-comparison',
          variable: { $ref: { collection: 'variables', id: 'flag' } },
          operator: 'equal',
          value: 'not-a-boolean',
        },
      },
    ];
    project.scenes.typed = { id: 'typed', label: 'Typed', data: scene };
    project.rooms.foyer!.data.lifecycle.canEnter = {
      kind: 'variable-comparison',
      variable: { $ref: { collection: 'variables', id: 'flag' } },
      operator: 'equal',
      value: 'not-a-boolean',
    };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        jsonPointer: '/rooms/foyer/data/lifecycle/canEnter/value',
        message: "Value does not match variable 'flag'.",
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        jsonPointer: '/scenes/typed/data/events/0/condition/value',
        message: "Value does not match variable 'flag'.",
      }),
    );
    expect(result.stages.find((stage) => stage.name === 'semantic-validation')).toEqual({
      name: 'semantic-validation',
      status: 'failed',
    });
  });

  it('losslessly lowers Dialogue graphs, Interaction instructions and retained Verb fallback chains', () => {
    const project = validProject();
    project.assets.voice = {
      id: 'voice',
      label: 'Voice',
      data: assetDataFromImportMetadata({
        kind: 'audio',
        projectRelativePath: 'assets/audio/voice.ogg',
        extension: '.ogg',
        byteSize: 10,
        contentHash: 'voice-hash',
        importedAt: '2026-01-01T00:00:00.000Z',
        originalName: 'voice.ogg',
        originalPath: '/tmp/voice.ogg',
        imageMetadata: null,
      }),
    };
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    const key = defaultInteractableData('Key');
    key.presentation.hotspots = { kind: 'custom', hotspots: [] };
    project.interactables.key = { id: 'key', label: 'Key', data: key };
    project.rooms.foyer!.data.placements = [
      {
        id: 'key-place',
        bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
        presentation: { label: null, layout: null },
      },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    const dialogue = defaultDialogueData('Intro');
    dialogue.blocks = [
      {
        ...defaultDialogueBlock('sequence', 'start'),
        segments: [
          {
            ...defaultDialogueSegment('line', 'welcome'),
            text: {
              source: { kind: 'inline', text: 'Hello' },
              markup: 'active-text',
            },
            cues: [
              {
                id: 'bold-open',
                kind: 'active-text',
                position: { offset: 0, order: 0 },
                token: '[b]',
              },
              {
                id: 'expression',
                kind: 'speaker-expression',
                position: { offset: 2, order: 0 },
                expressionId: 'neutral',
              },
              {
                id: 'voice',
                kind: 'voice',
                position: { offset: 3, order: 0 },
                asset: { $ref: { collection: 'assets', id: 'voice' } },
                pausePolicy: 'gameplay',
                gain: 0.8,
                pan: -0.2,
                waitForCompletion: true,
                skipBehavior: 'stop',
              },
              {
                id: 'sfx',
                kind: 'sound-effect',
                position: { offset: 3, order: 1 },
                asset: { $ref: { collection: 'assets', id: 'voice' } },
                pausePolicy: 'owner',
                gain: 0.5,
                pan: 0.25,
                waitForCompletion: false,
                causality: 'disposable',
                synchronized: false,
                skipBehavior: 'suppress',
              },
              {
                id: 'camera',
                kind: 'camera',
                position: { offset: 4, order: 0 },
                emphasis: {
                  kind: 'flash',
                  color: '#ffffff',
                  opacity: 0.75,
                  durationMs: 120,
                  skippable: true,
                  waitForCompletion: false,
                },
              },
              {
                id: 'bold-close',
                kind: 'active-text',
                position: { offset: 5, order: 0 },
                token: '[/b]',
              },
            ],
            effects: [
              {
                id: 'dialogue-line-effect',
                kind: 'set-global-property',
                variable: { $ref: { collection: 'variables', id: 'flag' } },
                value: true,
              },
            ],
            showOnce: true,
            logged: false,
            autosaveSafePoint: true,
          },
          {
            ...defaultDialogueSegment('run-lua', 'script'),
            condition: { kind: 'always' },
            mayYield: true,
          },
          {
            ...defaultDialogueSegment('call-scene', 'child-scene'),
            scene: { $ref: { collection: 'scenes', id: 'opening' } },
            inputs: [],
            uiPolicy: 'preserve',
            condition: { kind: 'always' },
          },
          {
            ...defaultDialogueSegment('handoff', 'handoff'),
            condition: { kind: 'always' },
            payload: 'resume-token',
          },
          { ...defaultDialogueSegment('comment', 'note') },
        ],
      },
      defaultDialogueBlock('choice', 'choice'),
      { ...defaultDialogueBlock('redirect', 'redirect'), targetBlockId: 'start' },
      defaultDialogueBlock('comment', 'comment'),
    ];
    dialogue.edges = [
      { id: 'next', kind: 'next', fromBlockId: 'start', toBlockId: 'choice' },
      {
        id: 'choose',
        kind: 'choice',
        fromBlockId: 'choice',
        toBlockId: 'redirect',
        label: { source: { kind: 'inline', text: 'Again' }, markup: 'plain' },
        condition: { kind: 'always' },
        effects: [{ id: 'choice-effect', kind: 'run-lua', source: 'again()' }],
        logged: true,
        autosaveSafePoint: true,
      },
    ];
    dialogue.completion = { kind: 'scene', id: 'opening' };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };

    const baseVerb = defaultVerbData('Use');
    const targetText = {
      source: { kind: 'inline' as const, text: 'target' },
      markup: 'plain' as const,
    };
    baseVerb.slots = [
      {
        id: 'target',
        label: targetText,
        prompt: targetText,
        selectors: [{ kind: 'any-subject' }],
      },
    ];
    baseVerb.bindingOrder = ['target'];
    baseVerb.availability = { kind: 'lua-predicate', source: 'base_available()' };
    baseVerb.defaultProgram = {
      instructions: [
        {
          id: 'base-notify',
          kind: 'notify',
          message: { source: { kind: 'inline', text: 'Base' }, markup: 'plain' },
        },
      ],
      completion: { kind: 'return' },
      outcome: 'unhandled',
    };
    project.verbs.use = { id: 'use', label: 'Use', data: baseVerb };
    const childVerb = defaultVerbData('Unlock');
    childVerb.slots = [
      {
        id: 'target',
        label: targetText,
        prompt: targetText,
        selectors: [{ kind: 'any-subject' }],
      },
    ];
    childVerb.bindingOrder = ['target'];
    childVerb.availability = { kind: 'always' };
    childVerb.defaultProgram = {
      instructions: [
        {
          id: 'child-call',
          kind: 'call-dialogue',
          dialogue: { $ref: { collection: 'dialogues', id: 'intro' } },
        },
      ],
      completion: { kind: 'return' },
      outcome: 'handled',
    };
    project.verbs.unlock = { id: 'unlock', label: 'Unlock', data: childVerb };

    const interaction = defaultInteractionData();
    interaction.rules = [
      {
        id: 'unlock-key',
        verb: { $ref: { collection: 'verbs', id: 'unlock' } },
        slots: [
          {
            slotId: 'target',
            selectors: [
              {
                kind: 'exact',
                subject: {
                  kind: 'interactable',
                  interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
                },
              },
            ],
          },
        ],
        offer: null,
        guard: { kind: 'always' },
        priority: 20,
        program: {
          instructions: [
            {
              id: 'effect',
              kind: 'set-global-property',
              variable: { $ref: { collection: 'variables', id: 'flag' } },
              value: true,
            },
            {
              id: 'move',
              kind: 'move-instance',
              subject: {
                kind: 'interactable',
                interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
              },
              location: {
                kind: 'inventory',
                inventory: {
                  kind: 'inventory',
                  inventory: { owner: { kind: 'project' }, inventoryId: 'inventory' },
                },
              },
            },
            {
              id: 'state',
              kind: 'set-visible',
              subject: {
                kind: 'interactable',
                interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
              },
              visible: false,
            },
            {
              id: 'notify',
              kind: 'notify',
              message: { source: { kind: 'inline', text: 'Unlocked' }, markup: 'plain' },
            },
          ],
          completion: { kind: 'return' },
          outcome: 'handled',
        },
      },
      {
        id: 'any-key',
        verb: { $ref: { collection: 'verbs', id: 'unlock' } },
        slots: [
          {
            slotId: 'target',
            selectors: [{ kind: 'family', family: 'interactable' }],
          },
        ],
        offer: null,
        guard: { kind: 'always' },
        priority: 0,
        program: defaultInteractionProgram(),
      },
    ];
    project.interactions.unlock = { id: 'unlock', label: 'Unlock', data: interaction };

    const shared = lowerSharedAuthoringProject(project).draft!;
    const sceneRoom = lowerSceneAndRoomPrograms(project, shared).draft!;
    const result = lowerDialogueAndInteractionPrograms(project, sceneRoom);
    expect(result.diagnostics).toEqual([]);
    const compiled = result.draft!;
    const loweredDialogue = compiled.definitions.dialogues[0]!;
    expect(loweredDialogue.program.blocks.map((block) => block.kind)).toEqual([
      'sequence',
      'choice',
      'redirect',
    ]);
    expect(loweredDialogue.program.blocks[0]).toMatchObject({
      segments: [
        {
          id: 'welcome',
          kind: 'line',
          text: {
            markup: 'active-text',
            source: { kind: 'inline', text: '[b]Hello[/b]' },
          },
          cues: [
            {
              id: 'expression',
              kind: 'speaker-expression',
              position: { offset: 2, order: 0 },
              expressionId: 'neutral',
            },
            {
              id: 'voice',
              kind: 'voice',
              position: { offset: 3, order: 0 },
              asset: { kind: 'asset', id: 'voice' },
              pausePolicy: 'gameplay',
              gain: 0.8,
              pan: -0.2,
              waitForCompletion: true,
              skipBehavior: 'stop',
            },
            {
              id: 'sfx',
              kind: 'sound-effect',
              position: { offset: 3, order: 1 },
              asset: { kind: 'asset', id: 'voice' },
              pausePolicy: 'owner',
              gain: 0.5,
              pan: 0.25,
              waitForCompletion: false,
              causality: 'disposable',
              synchronized: false,
              skipBehavior: 'suppress',
            },
            {
              id: 'camera',
              kind: 'camera',
              position: { offset: 4, order: 0 },
              emphasis: {
                kind: 'flash',
                color: '#ffffff',
                opacity: 0.75,
                durationMs: 120,
                skippable: true,
                waitForCompletion: false,
              },
            },
          ],
        },
        { id: 'script', kind: 'run-lua' },
        {
          id: 'child-scene',
          kind: 'call-scene',
          scene: { kind: 'scene', id: 'opening' },
          inputs: [],
          uiPolicy: 'preserve',
        },
        { id: 'handoff', kind: 'handoff', payload: 'resume-token' },
      ],
    });
    expect(loweredDialogue.program.edges.map((edge) => edge.kind)).toEqual(['next', 'choice']);
    expect(loweredDialogue.completion).toEqual({
      kind: 'scene',
      scene: { kind: 'scene', id: 'opening' },
    });
    expect(
      compiled.definitions.verbs.map((verb) => ({
        id: verb.id,
        availability: verb.availability.kind,
        outcome: verb.defaultProgram.outcome,
      })),
    ).toEqual([
      { id: 'unlock', availability: 'always', outcome: 'handled' },
      { id: 'use', availability: 'lua-predicate', outcome: 'unhandled' },
    ]);
    expect(
      compiled.definitions.interactions[0]!.rules[0]!.program.instructions.map(
        (instruction) => instruction.id,
      ),
    ).toEqual(['effect', 'move', 'state', 'notify']);
    expect(
      compiled.definitions.interactions[0]!.rules.map((rule) => rule.slots[0]!.selectors[0]!.kind),
    ).toEqual(['exact', 'family']);
  });

  it('rejects type-invalid Dialogue, Interaction, and Verb variable usage before lowering', () => {
    const project = validProject();
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };

    const dialogue = defaultDialogueData('Typed Dialogue');
    dialogue.blocks = [
      {
        ...defaultDialogueBlock('sequence', 'start'),
        segments: [
          {
            ...defaultDialogueSegment('line', 'line'),
            condition: {
              kind: 'variable-comparison',
              variable: { $ref: { collection: 'variables', id: 'flag' } },
              operator: 'equal',
              value: 'not-a-boolean',
            },
          },
        ],
      },
    ];
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
    interaction.rules = [
      {
        id: 'typed-rule',
        verb: { $ref: { collection: 'verbs', id: 'use' } },
        slots: [],
        offer: null,
        guard: {
          kind: 'variable-comparison',
          variable: { $ref: { collection: 'variables', id: 'flag' } },
          operator: 'equal',
          value: 'not-a-boolean',
        },
        priority: 0,
        program: {
          instructions: [
            {
              id: 'bad-effect',
              kind: 'set-global-property',
              variable: { $ref: { collection: 'variables', id: 'flag' } },
              value: 'not-a-boolean',
            },
          ],
          completion: { kind: 'return' },
          outcome: 'handled',
        },
      },
    ];
    project.interactions.typed = { id: 'typed', label: 'Typed', data: interaction };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(false);
    for (const pointer of [
      '/dialogues/typed/data/blocks/0/segments/0/condition/value',
      '/interactions/typed/data/rules/0/guard/value',
      '/interactions/typed/data/rules/0/program/instructions/0/value',
      '/verbs/use/data/availability/value',
    ]) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          jsonPointer: pointer,
          message: "Value does not match variable 'flag'.",
        }),
      );
    }
  });

  it('produces identical specialized program drafts independently of collection map insertion order', () => {
    const buildDraft = (roomOrder: readonly string[]) => {
      const project = validProject(roomOrder);
      project.scenes.opening = {
        id: 'opening',
        label: 'Opening',
        data: defaultSceneData('Opening'),
      };
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'COMPILER_ENTRYPOINT_REQUIRED', path: '/entrypoint' }),
    ]);
  });

  it('compiles a newly created Interactable without requiring a sprite or hotspot', () => {
    const project = validProject();
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
    };

    const result = compileAuthoringProject(project);

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(
      true,
    );
    if (!result.ok) return;
    expect(result.project.definitions.interactables[0]?.presentation).toMatchObject({
      sprite: null,
      material: null,
      hotspots: { kind: 'none' },
    });
  });

  it('blocks compilation when Alpha hotspot mode has no sprite', () => {
    const project = validProject();
    const data = defaultInteractableData('Key');
    data.presentation.hotspots = {
      kind: 'sprite-alpha',
      hotspot: defaultHotspotBehavior('Key'),
    };
    project.interactables.key = { id: 'key', label: 'Key', data };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'AUTHORING_HOTSPOT_AUTHORING_SOURCE_IMAGE_REQUIRED',
        severity: 'error',
        jsonPointer: '/interactables/key/data/presentation/hotspots/kind',
      }),
    );
  });

  it('lowers multiple declared Interactable Instances from one immutable definition without changing the compiled schema version', () => {
    const project = validProject();
    project.traits.quest = {
      id: 'quest',
      label: 'Quest object',
      ownerKinds: ['interactable'],
      properties: [{ id: 'polished', type: 'boolean', nullable: false }],
    };
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
      traits: [],
      defaultProperties: [
        {
          id: 'polished',
          label: 'Polished',
          description: 'Instance finish',
          type: 'boolean',
          nullable: false,
          defaultValue: false,
        },
      ],
    };
    project.interactableInstances['key-foyer'] = {
      ...defaultInteractableInstanceData('key-foyer', 'key', {
        kind: 'room',
        room: { $ref: { collection: 'rooms', id: 'foyer' } },
      }),
      editorLabel: 'Foyer key',
      traits: { add: ['quest'], remove: [] },
      localProperties: [{ id: 'polished', type: 'boolean', nullable: false, value: true }],
    };
    project.interactableInstances['key-spare'] = defaultInteractableInstanceData(
      'key-spare',
      'key',
    );
    project.interactableInstances['key-spare'].localProperties.push({
      id: 'polished',
      type: 'boolean',
      nullable: false,
      value: true,
    });

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.schemaVersion).toBe(1);
    expect(result.project.definitions.interactables).toEqual([
      {
        id: 'key',
        displayName: 'Key',
        stackable: false,
        stackLimit: null,
        features: [],
        inventories: [],
        presentation: { sprite: null, material: null, hotspots: { kind: 'none' } },
        traits: [],
        propertyAssignments: [],
        properties: [
          {
            id: 'polished',
            label: 'Polished',
            description: 'Instance finish',
            type: 'boolean',
            nullable: false,
            enumValues: [],
            defaultValue: false,
          },
        ],
      },
    ]);
    expect(result.project.interactableInstances).toEqual([
      {
        id: 'key-foyer',
        definition: { kind: 'interactable-definition', id: 'key' },
        enabled: true,
        visible: true,
        quantity: 1,
        location: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
        traitAdds: ['quest'],
        traitRemoves: [],
        propertyOverrides: [{ propertyId: 'polished', value: true }],
        localProperties: [],
        featureOverrides: [],
      },
      {
        id: 'key-spare',
        definition: { kind: 'interactable-definition', id: 'key' },
        enabled: true,
        visible: true,
        quantity: 1,
        location: { kind: 'unplaced' },
        traitAdds: [],
        traitRemoves: [],
        propertyOverrides: [{ propertyId: 'polished', value: true }],
        localProperties: [],
        featureOverrides: [],
      },
    ]);
  });

  it('lowers same-key Room Properties as independent exact-owner declarations', () => {
    const project = validProject(['foyer', 'hall']);
    project.variables.state = {
      id: 'state',
      label: 'Global state',
      data: defaultVariableData('integer'),
    };
    project.rooms.foyer!.localProperties = [
      {
        id: 'state',
        label: 'Open state',
        type: 'boolean',
        nullable: false,
        value: true,
      },
    ];
    project.rooms.hall!.localProperties = [
      {
        id: 'state',
        description: 'Unrelated textual state',
        type: 'string',
        nullable: true,
        value: null,
      },
    ];

    const result = compileAuthoringProject(project);

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(
      true,
    );
    if (!result.ok) return;
    expect(result.project.schemaVersion).toBe(1);
    expect(result.project.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'state',
          type: 'boolean',
          nullable: false,
          owner: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
          scope: 'identity',
        }),
        expect.objectContaining({
          id: 'state',
          type: 'string',
          nullable: true,
          owner: { kind: 'room', room: { kind: 'room', id: 'hall' } },
          scope: 'identity',
        }),
        expect.objectContaining({
          id: 'state',
          type: 'integer',
          scope: 'global',
        }),
      ]),
    );
    expect(
      result.project.definitions.rooms.find((room) => room.id === 'foyer')?.propertyAssignments,
    ).toEqual([{ propertyId: 'state', value: true }]);
    expect(
      result.project.definitions.rooms.find((room) => room.id === 'hall')?.propertyAssignments,
    ).toEqual([{ propertyId: 'state', value: null }]);
  });

  it('strictly rejects invalid authoring boundary data and produces deterministic diagnostics independent of map insertion order', () => {
    const invalid = Object.assign(validProject(), { unknownWireInput: true });
    const invalidResult = compileAuthoringProject(invalid);
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'AUTHORING_SCHEMA_UNRECOGNIZED_KEYS' }),
    );

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
    character.idles = [
      {
        id: 'breathing',
        label: 'Breathing',
        kind: 'pulse',
        amplitude: 0.02,
        periodMs: 1800,
        clock: 'gameplay',
      },
    ];
    character.defaults.idleId = 'breathing';
    const room = project.rooms.start!.data;
    room.environments = [
      {
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
      },
    ];

    const result = compileAuthoringProject(project);

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(
      true,
    );
    if (!result.ok) return;
    const compiledCharacter = result.project.definitions.characters.find(
      (value) => value.id === 'hero',
    );
    const compiledRoom = result.project.definitions.rooms.find((value) => value.id === 'start');
    expect(compiledCharacter?.defaults.idleId).toBe('breathing');
    expect(compiledCharacter?.idles).toEqual([
      {
        id: 'breathing',
        kind: 'pulse',
        amplitude: 0.02,
        periodMs: 1800,
        clock: 'gameplay',
      },
    ]);
    expect(compiledRoom?.environments).toEqual([
      expect.objectContaining({
        id: 'rain',
        plane: 'world-overlay',
        order: 4,
        clock: 'gameplay',
        scrollPerSecond: { x: 0, y: 0.1 },
        opacity: 0.6,
      }),
    ]);
  });

  it('builds shared symbols for every collection and representative nested stable-ID namespaces', () => {
    const project = validProject();
    const room = project.rooms.foyer!;
    const roomData = room.data;
    roomData.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
        presentation: { label: null, layout: null },
      },
    ];
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    const scene = defaultSceneData('Opening');
    scene.events = [
      {
        ...defaultSceneStep('choice'),
        id: 'choice',
        options: [
          {
            id: 'continue',
            label: { source: { kind: 'inline', text: 'Continue' }, markup: 'plain' },
            effects: [],
            targetStepId: 'choice',
          },
        ],
      },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };

    const symbols = buildAuthoringSymbolTables(project);
    for (const collection of authoringCollectionKeys)
      expect(symbols.collections.has(collection)).toBe(true);
    expect(resolveAuthoringSymbol(symbols, 'rooms', 'foyer')).toEqual(project.rooms.foyer);
    expect(
      resolveNestedAuthoringSymbol(symbols, 'room-placement', 'foyer', 'key-placement')?.sourcePath,
    ).toBe('/rooms/foyer/data/placements/0');
    expect(
      resolveNestedAuthoringSymbol(symbols, 'scene-choice-option', 'opening', 'continue')
        ?.sourcePath,
    ).toBe('/scenes/opening/data/events/0/options/0');
  });

  it('indexes every declared nested stable-ID namespace', () => {
    const project = validProject();

    const character = defaultCharacterData('Hero');
    character.profiles[0]!.poses = [{ ...character.profiles[0]!.poses[0]!, id: 'standing' }];
    character.profiles[0]!.defaultPoseId = 'standing';
    character.expressions = [{ ...character.expressions[0]!, id: 'neutral' }];
    project.characters.hero = { id: 'hero', label: 'Hero', data: character };

    const room = defaultRoomData('Foyer');
    room.overlays = [
      {
        id: 'hud-overlay',
        layout: { $ref: { collection: 'layouts', id: 'hud' } },
        condition: { kind: 'always' },
        visible: true,
        order: 0,
      },
    ];
    room.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
        presentation: { label: null, layout: null },
      },
    ];
    room.cast = [
      {
        id: 'hero-cast',
        character: { $ref: { collection: 'characters', id: 'hero' } },
        condition: { kind: 'always' },
        placementId: 'key-placement',
        poseId: 'standing',
        expressionId: 'neutral',
        idleId: null,
        visible: true,
        order: 0,
      },
    ];
    room.props = [
      {
        id: 'key-prop',
        condition: { kind: 'always' },
        placementId: 'key-placement',
        asset: null,
        material: { $ref: { collection: 'materials', id: 'material' } },
        visible: true,
        order: 0,
      },
    ];
    room.exits = [
      {
        id: 'north-exit',
        direction: 'north',
        target: { $ref: { collection: 'rooms', id: 'hall' } },
        label: 'North',
        condition: { kind: 'always' },
        onRejected: [],
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };

    const scene = defaultSceneData('Opening');
    scene.events = [
      {
        ...defaultSceneStep('conditional-branch'),
        id: 'branch',
        branches: [{ id: 'true-branch', condition: { kind: 'always' }, targetStepId: 'choice' }],
        fallbackStepId: 'choice',
      },
      {
        ...defaultSceneStep('choice'),
        id: 'choice',
        options: [
          {
            id: 'continue',
            label: { source: { kind: 'inline', text: 'Continue' }, markup: 'plain' },
            effects: [],
            targetStepId: 'choice',
          },
        ],
      },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };

    const dialogue = defaultDialogueData('Intro');
    dialogue.blocks = [
      {
        ...defaultDialogueBlock('sequence', 'start'),
        segments: [defaultDialogueSegment('line', 'line-1')],
      },
    ];
    dialogue.edges = [{ id: 'loop', kind: 'next', fromBlockId: 'start', toBlockId: 'start' }];
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };

    const interaction = defaultInteractionData();
    interaction.rules = [
      {
        id: 'look-rule',
        verb: { $ref: { collection: 'verbs', id: 'look' } },
        slots: [],
        offer: null,
        guard: { kind: 'always' },
        priority: 0,
        program: {
          instructions: [
            {
              id: 'notice',
              kind: 'notify',
              message: { source: { kind: 'inline', text: 'Look' }, markup: 'plain' },
            },
          ],
          completion: { kind: 'return' },
          outcome: 'unhandled',
        },
      },
    ];
    project.interactions.look = { id: 'look', label: 'Look', data: interaction };

    const map = defaultMapData();
    map.locations = [
      {
        id: 'foyer-location',
        room: { $ref: { collection: 'rooms', id: 'foyer' } },
        regions: [],
        label: null,
        icon: null,
        style: null,
        labelAnchor: null,
        connectionAnchor: null,
        visibility: { kind: 'always' },
        pickOrder: 0,
        logicalOrder: 0,
      },
    ];
    map.connections = [
      {
        id: 'north-connection',
        exits: [{ room: 'foyer', exit: 'north-exit' }],
        label: null,
        icon: null,
        style: null,
        visibility: { kind: 'always' },
        logicalOrder: 0,
        path: [],
        hitRegions: [],
      },
    ];
    project.maps.house = { id: 'house', label: 'House', data: map };

    const test = defaultTestData('Smoke');
    const step = defaultTestStep('tick', 'Start');
    test.steps = [{ ...step, id: 'start' }];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data: test };

    const symbols = buildAuthoringSymbolTables(project);
    expect([...symbols.nested.keys()].sort()).toEqual([...compilerNestedNamespaces].sort());
    for (const namespace of compilerNestedNamespaces)
      expect(symbols.nested.get(namespace)?.size).toBeGreaterThan(0);
  });
});
