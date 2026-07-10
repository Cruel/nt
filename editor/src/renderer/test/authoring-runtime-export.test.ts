import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';
import { buildAuthoringRuntimeExport } from '../../shared/project-schema/authoring-runtime-export';
import { defaultRoomData, roomAssetRef, roomRoomRef } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData, defaultSceneStep, sceneRoomRef } from '../../shared/project-schema/authoring-scenes';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';

function roomProject() {
  const project = createAuthoringProject({ name: 'Export Demo', version: '2.0.0', author: 'NovelTea' });
  project.assets.foyer = {
    id: 'foyer',
    label: 'Foyer BG',
    tags: [],
    data: assetDataFromImportMetadata({ kind: 'image', projectRelativePath: 'assets/images/foyer.png', extension: '.png' }),
  };
  const foyer = defaultRoomData('Foyer');
  foyer.description.source = 'A quiet foyer.';
  foyer.background.asset = roomAssetRef('foyer');
  foyer.paths = [{ id: 'north', label: 'North', direction: 'north', target: roomRoomRef('kitchen'), enabled: true, condition: '', order: 0 }];
  const kitchen = defaultRoomData('Kitchen');
  kitchen.description.source = 'A bright kitchen.';
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: foyer };
  project.rooms.kitchen = { id: 'kitchen', label: 'Kitchen', tags: [], data: kitchen };
  project.entrypoint = { collection: 'rooms', id: 'foyer' };
  project.tests.smoke = { id: 'smoke', label: 'Smoke', tags: [], data: defaultTestData('Smoke') };
  return project;
}

