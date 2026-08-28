import {
  assetDataFromImportMetadata,
  type AssetKind,
} from '../../../shared/project-schema/authoring-assets';
import { defaultArchetypeData } from '../../../shared/project-schema/authoring-archetypes';
import {
  characterAssetRef,
  characterMaterialRef,
  defaultCharacterData,
} from '../../../shared/project-schema/authoring-characters';
import {
  defaultDialogueBlock,
  defaultDialogueData,
  defaultDialogueSegment,
} from '../../../shared/project-schema/authoring-dialogues';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
  interactableAssetRef,
  interactableMaterialRef,
} from '../../../shared/project-schema/authoring-interactables';
import { defaultInteractionData } from '../../../shared/project-schema/authoring-interactions';
import {
  defaultLayoutData,
  layoutRecordRef,
} from '../../../shared/project-schema/authoring-layouts';
import { defaultMapData } from '../../../shared/project-schema/authoring-maps';
import { defaultMaterialData } from '../../../shared/project-schema/authoring-materials';
import {
  createAuthoringProject,
  type AuthoringProject,
} from '../../../shared/project-schema/authoring-project';
import { assetRef as projectAssetRef } from '../../../shared/project-schema/authoring-project-settings';
import {
  defaultRoomData,
  roomAssetRef,
  roomLayoutRef,
  roomMaterialRef,
  roomRoomRef,
} from '../../../shared/project-schema/authoring-rooms';
import {
  defaultSceneData,
  defaultSceneStep,
  sceneAssetRef,
  sceneCharacterRef,
  sceneDialogueRef,
  sceneLayoutRef,
  sceneMaterialRef,
  sceneRoomRef,
  sceneSceneRef,
  sceneVariableRef,
} from '../../../shared/project-schema/authoring-scenes';
import { defaultScriptModuleData } from '../../../shared/project-schema/authoring-script-modules';
import { defaultShaderData } from '../../../shared/project-schema/authoring-shaders';
import { defaultVariableData } from '../../../shared/project-schema/authoring-variables';
import { defaultVerbData } from '../../../shared/project-schema/authoring-verbs';

const assetReference = (id: string) => ({ $ref: { collection: 'assets' as const, id } });
const characterReference = (id: string) => ({ $ref: { collection: 'characters' as const, id } });
const dialogueReference = (id: string) => ({ $ref: { collection: 'dialogues' as const, id } });
const interactableReference = (id: string) => ({
  $ref: { collection: 'interactables' as const, id },
});
const roomReference = (id: string) => ({ $ref: { collection: 'rooms' as const, id } });
const variableReference = (id: string) => ({ $ref: { collection: 'variables' as const, id } });
const verbReference = (id: string) => ({ $ref: { collection: 'verbs' as const, id } });

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index >= 0 ? path.slice(index) : '';
}

function addAsset(
  project: AuthoringProject,
  id: string,
  kind: AssetKind,
  path: string,
  aliases: string[] = [],
): void {
  const metadata =
    kind === 'image'
      ? {
          kind,
          projectRelativePath: path,
          aliases,
          extension: extensionOf(path),
          contentHash: `golden-${id}`,
          imageMetadata: { width: 1920, height: 1080, hasAlpha: true, orientation: 1 as const },
        }
      : {
          kind,
          projectRelativePath: path,
          aliases,
          extension: extensionOf(path),
          contentHash: `golden-${id}`,
          imageMetadata: null,
        };
  project.assets[id] = {
    id,
    label: id,
    data: assetDataFromImportMetadata(metadata),
  };
}

function renameProject(project: AuthoringProject, id: string, name: string): void {
  const applicationId = `org.noveltea.${id}`;
  project.project = {
    ...project.project,
    id,
    name,
    description: `${name} decoder fixture.`,
  };
  if (project.settings.app) {
    project.settings.app = {
      ...project.settings.app,
      displayName: name,
      applicationId,
      saveNamespace: applicationId,
    };
  }
}

export function minimalGoldenProject(): AuthoringProject {
  const project = createAuthoringProject({ id: 'golden-minimal', name: 'Golden Minimal' });
  project.settings.ui.systemLayouts = {};
  const room = defaultRoomData('Start');
  room.description = { markup: 'plain', source: { kind: 'inline', text: 'Minimal room.' } };
  project.rooms.start = { id: 'start', label: 'Start', data: room };
  project.entrypoint = { kind: 'room', id: 'start' };
  return project;
}

export function canonicalLinearGoldenProject(): AuthoringProject {
  const project = createAuthoringProject({
    id: 'golden-canonical-linear',
    name: 'Golden Canonical Linear',
  });
  project.settings.ui.systemLayouts = {};

  const dialogue = defaultDialogueData('Conversation');
  dialogue.blocks[0] = {
    ...dialogue.blocks[0]!,
    type: 'sequence',
    defaultSpeaker: null,
    segments: [
      {
        ...defaultDialogueSegment('line', 'opening-line'),
        text: { markup: 'plain', source: { kind: 'inline', text: 'A linear conversation.' } },
        autosaveSafePoint: true,
      },
    ],
  };
  dialogue.completion = { kind: 'return' };
  project.dialogues.conversation = {
    id: 'conversation',
    label: 'Conversation',
    data: dialogue,
  };

  const scene = defaultSceneData('Opening');
  scene.stage = {
    kind: 'blank',
    background: { asset: null, material: null, color: '#0f172a', fit: 'cover' },
    layout: null,
  };
  scene.events = [
    {
      ...defaultSceneStep('call-dialogue'),
      id: 'conversation',
      dialogue: sceneDialogueRef('conversation'),
      startBlockId: 'start',
      autosaveSafePoint: true,
    },
  ];
  scene.terminal = { kind: 'complete-game' };
  project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };
  project.entrypoint = { kind: 'scene', id: 'opening' };
  return project;
}

export function canonicalFlowGoldenProject(): AuthoringProject {
  const project = comprehensiveGoldenProject();
  renameProject(project, 'golden-canonical-flow', 'Golden Canonical Flow');

  const dialogue = defaultDialogueData('Repeated Handoff');
  dialogue.blocks[0] = {
    ...dialogue.blocks[0]!,
    type: 'sequence',
    defaultSpeaker: null,
    segments: [
      {
        ...defaultDialogueSegment('line', 'first-line'),
        text: { markup: 'plain', source: { kind: 'inline', text: 'Before the flashback.' } },
      },
      { ...defaultDialogueSegment('handoff', 'first-handoff'), payload: 'first' },
      {
        ...defaultDialogueSegment('line', 'second-line'),
        text: { markup: 'plain', source: { kind: 'inline', text: 'After the flashback.' } },
      },
      { ...defaultDialogueSegment('handoff', 'second-handoff'), payload: 2 },
      {
        ...defaultDialogueSegment('line', 'third-line'),
        text: { markup: 'plain', source: { kind: 'inline', text: 'After the second handoff.' } },
      },
    ],
  };
  dialogue.completion = { kind: 'return' };
  project.dialogues.handoff = { id: 'handoff', label: 'Repeated Handoff', data: dialogue };

  const flashback = defaultSceneData('Flashback');
  flashback.stage = { kind: 'staged-room', room: sceneRoomRef('hall') };
  flashback.events = [
    {
      ...defaultSceneStep('show-text'),
      id: 'memory',
      text: { markup: 'plain', source: { kind: 'inline', text: 'A staged memory.' } },
      wait: 'input',
    },
  ];
  flashback.terminal = { kind: 'return', outcome: null };
  project.scenes.flashback = { id: 'flashback', label: 'Flashback', data: flashback };

  const parent = defaultSceneData('Handoff Parent');
  parent.stage = {
    kind: 'blank',
    background: { asset: null, material: null, color: '#111827', fit: 'cover' },
    layout: null,
  };
  parent.events = [
    {
      ...defaultSceneStep('call-dialogue'),
      id: 'dialogue',
      dialogue: sceneDialogueRef('handoff'),
      startBlockId: 'start',
    },
    {
      ...defaultSceneStep('call-scene'),
      id: 'flashback',
      scene: sceneSceneRef('flashback'),
      inputs: [],
    },
    { ...defaultSceneStep('resume-dialogue'), id: 'resume-first' },
    {
      ...defaultSceneStep('show-text'),
      id: 'between-handoffs',
      text: { markup: 'plain', source: { kind: 'inline', text: 'Between handoffs.' } },
      wait: 'input',
    },
    { ...defaultSceneStep('resume-dialogue'), id: 'resume-second' },
  ];
  parent.terminal = { kind: 'complete-game' };
  project.scenes['handoff-parent'] = {
    id: 'handoff-parent',
    label: 'Handoff Parent',
    data: parent,
  };
  project.entrypoint = { kind: 'scene', id: 'handoff-parent' };
  return project;
}

