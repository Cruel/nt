import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';
import { buildAuthoringRuntimeExport } from '../../shared/project-schema/authoring-runtime-export';
import { defaultRoomData, roomAssetRef, roomRoomRef } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData, defaultSceneStep } from '../../shared/project-schema/authoring-scenes';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';

function roomProject() {
  const project = createAuthoringProject({ name: 'Export Demo', version: '2.0.0', author: 'NovelTea' });
  project.assets.foyer = {
    id: 'foyer',
    label: 'Foyer BG',
        data: assetDataFromImportMetadata({ kind: 'image', projectRelativePath: 'assets/images/foyer.png', extension: '.png' }),
  };
  const foyer = defaultRoomData('Foyer');
  foyer.description.source = 'A quiet foyer.';
  foyer.background.asset = roomAssetRef('foyer');
  foyer.paths = [{ id: 'north', label: 'North', direction: 'north', target: roomRoomRef('kitchen'), enabled: true, condition: '', order: 0 }];
  const kitchen = defaultRoomData('Kitchen');
  kitchen.description.source = 'A bright kitchen.';
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: foyer };
  project.rooms.kitchen = { id: 'kitchen', label: 'Kitchen', data: kitchen };
  project.entrypoint = { kind: 'room', id: 'foyer' };
  project.tests.smoke = { id: 'smoke', label: 'Smoke', data: defaultTestData('Smoke') };
  return project;
}