describe('authoring runtime export builder', () => {
  it('builds a runtime-shaped package input from a simple room project', () => {
    const profile = { ...defaultExportProfile(), compileShadersBeforeExport: false };
    const result = buildAuthoringRuntimeExport(roomProject(), { projectRoot: '/project', profile });

    expect(result.ok).toBe(true);
    expect(result.runtimeProject).toMatchObject({
      name: 'Export Demo',
      version: '2.0.0',
      author: 'NovelTea',
      entrypoint: [3, 'foyer'],
      room: {
        foyer: expect.arrayContaining(['foyer', 'A quiet foyer.', 'Foyer']),
        kitchen: expect.arrayContaining(['kitchen', 'A bright kitchen.', 'Kitchen']),
      },
    });
    expect((result.runtimeProject as { room: Record<string, unknown[]> }).room.foyer?.[2]).toMatchObject({
      background: 'project:/textures/foyer.png',
      backgroundFit: 'cover',
    });
    expect(result.runtimeProject).not.toHaveProperty('editor');
    expect(result.runtimeProject).not.toHaveProperty('tests');
    expect(result.fileEntries).toEqual([
      expect.objectContaining({ source: '/project/assets/images/foyer.png', packagePath: 'textures/foyer.png', assetId: 'foyer' }),
    ]);
    expect(result.packageOptions.fileEntries).toEqual([{ source: '/project/assets/images/foyer.png', packagePath: 'textures/foyer.png' }]);
    expect(result.packageOptions.shaderVariants).toEqual([]);
    expect(result.runtimeProject).toMatchObject({ display: { aspect_ratio: { width: 16, height: 9 }, orientation: 'landscape', bar_color: '#000000' } });
    expect(result.packageOptions.display).toEqual({ aspect_ratio: { width: 16, height: 9 }, orientation: 'landscape', bar_color: '#000000' });
    expect(result.manifestPreview).toMatchObject({ projectName: 'Export Demo', assetCount: 1, shaderVariants: [] });
  });

  it('blocks unsupported non-scene entrypoints with precise diagnostics', () => {
    const project = roomProject();
    project.characters.guide = { id: 'guide', label: 'Guide', tags: [], data: {} };
    project.entrypoint = { collection: 'characters', id: 'guide' };
    const result = buildAuthoringRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', path: '/entrypoint', message: expect.stringContaining('characters') }),
    ]));
  });

  it('exports scripts and allows a script entrypoint', () => {
    const project = roomProject();
    project.scripts.bootstrap = {
      id: 'bootstrap',
      label: 'Bootstrap',
      tags: [],
      data: { language: 'lua', source: 'Game.start_room("foyer")', autorun: true },
    };
    project.entrypoint = { collection: 'scripts', id: 'bootstrap' };

    const result = buildAuthoringRuntimeExport(project, { projectRoot: '/project', profile: defaultExportProfile(project) });

    expect(result.ok).toBe(true);
    expect(result.runtimeProject).toMatchObject({
      entrypoint: [6, 'bootstrap'],
      script: {
        bootstrap: ['bootstrap', '', {}, true, 'Game.start_room("foyer")'],
      },
    });
  });

  it('blocks missing script entrypoints with a precise diagnostic', () => {
    const project = roomProject();
    project.entrypoint = { collection: 'scripts', id: 'missing-script' };

    const result = buildAuthoringRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        path: '/entrypoint',
        message: "Entrypoint script 'missing-script' does not exist.",
      }),
    ]));
  });

  it('exports dialogues and allows a dialogue entrypoint', () => {
    const project = roomProject();
    const dialogue = defaultDialogueData('Intro');
    dialogue.blocks[0]!.segments[0]!.text.source = 'Hello from dialogue.';
    project.dialogues.intro = { id: 'intro', label: 'Intro', tags: [], data: dialogue };
    project.entrypoint = { collection: 'dialogues', id: 'intro' };

    const result = buildAuthoringRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(true);
    expect(result.runtimeProject).toMatchObject({
      entrypoint: [5, 'intro'],
      dialogue: {
        intro: expect.arrayContaining(['intro', 'Intro']),
      },
    });
    expect((result.runtimeProject as { dialogue: Record<string, unknown[]> }).dialogue.intro![9]).toEqual([
      [0, -1, false, false, false, false, false, true, '', '', '', [1]],
      [1, -1, false, false, false, false, false, true, '', '', 'Hello from dialogue.', []],
    ]);
  });

  it('reports unsupported dialogue export features as diagnostics', () => {
    const project = roomProject();
    const dialogue = defaultDialogueData('Intro');
    dialogue.blocks[0]!.segments[0]!.condition.enabled = true;
    dialogue.blocks[0]!.segments[0]!.condition.source = 'Game.prop("ok", true)';
    dialogue.blocks[0]!.segments[0]!.text.mode = 'lua';
    project.dialogues.intro = { id: 'intro', label: 'Intro', tags: [], data: dialogue };
    project.entrypoint = { collection: 'dialogues', id: 'intro' };

    const result = buildAuthoringRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', path: expect.stringContaining('/condition') }),
      expect.objectContaining({ severity: 'warning', path: expect.stringContaining('/text/mode') }),
    ]));
  });

  it('exports scenes as runtime cutscenes and allows a scene entrypoint', () => {
    const project = roomProject();
    const scene = defaultSceneData('Opening');
    scene.settings.next = sceneRoomRef('kitchen');
    scene.steps = [
      { ...defaultSceneStep('comment', 'Opening line'), comment: { source: 'The room fades in.' } },
      {
        ...defaultSceneStep('wait', 'Pause'),
        wait: { mode: 'input', durationMs: 0 },
        timing: { delayMs: 0, durationMs: 0, waitForInput: true, canSkip: true },
      },
      { ...defaultSceneStep('comment', 'Second line'), id: 'second-line', comment: { source: 'A kettle sings.' } },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data: scene };
    project.entrypoint = { collection: 'scenes', id: 'opening' };

    const result = buildAuthoringRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(true);
    expect(result.runtimeProject).toMatchObject({
      entrypoint: [1, 'opening'],
      cutscene: {
        opening: expect.arrayContaining(['opening', true, true, 1, [3, 'kitchen']]),
      },
    });
    expect((result.runtimeProject as { cutscene: Record<string, unknown[]> }).cutscene.opening![7]).toEqual([
      [0, 'The room fades in.', true, true, 0, 1000, 0, 0, 0, true, ''],
      [1, 1, 0, 0, true, false, ''],
      [0, 'A kettle sings.', true, true, 0, 1000, 0, 0, 0, true, ''],
    ]);
  });

  it('reports unsupported scene step types as diagnostics', () => {
    const project = roomProject();
    const scene = defaultSceneData('Opening');
    scene.steps = [
      {
        ...defaultSceneStep('background', 'Show background'),
        background: { asset: null, material: null, color: '#000000', fit: 'cover', transition: 'fade' },
      },
      { ...defaultSceneStep('transition', 'Fade'), transition: { kind: 'fade', durationMs: 500, color: '#000000' } },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data: scene };
    project.entrypoint = { collection: 'scenes', id: 'opening' };

    const result = buildAuthoringRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', path: expect.stringContaining('/steps/0') }),
      expect.objectContaining({ severity: 'warning', path: expect.stringContaining('/steps/1') }),
    ]));
  });
});
