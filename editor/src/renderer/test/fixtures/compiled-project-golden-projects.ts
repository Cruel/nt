import {
  assetDataFromImportMetadata,
  type AssetKind,
} from '../../../shared/project-schema/authoring-assets';
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
  interactableAssetRef,
  interactableMaterialRef,
} from '../../../shared/project-schema/authoring-interactables';
import { defaultInteractionData } from '../../../shared/project-schema/authoring-interactions';
import { defaultLayoutData, layoutRecordRef } from '../../../shared/project-schema/authoring-layouts';
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
  roomInteractableRef,
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
  sceneVariableRef,
} from '../../../shared/project-schema/authoring-scenes';
import { defaultScriptModuleData } from '../../../shared/project-schema/authoring-script-modules';
import { defaultShaderData } from '../../../shared/project-schema/authoring-shaders';
import { defaultVariableData } from '../../../shared/project-schema/authoring-variables';
import { defaultVerbData } from '../../../shared/project-schema/authoring-verbs';

const assetReference = (id: string) => ({ $ref: { collection: 'assets' as const, id } });
const characterReference = (id: string) => ({ $ref: { collection: 'characters' as const, id } });
const dialogueReference = (id: string) => ({ $ref: { collection: 'dialogues' as const, id } });
const interactableReference = (id: string) => ({ $ref: { collection: 'interactables' as const, id } });
const roomReference = (id: string) => ({ $ref: { collection: 'rooms' as const, id } });
const sceneReference = (id: string) => ({ $ref: { collection: 'scenes' as const, id } });
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
  project.assets[id] = {
    id,
    label: id,
    data: assetDataFromImportMetadata({
      kind,
      projectRelativePath: path,
      aliases,
      extension: extensionOf(path),
      contentHash: `golden-${id}`,
    }),
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
  const room = defaultRoomData('Start');
  room.description = { markup: 'plain', source: { kind: 'inline', text: 'Minimal room.' } };
  project.rooms.start = { id: 'start', label: 'Start', data: room };
  project.entrypoint = { kind: 'room', id: 'start' };
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
  shader.samplers = [{ name: 's_texColor', type: 'texture2d' }];
  project.shaders['sprite-shader'] = { id: 'sprite-shader', label: 'Sprite Shader', data: shader };

  const material = defaultMaterialData('Sprite Material', 'sprite-shader');
  material.uniforms = [{ name: 'u_tint', value: [1, 0.75, 0.5, 1] }];
  material.textures = [{
    sampler: 's_texColor',
    source: assetReference('image-main'),
    filtering: 'repeat-linear',
  }];
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
  assetLayout.rml = { sourceMode: 'asset', sourceText: '', sourceAsset: assetReference('text-rml') };
  assetLayout.rcss = { sourceMode: 'asset', sourceText: '', sourceAsset: assetReference('text-rcss') };
  assetLayout.lua = { sourceMode: 'asset', sourceText: '', sourceAsset: assetReference('script-layout') };
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
  project.scripts['inline-module'] = { id: 'inline-module', label: 'Inline Module', data: inlineScript };
  project.scripts['asset-module'] = {
    id: 'asset-module',
    label: 'Asset Module',
    data: { kind: 'script-module', source: { kind: 'asset', asset: assetReference('script-layout') } },
  };

  project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
  const count = defaultVariableData('integer');
  count.defaultValue = 2;
  project.variables.count = { id: 'count', label: 'Count', data: count };
  const ratio = defaultVariableData('number');
  ratio.defaultValue = 0.5;
  project.variables.ratio = { id: 'ratio', label: 'Ratio', data: ratio };
  const playerName = defaultVariableData('string');
  playerName.defaultValue = 'Ada';
  project.variables['player-name'] = { id: 'player-name', label: 'Player Name', data: playerName };
  const moodVariable = defaultVariableData('enum');
  moodVariable.enumValues = ['calm', 'tense'];
  moodVariable.defaultValue = 'calm';
  project.variables['mood-variable'] = { id: 'mood-variable', label: 'Mood', data: moodVariable };

  const allOwnerKinds = [
    'room', 'scene', 'dialogue', 'character', 'interactable', 'verb', 'interaction', 'map',
  ] as const;
  project.properties.enabled = {
    id: 'enabled', label: 'Enabled', type: 'boolean', nullable: false, defaultValue: true,
    ownerKinds: [...allOwnerKinds], persistence: 'Session',
  };
  project.properties['visit-count'] = {
    id: 'visit-count', label: 'Visit Count', type: 'integer', nullable: false, defaultValue: 0,
    ownerKinds: ['room'], persistence: 'Save',
  };
  project.properties.opacity = {
    id: 'opacity', label: 'Opacity', type: 'number', nullable: false, defaultValue: 1,
    ownerKinds: ['scene'], persistence: 'Session',
  };
  project.properties.note = {
    id: 'note', label: 'Note', type: 'string', nullable: true, defaultValue: null,
    ownerKinds: ['dialogue'], persistence: 'Save',
  };
  project.properties.mood = {
    id: 'mood', label: 'Mood', description: 'Inherited mood', type: 'enum', nullable: false,
    defaultValue: 'calm', enumValues: ['calm', 'tense'], ownerKinds: ['room'], persistence: 'Save',
  };

  const hero = defaultCharacterData('Hero');
  hero.poses[0]!.sprite = characterAssetRef('image-main');
  hero.poses[0]!.material = characterMaterialRef('sprite-material');
  hero.expressions[0]!.poseId = 'default';
  hero.expressions[0]!.sprite = characterAssetRef('image-main');
  hero.expressions[0]!.material = characterMaterialRef('sprite-material');
  project.characters.hero = {
    id: 'hero', label: 'Hero', properties: { enabled: true }, data: hero,
  };

  const key = defaultInteractableData('Key');
  key.presentation = {
    sprite: interactableAssetRef('image-main'),
    material: interactableMaterialRef('sprite-material'),
  };
  key.initialState.location = {
    kind: 'room-placement',
    placement: { room: 'start', placement: 'key-placement' },
  };
  project.interactables.key = { id: 'key', label: 'Key', properties: { enabled: true }, data: key };

  const coin = defaultInteractableData('Coin');
  coin.presentation = {
    sprite: interactableAssetRef('image-main'),
    material: interactableMaterialRef('sprite-material'),
  };
  coin.initialState.location = { kind: 'inventory' };
  project.interactables.coin = { id: 'coin', label: 'Coin', data: coin };

  const dust = defaultInteractableData('Dust');
  dust.initialState.location = { kind: 'nowhere' };
  project.interactables.dust = { id: 'dust', label: 'Dust', data: dust };

  const start = defaultRoomData('Start');
  start.background = {
    asset: roomAssetRef('image-main'), material: roomMaterialRef('sprite-material'), fit: 'cover', color: '#101820',
  };
  start.description = { markup: 'active-text', source: { kind: 'localized', key: 'room-start' } };
  start.overlays = [{ id: 'start-overlay', layout: roomLayoutRef('hud-assets'), enabled: true }];
  start.placements = [{
    id: 'key-placement',
    interactable: roomInteractableRef('key'),
    bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
    presentation: {
      label: { markup: 'plain', source: { kind: 'lua-expression', source: 'key_label()' } },
      layout: roomLayoutRef('hud-inline'),
    },
  }];
  start.exits = [{
    id: 'north-exit', label: 'North', direction: 'north', target: roomRoomRef('hall'),
    condition: { kind: 'variable-comparison', variable: variableReference('flag'), operator: 'truthy' },
  }];
  start.lifecycle = {
    canEnter: { kind: 'always' },
    canLeave: { kind: 'lua-predicate', source: 'can_leave_start()' },
    beforeEnter: [{ kind: 'set-variable', variable: variableReference('flag'), value: true }],
    afterEnter: [{ kind: 'run-lua-effect', source: 'after_enter_start()' }],
    beforeLeave: [{ kind: 'run-lua-effect', source: 'before_leave_start()' }],
    afterLeave: [{ kind: 'set-variable', variable: variableReference('count'), value: 3 }],
  };
  project.rooms.start = {
    id: 'start', label: 'Start', properties: { mood: 'calm', 'visit-count': 1 }, data: start,
  };

  const hall = defaultRoomData('Hall');
  hall.background = {
    asset: roomAssetRef('image-main'), material: roomMaterialRef('sprite-material'), fit: 'contain', color: null,
  };
  hall.description = { markup: 'plain', source: { kind: 'lua-expression', source: 'hall_description()' } };
  hall.overlays = [{ id: 'hall-overlay', layout: roomLayoutRef('hud-inline'), enabled: false }];
  hall.placements = [{
    id: 'coin-placement',
    interactable: roomInteractableRef('coin'),
    bounds: { x: 0.6, y: 0.6, width: 0.1, height: 0.1 },
    presentation: { label: { markup: 'plain', source: { kind: 'inline', text: 'Coin' } }, layout: null },
  }];
  hall.exits = [
    { id: 'south-exit', label: 'South', direction: 'south', target: roomRoomRef('start'), condition: { kind: 'always' } },
    { id: 'east-exit', label: 'East', direction: 'east', target: roomRoomRef('tower'), condition: { kind: 'lua-predicate', source: 'tower_open()' } },
  ];
  project.rooms.hall = {
    id: 'hall', label: 'Hall', extends: 'start', properties: { mood: 'tense' }, data: hall,
  };

  const tower = defaultRoomData('Tower');
  tower.description = { markup: 'plain', source: { kind: 'inline', text: 'A quiet tower.' } };
  tower.exits = [{
    id: 'west-exit', label: 'West', direction: 'west', target: roomRoomRef('hall'), condition: { kind: 'always' },
  }];
  project.rooms.tower = { id: 'tower', label: 'Tower', data: tower };

  const look = defaultVerbData('Look');
  look.quickAction = true;
  project.verbs.look = { id: 'look', label: 'Look', properties: { enabled: true }, data: look };
  project.interactions.look = {
    id: 'look', label: 'Look Rules', properties: { enabled: true }, data: defaultInteractionData(),
  };

  const opening = defaultSceneData('Opening');
  opening.steps = [{
    ...defaultSceneStep('show-text'),
    id: 'opening-text',
    text: { markup: 'plain', source: { kind: 'inline', text: 'Opening.' } },
  }];
  project.scenes.opening = {
    id: 'opening', label: 'Opening', properties: { opacity: 0.75 }, data: opening,
  };

  const intro = defaultDialogueData('Intro');
  intro.blocks[0] = {
    ...intro.blocks[0]!,
    type: 'sequence',
    defaultSpeaker: null,
    segments: [{
      ...defaultDialogueSegment('line', 'intro-line'),
      text: { markup: 'active-text', source: { kind: 'localized', key: 'dialogue-intro' } },
    }],
  };
  project.dialogues.intro = {
    id: 'intro', label: 'Intro', properties: { note: null }, data: intro,
  };

  const map = defaultMapData();
  map.presentation = {
    title: { markup: 'plain', source: { kind: 'localized', key: 'map-title' } },
    background: assetReference('image-main'),
    layout: layoutRecordRef('hud-inline'),
    initialMode: 'minimap',
  };
  map.locations = [
    { id: 'start-location', room: roomReference('start'), position: { x: 0, y: 0 }, shape: { kind: 'point' }, label: null },
    { id: 'hall-location', room: roomReference('hall'), position: { x: 1, y: 0 }, shape: { kind: 'circle', radius: 0.25 }, label: { markup: 'plain', source: { kind: 'inline', text: 'Hall' } } },
    { id: 'tower-location', room: roomReference('tower'), position: { x: 2, y: 0 }, shape: { kind: 'rect', width: 0.5, height: 0.75 }, label: { markup: 'plain', source: { kind: 'localized', key: 'room-tower' } } },
  ];
  map.connections = [
    { id: 'start-hall', exit: { room: 'start', exit: 'north-exit' }, sourceLocation: 'start-location', targetLocation: 'hall-location' },
    { id: 'hall-tower', exit: { room: 'hall', exit: 'east-exit' }, sourceLocation: 'hall-location', targetLocation: 'tower-location' },
  ];
  project.maps.house = { id: 'house', label: 'House', properties: { enabled: true }, data: map };

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
  project.startupHook = { source: 'initialize_fixture()' };
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

export function inheritancePropertiesLocalizationGoldenProject(): AuthoringProject {
  const project = comprehensiveGoldenProject();
  renameProject(
    project,
    'golden-inheritance-properties-localization',
    'Golden Inheritance Properties Localization',
  );
  project.localization.fallbackLocale = 'en';
  project.rooms.hall!.properties = { mood: 'tense', 'visit-count': 7 };
  project.rooms.tower!.extends = 'hall';
  project.rooms.tower!.properties = { mood: 'calm' };
  return project;
}

export function sceneProgramGoldenProject(): AuthoringProject {
  const project = comprehensiveGoldenProject();
  renameProject(project, 'golden-scene-program', 'Golden Scene Program');

  const opening = defaultSceneData('Opening');
  opening.defaultBackground = {
    asset: sceneAssetRef('image-main'),
    material: sceneMaterialRef('sprite-material'),
    color: '#112233',
    fit: 'stretch',
  };
  opening.defaultLayout = sceneLayoutRef('hud-inline');
  opening.steps = [
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
      transition: 'slide',
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
      channel: 'voice',
      action: 'fade-in',
      loop: false,
      volume: 0.8,
      fadeMs: 250,
      waitForCompletion: true,
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
      id: 'input-wait', label: 'Input Wait', enabled: true, type: 'wait', waitKind: 'input', skippable: false,
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
          label: { markup: 'plain', source: { kind: 'lua-expression', source: 'transition_label()' } },
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
      slot: 'custom',
    },
    {
      ...defaultSceneStep('transition'),
      id: 'transition',
      transitionKind: 'dissolve',
      durationMs: 500,
      color: '#000000',
      waitForCompletion: true,
    },
    { ...defaultSceneStep('comment'), id: 'editor-note', text: 'Must not compile.' },
  ];
  opening.continuation = { kind: 'scene', id: 'closing' };
  project.scenes.opening = {
    id: 'opening', label: 'Opening', properties: { opacity: 0.5 }, data: opening,
  };

  const closing = defaultSceneData('Closing');
  closing.steps = [{
    ...defaultSceneStep('show-text'),
    id: 'closing-text',
    text: { markup: 'plain', source: { kind: 'inline', text: 'Closing.' } },
  }];
  closing.continuation = { kind: 'dialogue', id: 'intro' };
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
      segments: [{
        ...defaultDialogueSegment('line', 'final-line'),
        text: { markup: 'plain', source: { kind: 'inline', text: 'Final line.' } },
      }],
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
      label: { markup: 'plain', source: { kind: 'lua-expression', source: 'final_choice_label()' } },
      condition: { kind: 'lua-predicate', source: 'can_finish_dialogue()' },
      effects: [{ kind: 'run-lua-effect', source: 'finish_dialogue()' }],
      logged: false,
      autosaveSafePoint: false,
    },
  ];
  intro.completion = { kind: 'dialogue', id: 'epilogue' };
  project.dialogues.intro = {
    id: 'intro', label: 'Intro', properties: { note: 'dialogue-note' }, data: intro,
  };

  const epilogue = defaultDialogueData('Epilogue');
  epilogue.blocks[0] = {
    ...epilogue.blocks[0]!,
    type: 'sequence',
    defaultSpeaker: null,
    segments: [{
      ...defaultDialogueSegment('line', 'epilogue-line'),
      text: { markup: 'plain', source: { kind: 'inline', text: 'Epilogue.' } },
    }],
  };
  epilogue.completion = { kind: 'room', id: 'start' };
  project.dialogues.epilogue = { id: 'epilogue', label: 'Epilogue', data: epilogue };
  project.entrypoint = { kind: 'dialogue', id: 'intro' };
  return project;
}