describe('authoring runtime export builder', () => {
  it('builds a runtime-shaped package input from a simple room project', () => {
    const profile = { ...defaultExportProfile(), compileShadersBeforeExport: false };
    const result = buildAuthoringRuntimeExport(roomProject(), { projectRoot: '/project', profile });

    expect(result.ok).toBe(true);
    expect(result.runtimeProject).toMatchObject({
      schema: 'noveltea.runtime.project', schemaVersion: 1,
      identity: { name: 'Export Demo', version: '2.0.0', author: 'NovelTea' },
      entrypoint: { kind: 'room', id: 'foyer' },
      rooms: expect.arrayContaining([
        expect.objectContaining({ id: 'foyer', description: 'A quiet foyer.', name: 'Foyer' }),
        expect.objectContaining({ id: 'kitchen', description: 'A bright kitchen.', name: 'Kitchen' }),
      ]),
    });
    expect(result.runtimeProject).toMatchObject({ assets: [expect.objectContaining({ id: 'foyer', path: 'project:/textures/foyer.png' })] });
    expect(result.runtimeProject).not.toHaveProperty('editor');
    expect(result.runtimeProject).not.toHaveProperty('tests');
    expect(result.fileEntries).toEqual([
      expect.objectContaining({ source: '/project/assets/images/foyer.png', packagePath: 'textures/foyer.png', assetId: 'foyer' }),
    ]);
    expect(result.packageOptions.fileEntries).toEqual([{ source: '/project/assets/images/foyer.png', packagePath: 'textures/foyer.png' }]);
    expect(result.packageOptions.shaderVariants).toEqual([]);
    expect(result.runtimeProject).toMatchObject({ display: { aspect_ratio: { width: 16, height: 9 }, orientation: 'landscape', bar_color: '#000000' } });
    expect(result.packageOptions.display).toEqual({ aspect_ratio: { width: 16, height: 9 }, orientation: 'landscape', bar_color: '#000000' });
    expect(result.packageOptions.platform).toEqual({
      orientation: 'landscape',
      desktop: { initialWidth: 1280, initialHeight: 720, arguments: ['--display-orientation', 'landscape'] },
      web: { orientation: 'landscape', query: 'orientation=landscape' },
      android: { orientation: 'landscape', gradleProperty: 'novelteaOrientation=landscape', screenOrientation: 'sensorLandscape' },
    });
    expect(result.manifestPreview).toMatchObject({ projectName: 'Export Demo', assetCount: 1, shaderVariants: [] });
  });

  it('derives every portrait platform launch input from the normalized project profile', () => {
    const project = roomProject();
    project.settings.display = {
      aspectRatio: { width: 32, height: 18 },
      orientation: 'portrait',
      barColor: '#102030',
    };

    const result = buildAuthoringRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.packageOptions.display).toEqual({
      aspect_ratio: { width: 16, height: 9 },
      orientation: 'portrait',
      bar_color: '#102030',
    });
    expect(result.packageOptions.platform).toEqual({
      orientation: 'portrait',
      desktop: { initialWidth: 720, initialHeight: 1280, arguments: ['--display-orientation', 'portrait'] },
      web: { orientation: 'portrait', query: 'orientation=portrait' },
      android: { orientation: 'portrait', gradleProperty: 'novelteaOrientation=portrait', screenOrientation: 'sensorPortrait' },
    });
  });

  it('keeps startup Lua separate from the Room entrypoint', () => {
    const project = roomProject();
    project.scripts.bootstrap = {
      id: 'bootstrap',
      label: 'Bootstrap',
      data: { kind: 'script-module', source: 'Game.start_room("foyer")' },
    };
    project.startupHook = { source: 'require("bootstrap")' };
    expect(project.entrypoint).toEqual({ kind: 'room', id: 'foyer' });
  });

  it('exports dialogues and allows a dialogue entrypoint', () => {
    const project = roomProject();
    const dialogue = defaultDialogueData('Intro');
    const start = dialogue.blocks[0]!;
    if (start.type !== 'sequence' || start.segments[0]?.type !== 'line') throw new Error('Expected default line.');
    start.segments[0].text.source = { kind: 'inline', text: 'Hello from dialogue.' };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };
    project.entrypoint = { kind: 'dialogue', id: 'intro' };

    const result = buildAuthoringRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(true);
    expect(result.runtimeProject).toMatchObject({
      entrypoint: { kind: 'dialogue', id: 'intro' },
      dialogues: [expect.objectContaining({ id: 'intro' })],
    });
    expect(result.runtimeProject).toMatchObject({ dialogues: [{ nodes: [expect.objectContaining({ text: 'Hello from dialogue.' })] }] });
  });

  it('reports unsupported dialogue export features as diagnostics', () => {
    const project = roomProject();
    const dialogue = defaultDialogueData('Intro');
    const start = dialogue.blocks[0]!;
    if (start.type !== 'sequence' || start.segments[0]?.type !== 'line') throw new Error('Expected default line.');
    start.segments[0].condition = { kind: 'lua-predicate', source: 'return true' };
    start.segments[0].text.source = { kind: 'lua-expression', source: 'return "hello"' };
    start.segments[0].showOnce = true;
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };
    project.entrypoint = { kind: 'dialogue', id: 'intro' };

    const result = buildAuthoringRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', path: expect.stringContaining('/condition') }),
      expect.objectContaining({ severity: 'warning', path: expect.stringContaining('/text/source') }),
    ]));
  });

  it('exports typed scenes through the transitional runtime adapter', () => {
    const project = roomProject();
    const scene = defaultSceneData('Opening');
    scene.continuation = { kind: 'room', id: 'kitchen' };
    scene.steps = [
      { ...defaultSceneStep('comment', 'Opening line'), text: 'The room fades in.' },
      { id: 'pause', type: 'wait', label: 'Pause', enabled: true, waitKind: 'input', skippable: true },
      { ...defaultSceneStep('show-text', 'Second line'), id: 'second-line', text: { source: { kind: 'inline', text: 'A kettle sings.' }, markup: 'active-text' } },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };
    project.entrypoint = { kind: 'scene', id: 'opening' };

    const result = buildAuthoringRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(true);
    expect(result.runtimeProject).toMatchObject({
      entrypoint: { kind: 'scene', id: 'opening' },
      scenes: [{ id: 'opening', steps: expect.any(Array) }],
    });
  });

  it('reports unsupported scene step types as diagnostics', () => {
    const project = roomProject();
    const scene = defaultSceneData('Opening');
    scene.steps = [
      {
        ...defaultSceneStep('set-background', 'Show background'),
        color: '#000000',
      },
      { ...defaultSceneStep('transition', 'Fade'), durationMs: 500, color: '#000000' },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };
    project.entrypoint = { kind: 'scene', id: 'opening' };

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
