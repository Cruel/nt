import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';
import { buildCompiledRuntimeExport } from '../../shared/project-schema/compiled-runtime-export';
import {
  defaultRoomData,
  roomAssetRef,
  roomRoomRef,
} from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData, defaultSceneStep } from '../../shared/project-schema/authoring-scenes';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';

function roomProject() {
  const project = createAuthoringProject({
    name: 'Export Demo',
    version: '2.0.0',
    author: 'NovelTea',
  });
  project.assets.foyer = {
    id: 'foyer',
    label: 'Foyer BG',
    data: assetDataFromImportMetadata({
      kind: 'image',
      projectRelativePath: 'assets/images/foyer.png',
      extension: '.png',
    }),
  };
  const foyer = defaultRoomData('Foyer');
  foyer.description.source = { kind: 'inline', text: 'A quiet foyer.' };
  foyer.background.asset = roomAssetRef('foyer');
  foyer.exits = [
    {
      id: 'north',
      label: 'North',
      direction: 'north',
      target: roomRoomRef('kitchen'),
      condition: { kind: 'always' },
    },
  ];
  const kitchen = defaultRoomData('Kitchen');
  kitchen.description.source = { kind: 'inline', text: 'A bright kitchen.' };
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: foyer };
  project.rooms.kitchen = { id: 'kitchen', label: 'Kitchen', data: kitchen };
  project.entrypoint = { kind: 'room', id: 'foyer' };
  project.tests.smoke = { id: 'smoke', label: 'Smoke', data: defaultTestData('Smoke') };
  return project;
}