export function interactionProgramGoldenProject(): AuthoringProject {
  const project = comprehensiveGoldenProject();
  renameProject(project, 'golden-interaction-program', 'Golden Interaction Program');

  const use = defaultVerbData('Use');
  use.arity = 1;
  use.operandRoles = ['target'];
  use.availability = {
    kind: 'variable-comparison',
    variable: variableReference('flag'),
    operator: 'truthy',
  };
  use.defaultProgram = {
    instructions: [{
      id: 'base-notify',
      kind: 'notify',
      message: { markup: 'plain', source: { kind: 'inline', text: 'Nothing happens.' } },
    }],
    completion: { kind: 'return' },
    outcome: 'unhandled',
  };
  project.verbs.use = { id: 'use', label: 'Use', data: use };

  const unlock = defaultVerbData('Unlock');
  unlock.arity = 1;
  unlock.operandRoles = ['target'];
  unlock.availability = { kind: 'lua-predicate', source: 'can_unlock()' };
  unlock.defaultProgram = {
    instructions: [{ id: 'unlock-dialogue', kind: 'call-dialogue', dialogue: dialogueReference('intro') }],
    completion: { kind: 'end' },
    outcome: 'handled',
  };
  project.verbs.unlock = { id: 'unlock', label: 'Unlock', extends: 'use', data: unlock };

  const combine = defaultVerbData('Combine');
  combine.arity = 2;
  combine.operandRoles = ['first', 'second'];
  combine.defaultProgram = {
    instructions: [],
    completion: { kind: 'scene', id: 'opening' },
    outcome: 'unhandled',
  };
  project.verbs.combine = { id: 'combine', label: 'Combine', data: combine };

  const interaction = defaultInteractionData();
  interaction.rules = [
    {
      id: 'any-context',
      verb: verbReference('use'),
      operands: [{ kind: 'exact', interactable: interactableReference('key') }],
      context: { kind: 'any' },
      program: {
        instructions: [
          { id: 'effect', kind: 'apply-effect', effect: { kind: 'set-variable', variable: variableReference('flag'), value: true } },
          { id: 'inventory', kind: 'move-interactable', interactable: interactableReference('key'), target: { kind: 'inventory' } },
          { id: 'state', kind: 'set-interactable-state', interactable: interactableReference('key'), enabled: true, visible: false },
          { id: 'notify', kind: 'notify', message: { markup: 'plain', source: { kind: 'localized', key: 'dialogue-intro' } } },
          { id: 'scene', kind: 'call-scene', scene: sceneReference('opening') },
          { id: 'dialogue', kind: 'call-dialogue', dialogue: dialogueReference('intro') },
        ],
        completion: { kind: 'room', id: 'hall' },
        outcome: 'handled',
      },
    },
    {
      id: 'active-room-context',
      verb: verbReference('use'),
      operands: [{ kind: 'any-interactable' }],
      context: { kind: 'active-room', room: roomReference('start') },
      program: {
        instructions: [{
          id: 'nowhere', kind: 'move-interactable', interactable: interactableReference('coin'), target: { kind: 'nowhere' },
        }],
        completion: { kind: 'scene', id: 'opening' },
        outcome: 'unhandled',
      },
    },
    {
      id: 'placement-context',
      verb: verbReference('unlock'),
      operands: [{ kind: 'exact', interactable: interactableReference('key') }],
      context: { kind: 'room-placement', placement: { room: 'start', placement: 'key-placement' } },
      program: {
        instructions: [{
          id: 'room-placement',
          kind: 'move-interactable',
          interactable: interactableReference('key'),
          target: { kind: 'room-placement', placement: { room: 'start', placement: 'key-placement' } },
        }],
        completion: { kind: 'dialogue', id: 'intro' },
        outcome: 'handled',
      },
    },
    {
      id: 'predicate-context',
      verb: verbReference('combine'),
      operands: [
        { kind: 'exact', interactable: interactableReference('key') },
        { kind: 'exact', interactable: interactableReference('coin') },
      ],
      context: {
        kind: 'predicate',
        condition: {
          kind: 'variable-comparison',
          variable: variableReference('count'),
          operator: 'greater',
          value: 0,
        },
      },
      program: {
        instructions: [{ id: 'lua-effect', kind: 'apply-effect', effect: { kind: 'run-lua-effect', source: 'combine_items()' } }],
        completion: { kind: 'end' },
        outcome: 'handled',
      },
    },
  ];
  project.interactions.actions = {
    id: 'actions', label: 'Actions', properties: { enabled: true }, data: interaction,
  };
  return project;
}
