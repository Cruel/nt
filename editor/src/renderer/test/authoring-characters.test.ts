import { describe, expect, it } from 'vite-plus/test';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  characterAssetRef,
  characterMaterialRef,
  defaultCharacterData,
  validateCharacterData,
} from '../../shared/project-schema/authoring-characters';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import {
  buildCharacterPreviewDocumentData,
  characterPreviewRevision,
  resolveCharacterPresentationLayers,
} from '../../shared/project-schema/character-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';

describe('authoring characters schema', () => {
  it('provides a trivial one-layer default presentation profile', () => {
    expect(defaultCharacterData('Iris')).toMatchObject({
      kind: 'character',
      displayName: 'Iris',
      dialogue: { name: 'Iris' },
      defaults: {
        profileId: 'stage',
        expressionId: 'neutral',
        appearanceId: null,
      },
      profiles: [
        {
          id: 'stage',
          defaultPoseId: 'default',
          layers: [{ id: 'body', role: 'body' }],
          poses: [{ id: 'default', layers: [{ layerId: 'body' }] }],
        },
      ],
      expressions: [{ id: 'neutral', profiles: [] }],
      appearances: [],
    });
  });

  it('resolves expression layers per profile with fallback to the default expression', () => {
    const project = createAuthoringProject();
    project.assets.neutral = {
      id: 'neutral',
      label: 'Neutral',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/neutral.png',
        extension: '.png',
        byteSize: 12,
        contentHash: 'neutral-hash',
        importedAt: '2026-01-01T00:00:00.000Z',
        originalName: 'neutral.png',
        originalPath: '/tmp/neutral.png',
        imageMetadata: { width: 640, height: 960, hasAlpha: true, orientation: 1 },
      }),
    };
    const data = defaultCharacterData('Iris');
    data.expressions[0]!.profiles = [
      {
        profileId: 'stage',
        layers: [{ layerId: 'body', sprite: characterAssetRef('neutral') }],
      },
    ];
    data.expressions.push({ id: 'happy', label: 'Happy', profiles: [] });
    project.characters.iris = { id: 'iris', label: 'Iris', data };

    const resolved = resolveCharacterPresentationLayers(data, 'stage', 'default', 'happy');
    expect(resolved).toMatchObject([
      {
        id: 'body',
        role: 'body',
        sprite: characterAssetRef('neutral'),
      },
    ]);
  });

  it('preserves profile layer order and applies appearance after expression overrides', () => {
    const data = defaultCharacterData('Iris');
    const profile = data.profiles[0]!;
    profile.layers.push({ id: 'face', label: 'Face', role: 'face' });
    profile.poses[0]!.layers.push({
      layerId: 'face',
      sprite: null,
      material: null,
      offset: { x: 0, y: 0 },
      scale: 1,
      anchor: { x: 0.5, y: 1 },
      visible: true,
    });
    data.expressions[0]!.profiles = [
      {
        profileId: 'stage',
        layers: [{ layerId: 'face', visible: false }],
      },
    ];
    data.appearances.push({
      id: 'disguise',
      label: 'Disguise',
      profiles: [
        {
          profileId: 'stage',
          layers: [{ layerId: 'face', visible: true }],
        },
      ],
    });

    expect(
      resolveCharacterPresentationLayers(data, 'stage', 'default', 'neutral', 'disguise'),
    ).toMatchObject([
      { id: 'body', role: 'body', visible: true },
      { id: 'face', role: 'face', visible: true },
    ]);
  });

  it('validates duplicate subrecord IDs and missing defaults', () => {
    const project = createAuthoringProject();
    project.characters.iris = {
      id: 'iris',
      label: 'Iris',
      data: {
        ...defaultCharacterData('Iris'),
        defaults: {
          profileId: 'missing-profile',
          expressionId: 'missing-expression',
          appearanceId: null,
          idleId: null,
        },
        profiles: [
          {
            ...defaultCharacterData('Iris').profiles[0]!,
            poses: [
              defaultCharacterData('Iris').profiles[0]!.poses[0]!,
              { ...defaultCharacterData('Iris').profiles[0]!.poses[0]!, label: 'Duplicate' },
            ],
          },
        ],
        expressions: [
          { id: 'neutral', label: 'Neutral', profiles: [] },
          { id: 'neutral', label: 'Duplicate', profiles: [] },
        ],
      },
    };

    expect(validateAuthoringProject(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/characters/iris/data/profiles/0/poses/1/id',
          category: 'Characters',
        }),
        expect.objectContaining({
          path: '/characters/iris/data/expressions/1/id',
          category: 'Characters',
        }),
        expect.objectContaining({
          path: '/characters/iris/data/defaults/profileId',
          category: 'Characters',
        }),
        expect.objectContaining({
          path: '/characters/iris/data/defaults/expressionId',
          category: 'Characters',
        }),
      ]),
    );
  });

  it('validates sprite and material references', () => {
    const project = createAuthoringProject();
    project.assets.theme = {
      id: 'theme',
      label: 'Theme',
      data: assetDataFromImportMetadata({
        kind: 'audio',
        projectRelativePath: 'assets/audio/theme.mp3',
        extension: '.mp3',
        byteSize: 10,
        contentHash: 'hash-audio',
        importedAt: '2026-01-01T00:00:00.000Z',
        originalName: 'theme.mp3',
        originalPath: '/tmp/theme.mp3',
        imageMetadata: null,
      }),
    };
    project.materials.glow = { id: 'glow', label: 'Glow', data: defaultMaterialData('Glow') };
    project.characters.iris = {
      id: 'iris',
      label: 'Iris',
      data: {
        ...defaultCharacterData('Iris'),
        profiles: [
          {
            ...defaultCharacterData('Iris').profiles[0]!,
            poses: [
              {
                ...defaultCharacterData('Iris').profiles[0]!.poses[0]!,
                layers: [
                  {
                    ...defaultCharacterData('Iris').profiles[0]!.poses[0]!.layers[0]!,
                    sprite: characterAssetRef('theme'),
                    material: characterMaterialRef('glow'),
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const diagnostics = validateCharacterData(project, 'iris', project.characters.iris);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          path: '/characters/iris/data/profiles/0/poses/0/layers/0/sprite/$ref',
        }),
      ]),
    );
  });

  it('builds character preview documents with dependency revisions', () => {
    const project = createAuthoringProject();
    project.assets.iris = {
      id: 'iris',
      label: 'Iris Sprite',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/iris.png',
        extension: '.png',
        byteSize: 12,
        contentHash: 'hash-image',
        importedAt: '2026-01-01T00:00:00.000Z',
        originalName: 'iris.png',
        originalPath: '/tmp/iris.png',
        imageMetadata: { width: 640, height: 960, hasAlpha: true, orientation: 1 },
      }),
    };
    const data = defaultCharacterData('Iris');
    data.profiles[0]!.poses[0]!.layers[0]!.sprite = characterAssetRef('iris');
    project.characters.iris = { id: 'iris', label: 'Iris', data };

    expect(characterPreviewRevision(project, 'iris')).toContain('hash-image');
    expect(buildCharacterPreviewDocumentData(project, 'iris')).toMatchObject({
      schema: 'noveltea.character-preview',
      characterId: 'iris',
      resolvedLayers: [
        { id: 'body', sprite: { id: 'iris', kind: 'image', contentHash: 'hash-image' } },
      ],
    });
  });
});