export function comprehensiveGoldenProject(): AuthoringProject {
  const project = createAuthoringProject({
    id: 'golden-comprehensive',
    name: 'Golden Comprehensive',
    version: '1.0.0',
    author: 'NovelTea',
    description: 'Every compiled definition, declaration, localization, and resource family.',
  });

  addAsset(project, 'image-main', 'image', 'assets/images/main.png', ['main-image']);
  addAsset(project, 'font-main', 'font', 'assets/fonts/main.ttf', ['main-font']);
  addAsset(project, 'audio-voice', 'audio', 'assets/audio/voice.ogg');
  addAsset(project, 'script-layout', 'script', 'assets/scripts/layout.lua');
  addAsset(project, 'shader-source', 'shader-source', 'assets/shaders/effect.sc');
  addAsset(project, 'text-rml', 'text', 'assets/ui/layout.rml');
  addAsset(project, 'text-rcss', 'text', 'assets/ui/layout.rcss');
  addAsset(project, 'data-config', 'data', 'assets/data/config.json');
  addAsset(project, 'binary-blob', 'binary', 'assets/binary/blob.bin');

  const shader = defaultShaderData('Sprite Shader');
  shader.samplers = [{ name: 's_texColor', type: 'texture2d', binding: null }];
  project.shaders['sprite-shader'] = { id: 'sprite-shader', label: 'Sprite Shader', data: shader };

  const material = defaultMaterialData('Sprite Material', 'sprite-shader');
  material.uniforms = [{ name: 'u_tint', value: [1, 0.75, 0.5, 1] }];
  material.textures = [
    {
      sampler: 's_texColor',
      source: assetReference('image-main'),
      filtering: 'repeat-linear',
    },
  ];
  project.materials['sprite-material'] = {
    id: 'sprite-material',
    label: 'Sprite Material',
    data: material,
  };

  const inlineLayout = defaultLayoutData('Inline HUD', 'document');
  inlineLayout.target = 'default-ui';
  inlineLayout.dependencies = {
    images: [assetReference('image-main')],
    fonts: [assetReference('font-main')],
    stylesheets: [assetReference('text-rcss')],
    materials: [{ $ref: { collection: 'materials', id: 'sprite-material' } }],
    scripts: [assetReference('script-layout')],
  };
  project.layouts['hud-inline'] = { id: 'hud-inline', label: 'Inline HUD', data: inlineLayout };

  const assetLayout = defaultLayoutData('Asset HUD', 'fragment');
  assetLayout.target = 'room-overlay';
  assetLayout.rml = {
    sourceMode: 'asset',
    sourceText: '',
    sourceAsset: assetReference('text-rml'),
  };
  assetLayout.rcss = {
    sourceMode: 'asset',
    sourceText: '',
    sourceAsset: assetReference('text-rcss'),
  };
  assetLayout.lua = {
    sourceMode: 'asset',
    sourceText: '',
    sourceAsset: assetReference('script-layout'),
  };
  assetLayout.dependencies = {
    images: [assetReference('image-main')],
    fonts: [assetReference('font-main')],
    stylesheets: [assetReference('text-rcss')],
    materials: [{ $ref: { collection: 'materials', id: 'sprite-material' } }],
    scripts: [assetReference('script-layout')],
  };
  project.layouts['hud-assets'] = { id: 'hud-assets', label: 'Asset HUD', data: assetLayout };

  const inlineScript = defaultScriptModuleData();
  inlineScript.source = { kind: 'inline-lua', source: 'return { fixture = true }' };
  project.scripts['inline-module'] = {
    id: 'inline-module',
    label: 'Inline Module',
    data: inlineScript,
  };
  project.scripts['asset-module'] = {
    id: 'asset-module',
    label: 'Asset Module',
    data: {
      kind: 'script-module',
      source: { kind: 'asset', asset: assetReference('script-layout') },
    },
  };

  project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
  const count = defaultVariableData('integer');
  count.value = 2;
  project.variables.count = { id: 'count', label: 'Count', data: count };
  const ratio = defaultVariableData('number');
  ratio.value = 0.5;
  project.variables.ratio = { id: 'ratio', label: 'Ratio', data: ratio };
  const playerName = defaultVariableData('string');
  playerName.value = 'Ada';
  project.variables['player-name'] = { id: 'player-name', label: 'Player Name', data: playerName };
  const moodVariable = defaultVariableData('enum');
  moodVariable.enumValues = ['calm', 'tense'];
  moodVariable.value = 'calm';
  project.variables['mood-variable'] = { id: 'mood-variable', label: 'Mood', data: moodVariable };

  const allOwnerKinds = ['room', 'character', 'interactable', 'feature'] as const;
  project.properties.affinity = {
    id: 'affinity',
    label: 'Affinity',
    type: 'number',
    nullable: false,
    defaultValue: 0.5,
    ownerKinds: ['character'],
  };
  project.properties.enabled = {
    id: 'enabled',
    label: 'Enabled',
    type: 'boolean',
    nullable: false,
    defaultValue: true,
    ownerKinds: [...allOwnerKinds],
  };
  project.properties['visit-count'] = {
    id: 'visit-count',
    label: 'Visit Count',
    type: 'integer',
    nullable: false,
    defaultValue: 0,
    ownerKinds: ['room'],
  };
  project.properties.mood = {
    id: 'mood',
    label: 'Mood',
    description: 'Room mood',
    type: 'enum',
    nullable: false,
    defaultValue: 'calm',
    enumValues: ['calm', 'tense'],
    ownerKinds: ['room'],
  };
  project.properties.note = {
    id: 'note',
    label: 'Note',
    type: 'string',
    nullable: true,
    defaultValue: null,
    ownerKinds: ['interactable'],
  };
  project.properties.quality = {
    id: 'quality',
    label: 'Quality',
    type: 'enum',
    nullable: false,
    defaultValue: 'ordinary',
    enumValues: ['ordinary', 'polished'],
    ownerKinds: ['interactable'],
  };
  project.traits['tense-room'] = {
    id: 'tense-room',
    label: 'Tense Room',
    description: 'Configures a tense mood while requiring visit tracking.',
    ownerKinds: ['room'],
    properties: [
      {
        id: 'mood',
        type: 'enum',
        nullable: false,
        enumValues: ['calm', 'tense'],
        defaultValue: 'tense',
      },
      { id: 'visit-count', type: 'integer', nullable: false },
    ],
  };
  project.traits['feature-enabled'] = {
    id: 'feature-enabled',
    label: 'Feature Enabled',
    description: 'Requires an enabled state for semantic Features.',
    ownerKinds: ['feature'],
    properties: [{ id: 'enabled', type: 'boolean', nullable: false }],
  };
  project.traits.currency = {
    id: 'currency',
    label: 'Currency',
    ownerKinds: ['interactable'],
    properties: [
      {
        id: 'quality',
        type: 'enum',
        nullable: false,
        enumValues: ['ordinary', 'polished'],
        defaultValue: 'polished',
      },
    ],
  };
  project.inventories = [{ id: 'player', label: 'Player Inventory' }];

  const credits = defaultInteractableData('Credits');
  credits.presentation = {
    sprite: interactableAssetRef('image-main'),
    material: interactableMaterialRef('sprite-material'),
    hotspots: { kind: 'none' },
  };
  project.interactables.credits = {
    id: 'credits',
    label: 'Credits',
    traits: ['currency'],
    data: credits,
  };
  project.interactableInstances.wallet = defaultInteractableInstanceData('wallet', 'credits', {
    kind: 'inventory',
    inventory: { owner: { kind: 'project' }, inventoryId: 'player' },
  });
  project.interactableInstances.wallet.editorLabel = 'Wallet credits';
  project.interactableInstances.wallet.properties.quality = 'polished';

  const hero = defaultCharacterData('Hero');
  hero.profiles[0]!.poses[0]!.layers[0]!.sprite = characterAssetRef('image-main');
  hero.profiles[0]!.poses[0]!.layers[0]!.material = characterMaterialRef('sprite-material');
  hero.expressions[0]!.profiles = [
    {
      profileId: 'stage',
      layers: [
        {
          layerId: 'body',
          sprite: characterAssetRef('image-main'),
          material: characterMaterialRef('sprite-material'),
        },
      ],
    },
  ];
  hero.inventories = [{ id: 'carried', label: 'Carried' }];
  hero.initialWorldState.location = { kind: 'room', room: roomReference('start') };
  project.characters.hero = {
    id: 'hero',
    label: 'Hero',
    properties: { affinity: 0.75, enabled: true },
    data: hero,
  };

  const key = defaultInteractableData('Key');
  key.presentation.hotspots = { kind: 'custom', hotspots: [] };
  key.presentation = {
    sprite: interactableAssetRef('image-main'),
    material: interactableMaterialRef('sprite-material'),
    hotspots: key.presentation.hotspots,
  };
  key.inventories = [{ id: 'hidden', label: 'Hidden Compartment' }];
  project.interactables.key = {
    id: 'key',
    label: 'Key',
    properties: { enabled: true, note: 'brass key' },
    data: key,
  };

  const coin = defaultInteractableData('Coin');
  coin.inventories = [{ id: 'pouch', label: 'Coin Pouch' }];
  coin.presentation.hotspots = { kind: 'custom', hotspots: [] };
  coin.presentation = {
    sprite: interactableAssetRef('image-main'),
    material: interactableMaterialRef('sprite-material'),
    hotspots: coin.presentation.hotspots,
  };
  project.interactables.coin = { id: 'coin', label: 'Coin', data: coin };

  const dust = defaultInteractableData('Dust');
  dust.presentation.hotspots = { kind: 'custom', hotspots: [] };
  project.interactables.dust = { id: 'dust', label: 'Dust', data: dust };
  project.interactableInstances.key = defaultInteractableInstanceData('key', 'key', {
    kind: 'room',
    room: roomReference('start'),
  });
  project.interactableInstances.coin = defaultInteractableInstanceData('coin', 'coin');
  project.interactableInstances.dust = defaultInteractableInstanceData('dust', 'dust');

  const start = defaultRoomData('Start');
  start.background = {
    asset: roomAssetRef('image-main'),
    material: roomMaterialRef('sprite-material'),
    fit: 'cover',
    color: '#101820',
  };
  start.description = { markup: 'active-text', source: { kind: 'localized', key: 'room-start' } };
  start.overlays = [
    {
      id: 'start-overlay',
      layout: roomLayoutRef('hud-assets'),
      condition: { kind: 'always' },
      visible: true,
      order: 0,
    },
  ];
  start.placements = [
    {
      id: 'key-placement',
      bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
      presentation: {
        label: { markup: 'plain', source: { kind: 'lua-expression', source: 'key_label()' } },
        layout: roomLayoutRef('hud-inline'),
      },
    },
  ];
  start.interactables = [
    {
      id: 'key',
      interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
      condition: { kind: 'always' },
      placementId: 'key-placement',
      visible: true,
      order: 0,
    },
  ];
  start.exits = [
    {
      id: 'north-exit',
      label: 'North',
      direction: 'north',
      target: roomRoomRef('hall'),
      condition: {
        kind: 'variable-comparison',
        variable: variableReference('flag'),
        operator: 'truthy',
      },
    },
  ];
  start.lifecycle = {
    canEnter: { kind: 'always' },
    canLeave: { kind: 'lua-predicate', source: 'can_leave_start()' },
  };
  start.scriptHooks = [
    {
      hook: 'before-enter',
      handler: {
        module: { $ref: { collection: 'scripts', id: 'bootstrap' } },
        export: 'before_enter_start',
      },
    },
    {
      hook: 'after-enter',
      handler: {
        module: { $ref: { collection: 'scripts', id: 'bootstrap' } },
        export: 'after_enter_start',
      },
    },
    {
      hook: 'before-leave',
      handler: {
        module: { $ref: { collection: 'scripts', id: 'bootstrap' } },
        export: 'before_leave_start',
      },
    },
    {
      hook: 'after-leave',
      handler: {
        module: { $ref: { collection: 'scripts', id: 'bootstrap' } },
        export: 'after_leave_start',
      },
    },
  ];
  project.rooms.start = {
    id: 'start',
    label: 'Start',
    properties: { mood: 'calm', 'visit-count': 1 },
    data: start,
  };

  const hall = defaultRoomData('Hall');
  hall.background = {
    asset: roomAssetRef('image-main'),
    material: roomMaterialRef('sprite-material'),
    fit: 'contain',
    color: null,
  };
  hall.description = {
    markup: 'plain',
    source: { kind: 'lua-expression', source: 'hall_description()' },
  };
  hall.overlays = [
    {
      id: 'hall-overlay',
      layout: roomLayoutRef('hud-inline'),
      condition: { kind: 'always' },
      visible: false,
      order: 0,
    },
  ];
  hall.placements = [
    {
      id: 'coin-placement',
      bounds: { x: 0.6, y: 0.6, width: 0.1, height: 0.1 },
      presentation: {
        label: { markup: 'plain', source: { kind: 'inline', text: 'Coin' } },
        layout: null,
      },
    },
  ];
  hall.exits = [
    {
      id: 'south-exit',
      label: 'South',
      direction: 'south',
      target: roomRoomRef('start'),
      condition: { kind: 'always' },
    },
    {
      id: 'east-exit',
      label: 'East',
      direction: 'east',
      target: roomRoomRef('tower'),
      condition: { kind: 'lua-predicate', source: 'tower_open()' },
    },
  ];
  project.rooms.hall = {
    id: 'hall',
    label: 'Hall',
    traits: ['tense-room'],
    properties: { 'visit-count': 2 },
    data: hall,
  };

  const tower = defaultRoomData('Tower');
  tower.description = { markup: 'plain', source: { kind: 'inline', text: 'A quiet tower.' } };
  tower.exits = [
    {
      id: 'west-exit',
      label: 'West',
      direction: 'west',
      target: roomRoomRef('hall'),
      condition: { kind: 'always' },
    },
  ];
  project.rooms.tower = { id: 'tower', label: 'Tower', data: tower };

  const look = defaultVerbData('Look');
  project.verbs.look = { id: 'look', label: 'Look', data: look };
  project.interactions.look = {
    id: 'look',
    label: 'Look Rules',
    data: defaultInteractionData(),
  };

  const opening = defaultSceneData('Opening');
  opening.events = [
    {
      ...defaultSceneStep('show-text'),
      id: 'opening-text',
      text: { markup: 'plain', source: { kind: 'inline', text: 'Opening.' } },
    },
  ];
  project.scenes.opening = {
    id: 'opening',
    label: 'Opening',
    data: opening,
  };

  const intro = defaultDialogueData('Intro');
  intro.blocks[0] = {
    ...intro.blocks[0]!,
    type: 'sequence',
    defaultSpeaker: null,
    segments: [
      {
        ...defaultDialogueSegment('line', 'intro-line'),
        text: { markup: 'active-text', source: { kind: 'localized', key: 'dialogue-intro' } },
      },
    ],
  };
  project.dialogues.intro = {
    id: 'intro',
    label: 'Intro',
    data: intro,
  };

  const map = defaultMapData();
  map.presentation = {
    title: { markup: 'plain', source: { kind: 'localized', key: 'map-title' } },
    background: assetReference('image-main'),
    layout: layoutRecordRef('hud-inline'),
    initialMode: 'minimap',
  };
  map.locations = [
    {
      id: 'start-location',
      room: roomReference('start'),
      regions: [
        {
          points: [
            { x: 0.05, y: 0.1 },
            { x: 0.2, y: 0.1 },
            { x: 0.2, y: 0.3 },
          ],
        },
      ],
      label: null,
      icon: null,
      style: null,
      labelAnchor: { x: 0.12, y: 0.2 },
      connectionAnchor: { x: 0.2, y: 0.2 },
      visibility: { kind: 'always' },
      pickOrder: 0,
      logicalOrder: 0,
    },
    {
      id: 'hall-location',
      room: roomReference('hall'),
      regions: [
        {
          points: [
            { x: 0.35, y: 0.1 },
            { x: 0.55, y: 0.1 },
            { x: 0.55, y: 0.3 },
          ],
        },
      ],
      label: { markup: 'plain', source: { kind: 'inline', text: 'Hall' } },
      icon: null,
      style: 'main-hall',
      labelAnchor: { x: 0.45, y: 0.2 },
      connectionAnchor: { x: 0.55, y: 0.2 },
      visibility: { kind: 'always' },
      pickOrder: 1,
      logicalOrder: 1,
    },
    {
      id: 'tower-location',
      room: roomReference('tower'),
      regions: [
        {
          points: [
            { x: 0.7, y: 0.1 },
            { x: 0.9, y: 0.1 },
            { x: 0.9, y: 0.35 },
            { x: 0.7, y: 0.35 },
          ],
        },
      ],
      label: { markup: 'plain', source: { kind: 'localized', key: 'room-tower' } },
      icon: null,
      style: null,
      labelAnchor: null,
      connectionAnchor: null,
      visibility: { kind: 'always' },
      pickOrder: 2,
      logicalOrder: 2,
    },
  ];
  map.connections = [
    {
      id: 'start-hall',
      exits: [{ room: 'start', exit: 'north-exit' }],
      label: null,
      icon: null,
      style: null,
      visibility: { kind: 'always' },
      logicalOrder: 0,
      path: [
        { x: 0.2, y: 0.2 },
        { x: 0.35, y: 0.2 },
      ],
      hitRegions: [],
    },
    {
      id: 'hall-tower',
      exits: [{ room: 'hall', exit: 'east-exit' }],
      label: null,
      icon: null,
      style: null,
      visibility: { kind: 'always' },
      logicalOrder: 1,
      path: [
        { x: 0.55, y: 0.2 },
        { x: 0.7, y: 0.2 },
      ],
      hitRegions: [],
    },
  ];
  project.maps.house = { id: 'house', label: 'House', data: map };

  project.settings.text.defaultFont = projectAssetRef('font-main');
  project.settings.titleScreen.titleImage = projectAssetRef('image-main');
  project.settings.ui.systemLayouts.title = layoutRecordRef('hud-assets');
  project.settings.ui.systemLayouts['game-hud'] = layoutRecordRef('hud-inline');
  if (project.settings.app) {
    project.settings.app.icon = projectAssetRef('image-main');
    project.settings.app.launchImage = projectAssetRef('image-main');
  }

  project.localization.defaultLocale = 'en';
  project.localization.fallbackLocale = 'es';
  project.localization.catalogs = {
    en: {
      'dialogue-intro': 'Welcome.',
      'map-title': 'House Map',
      'room-start': 'The starting room.',
      'room-tower': 'Tower',
      'scene-choice': 'Choose a path.',
    },
    es: {
      'dialogue-intro': 'Bienvenido.',
      'map-title': 'Mapa de la casa',
      'room-start': 'La sala inicial.',
      'room-tower': 'Torre',
      'scene-choice': 'Elige un camino.',
    },
  };
  project.scripts.bootstrap!.data = {
    kind: 'script-module',
    source: {
      kind: 'inline-lua',
      source:
        "return { before_enter_start = function(...) local ok, err = Game.set_prop('flag', true); assert(ok, err); if type(before_enter_start) == 'function' then before_enter_start(...) end end, after_enter_start = function(...) if type(after_enter_start) == 'function' then after_enter_start(...) end end, before_leave_start = function(...) if type(before_leave_start) == 'function' then before_leave_start(...) end end, after_leave_start = function(...) local ok, err = Game.set_prop('count', 3); assert(ok, err); if type(after_leave_start) == 'function' then after_leave_start(...) end end }\n",
    },
  };
  project.entrypoint = { kind: 'room', id: 'start' };
  return project;
}

