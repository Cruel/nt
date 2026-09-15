import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { createLocalizedAssetVariant } from '../../shared/authoring-localized-assets';
import {
  createLocalizationTranslation,
  localizationMessageWorkflowViews,
} from '../../shared/authoring-localization-workflow';
import {
  defaultExportProfile,
  type ExportProfileData,
} from '../../shared/project-schema/authoring-export';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';
import {
  prepareRuntimeAssessmentForTest,
  prepareRuntimeArtifactForTest,
  type RuntimeArtifactTestOptions,
} from './runtime-artifact-test-helpers';
import {
  PREPARED_RUNTIME_ARTIFACT_SCHEMA,
  verifyPreparedRuntimeArtifact,
} from '../../shared/runtime-artifact-preparation';
import {
  defaultRoomData,
  roomAssetRef,
  roomRoomRef,
} from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData, defaultSceneStep } from '../../shared/project-schema/authoring-scenes';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { rendererRuntimeArtifactPaths } from '../export/runtime-artifact-adapters';

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
      imageMetadata: { width: 1920, height: 1080, hasAlpha: true, orientation: 1 },
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
      onRejected: [],
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

describe('Prepared Runtime Artifact module', () => {
  it('assembles a compiled package input from a simple room project', async () => {
    const profile = { ...defaultExportProfile(), compileShadersBeforeExport: false };
    const result = await prepareRuntimeAssessmentForTest(roomProject(), {
      projectRoot: '/project',
      profile,
    });

    expect(result.ready).toBe(true);
    expect(result.compiledProject).toMatchObject({
      schema: 'noveltea.compiled.project',
      schemaVersion: 1,
      project: { name: 'Export Demo', version: '2.0.0', author: 'NovelTea' },
      entrypoint: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
      definitions: {
        rooms: expect.arrayContaining([
          expect.objectContaining({
            id: 'foyer',
            displayName: expect.objectContaining({
              source: expect.objectContaining({ kind: 'message' }),
            }),
          }),
          expect.objectContaining({
            id: 'kitchen',
            displayName: expect.objectContaining({
              source: expect.objectContaining({ kind: 'message' }),
            }),
          }),
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
      {
        source: '/project/assets/images/foyer.png',
        packagePath: 'assets/images/foyer.png',
        storage: 'auto',
      },
    ]);
    expect(result.packageOptions.requiredSeekablePaths).toEqual([]);
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

  it('flattens selected locale inheritance and omits unused source-language catalogs', async () => {
    const project = roomProject();
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.localization.locales['fr-CA'] = {
      supported: true,
      parentLocale: 'fr',
      fontStack: null,
    };
    project.localization.translations.fr = Object.fromEntries(
      localizationMessageWorkflowViews(project).map((message) => [
        message.id,
        createLocalizationTranslation(message, `FR ${message.source}`, 'human', {
          review: 'reviewed',
        }),
      ]),
    );
    const profile = {
      ...defaultExportProfile(),
      compileShadersBeforeExport: false,
      localization: {
        locales: ['fr-CA'],
        defaultLocale: 'fr-CA',
        quality: 'release' as const,
      },
    };

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile,
    });

    expect(result.ready).toBe(true);
    expect(result.localization).toEqual({
      includedLocales: ['fr-CA'],
      defaultLocale: 'fr-CA',
      quality: 'release',
      sourceFallback: { messageCount: 0, assetCount: 1 },
    });
    expect(result.compiledProject?.localization).toMatchObject({
      sourceLocale: 'fr-CA',
      defaultLocale: 'fr-CA',
      locales: [expect.objectContaining({ locale: 'fr-CA', parentLocale: null, supported: true })],
      catalogs: [expect.objectContaining({ locale: 'fr-CA' })],
    });
    expect(result.compiledProject?.localization.locales.map((locale) => locale.locale)).toEqual([
      'fr-CA',
    ]);
    expect(result.compiledProject?.localization.catalogs.map((catalog) => catalog.locale)).toEqual([
      'fr-CA',
    ]);
    expect(
      result.diagnostics.filter((item) => item.code.startsWith('localization.export.message_')),
    ).toEqual([]);
  });

  it('prepares localized Asset variants and locale fonts through the same selected-locale closure', async () => {
    const project = roomProject();
    project.assets['foyer-fr'] = {
      id: 'foyer-fr',
      label: 'Foyer French',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/foyer-fr.png',
        extension: '.png',
        imageMetadata: { width: 1920, height: 1080, hasAlpha: true, orientation: 1 },
      }),
    };
    project.assets['font-fr'] = {
      id: 'font-fr',
      label: 'French Font',
      data: assetDataFromImportMetadata({
        kind: 'font',
        projectRelativePath: 'assets/fonts/fr.ttf',
        extension: '.ttf',
        imageMetadata: null,
      }),
    };
    project.assets['foyer-es'] = {
      id: 'foyer-es',
      label: 'Foyer Spanish',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/foyer-es.png',
        extension: '.png',
        imageMetadata: { width: 1920, height: 1080, hasAlpha: true, orientation: 1 },
      }),
    };
    project.assets['font-es'] = {
      id: 'font-es',
      label: 'Spanish Font',
      data: assetDataFromImportMetadata({
        kind: 'font',
        projectRelativePath: 'assets/fonts/es.ttf',
        extension: '.ttf',
        imageMetadata: null,
      }),
    };
    project.localization.locales.fr = {
      supported: true,
      parentLocale: null,
      fontStack: [{ $ref: { collection: 'assets', id: 'font-fr' } }],
    };
    project.localization.locales.es = {
      supported: true,
      parentLocale: null,
      fontStack: [{ $ref: { collection: 'assets', id: 'font-es' } }],
    };
    project.localization.translations.fr = Object.fromEntries(
      localizationMessageWorkflowViews(project).map((message) => [
        message.id,
        createLocalizationTranslation(message, `FR ${message.source}`, 'human', {
          review: 'reviewed',
        }),
      ]),
    );
    const localizedFoyer = createLocalizedAssetVariant(project, 'foyer', 'foyer-fr', 'human')!;
    localizedFoyer.review = 'reviewed';
    const localizedFoyerEs = createLocalizedAssetVariant(project, 'foyer', 'foyer-es', 'human')!;
    localizedFoyerEs.review = 'reviewed';
    project.localization.assets.fr = { foyer: localizedFoyer };
    project.localization.assets.es = { foyer: localizedFoyerEs };
    const profile = {
      ...defaultExportProfile(),
      compileShadersBeforeExport: false,
      localization: { locales: ['fr'], defaultLocale: 'fr', quality: 'release' as const },
    };

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile,
    });

    expect(result.ready).toBe(true);
    expect(result.localization.sourceFallback).toEqual({ messageCount: 0, assetCount: 0 });
    expect(result.fileEntries.map((entry) => entry.assetId).sort()).toEqual([
      'font-fr',
      'foyer-fr',
    ]);
    expect(result.fileEntries.map((entry) => entry.assetId)).not.toContain('foyer');
    expect(result.fileEntries.map((entry) => entry.assetId)).not.toContain('foyer-es');
    expect(result.fileEntries.map((entry) => entry.assetId)).not.toContain('font-es');
    expect(result.compiledProject?.resources.assets.map((asset) => asset.id)).not.toContain(
      'foyer-es',
    );
    expect(result.compiledProject?.resources.assets.map((asset) => asset.id)).not.toContain(
      'font-es',
    );
    expect(
      result.compiledProject?.resources.assets.find((asset) => asset.id === 'foyer')?.localized,
    ).toEqual([{ locale: 'fr', state: 'variant', asset: { kind: 'asset', id: 'foyer-fr' } }]);
    expect(result.compiledProject?.localization.locales[0]?.fontStack).toEqual([
      { kind: 'asset', id: 'font-fr' },
    ]);

    const prepared = await prepareRuntimeArtifactForTest(project, {
      projectRoot: '/project',
      profile,
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status === 'prepared')
      expect(
        (
          await verifyPreparedRuntimeArtifact(prepared.artifact, {
            project,
            projectRoot: '/project',
            profile,
            paths: rendererRuntimeArtifactPaths,
          })
        ).status,
      ).toBe('verified');
  });

  it('partitions non-startup locale catalogs into package-local text entries', async () => {
    const project = roomProject();
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.localization.locales.es = { supported: true, parentLocale: null, fontStack: null };
    const messages = localizationMessageWorkflowViews(project);
    project.localization.translations.fr = Object.fromEntries(
      messages.map((message) => [
        message.id,
        createLocalizationTranslation(message, `FR ${message.source}`, 'human', {
          review: 'reviewed',
        }),
      ]),
    );
    project.localization.translations.es = Object.fromEntries(
      messages.map((message) => [
        message.id,
        createLocalizationTranslation(message, `ES ${message.source}`, 'human', {
          review: 'reviewed',
        }),
      ]),
    );
    const profile = {
      ...defaultExportProfile(),
      compileShadersBeforeExport: false,
      localization: {
        locales: ['fr', 'es'],
        defaultLocale: 'fr',
        quality: 'release' as const,
      },
    };

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile,
    });

    expect(result.ready).toBe(true);
    expect(result.compiledProject?.localization.sourceLocale).toBe('fr');
    expect(result.compiledProject?.localization.defaultLocale).toBe('fr');
    expect(result.compiledProject?.localization.catalogs.map((catalog) => catalog.locale)).toEqual([
      'fr',
    ]);
    expect(
      result.compiledProject?.localization.locales.find((locale) => locale.locale === 'es')
        ?.catalogPath,
    ).toBe('localization/es.json');
    expect(result.packageOptions.textEntries).toHaveLength(1);
    expect(result.packageOptions.textEntries[0]).toMatchObject({
      packagePath: 'localization/es.json',
      storage: 'compressed',
    });
    expect(JSON.parse(result.packageOptions.textEntries[0]!.text)).toMatchObject({ locale: 'es' });

    const prepared = await prepareRuntimeArtifactForTest(project, {
      projectRoot: '/project',
      profile,
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status === 'prepared')
      expect(
        (
          await verifyPreparedRuntimeArtifact(prepared.artifact, {
            project,
            projectRoot: '/project',
            profile,
            paths: rendererRuntimeArtifactPaths,
          })
        ).status,
      ).toBe('verified');
  });

  it('retains a locale variant that is also referenced independently at runtime', async () => {
    const project = roomProject();
    project.assets['foyer-es'] = {
      id: 'foyer-es',
      label: 'Foyer Spanish',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/foyer-es.png',
        extension: '.png',
        imageMetadata: { width: 1920, height: 1080, hasAlpha: true, orientation: 1 },
      }),
    };
    project.localization.locales.es = { supported: true, parentLocale: null, fontStack: null };
    project.localization.assets.es = {
      foyer: createLocalizedAssetVariant(project, 'foyer', 'foyer-es', 'human')!,
    };
    const annex = defaultRoomData('Annex');
    annex.background.asset = roomAssetRef('foyer-es');
    project.rooms.annex = { id: 'annex', label: 'Annex', data: annex };

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: { ...defaultExportProfile(), compileShadersBeforeExport: false },
    });

    expect(result.ready).toBe(true);
    expect(result.fileEntries.map((entry) => entry.assetId).sort()).toEqual(['foyer', 'foyer-es']);
    expect(
      result.compiledProject?.resources.assets.find((asset) => asset.id === 'foyer-es')?.localized,
    ).toEqual([{ locale: 'en', state: 'source' }]);
  });

  it('reports only required source fallback closure for incomplete selected content', async () => {
    const project = roomProject();
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    const messages = localizationMessageWorkflowViews(project);
    const first = messages[0]!;
    project.localization.translations.fr = {
      [first.id]: {
        ...createLocalizationTranslation(first, first.source, 'human'),
        useSource: true,
      },
    };
    project.localization.assets.fr = { foyer: { useSource: true } };
    const profile = {
      ...defaultExportProfile(),
      compileShadersBeforeExport: false,
      localization: { locales: ['fr'], defaultLocale: 'fr', quality: 'release' as const },
    };

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile,
    });

    expect(result.ready).toBe(true);
    expect(result.localization.sourceFallback.assetCount).toBe(1);
    expect(result.localization.sourceFallback.messageCount).toBe(messages.length);
    expect(result.compiledProject?.localization.locales.map((locale) => locale.locale)).toEqual([
      'fr',
    ]);
    expect(result.compiledProject?.localization.catalogs.map((catalog) => catalog.locale)).toEqual([
      'fr',
    ]);
    expect(result.fileEntries.map((entry) => entry.assetId)).toContain('foyer');
    expect(
      result.diagnostics.some((item) => item.code === 'localization.export.message_missing'),
    ).toBe(true);
    expect(
      result.diagnostics.some((item) => item.code === 'localization.export.asset_missing'),
    ).toBe(false);
  });

  it('excludes unreferenced assets from both gameplay resources and package files by default', async () => {
    const project = roomProject();
    project.assets.unused = {
      id: 'unused',
      label: 'Unused',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/unused.png',
        extension: '.png',
        imageMetadata: { width: 64, height: 64, hasAlpha: true, orientation: 1 },
      }),
    };

    const pruned = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: { ...defaultExportProfile(), compileShadersBeforeExport: false },
    });
    expect(pruned.excludedUnusedAssetCount).toBe(1);
    expect(pruned.compiledProject?.resources.assets.map((asset) => asset.id)).toEqual(['foyer']);
    expect(pruned.fileEntries.map((entry) => entry.assetId)).toEqual(['foyer']);
    expect(
      JSON.parse(pruned.gameplayJson ?? '{}').resources.assets.map(
        (asset: { id: string }) => asset.id,
      ),
    ).toEqual(['foyer']);

    const complete = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: {
        ...defaultExportProfile(),
        compileShadersBeforeExport: false,
        excludeUnusedAssets: false,
      },
    });
    expect(complete.excludedUnusedAssetCount).toBe(0);
    expect(complete.compiledProject?.resources.assets.map((asset) => asset.id)).toEqual([
      'foyer',
      'unused',
    ]);
    expect(complete.fileEntries.map((entry) => entry.assetId)).toEqual(['foyer', 'unused']);

    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    const localizedPruned = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: {
        ...defaultExportProfile(),
        compileShadersBeforeExport: false,
        localization: { locales: ['fr'], defaultLocale: 'fr', quality: 'release' },
      },
    });
    expect(localizedPruned.localization.sourceFallback.assetCount).toBe(1);
    expect(localizedPruned.compiledProject?.resources.assets.map((asset) => asset.id)).toEqual([
      'foyer',
    ]);
    expect(localizedPruned.fileEntries.map((entry) => entry.assetId)).toEqual(['foyer']);
    expect(localizedPruned.diagnostics.some((item) => item.path.includes('/unused'))).toBe(false);
  });

  it('retains JSON data Assets declared as Layout dependencies in pruned runtime artifacts', async () => {
    const project = roomProject();
    project.assets.catalog = {
      id: 'catalog',
      label: 'Catalog',
      data: assetDataFromImportMetadata({
        kind: 'data',
        projectRelativePath: 'assets/data/catalog.json',
        extension: '.json',
        imageMetadata: null,
      }),
    };
    const layout = defaultLayoutData();
    layout.dependencies.data = [{ $ref: { collection: 'assets', id: 'catalog' } }];
    project.layouts.catalog = { id: 'catalog', label: 'Catalog', data: layout };

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: { ...defaultExportProfile(), compileShadersBeforeExport: false },
    });

    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(result.ready).toBe(true);
    expect(result.compiledProject?.resources.assets.map((asset) => asset.id)).toContain('catalog');
    expect(result.fileEntries.map((entry) => entry.assetId)).toContain('catalog');
    expect(
      result.compiledProject?.resources.layouts.find((entry) => entry.id === 'catalog'),
    ).toMatchObject({
      dependencies: { data: [{ kind: 'asset', id: 'catalog' }] },
    });
  });

  it('retains assets referenced only by conservative Lua/source analysis', async () => {
    const project = roomProject();
    project.assets['lua-only'] = {
      id: 'lua-only',
      label: 'Lua Only',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/lua-only.png',
        extension: '.png',
        imageMetadata: { width: 64, height: 64, hasAlpha: true, orientation: 1 },
      }),
    };
    project.scripts.bootstrap!.data = {
      kind: 'script-module',
      source: { kind: 'inline-lua', source: "local image = 'lua-only'\nreturn {}\n" },
    };

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: { ...defaultExportProfile(), compileShadersBeforeExport: false },
    });

    expect(result.compiledProject?.resources.assets.map((asset) => asset.id)).toContain('lua-only');
    expect(result.fileEntries.map((entry) => entry.assetId)).toContain('lua-only');
  });

  it('retains assets referenced only from file-backed Lua source', async () => {
    const project = roomProject();
    const sourceHash = `sha256:${'a'.repeat(64)}` as const;
    project.assets['script-file'] = {
      id: 'script-file',
      label: 'Script File',
      data: assetDataFromImportMetadata({
        kind: 'script',
        projectRelativePath: 'assets/scripts/main.lua',
        extension: '.lua',
        contentHash: sourceHash,
        imageMetadata: null,
      }),
    };
    project.assets['lua-only-file'] = {
      id: 'lua-only-file',
      label: 'Lua Only File',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/lua-only-file.png',
        extension: '.png',
        imageMetadata: { width: 64, height: 64, hasAlpha: true, orientation: 1 },
      }),
    };
    project.scripts.main = {
      id: 'main',
      label: 'Main',
      data: {
        kind: 'script-module',
        source: { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'script-file' } } },
      },
    };

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: { ...defaultExportProfile(), compileShadersBeforeExport: false },
      paths: {
        resolveProjectSource(root, source) {
          return `${root}/${source}`;
        },
        shaderAssetRoot() {
          return undefined;
        },
        async readProjectTextSources(_root, entries) {
          return entries.map((entry) => ({
            status: 'ready' as const,
            assetId: entry.assetId,
            projectRelativePath: entry.projectRelativePath,
            contentHash: entry.expectedContentHash,
            text: "local image = 'lua-only-file'",
          }));
        },
      },
    });

    expect(result.compiledProject?.resources.assets.map((asset) => asset.id)).toContain(
      'lua-only-file',
    );
    expect(result.fileEntries.map((entry) => entry.assetId)).toContain('lua-only-file');
  });

  it('marks authored audio stored and seekable regardless of its package filename', async () => {
    const project = roomProject();
    project.assets.theme = {
      id: 'theme',
      label: 'Theme',
      data: assetDataFromImportMetadata({
        kind: 'audio',
        projectRelativePath: 'assets/audio/theme.wav',
        extension: '.wav',
        imageMetadata: null,
      }),
    };
    const profile = {
      ...defaultExportProfile(),
      compileShadersBeforeExport: false,
      excludeUnusedAssets: false,
    };
    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile,
    });

    expect(result.ready).toBe(true);
    expect(result.fileEntries).toContainEqual(
      expect.objectContaining({
        source: '/project/assets/audio/theme.wav',
        packagePath: 'assets/audio/theme.wav',
        storage: 'stored',
        kind: 'audio',
      }),
    );
    expect(result.packageOptions.fileEntries).toContainEqual({
      source: '/project/assets/audio/theme.wav',
      packagePath: 'assets/audio/theme.wav',
      storage: 'stored',
    });
    expect(result.packageOptions.requiredSeekablePaths).toEqual(['assets/audio/theme.wav']);
  });

  it('derives every portrait platform launch input from the normalized project profile', async () => {
    const project = roomProject();
    project.settings.display = {
      referenceResolution: { width: 1080, height: 1920 },
      worldRasterPolicy: 'capped',
      barColor: '#102030',
    };

    const result = await prepareRuntimeAssessmentForTest(project, {
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

  it('keeps startup Lua separate from the Room entrypoint', async () => {
    const project = roomProject();
    project.scripts.bootstrap = {
      id: 'bootstrap',
      label: 'Bootstrap',
      data: {
        kind: 'script-module',
        source: { kind: 'inline-lua', source: 'Game.start_room("foyer")' },
      },
    };
    project.scripts.bootstrap!.data = {
      kind: 'script-module',
      source: { kind: 'inline-lua', source: 'import("bootstrap-dependency")\nreturn {}\n' },
    };
    expect(project.entrypoint).toEqual({ kind: 'room', id: 'foyer' });
  });

  it('exports dialogues and allows a dialogue entrypoint', async () => {
    const project = roomProject();
    const dialogue = defaultDialogueData('Intro');
    const start = dialogue.blocks[0]!;
    if (start.type !== 'sequence' || start.segments[0]?.type !== 'line')
      throw new Error('Expected default line.');
    start.segments[0].text.source = { kind: 'inline', text: 'Hello from dialogue.' };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };
    project.entrypoint = { kind: 'dialogue', id: 'intro' };

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ready).toBe(true);
    expect(result.compiledProject).toMatchObject({
      entrypoint: { kind: 'dialogue', dialogue: { kind: 'dialogue', id: 'intro' } },
      definitions: { dialogues: [expect.objectContaining({ id: 'intro' })] },
    });
    expect(result.compiledProject).toMatchObject({
      definitions: { dialogues: [{ program: { blocks: expect.any(Array) } }] },
    });
  });

  it('preserves supported typed dialogue features without lossy warnings', async () => {
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

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ready).toBe(true);
    expect(result.diagnostics.filter((item) => item.severity === 'warning')).toEqual([]);
  });

  it('exports typed scenes through the compiled runtime artifact', async () => {
    const project = roomProject();
    const scene = defaultSceneData('Opening');
    scene.terminal = { kind: 'complete-game' };
    scene.events = [
      { ...defaultSceneStep('comment', 'Opening line'), text: 'The room fades in.' },
      {
        id: 'pause',
        type: 'wait',
        label: 'Pause',
        enabled: true,
        timeline: { trackId: 'main', startMs: 0, durationMs: 0 },
        completionDependencies: [],
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

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ready).toBe(true);
    expect(result.compiledProject).toMatchObject({
      entrypoint: { kind: 'scene', scene: { kind: 'scene', id: 'opening' } },
      definitions: { scenes: [{ id: 'opening', program: { events: expect.any(Array) } }] },
    });
  });

  it('preserves supported scene presentation instructions without lossy warnings', async () => {
    const project = roomProject();
    const scene = defaultSceneData('Opening');
    scene.events = [
      {
        ...defaultSceneStep('set-background', 'Show background'),
        color: '#000000',
      },
      { ...defaultSceneStep('transition-group', 'Fade'), durationMs: 500, color: '#000000' },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };
    project.entrypoint = { kind: 'scene', id: 'opening' };

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ready).toBe(true);
    expect(result.diagnostics.filter((item) => item.severity === 'warning')).toEqual([]);
  });

  it('preserves compiler codes and normalized runtime boundary ownership', async () => {
    const project = roomProject();
    project.entrypoint = { kind: 'room', id: 'missing-room' };

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ready).toBe(false);
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

  it('uses generated fallback metadata without mutating platform-invalid authoring values', async () => {
    const project = roomProject();
    project.project.name = '';
    project.project.version = '';
    const authored = structuredClone(project);

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ready).toBe(true);
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

  it('keeps invalid editor-only metadata out of runtime artifact publication', async () => {
    const project = roomProject();
    project.editor.recordMetadata.shaders = {
      removed: { tags: [] },
    };

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ready).toBe(true);
    expect(result.compiledArtifactAvailable).toBe(true);
    expect(result.runtimeBlockers).toEqual([]);
    expect(result.runtimeDiagnostics).not.toContainEqual(
      expect.objectContaining({ path: '/editor/recordMetadata/shaders/removed' }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        path: '/editor/recordMetadata/shaders/removed',
        boundaries: ['authoring'],
      }),
    );
  });

  it('blocks a missing entrypoint at the runtime-package boundary', async () => {
    const project = roomProject();
    project.entrypoint = null;

    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/project',
      profile: defaultExportProfile(project),
    });

    expect(result.ready).toBe(false);
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

  it('prepares shader outputs ephemerally without changing authoring content or its fingerprint', async () => {
    const project = roomProject();
    project.shaders.basic = {
      id: 'basic',
      label: 'Basic',
      data: defaultShaderData('Basic'),
    };
    const authored = structuredClone(project);
    const options: RuntimeArtifactTestOptions = {
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), shaderVariants: ['glsl-120'] },
    };
    const before = await prepareRuntimeAssessmentForTest(project, options);
    const prepared = await prepareRuntimeAssessmentForTest(project, {
      ...options,
      shaderOutputs: [
        {
          shader: 'basic',
          stage: 'vertex',
          variant: 'glsl-120',
          sourcePath: '/project/.noveltea/build/basic.vs.sc',
          runtimePath: 'project:/shaders/bgfx/glsl-120/basic.vs.bin',
          outputPath: '/project/shaders/bgfx/glsl-120/basic.vs.bin',
          cacheKey: 'basic-vertex-glsl-120',
          byteHash: `sha256:${'b'.repeat(64)}`,
          byteSize: 4,
          cacheHit: false,
        },
        {
          shader: 'basic',
          stage: 'fragment',
          variant: 'glsl-120',
          sourcePath: '/project/.noveltea/build/basic.fs.sc',
          runtimePath: 'project:/shaders/bgfx/glsl-120/basic.fs.bin',
          outputPath: '/project/shaders/bgfx/glsl-120/basic.fs.bin',
          cacheKey: 'basic-fragment-glsl-120',
          byteHash: `sha256:${'a'.repeat(64)}`,
          byteSize: 4,
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
                'glsl-120': {
                  runtimePath: 'project:/shaders/bgfx/glsl-120/basic.fs.bin',
                  byteHash: `sha256:${'a'.repeat(64)}`,
                  byteSize: 4,
                },
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
    expect(JSON.stringify(prepared.shaderMaterialMetadata)).not.toContain(
      'compileInputFingerprint',
    );
    expect(project).toEqual(authored);
  });

  it('publishes and verifies the one current Prepared Runtime Artifact contract', async () => {
    const project = roomProject();
    const profile = { ...defaultExportProfile(project), compileShadersBeforeExport: false };
    const prepared = await prepareRuntimeArtifactForTest(project, {
      projectRoot: '/project',
      profile,
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.artifact).toMatchObject({
      schema: PREPARED_RUNTIME_ARTIFACT_SCHEMA,
    });
    expect(
      (
        await verifyPreparedRuntimeArtifact(prepared.artifact, {
          project,
          projectRoot: '/project',
          profile,
          paths: rendererRuntimeArtifactPaths,
        })
      ).status,
    ).toBe('verified');

    const testOnlyEdit = structuredClone(project);
    testOnlyEdit.tests.smoke!.label = 'Renamed smoke test';
    expect(
      (
        await verifyPreparedRuntimeArtifact(prepared.artifact, {
          project: testOnlyEdit,
          projectRoot: '/project',
          profile,
          paths: rendererRuntimeArtifactPaths,
        })
      ).status,
    ).toBe('verified');
  });

  it('rejects unsupported and internally inconsistent prepared evidence', async () => {
    const project = roomProject();
    const profile = { ...defaultExportProfile(project), compileShadersBeforeExport: false };
    const prepared = await prepareRuntimeArtifactForTest(project, {
      projectRoot: '/project',
      profile,
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(
      (
        await verifyPreparedRuntimeArtifact(
          { ...prepared.artifact, schemaVersion: 0 },
          { project, projectRoot: '/project', profile, paths: rendererRuntimeArtifactPaths },
        )
      ).status,
    ).toBe('rejected');
    expect(
      (
        await verifyPreparedRuntimeArtifact(
          {
            ...prepared.artifact,
            packageOptions: { ...prepared.artifact.packageOptions, fileEntries: [] },
          },
          { project, projectRoot: '/project', profile, paths: rendererRuntimeArtifactPaths },
        )
      ).status,
    ).toBe('rejected');
    expect(
      (
        await verifyPreparedRuntimeArtifact(
          {
            ...prepared.artifact,
            packageOptions: { ...prepared.artifact.packageOptions, kind: 'editable' },
          },
          { project, projectRoot: '/project', profile, paths: rendererRuntimeArtifactPaths },
        )
      ).status,
    ).toBe('rejected');
  });

  it('rejects mutually consistent asset omissions and source-path substitutions', async () => {
    const project = roomProject();
    const profile = { ...defaultExportProfile(project), compileShadersBeforeExport: false };
    const prepared = await prepareRuntimeArtifactForTest(project, {
      projectRoot: '/project',
      profile,
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    const verify = (artifact: typeof prepared.artifact) =>
      verifyPreparedRuntimeArtifact(artifact, {
        project,
        projectRoot: '/project',
        profile,
        paths: rendererRuntimeArtifactPaths,
      });

    expect(
      (
        await verify({
          ...prepared.artifact,
          fileEntries: [],
          packageOptions: { ...prepared.artifact.packageOptions, fileEntries: [] },
          manifestPreview: {
            ...prepared.artifact.manifestPreview,
            assetCount: 0,
            entryCount: 1,
          },
        })
      ).status,
    ).toBe('rejected');

    const substituted = prepared.artifact.fileEntries.map((entry) => ({
      ...entry,
      source: '/project/assets/images/other.png',
    }));
    expect(
      (
        await verify({
          ...prepared.artifact,
          fileEntries: substituted,
          packageOptions: {
            ...prepared.artifact.packageOptions,
            fileEntries: substituted.map(({ source, packagePath, storage }) => ({
              source,
              packagePath,
              storage,
            })),
          },
        })
      ).status,
    ).toBe('rejected');
  });

  it('rejects a mutually consistent omitted compiled asset against a fresh current-project compile', async () => {
    const project = roomProject();
    const profile = { ...defaultExportProfile(project), compileShadersBeforeExport: false };
    const prepared = await prepareRuntimeArtifactForTest(project, {
      projectRoot: '/project',
      profile,
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;

    const compiledProject = {
      ...prepared.artifact.compiledProject,
      resources: { ...prepared.artifact.compiledProject.resources, assets: [] },
    };
    const omitted = {
      ...prepared.artifact,
      compiledProject,
      gameplayJson: JSON.stringify(compiledProject),
      fileEntries: [],
      manifestPreview: {
        ...prepared.artifact.manifestPreview,
        assetCount: 0,
        entryCount: 1,
      },
      packageOptions: { ...prepared.artifact.packageOptions, fileEntries: [] },
    };
    const verified = await verifyPreparedRuntimeArtifact(omitted, {
      project,
      projectRoot: '/project',
      profile,
      paths: rendererRuntimeArtifactPaths,
    });
    expect(verified.status).toBe('rejected');
    if (verified.status === 'rejected')
      expect(verified.diagnostics[0]?.path).toBe('/artifact/compiledProject/resources/assets');
  });

  it('rejects pruned prepared evidence when source references cannot be independently rederived', async () => {
    const project = roomProject();
    const sourceHash = `sha256:${'a'.repeat(64)}` as const;
    project.assets['script-file'] = {
      id: 'script-file',
      label: 'Script File',
      data: assetDataFromImportMetadata({
        kind: 'script',
        projectRelativePath: 'assets/scripts/main.lua',
        contentHash: sourceHash,
        imageMetadata: null,
      }),
    };
    project.assets['lua-only-file'] = {
      id: 'lua-only-file',
      label: 'Lua Only File',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/lua-only-file.png',
        extension: '.png',
        imageMetadata: { width: 64, height: 64, hasAlpha: true, orientation: 1 },
      }),
    };
    project.scripts.main = {
      id: 'main',
      label: 'Main',
      data: {
        kind: 'script-module',
        source: { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'script-file' } } },
      },
    };
    const profile = { ...defaultExportProfile(project), compileShadersBeforeExport: false };
    const readyPaths = {
      ...rendererRuntimeArtifactPaths,
      async readProjectTextSources(
        _root: string | null,
        entries: Parameters<
          NonNullable<typeof rendererRuntimeArtifactPaths.readProjectTextSources>
        >[1],
      ) {
        return entries.map((entry) => ({
          status: 'ready' as const,
          assetId: entry.assetId,
          projectRelativePath: entry.projectRelativePath,
          contentHash: entry.expectedContentHash,
          text: "local image = 'lua-only-file'",
        }));
      },
    };
    const prepared = await prepareRuntimeArtifactForTest(project, {
      projectRoot: '/project',
      profile,
      paths: readyPaths,
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.artifact.compiledProject.resources.assets.map((asset) => asset.id)).toContain(
      'lua-only-file',
    );

    const verified = await verifyPreparedRuntimeArtifact(prepared.artifact, {
      project,
      projectRoot: '/project',
      profile,
      paths: {
        ...rendererRuntimeArtifactPaths,
        async readProjectTextSources(_root, entries) {
          return entries.map((entry) => ({
            status: 'unavailable' as const,
            assetId: entry.assetId,
          }));
        },
      },
    });
    expect(verified.status).toBe('rejected');
    if (verified.status === 'rejected')
      expect(verified.diagnostics[0]?.message).toContain('cannot be verified');
  });

  it('rejects preflight shader evidence when an export profile requires compiled outputs', async () => {
    const project = roomProject();
    project.shaders.basic = {
      id: 'basic',
      label: 'Basic',
      data: defaultShaderData('Basic'),
    };
    const profile: ExportProfileData = {
      ...defaultExportProfile(project),
      shaderVariants: ['glsl-120'],
    };
    const prepared = await prepareRuntimeArtifactForTest(project, {
      projectRoot: '/project',
      profile,
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;

    expect(
      (
        await verifyPreparedRuntimeArtifact(prepared.artifact, {
          project,
          projectRoot: '/project',
          profile,
          paths: rendererRuntimeArtifactPaths,
        })
      ).status,
    ).toBe('rejected');
  });
});