describe('compiled runtime export builder', () => {
  it('assembles a compiled package input from a simple room project', () => {
    const profile = { ...defaultExportProfile(), compileShadersBeforeExport: false };
    const result = buildCompiledRuntimeExport(roomProject(), { projectRoot: '/project', profile });

    expect(result.ok).toBe(true);
    expect(result.compiledProject).toMatchObject({
      schema: 'noveltea.compiled.project',
      schemaVersion: 2,
      project: { name: 'Export Demo', version: '2.0.0', author: 'NovelTea' },
      entrypoint: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
      definitions: {
        rooms: expect.arrayContaining([
          expect.objectContaining({ id: 'foyer', displayName: 'Foyer' }),
          expect.objectContaining({ id: 'kitchen', displayName: 'Kitchen' }),
        ]),
      },
    });
    expect(result.compiledProject).toMatchObject({
      resources: {
        assets: [expect.objectContaining({ id: 'foyer', path: 'assets/images/foyer.png' })],
      },
    });
    expect(result.compiledProject).not.toHaveProperty('editor');
    expect(result.compiledProject).not.toHaveProperty('tests');
    expect(result.fileEntries).toEqual([
      expect.objectContaining({
        source: '/project/assets/images/foyer.png',
        packagePath: 'assets/images/foyer.png',
        assetId: 'foyer',
      }),
    ]);
    expect(result.packageOptions.fileEntries).toEqual([
      { source: '/project/assets/images/foyer.png', packagePath: 'assets/images/foyer.png' },
    ]);
    expect(result.packageOptions.shaderVariants).toEqual([]);
    expect(result.compiledProject).toMatchObject({
      settings: {
        display: {
          referenceResolution: { width: 1920, height: 1080 },
          worldRasterPolicy: 'capped',
          barColor: '#000000',
        },
      },
    });
    expect(result.packageOptions.display).toEqual({
      reference_resolution: { width: 1920, height: 1080 },
      world_raster_policy: 'capped',
      bar_color: '#000000',
    });
    expect(result.packageOptions.platform).toEqual({
      orientation: 'landscape',
      desktop: {
        initialWidth: 1280,
        initialHeight: 720,
        arguments: ['--display-orientation', 'landscape'],
      },
      web: { orientation: 'landscape', query: 'orientation=landscape' },
      android: {
        orientation: 'landscape',
        gradleProperty: 'novelteaOrientation=landscape',
        screenOrientation: 'sensorLandscape',
      },
    });
    expect(result.manifestPreview).toMatchObject({
      projectName: 'Export Demo',
      assetCount: 1,
      shaderVariants: [],
    });
  });

  it('derives every portrait platform launch input from the normalized project profile', () => {
    const project = roomProject();
    project.settings.display = {
      referenceResolution: { width: 1080, height: 1920 },
      worldRasterPolicy: 'capped',
      barColor: '#102030',
    };

    const result = buildCompiledRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.packageOptions.display).toEqual({
      reference_resolution: { width: 1080, height: 1920 },
      world_raster_policy: 'capped',
      bar_color: '#102030',
    });
    expect(result.packageOptions.platform).toEqual({
      orientation: 'portrait',
      desktop: {
        initialWidth: 720,
        initialHeight: 1280,
        arguments: ['--display-orientation', 'portrait'],
      },
      web: { orientation: 'portrait', query: 'orientation=portrait' },
      android: {
        orientation: 'portrait',
        gradleProperty: 'novelteaOrientation=portrait',
        screenOrientation: 'sensorPortrait',
      },
    });
  });

  it('keeps startup Lua separate from the Room entrypoint', () => {
    const project = roomProject();
    project.scripts.bootstrap = {
      id: 'bootstrap',
      label: 'Bootstrap',
      data: {
        kind: 'script-module',
        source: { kind: 'inline-lua', source: 'Game.start_room("foyer")' },
      },
    };
    project.startupHook = { source: 'require("bootstrap")' };
    expect(project.entrypoint).toEqual({ kind: 'room', id: 'foyer' });
  });

  it('exports dialogues and allows a dialogue entrypoint', () => {
    const project = roomProject();
    const dialogue = defaultDialogueData('Intro');
    const start = dialogue.blocks[0]!;
    if (start.type !== 'sequence' || start.segments[0]?.type !== 'line')
      throw new Error('Expected default line.');
    start.segments[0].text.source = { kind: 'inline', text: 'Hello from dialogue.' };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };
    project.entrypoint = { kind: 'dialogue', id: 'intro' };

    const result = buildCompiledRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(true);
    expect(result.compiledProject).toMatchObject({
      entrypoint: { kind: 'dialogue', dialogue: { kind: 'dialogue', id: 'intro' } },
      definitions: { dialogues: [expect.objectContaining({ id: 'intro' })] },
    });
    expect(result.compiledProject).toMatchObject({
      definitions: { dialogues: [{ program: { blocks: expect.any(Array) } }] },
    });
  });

  it('preserves supported typed dialogue features without lossy warnings', () => {
    const project = roomProject();
    const dialogue = defaultDialogueData('Intro');
    const start = dialogue.blocks[0]!;
    if (start.type !== 'sequence' || start.segments[0]?.type !== 'line')
      throw new Error('Expected default line.');
    start.segments[0].condition = { kind: 'lua-predicate', source: 'return true' };
    start.segments[0].text.source = { kind: 'lua-expression', source: 'return "hello"' };
    start.segments[0].showOnce = true;
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };
    project.entrypoint = { kind: 'dialogue', id: 'intro' };

    const result = buildCompiledRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((item) => item.severity === 'warning')).toEqual([]);
  });

  it('exports typed scenes through the compiled runtime artifact', () => {
    const project = roomProject();
    const scene = defaultSceneData('Opening');
    scene.continuation = { kind: 'room', id: 'kitchen' };
    scene.steps = [
      { ...defaultSceneStep('comment', 'Opening line'), text: 'The room fades in.' },
      {
        id: 'pause',
        type: 'wait',
        label: 'Pause',
        enabled: true,
        waitKind: 'input',
        skippable: true,
      },
      {
        ...defaultSceneStep('show-text', 'Second line'),
        id: 'second-line',
        text: { source: { kind: 'inline', text: 'A kettle sings.' }, markup: 'active-text' },
      },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };
    project.entrypoint = { kind: 'scene', id: 'opening' };

    const result = buildCompiledRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(true);
    expect(result.compiledProject).toMatchObject({
      entrypoint: { kind: 'scene', scene: { kind: 'scene', id: 'opening' } },
      definitions: { scenes: [{ id: 'opening', program: { instructions: expect.any(Array) } }] },
    });
  });

  it('preserves supported scene presentation instructions without lossy warnings', () => {
    const project = roomProject();
    const scene = defaultSceneData('Opening');
    scene.steps = [
      {
        ...defaultSceneStep('set-background', 'Show background'),
        color: '#000000',
      },
      { ...defaultSceneStep('transition-group', 'Fade'), durationMs: 500, color: '#000000' },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };
    project.entrypoint = { kind: 'scene', id: 'opening' };

    const result = buildCompiledRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((item) => item.severity === 'warning')).toEqual([]);
  });

  it('preserves compiler codes and normalized runtime boundary ownership', () => {
    const project = roomProject();
    project.entrypoint = { kind: 'room', id: 'missing-room' };

    const result = buildCompiledRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'AUTHORING_AUTHORING_ENTRYPOINT_TARGET_MISSING',
        severity: 'error',
        path: '/entrypoint',
        ownerPaths: ['/entrypoint'],
        boundaries: ['authoring', 'runtime-package', 'platform-export'],
      }),
    );
  });

  it('uses generated fallback metadata without mutating platform-invalid authoring values', () => {
    const project = roomProject();
    project.project.name = '';
    project.project.version = '';
    const authored = structuredClone(project);

    const result = buildCompiledRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(true);
    expect(result.compiledArtifactAvailable).toBe(true);
    expect(result.runtimeBlockers).toEqual([]);
    expect(result.compiledProject).toMatchObject({
      project: { name: '[Unnamed Project]', version: '0.0.0' },
    });
    expect(result.manifestPreview).toMatchObject({
      projectName: '[Unnamed Project]',
      projectVersion: '0.0.0',
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'authoring.project.name.required',
        path: '/project/name',
        ownerPaths: ['/project/name'],
        boundaries: ['authoring', 'platform-export'],
      }),
    );
    expect(project).toEqual(authored);
  });

  it('blocks a missing entrypoint at the runtime-package boundary', () => {
    const project = roomProject();
    project.entrypoint = null;

    const result = buildCompiledRuntimeExport(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ok).toBe(false);
    expect(result.compiledArtifactAvailable).toBe(false);
    expect(result.runtimeBlockers).toContainEqual(
      expect.objectContaining({
        code: 'runtime-package.entrypoint.required',
        path: '/entrypoint',
        ownerPaths: ['/entrypoint'],
        boundaries: ['runtime-package', 'platform-export'],
      }),
    );
  });

  it('prepares shader outputs ephemerally without changing authoring content or its fingerprint', () => {
    const project = roomProject();
    project.shaders.basic = {
      id: 'basic',
      label: 'Basic',
      data: defaultShaderData('Basic'),
    };
    const authored = structuredClone(project);
    const options: Parameters<typeof buildCompiledRuntimeExport>[1] = {
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), shaderVariants: ['glsl-120'] },
    };
    const before = buildCompiledRuntimeExport(project, options);
    const prepared = buildCompiledRuntimeExport(project, {
      ...options,
      shaderOutputs: [
        {
          shader: 'basic',
          stage: 'fragment',
          variant: 'glsl-120',
          sourcePath: '/project/.noveltea/build/basic.fs.sc',
          runtimePath: 'project:/shaders/bgfx/glsl-120/basic.fs.bin',
          outputPath: '/project/shaders/bgfx/glsl-120/basic.fs.bin',
          cacheKey: 'basic-fragment-glsl-120',
          cacheHit: false,
        },
      ],
    });

    expect(prepared.sourceFingerprint).toBe(before.sourceFingerprint);
    expect(prepared.shaderMaterialMetadata).toMatchObject({
      shaders: {
        basic: {
          stages: {
            fragment: {
              compiled: {
                'glsl-120': 'project:/shaders/bgfx/glsl-120/basic.fs.bin',
              },
            },
          },
        },
      },
    });
    expect(prepared.packageOptions.shaderVariants).toEqual(['glsl-120']);
    expect(prepared.packageOptions.requiredShaderBinaryPaths).toContain(
      'shaders/bgfx/glsl-120/basic.fs.bin',
    );
    expect(project).toEqual(authored);
  });
});