export function resourceGoldenProject(): AuthoringProject {
  const project = comprehensiveGoldenProject();
  renameProject(project, 'golden-resources', 'Golden Resources');
  project.scenes = {};
  project.dialogues = {};
  project.verbs = {};
  project.interactions = {};
  return project;
}

export function traitPropertiesLocalizationGoldenProject(): AuthoringProject {
  const project = comprehensiveGoldenProject();
  renameProject(
    project,
    'golden-trait-properties-localization',
    'Golden Trait Properties Localization',
  );
  project.localization.fallbackLocale = 'en';
  project.rooms.hall!.properties = { 'visit-count': 7 };
  project.rooms.tower!.traits = ['tense-room'];
  project.rooms.tower!.properties = { mood: 'calm', 'visit-count': 3 };
  return project;
}

export function sceneProgramGoldenProject(): AuthoringProject {
  const project = comprehensiveGoldenProject();
  renameProject(project, 'golden-scene-program', 'Golden Scene Program');

  const postprocessShader = defaultShaderData('Scene Postprocess Shader');
  postprocessShader.roles = ['postprocess'];
  postprocessShader.uniforms = [
    { name: 'u_strength', type: 'float', default: 0.25, label: 'Strength' },
  ];
  project.shaders['scene-postprocess-shader'] = {
    id: 'scene-postprocess-shader',
    label: 'Scene Postprocess Shader',
    data: postprocessShader,
  };
  const postprocessMaterial = defaultMaterialData(
    'Scene Postprocess Material',
    'scene-postprocess-shader',
  );
  postprocessMaterial.role = 'postprocess';
  postprocessMaterial.postprocessScope = 'world';
  project.materials['scene-postprocess-material'] = {
    id: 'scene-postprocess-material',
    label: 'Scene Postprocess Material',
    data: postprocessMaterial,
  };

  const opening = defaultSceneData('Opening');
  opening.stage = {
    kind: 'blank',
    background: {
      asset: sceneAssetRef('image-main'),
      material: sceneMaterialRef('sprite-material'),
      color: '#112233',
      fit: 'stretch',
    },
    layout: sceneLayoutRef('hud-inline'),
  };
  opening.events = [
    {
      ...defaultSceneStep('set-background'),
      id: 'background',
      asset: sceneAssetRef('image-main'),
      material: sceneMaterialRef('sprite-material'),
      color: '#223344',
      fit: 'center',
      transition: 'cut',
      condition: { kind: 'always' },
    },
    {
      ...defaultSceneStep('actor-cue'),
      id: 'actor',
      slotId: 'hero-slot',
      character: sceneCharacterRef('hero'),
      action: 'expression',
      poseId: 'default',
      expressionId: 'neutral',
      position: 'custom',
      offset: { x: 0.25, y: -0.1 },
      scale: 1.25,
      transition: 'none',
      durationMs: 0,
      waitForCompletion: false,
      condition: { kind: 'lua-predicate', source: 'show_hero()' },
    },
    {
      ...defaultSceneStep('call-dialogue'),
      id: 'dialogue',
      dialogue: sceneDialogueRef('intro'),
      startBlockId: 'start',
      autosaveSafePoint: true,
    },
    {
      ...defaultSceneStep('show-text'),
      id: 'inline-text',
      speaker: sceneCharacterRef('hero'),
      text: { markup: 'plain', source: { kind: 'inline', text: 'Inline text.' } },
      wait: 'immediate',
    },
    {
      ...defaultSceneStep('show-text'),
      id: 'localized-text',
      text: { markup: 'active-text', source: { kind: 'localized', key: 'dialogue-intro' } },
      wait: 'input',
    },
    {
      ...defaultSceneStep('show-text'),
      id: 'lua-text',
      text: { markup: 'plain', source: { kind: 'lua-expression', source: 'dynamic_line()' } },
      wait: 'input',
    },
    {
      ...defaultSceneStep('audio-cue'),
      id: 'audio',
      asset: sceneAssetRef('audio-voice'),
      purpose: 'voice',
      action: 'fade-in',
      lifetime: 'one-shot',
      pausePolicy: 'gameplay',
      gain: 0.8,
      pan: 0,
      panSource: null,
      fadeMs: 250,
      waitForCompletion: true,
      causality: 'causal',
      synchronized: false,
      skipBehavior: 'stop',
      instanceId: null,
      replacementGroup: null,
    },
    {
      ...defaultSceneStep('set-variable'),
      id: 'set-flag',
      variable: sceneVariableRef('flag'),
      value: true,
    },
    {
      ...defaultSceneStep('run-lua'),
      id: 'lua',
      source: 'run_scene_effect()',
      mayYield: true,
      autosaveSafePoint: true,
    },
    {
      ...defaultSceneStep('wait'),
      id: 'duration-wait',
      waitKind: 'duration',
      durationMs: 1500,
      skippable: true,
    },
    {
      id: 'input-wait',
      label: 'Input Wait',
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
      branches: [
        {
          id: 'count-branch',
          condition: {
            kind: 'variable-comparison',
            variable: sceneVariableRef('count'),
            operator: 'greater-equal',
            value: 2,
          },
          targetStepId: 'choice',
        },
        {
          id: 'lua-branch',
          condition: { kind: 'lua-predicate', source: 'take_layout_branch()' },
          targetStepId: 'layout',
        },
      ],
      fallbackStepId: 'transition',
    },
    {
      ...defaultSceneStep('choice'),
      id: 'choice',
      prompt: { markup: 'active-text', source: { kind: 'localized', key: 'scene-choice' } },
      options: [
        {
          id: 'layout-option',
          label: { markup: 'plain', source: { kind: 'inline', text: 'Show layout' } },
          condition: {
            kind: 'variable-comparison',
            variable: sceneVariableRef('flag'),
            operator: 'truthy',
          },
          effects: [{ kind: 'set-variable', variable: sceneVariableRef('ratio'), value: 0.75 }],
          targetStepId: 'layout',
        },
        {
          id: 'transition-option',
          label: {
            markup: 'plain',
            source: { kind: 'lua-expression', source: 'transition_label()' },
          },
          condition: { kind: 'lua-predicate', source: 'can_transition()' },
          effects: [{ kind: 'run-lua-effect', source: 'prepare_transition()' }],
          targetStepId: 'transition',
        },
      ],
      autosaveSafePoint: true,
    },
    {
      ...defaultSceneStep('set-layout'),
      id: 'layout',
      layout: sceneLayoutRef('hud-assets'),
      action: 'swap',
      scaleOverrides: { ui: 'inherit', text: 'ignore' },
      slot: 'custom',
      transition: 'none',
      durationMs: 0,
    },
    {
      ...defaultSceneStep('postprocess-effect'),
      id: 'postprocess-add',
      action: 'upsert',
      instanceId: 'scene-grade',
      material: sceneMaterialRef('scene-postprocess-material'),
      scope: 'world',
      order: 2,
      clock: 'unscaled-presentation',
      parameters: [{ name: 'u_strength', value: 0.4 }],
    },
    {
      ...defaultSceneStep('material-parameter'),
      id: 'background-material',
      target: { kind: 'background' },
      material: sceneMaterialRef('sprite-material'),
      parameter: 'u_tint',
      value: { r: 0.9, g: 0.8, b: 0.7, a: 1 },
      transition: 'none',
      durationMs: 0,
      easing: 'linear',
      clock: 'gameplay',
      waitForCompletion: false,
      skippable: true,
    },
    {
      ...defaultSceneStep('material-parameter'),
      id: 'postprocess-material',
      target: { kind: 'postprocess', instanceId: 'scene-grade' },
      material: sceneMaterialRef('scene-postprocess-material'),
      parameter: 'u_strength',
      value: 0.75,
      transition: 'tween',
      durationMs: 350,
      easing: 'ease-in-out',
      clock: 'unscaled-presentation',
      waitForCompletion: true,
      skippable: true,
    },
    {
      ...defaultSceneStep('postprocess-effect'),
      id: 'postprocess-remove',
      action: 'remove',
      instanceId: 'scene-grade',
      material: null,
      scope: 'world',
      order: 0,
      clock: 'gameplay',
      parameters: [],
    },
    {
      ...defaultSceneStep('transition-group'),
      id: 'transition',
      transitionKind: 'dissolve',
      durationMs: 500,
      color: null,
      waitForCompletion: true,
    },
    { ...defaultSceneStep('comment'), id: 'editor-note', text: 'Must not compile.' },
  ];
  opening.terminal = { kind: 'continue-scene', scene: sceneSceneRef('closing'), inputs: [] };
  project.scenes.opening = {
    id: 'opening',
    label: 'Opening',
    data: opening,
  };

  const closing = defaultSceneData('Closing');
  closing.events = [
    {
      ...defaultSceneStep('show-text'),
      id: 'closing-text',
      text: { markup: 'plain', source: { kind: 'inline', text: 'Closing.' } },
    },
  ];
  closing.terminal = { kind: 'continue-dialogue', dialogue: sceneDialogueRef('intro') };
  project.scenes.closing = { id: 'closing', label: 'Closing', data: closing };
  project.entrypoint = { kind: 'scene', id: 'opening' };
  return project;
}

