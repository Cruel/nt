import { describe, expect, it } from 'vitest';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  characterAssetRef,
  characterMaterialRef,
  defaultCharacterData,
  validateCharacterData,
} from '../../shared/project-schema/authoring-characters';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { buildCharacterPreviewDocumentData, characterPreviewRevision } from '../../shared/project-schema/character-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';

describe('authoring characters schema', () => {
  it('provides typed defaults with one pose and one expression', () => {
    expect(defaultCharacterData('Iris')).toMatchObject({
      kind: 'character',
      displayName: 'Iris',
      dialogue: { name: 'Iris' },
      defaults: { poseId: 'default', expressionId: 'neutral' },
      poses: [{ id: 'default', label: 'Default' }],
      expressions: [{ id: 'neutral', label: 'Neutral' }],
    });
  });

  it('validates duplicate subrecord IDs and missing defaults', () => {
    const project = createAuthoringProject();
    project.characters.iris = {
      id: 'iris',
      label: 'Iris',
      tags: [],
      data: {
        ...defaultCharacterData('Iris'),
        defaults: { poseId: 'missing-pose', expressionId: 'missing-expression' },
        poses: [
          { id: 'default', label: 'Default', sprite: null, material: null, offset: { x: 0, y: 0 }, scale: 1, anchor: { x: 0.5, y: 1 } },
          { id: 'default', label: 'Duplicate', sprite: null, material: null, offset: { x: 0, y: 0 }, scale: 1, anchor: { x: 0.5, y: 1 } },
        ],
        expressions: [
          { id: 'neutral', label: 'Neutral', poseId: null, sprite: null, material: null },
          { id: 'neutral', label: 'Duplicate', poseId: null, sprite: null, material: null },
        ],
      },
    };

    expect(validateAuthoringProject(project)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/characters/iris/data/poses/1/id', category: 'authoring-characters' }),
      expect.objectContaining({ path: '/characters/iris/data/expressions/1/id', category: 'authoring-characters' }),
      expect.objectContaining({ path: '/characters/iris/data/defaults/poseId', category: 'authoring-characters' }),
      expect.objectContaining({ path: '/characters/iris/data/defaults/expressionId', category: 'authoring-characters' }),
    ]));
  });

  it('validates sprite and material references', () => {
    const project = createAuthoringProject();
    project.assets.theme = {
      id: 'theme',
      label: 'Theme',
      tags: [],
      data: assetDataFromImportMetadata({
        kind: 'audio',
        projectRelativePath: 'assets/audio/theme.mp3',
        extension: '.mp3',
        byteSize: 10,
        contentHash: 'hash-audio',
        importedAt: '2026-01-01T00:00:00.000Z',
        originalName: 'theme.mp3',
        originalPath: '/tmp/theme.mp3',
      }),
    };
    project.materials.glow = { id: 'glow', label: 'Glow', tags: [], data: defaultMaterialData('Glow') };
    project.characters.iris = {
      id: 'iris',
      label: 'Iris',
      tags: [],
      data: {
        ...defaultCharacterData('Iris'),
        poses: [{
          id: 'default',
          label: 'Default',
          sprite: characterAssetRef('theme'),
          material: characterMaterialRef('glow'),
          offset: { x: 0, y: 0 },
          scale: 1,
          anchor: { x: 0.5, y: 1 },
        }],
      },
    };

    const diagnostics = validateCharacterData(project, 'iris', project.characters.iris);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', path: '/characters/iris/data/poses/0/sprite/$ref' }),
    ]));
  });

  it('builds character preview documents with dependency revisions', () => {
    const project = createAuthoringProject();
    project.assets.iris = {
      id: 'iris',
      label: 'Iris Sprite',
      tags: [],
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/iris.png',
        extension: '.png',
        byteSize: 12,
        contentHash: 'hash-image',
        importedAt: '2026-01-01T00:00:00.000Z',
        originalName: 'iris.png',
        originalPath: '/tmp/iris.png',
      }),
    };
    const data = defaultCharacterData('Iris');
    data.poses[0]!.sprite = characterAssetRef('iris');
    project.characters.iris = { id: 'iris', label: 'Iris', tags: [], data };

    expect(characterPreviewRevision(project, 'iris')).toContain('hash-image');
    expect(buildCharacterPreviewDocumentData(project, 'iris')).toMatchObject({
      schema: 'noveltea.character-preview.v1',
      characterId: 'iris',
      resolvedSprite: { id: 'iris', kind: 'image', contentHash: 'hash-image' },
    });
  });
});