export function dialogueProgramGoldenProject(): AuthoringProject {
  const project = comprehensiveGoldenProject();
  renameProject(project, 'golden-dialogue-program', 'Golden Dialogue Program');

  const intro = defaultDialogueData('Intro');
  intro.defaultSpeaker = characterReference('hero');
  intro.settings = { showDisabledChoices: false, logMode: 'only-lines' };
  intro.entryBlockId = 'start';
  intro.blocks = [
    {
      ...defaultDialogueBlock('sequence', 'start', 'Start'),
      defaultSpeaker: characterReference('hero'),
      segments: [
        {
          ...defaultDialogueSegment('line', 'inline-line'),
          speaker: characterReference('hero'),
          text: { markup: 'plain', source: { kind: 'inline', text: 'Inline dialogue.' } },
          condition: { kind: 'always' },
          effects: [{ kind: 'set-variable', variable: variableReference('flag'), value: true }],
          showOnce: true,
          logged: true,
          autosaveSafePoint: true,
        },
        {
          ...defaultDialogueSegment('line', 'localized-line'),
          text: { markup: 'active-text', source: { kind: 'localized', key: 'dialogue-intro' } },
          condition: {
            kind: 'variable-comparison',
            variable: variableReference('count'),
            operator: 'less',
            value: 10,
          },
          effects: [{ kind: 'run-lua-effect', source: 'after_localized_line()' }],
          logged: false,
        },
        {
          ...defaultDialogueSegment('line', 'lua-line'),
          text: { markup: 'plain', source: { kind: 'lua-expression', source: 'dialogue_line()' } },
          condition: { kind: 'lua-predicate', source: 'show_lua_line()' },
        },
        {
          ...defaultDialogueSegment('run-lua', 'dialogue-lua'),
          source: 'yielding_dialogue_effect()',
          mayYield: true,
          condition: { kind: 'always' },
        },
        { ...defaultDialogueSegment('comment', 'segment-note'), text: 'Must not compile.' },
      ],
    },
    defaultDialogueBlock('choice', 'choice', 'Choice'),
    { ...defaultDialogueBlock('redirect', 'redirect', 'Redirect'), targetBlockId: 'final' },
    {
      ...defaultDialogueBlock('sequence', 'final', 'Final'),
      segments: [
        {
          ...defaultDialogueSegment('line', 'final-line'),
          text: { markup: 'plain', source: { kind: 'inline', text: 'Final line.' } },
        },
      ],
    },
    { ...defaultDialogueBlock('comment', 'block-note', 'Note'), text: 'Must not compile.' },
  ];
  intro.edges = [
    { id: 'start-choice', kind: 'next', fromBlockId: 'start', toBlockId: 'choice' },
    {
      id: 'choice-redirect',
      kind: 'choice',
      fromBlockId: 'choice',
      toBlockId: 'redirect',
      label: { markup: 'plain', source: { kind: 'localized', key: 'scene-choice' } },
      condition: {
        kind: 'variable-comparison',
        variable: variableReference('flag'),
        operator: 'truthy',
      },
      effects: [{ kind: 'set-variable', variable: variableReference('count'), value: 4 }],
      logged: true,
      autosaveSafePoint: true,
    },
    {
      id: 'choice-final',
      kind: 'choice',
      fromBlockId: 'choice',
      toBlockId: 'final',
      label: {
        markup: 'plain',
        source: { kind: 'lua-expression', source: 'final_choice_label()' },
      },
      condition: { kind: 'lua-predicate', source: 'can_finish_dialogue()' },
      effects: [{ kind: 'run-lua-effect', source: 'finish_dialogue()' }],
      logged: false,
      autosaveSafePoint: false,
    },
  ];
  intro.completion = { kind: 'dialogue', id: 'epilogue' };
  project.dialogues.intro = {
    id: 'intro',
    label: 'Intro',
    data: intro,
  };

  const epilogue = defaultDialogueData('Epilogue');
  epilogue.blocks[0] = {
    ...epilogue.blocks[0]!,
    type: 'sequence',
    defaultSpeaker: null,
    segments: [
      {
        ...defaultDialogueSegment('line', 'epilogue-line'),
        text: { markup: 'plain', source: { kind: 'inline', text: 'Epilogue.' } },
      },
    ],
  };
  epilogue.completion = { kind: 'room', id: 'start' };
  project.dialogues.epilogue = { id: 'epilogue', label: 'Epilogue', data: epilogue };
  project.entrypoint = { kind: 'dialogue', id: 'intro' };
  return project;
}

export function interactionProgramGoldenProject(): AuthoringProject {
  const project = comprehensiveGoldenProject();
  renameProject(project, 'golden-interaction-program', 'Golden Interaction Program');

  const hotspotShader = defaultShaderData('Hotspot Overlay Shader');
  hotspotShader.roles = ['hotspot-overlay'];
  hotspotShader.samplers = [
    { name: 's_image', type: 'texture2d', binding: 'engine.hotspot_image' },
    { name: 's_mask', type: 'texture2d', binding: 'engine.hotspot_mask' },
  ];
  hotspotShader.uniforms = [
    { name: 'u_bounds', type: 'vec4', binding: 'engine.hotspot_bounds' },
    { name: 'u_hovered', type: 'bool', binding: 'engine.hotspot_hovered' },
    { name: 'u_pressed', type: 'bool', binding: 'engine.hotspot_pressed' },
    { name: 'u_image_size', type: 'vec2', binding: 'engine.hotspot_image_dimensions' },
    { name: 'u_mask_size', type: 'vec2', binding: 'engine.hotspot_mask_dimensions' },
  ];
  project.shaders['hotspot-overlay-shader'] = {
    id: 'hotspot-overlay-shader',
    label: 'Hotspot Overlay Shader',
    data: hotspotShader,
  };
  const hotspotMaterial = defaultMaterialData('Hotspot Overlay', 'hotspot-overlay-shader');
  hotspotMaterial.role = 'hotspot-overlay';
  project.materials['hotspot-overlay'] = {
    id: 'hotspot-overlay',
    label: 'Hotspot Overlay',
    data: hotspotMaterial,
  };

  const inspect = defaultVerbData('Inspect');
  const targetText = {
    source: { kind: 'inline' as const, text: 'target' },
    markup: 'plain' as const,
  };
  inspect.slots = [
    {
      id: 'target',
      label: targetText,
      prompt: targetText,
      selectors: [{ kind: 'any-subject' }],
    },
  ];
  inspect.bindingOrder = ['target'];
  inspect.offers = [
    {
      id: 'feature-offer',
      slotId: 'target',
      selectors: [{ kind: 'family', family: 'feature' }],
      rank: 10,
      primary: false,
    },
  ];
  project.verbs.inspect = { id: 'inspect', label: 'Inspect', data: inspect };

  const use = defaultVerbData('Use');
  use.slots = [
    {
      id: 'target',
      label: targetText,
      prompt: targetText,
      selectors: [{ kind: 'any-subject' }],
    },
  ];
  use.bindingOrder = ['target'];
  use.offers = [
    {
      id: 'interactable-offer',
      slotId: 'target',
      selectors: [{ kind: 'family', family: 'interactable' }],
      rank: 20,
      primary: false,
    },
  ];
  use.availability = {
    kind: 'variable-comparison',
    variable: variableReference('flag'),
    operator: 'truthy',
  };
  use.defaultProgram = {
    instructions: [],
    completion: { kind: 'return' },
    outcome: 'unhandled',
  };
  project.verbs.use = { id: 'use', label: 'Use', data: use };

  const start = project.rooms.start!.data;
  start.features = [
    {
      id: 'door',
      label: 'Door',
      traits: ['feature-enabled'],
      properties: { enabled: true },
      inventories: [{ id: 'mail-slot', label: 'Mail Slot' }],
    },
  ];
  start.hotspots = [
    {
      id: 'inspect-door',
      label: 'Inspect Door',
      condition: { kind: 'always' },
      inputOrder: 10,
      highlight: { kind: 'default' },
      shape: { kind: 'rect', bounds: { x: 0.7, y: 0.1, width: 0.2, height: 0.5 } },
      target: { kind: 'owner-feature', featureId: 'door' },
    },
    {
      id: 'north-door',
      label: 'North Door',
      condition: { kind: 'always' },
      inputOrder: 20,
      highlight: { kind: 'none' },
      shape: { kind: 'rect', bounds: { x: 0.72, y: 0.12, width: 0.16, height: 0.46 } },
      target: { kind: 'exit', exitId: 'north-exit' },
    },
  ];

  const key = project.interactables.key!.data;
  key.features = [
    {
      id: 'surface',
      label: 'Key Surface',
      traits: ['feature-enabled'],
      properties: { enabled: true },
      inventories: [{ id: 'groove', label: 'Key Groove' }],
    },
  ];
  key.presentation.hotspots = {
    kind: 'sprite-alpha',
    hotspot: {
      id: 'key-alpha',
      label: 'Key',
      condition: { kind: 'always' },
      inputOrder: 0,
      highlight: { kind: 'default' },
      target: { kind: 'owner-feature', featureId: 'surface' },
    },
  };
  const coin = project.interactables.coin!.data;
  coin.features = [
    {
      id: 'face',
      label: 'Coin Face',
      traits: ['feature-enabled'],
      properties: { enabled: true },
      inventories: [],
    },
  ];
  coin.presentation.hotspots = {
    kind: 'custom',
    hotspots: [
      {
        id: 'coin-front',
        label: 'Coin Front',
        condition: { kind: 'always' },
        inputOrder: 1,
        highlight: {
          kind: 'material',
          material: { $ref: { collection: 'materials', id: 'hotspot-overlay' } },
        },
        target: { kind: 'owner-feature', featureId: 'face' },
        shape: { kind: 'rect', bounds: { x: 0.1, y: 0.1, width: 0.7, height: 0.7 } },
      },
      {
        id: 'coin-center',
        label: 'Coin Center',
        condition: { kind: 'always' },
        inputOrder: 2,
        highlight: { kind: 'none' },
        target: { kind: 'owner-feature', featureId: 'face' },
        shape: { kind: 'rect', bounds: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 } },
      },
    ],
  };

  const unlock = defaultVerbData('Unlock');
  unlock.slots = [
    {
      id: 'target',
      label: targetText,
      prompt: targetText,
      selectors: [{ kind: 'any-subject' }],
    },
  ];
  unlock.bindingOrder = ['target'];
  unlock.availability = { kind: 'lua-predicate', source: 'can_unlock()' };
  unlock.defaultProgram = {
    instructions: [
      { id: 'unlock-dialogue', kind: 'call-dialogue', dialogue: dialogueReference('intro') },
    ],
    completion: { kind: 'return' },
    outcome: 'handled',
  };
  project.verbs.unlock = { id: 'unlock', label: 'Unlock', data: unlock };

  const combine = defaultVerbData('Combine');
  const firstText = {
    source: { kind: 'inline' as const, text: 'first' },
    markup: 'plain' as const,
  };
  const secondText = {
    source: { kind: 'inline' as const, text: 'second' },
    markup: 'plain' as const,
  };
  combine.slots = [
    {
      id: 'first',
      label: firstText,
      prompt: firstText,
      selectors: [{ kind: 'any-subject' }],
    },
    {
      id: 'second',
      label: secondText,
      prompt: secondText,
      selectors: [{ kind: 'any-subject' }],
    },
  ];
  combine.bindingOrder = ['first', 'second'];
  combine.defaultProgram = {
    instructions: [],
    completion: { kind: 'return' },
    outcome: 'unhandled',
  };
  project.verbs.combine = { id: 'combine', label: 'Combine', data: combine };

  const interaction = defaultInteractionData();
  interaction.rules = [
    {
      id: 'room-feature',
      verb: verbReference('inspect'),
      slots: [
        {
          slotId: 'target',
          selectors: [
            {
              kind: 'exact',
              subject: {
                kind: 'feature',
                feature: { ownerKind: 'room', room: roomReference('start'), featureId: 'door' },
              },
            },
          ],
        },
      ],
      offer: { slotId: 'target', condition: { kind: 'always' }, rank: 0, primary: true },
      guard: { kind: 'always' },
      priority: 10,
      program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' },
    },
    {
      id: 'interactable-feature',
      verb: verbReference('use'),
      slots: [
        {
          slotId: 'target',
          selectors: [
            {
              kind: 'exact',
              subject: {
                kind: 'feature',
                feature: {
                  ownerKind: 'interactable',
                  interactable: interactableReference('key'),
                  featureId: 'surface',
                },
              },
            },
          ],
        },
      ],
      offer: null,
      guard: { kind: 'always' },
      priority: 10,
      program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' },
    },
    {
      id: 'any-context',
      verb: verbReference('use'),
      slots: [
        {
          slotId: 'target',
          selectors: [
            {
              kind: 'exact',
              subject: { kind: 'interactable', interactable: interactableReference('key') },
            },
          ],
        },
      ],
      offer: { slotId: 'target', condition: { kind: 'always' }, rank: 5, primary: true },
      guard: { kind: 'always' },
      priority: 20,
      program: {
        instructions: [
          {
            id: 'effect',
            kind: 'apply-effect',
            effect: { kind: 'set-variable', variable: variableReference('flag'), value: true },
          },
          {
            id: 'inventory',
            kind: 'move-interactable',
            interactable: interactableReference('key'),
            target: {
              kind: 'inventory',
              inventory: { owner: { kind: 'project' }, inventoryId: 'player' },
            },
          },
          {
            id: 'state',
            kind: 'set-interactable-state',
            interactable: interactableReference('key'),
            enabled: true,
            visible: false,
          },
          {
            id: 'notify',
            kind: 'notify',
            message: { markup: 'plain', source: { kind: 'localized', key: 'dialogue-intro' } },
          },
        ],
        completion: { kind: 'return' },
        outcome: 'handled',
      },
    },
    {
      id: 'active-room-context',
      verb: verbReference('use'),
      slots: [
        {
          slotId: 'target',
          selectors: [{ kind: 'family', family: 'interactable' }],
        },
      ],
      offer: null,
      guard: { kind: 'lua-predicate', source: 'offer_false()' },
      priority: 0,
      program: {
        instructions: [],
        completion: { kind: 'return' },
        outcome: 'unhandled',
      },
    },
    {
      id: 'placement-context',
      verb: verbReference('unlock'),
      slots: [
        {
          slotId: 'target',
          selectors: [
            {
              kind: 'exact',
              subject: { kind: 'interactable', interactable: interactableReference('key') },
            },
          ],
        },
      ],
      offer: null,
      guard: { kind: 'always' },
      priority: 5,
      program: {
        instructions: [
          {
            id: 'room',
            kind: 'move-interactable',
            interactable: interactableReference('key'),
            target: { kind: 'room', room: roomReference('start') },
          },
          {
            id: 'unlock-rule-dialogue',
            kind: 'call-dialogue',
            dialogue: dialogueReference('intro'),
          },
        ],
        completion: { kind: 'return' },
        outcome: 'handled',
      },
    },
    {
      id: 'predicate-context',
      verb: verbReference('combine'),
      slots: [
        {
          slotId: 'first',
          selectors: [
            {
              kind: 'exact',
              subject: { kind: 'interactable', interactable: interactableReference('key') },
            },
          ],
        },
        {
          slotId: 'second',
          selectors: [
            {
              kind: 'exact',
              subject: { kind: 'interactable', interactable: interactableReference('coin') },
            },
          ],
        },
      ],
      offer: null,
      guard: {
        kind: 'variable-comparison',
        variable: variableReference('count'),
        operator: 'greater',
        value: 0,
      },
      priority: 0,
      program: {
        instructions: [
          {
            id: 'lua-effect',
            kind: 'apply-effect',
            effect: { kind: 'run-lua-effect', source: 'combine_items()' },
          },
        ],
        completion: { kind: 'return' },
        outcome: 'handled',
      },
    },
  ];
  project.interactions.actions = {
    id: 'actions',
    label: 'Actions',
    data: interaction,
  };
  return project;
}

export function canonicalVocabularyGoldenProject(): AuthoringProject {
  const project = interactionProgramGoldenProject();
  renameProject(project, 'golden-canonical-vocabulary', 'Golden Canonical Vocabulary');

  const hero = project.characters.hero!.data;
  hero.profiles[0]!.animationClips.push({
    id: 'nod-clip',
    label: 'Nod',
    clock: 'gameplay',
    frames: [{ durationMs: 100, layers: [] }],
  });
  hero.gestures.push({
    id: 'nod',
    label: 'Nod',
    profiles: [
      {
        profileId: 'stage',
        clipId: 'nod-clip',
        cues: [
          {
            kind: 'presentation',
            id: 'nod-presentation',
            atMs: 25,
            event: 'impact',
          },
          {
            kind: 'audio',
            id: 'nod-audio',
            atMs: 50,
            asset: characterAssetRef('audio-voice'),
            gain: 0.5,
            pan: 0,
          },
        ],
      },
    ],
  });

  project.archetypes['room-template'] = {
    id: 'room-template',
    label: 'Room Template',
    data: defaultArchetypeData('room'),
  };
  project.archetypes['character-template'] = {
    id: 'character-template',
    label: 'Character Template',
    data: defaultArchetypeData('character'),
  };
  project.archetypes['interactable-template'] = {
    id: 'interactable-template',
    label: 'Interactable Template',
    data: defaultArchetypeData('interactable'),
  };

  project.interactableInstances['wallet-spare'] = defaultInteractableInstanceData(
    'wallet-spare',
    'credits',
    {
      kind: 'inventory',
      inventory: { owner: { kind: 'project' }, inventoryId: 'player' },
    },
  );
  project.interactableInstances['wallet-spare'].editorLabel = 'Spare credits';

  const selectorVerb = defaultVerbData('Selector Vocabulary');
  const selectorText = {
    source: { kind: 'inline' as const, text: 'subject' },
    markup: 'plain' as const,
  };
  selectorVerb.slots = [
    {
      id: 'subject',
      label: selectorText,
      prompt: selectorText,
      selectors: [
        { kind: 'any-subject' },
        { kind: 'family', family: 'feature' },
        { kind: 'trait', trait: { $ref: { collection: 'traits', id: 'feature-enabled' } } },
        { kind: 'qualified-pattern', family: 'interactable', pattern: 'key*' },
        {
          kind: 'exact',
          subject: { kind: 'interactable', interactable: interactableReference('key') },
        },
      ],
    },
  ];
  selectorVerb.bindingOrder = ['subject'];
  project.verbs['selector-vocabulary'] = {
    id: 'selector-vocabulary',
    label: 'Selector Vocabulary',
    data: selectorVerb,
  };

  const statefulLayout = defaultLayoutData('Stateful Overlay', 'document');
  statefulLayout.target = 'room-overlay';
  statefulLayout.contract = {
    inputs: {},
    signals: {
      confirm: {
        fields: { accepted: { type: 'boolean', nullable: false, required: true } },
      },
    },
    state: {
      type: 'object',
      nullable: false,
      fields: {
        page: {
          required: true,
          shape: { type: 'integer', nullable: false, defaultValue: 0 },
        },
      },
      defaultValue: { page: 0 },
    },
  };
  project.layouts['stateful-overlay'] = {
    id: 'stateful-overlay',
    label: 'Stateful Overlay',
    data: statefulLayout,
  };

  const decoratorShader = defaultShaderData('Layout Decorator Shader');
  decoratorShader.roles = ['rmlui-decorator'];
  decoratorShader.uniforms = [
    { name: 'u_tint', type: 'color', default: { r: 1, g: 1, b: 1, a: 1 } },
  ];
  project.shaders['layout-decorator-shader'] = {
    id: 'layout-decorator-shader',
    label: 'Layout Decorator Shader',
    data: decoratorShader,
  };
  const decoratorMaterial = defaultMaterialData(
    'Layout Decorator Material',
    'layout-decorator-shader',
  );
  decoratorMaterial.role = 'rmlui-decorator';
  project.materials['layout-decorator-material'] = {
    id: 'layout-decorator-material',
    label: 'Layout Decorator Material',
    data: decoratorMaterial,
  };

  const backgroundSafe = defaultSceneData('Background Safe');
  backgroundSafe.stage = { kind: 'inherited' };
  backgroundSafe.events = [
    {
      ...defaultSceneStep('set-variable'),
      id: 'background-safe-effect',
      variable: sceneVariableRef('flag'),
      value: true,
    },
  ];
  backgroundSafe.terminal = { kind: 'return', outcome: null };
  project.scenes['background-safe'] = {
    id: 'background-safe',
    label: 'Background Safe',
    data: backgroundSafe,
  };

  const vocabulary = defaultSceneData('Canonical Vocabulary');
  vocabulary.stage = { kind: 'staged-room', room: sceneRoomRef('hall') };
  vocabulary.events = [
    {
      ...defaultSceneStep('call-scene'),
      id: 'call-scene',
      scene: sceneSceneRef('background-safe'),
      inputs: [],
    },
    {
      ...defaultSceneStep('start-detached-scene'),
      id: 'start-detached-scene',
      scene: sceneSceneRef('background-safe'),
      inputs: [],
      owner: 'runtime-session',
    },
    { ...defaultSceneStep('resume-dialogue'), id: 'resume-dialogue' },
    {
      ...defaultSceneStep('gameplay-effect-batch'),
      id: 'gameplay-effects',
      operations: [
        { kind: 'set-variable', variable: sceneVariableRef('flag'), value: true },
        {
          kind: 'set-property',
          owner: { kind: 'room', room: sceneRoomRef('start') },
          property: { $ref: { collection: 'properties', id: 'mood' } },
          value: 'tense',
        },
        {
          kind: 'unset-property',
          owner: { kind: 'room', room: sceneRoomRef('start') },
          property: { $ref: { collection: 'properties', id: 'mood' } },
        },
        {
          kind: 'move-character',
          character: sceneCharacterRef('hero'),
          location: { kind: 'room', room: roomReference('hall') },
        },
        {
          kind: 'set-character-state',
          character: sceneCharacterRef('hero'),
          enabled: true,
          visible: false,
        },
        {
          kind: 'move-interactable',
          interactable: interactableReference('key'),
          location: { kind: 'room', room: roomReference('hall') },
        },
        {
          kind: 'set-interactable-state',
          interactable: interactableReference('key'),
          enabled: true,
          visible: false,
        },
      ],
    },
    {
      ...defaultSceneStep('runtime-world-transaction'),
      id: 'runtime-world',
      operations: [
        {
          kind: 'create-room',
          source: {
            kind: 'archetype',
            archetype: { $ref: { collection: 'archetypes', id: 'room-template' } },
          },
        },
        {
          kind: 'create-character',
          source: {
            kind: 'compiled-instance',
            instance: { kind: 'character', character: sceneCharacterRef('hero') },
          },
          location: { kind: 'room', room: roomReference('start') },
          enabled: true,
          visible: true,
        },
        {
          kind: 'create-interactable',
          source: {
            kind: 'effective-instance',
            instance: { kind: 'interactable', interactable: interactableReference('key') },
          },
          location: { kind: 'room', room: roomReference('start') },
          enabled: true,
          visible: true,
        },
        {
          kind: 'replace-configuration',
          instance: { kind: 'room', room: sceneRoomRef('hall') },
          source: {
            kind: 'archetype',
            archetype: { $ref: { collection: 'archetypes', id: 'room-template' } },
          },
        },
        {
          kind: 'clear-configuration',
          instance: { kind: 'character', character: sceneCharacterRef('hero') },
        },
        {
          kind: 'retarget-room-exit',
          room: sceneRoomRef('hall'),
          exitId: 'east-exit',
          target: sceneRoomRef('start'),
        },
        {
          kind: 'destroy-instance',
          instance: { kind: 'interactable', interactable: interactableReference('dust') },
        },
      ],
    },
    {
      ...defaultSceneStep('directed-room-change'),
      id: 'directed-room-change',
      room: sceneRoomRef('hall'),
    },
    {
      ...defaultSceneStep('navigation-attempt'),
      id: 'navigation-attempt',
      room: sceneRoomRef('start'),
      exitId: 'north-exit',
    },
    {
      ...defaultSceneStep('call-interaction'),
      id: 'call-interaction',
      verb: verbReference('inspect'),
      bindings: [
        {
          slotId: 'target',
          subject: {
            kind: 'feature',
            feature: { ownerKind: 'room', room: roomReference('start'), featureId: 'door' },
          },
        },
      ],
    },
    {
      ...defaultSceneStep('set-background'),
      id: 'background',
      owner: 'runtime-session',
      asset: sceneAssetRef('image-main'),
      material: sceneMaterialRef('sprite-material'),
      transition: 'fade',
      durationMs: 100,
      waitForCompletion: false,
    },
    {
      ...defaultSceneStep('audio-cue'),
      id: 'audio',
      owner: 'active-room',
      asset: sceneAssetRef('audio-voice'),
      waitForCompletion: false,
    },
    {
      ...defaultSceneStep('set-layout'),
      id: 'layout-signal-source',
      owner: 'invocation',
      layout: sceneLayoutRef('stateful-overlay'),
      slot: 'custom',
      action: 'show',
    },
    {
      ...defaultSceneStep('actor-cue'),
      id: 'actor-slot-source',
      slotId: 'hero-stage',
      character: sceneCharacterRef('hero'),
      action: 'show',
      profileId: 'stage',
      poseId: 'default',
      expressionId: 'neutral',
      position: 'center',
    },
    {
      ...defaultSceneStep('material-parameter'),
      id: 'actor-material',
      target: { kind: 'actor', slotId: 'hero-stage', layerId: 'body' },
      material: sceneMaterialRef('sprite-material'),
      parameter: 'u_tint',
      value: { r: 1, g: 1, b: 1, a: 1 },
    },
    {
      ...defaultSceneStep('material-parameter'),
      id: 'layout-material',
      target: { kind: 'layout', slot: 'custom' },
      material: sceneMaterialRef('layout-decorator-material'),
      parameter: 'u_tint',
      value: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
    },
    {
      ...defaultSceneStep('transition-group'),
      id: 'transition-children',
      transitionKind: 'cut',
      durationMs: 0,
      waitForCompletion: false,
      children: [
        {
          id: 'transition-background',
          type: 'set-background',
          asset: sceneAssetRef('image-main'),
          material: sceneMaterialRef('sprite-material'),
          color: null,
          fit: 'cover',
        },
        { id: 'transition-clear-background', type: 'clear-background' },
        {
          id: 'transition-actor',
          type: 'actor-cue',
          slotId: 'hero-stage',
          character: sceneCharacterRef('hero'),
          action: 'show',
          profileId: 'stage',
          poseId: 'default',
          expressionId: 'neutral',
          appearanceId: null,
          position: 'center',
          offset: { x: 0, y: 0 },
          scale: 1,
        },
        {
          id: 'transition-layout',
          type: 'set-layout',
          layout: sceneLayoutRef('stateful-overlay'),
          action: 'show',
          slot: 'custom',
        },
      ],
    },
    {
      id: 'wait-condition',
      label: 'Wait Condition',
      enabled: true,
      type: 'wait',
      timeline: { trackId: 'main', startMs: 0, durationMs: 0 },
      completionDependencies: [],
      waitKind: 'condition',
      waitCondition: {
        kind: 'variable-comparison',
        variable: variableReference('flag'),
        operator: 'truthy',
      },
      skippable: true,
    },
    {
      id: 'wait-operation',
      label: 'Wait Operation',
      enabled: true,
      type: 'wait',
      timeline: { trackId: 'main', startMs: 0, durationMs: 0 },
      completionDependencies: [],
      waitKind: 'operation',
      eventId: 'background',
      skippable: true,
    },
    {
      id: 'wait-audio',
      label: 'Wait Audio',
      enabled: true,
      type: 'wait',
      timeline: { trackId: 'main', startMs: 0, durationMs: 0 },
      completionDependencies: [],
      waitKind: 'audio',
      eventId: 'audio',
      skippable: true,
    },
    {
      id: 'wait-layout-signal',
      label: 'Wait Layout Signal',
      enabled: true,
      type: 'wait',
      timeline: { trackId: 'main', startMs: 0, durationMs: 0 },
      completionDependencies: [],
      waitKind: 'layout-signal',
      owner: 'invocation',
      slot: 'custom',
      signalId: 'confirm',
      skippable: false,
    },
  ];
  vocabulary.terminal = { kind: 'release-to-exploration' };
  project.scenes.vocabulary = { id: 'vocabulary', label: 'Canonical Vocabulary', data: vocabulary };

  const inherited = defaultSceneData('Inherited Stage');
  inherited.stage = { kind: 'inherited' };
  inherited.events = [
    {
      ...defaultSceneStep('show-text'),
      id: 'inherited-text',
      text: { markup: 'plain', source: { kind: 'inline', text: 'Inherited.' } },
      wait: 'immediate',
    },
  ];
  inherited.outcomes = [{ id: 'done', label: 'Done' }];
  inherited.terminal = { kind: 'return', outcome: 'done' };
  project.scenes['inherited-return'] = {
    id: 'inherited-return',
    label: 'Inherited Stage',
    data: inherited,
  };

  const dialogue = defaultDialogueData('Cue Vocabulary');
  dialogue.defaultSpeaker = characterReference('hero');
  dialogue.stageSlots = [
    {
      id: 'hero-stage',
      label: 'Hero Stage',
      speakerSync: true,
      initial: {
        character: characterReference('hero'),
        profileId: 'stage',
        poseId: 'default',
        expressionId: 'neutral',
        appearanceId: null,
        position: 'left',
        offset: { x: 0, y: 0 },
        scale: 1,
        visible: true,
      },
    },
  ];
  dialogue.mediaSlots = [
    {
      id: 'portrait',
      label: 'Portrait',
      initial: { kind: 'image', asset: assetReference('image-main') },
      visible: true,
    },
    {
      id: 'character-media',
      label: 'Character Media',
      initial: {
        kind: 'character',
        character: characterReference('hero'),
        profileId: 'stage',
        poseId: 'default',
        expressionId: 'neutral',
        appearanceId: null,
      },
      visible: false,
    },
  ];
  dialogue.blocks[0] = {
    ...dialogue.blocks[0]!,
    type: 'sequence',
    defaultSpeaker: characterReference('hero'),
    segments: [
      {
        ...defaultDialogueSegment('line', 'cue-line'),
        speaker: characterReference('hero'),
        text: { markup: 'plain', source: { kind: 'inline', text: 'ABCDE' } },
        cues: [
          {
            id: 'expression',
            kind: 'speaker-expression',
            position: { offset: 0, order: 0 },
            expressionId: 'neutral',
          },
          {
            id: 'stage',
            kind: 'stage',
            position: { offset: 1, order: 0 },
            mutation: { slotId: 'hero-stage', action: 'hide' },
          },
          {
            id: 'media',
            kind: 'media',
            position: { offset: 2, order: 0 },
            mutation: { slotId: 'portrait', action: 'show' },
          },
          {
            id: 'voice',
            kind: 'voice',
            position: { offset: 3, order: 0 },
            asset: assetReference('audio-voice'),
            pausePolicy: 'gameplay',
            gain: 1,
            pan: 0,
            waitForCompletion: false,
            skipBehavior: 'stop',
          },
          {
            id: 'gesture',
            kind: 'gesture',
            position: { offset: 3, order: 1 },
            slotId: 'hero-stage',
            gestureId: 'nod',
            waitForCompletion: false,
            skippable: true,
          },
          {
            id: 'sound',
            kind: 'sound-effect',
            position: { offset: 4, order: 0 },
            asset: assetReference('audio-voice'),
            pausePolicy: 'owner',
            gain: 0.5,
            pan: 0.25,
            waitForCompletion: false,
            causality: 'disposable',
            synchronized: false,
            skipBehavior: 'suppress',
          },
          {
            id: 'camera-shake',
            kind: 'camera',
            position: { offset: 5, order: 0 },
            emphasis: {
              kind: 'shake',
              amplitude: { x: 2, y: 3 },
              frequencyHz: 12,
              durationMs: 100,
              skippable: true,
              waitForCompletion: false,
            },
          },
          {
            id: 'camera-punch',
            kind: 'camera',
            position: { offset: 5, order: 1 },
            emphasis: {
              kind: 'punch',
              translation: { x: 4, y: -2 },
              zoomDelta: 0.1,
              rotationDegrees: 2,
              durationMs: 80,
              skippable: true,
              waitForCompletion: false,
            },
          },
          {
            id: 'camera-flash',
            kind: 'camera',
            position: { offset: 5, order: 2 },
            emphasis: {
              kind: 'flash',
              color: '#ffffff',
              opacity: 0.75,
              durationMs: 60,
              skippable: true,
              waitForCompletion: false,
            },
          },
        ],
      },
      {
        ...defaultDialogueSegment('call-scene', 'call-flashback'),
        scene: sceneSceneRef('inherited-return'),
        uiPolicy: 'preserve',
      },
      { ...defaultDialogueSegment('handoff', 'handoff'), payload: 'resume-me' },
    ],
  };
  dialogue.completion = { kind: 'return' };
  project.dialogues['cue-vocabulary'] = {
    id: 'cue-vocabulary',
    label: 'Cue Vocabulary',
    data: dialogue,
  };

  const roomFeatureRule = project.interactions.actions!.data.rules.find(
    (rule) => rule.id === 'room-feature',
  );
  if (roomFeatureRule) {
    roomFeatureRule.program.instructions = [
      {
        id: 'call-scene',
        kind: 'call-scene',
        scene: sceneSceneRef('background-safe'),
      },
    ];
  }

  return project;
}

export function canonicalExplorationGoldenProject(): AuthoringProject {
  const project = canonicalVocabularyGoldenProject();
  renameProject(project, 'golden-canonical-exploration', 'Golden Canonical Exploration');

  delete project.scenes.vocabulary;
  delete project.dialogues['cue-vocabulary'];
  delete project.materials['layout-decorator-material'];
  delete project.shaders['layout-decorator-shader'];
  const coinHotspots = project.interactables.coin?.data.presentation.hotspots;
  if (coinHotspots?.kind === 'custom')
    coinHotspots.hotspots = coinHotspots.hotspots.map((hotspot) => ({
      ...hotspot,
      highlight: hotspot.highlight.kind === 'material' ? { kind: 'default' } : hotspot.highlight,
    }));
  delete project.materials['hotspot-overlay'];
  delete project.shaders['hotspot-overlay-shader'];

  project.scripts.bootstrap!.data = {
    kind: 'script-module',
    source: {
      kind: 'inline-lua',
      source:
        "local ready = false\nreturn { on_ready = function() ready = true end, before_enter_start = function(...) local ok, err = Game.set_prop('flag', ready); assert(ok, err); if type(before_enter_start) == 'function' then before_enter_start(...) end end, after_enter_start = function(...) if type(after_enter_start) == 'function' then after_enter_start(...) end end, before_leave_start = function(...) if type(before_leave_start) == 'function' then before_leave_start(...) end end, after_leave_start = function(...) local ok, err = Game.set_prop('count', 3); assert(ok, err); if type(after_leave_start) == 'function' then after_leave_start(...) end end }\n",
    },
  };

  const mutation = defaultSceneData('Exploration Mutation');
  mutation.stage = { kind: 'inherited' };
  mutation.events = [
    {
      ...defaultSceneStep('runtime-world-transaction'),
      id: 'create-runtime-world',
      operations: [
        {
          kind: 'create-room',
          source: {
            kind: 'archetype',
            archetype: { $ref: { collection: 'archetypes', id: 'room-template' } },
          },
        },
        {
          kind: 'create-interactable',
          source: {
            kind: 'effective-instance',
            instance: { kind: 'interactable', interactable: interactableReference('dust') },
          },
          location: { kind: 'room', room: roomReference('start') },
          enabled: true,
          visible: true,
        },
      ],
    },
    {
      ...defaultSceneStep('gameplay-effect-batch'),
      id: 'mutate-gameplay',
      operations: [
        { kind: 'set-variable', variable: sceneVariableRef('flag'), value: true },
        {
          kind: 'move-interactable',
          interactable: interactableReference('key'),
          location: {
            kind: 'inventory',
            inventory: { owner: { kind: 'project' }, inventoryId: 'player' },
          },
        },
        {
          kind: 'set-interactable-state',
          interactable: interactableReference('key'),
          enabled: true,
          visible: false,
        },
        {
          kind: 'set-property',
          owner: { kind: 'interactable', interactable: interactableReference('key') },
          property: { $ref: { collection: 'properties', id: 'note' } },
          value: 'mutated',
        },
      ],
    },
    {
      ...defaultSceneStep('set-layout'),
      id: 'mount-stateful-layout',
      owner: 'runtime-session',
      layout: sceneLayoutRef('stateful-overlay'),
      action: 'show',
      slot: 'custom',
      waitForCompletion: false,
    },
    {
      ...defaultSceneStep('show-text'),
      id: 'mutation-complete',
      text: { markup: 'plain', source: { kind: 'inline', text: 'Mutation complete.' } },
      wait: 'input',
      autosaveSafePoint: true,
    },
  ];
  mutation.terminal = { kind: 'release-to-exploration' };
  project.scenes['exploration-mutation'] = {
    id: 'exploration-mutation',
    label: 'Exploration Mutation',
    data: mutation,
  };

  const interaction = project.interactions.actions!.data.rules.find(
    (rule) => rule.id === 'any-context',
  );
  if (interaction)
    interaction.program.instructions = [
      {
        id: 'exploration-scene',
        kind: 'call-scene',
        scene: sceneSceneRef('exploration-mutation'),
      },
    ];

  project.entrypoint = { kind: 'room', id: 'start' };
  return project;
}
