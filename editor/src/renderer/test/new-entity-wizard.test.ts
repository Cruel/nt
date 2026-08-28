import { describe, expect, it } from 'vite-plus/test';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  assertNewEntityWizardCoverage,
  newEntityWizardCollectionKeys,
  newEntityWizardDefinition,
  newEntityWizardDefinitions,
  newEntityWizardExcludedCollections,
} from '@/wizard/new-entity/registry';
import type { NewEntityWizardDraft } from '@/wizard/new-entity/types/common';

function draft(
  collection: NewEntityWizardDraft['basics']['collection'],
  options: NewEntityWizardDraft['options'] = {},
): NewEntityWizardDraft {
  return {
    basics: {
      collection,
      entityId: `new-${collection}`,
      label: `New ${collection}`,
      description: '',
      tags: [],
      color: '',
    },
    options,
  };
}

describe('new entity wizard registry', () => {
  it('covers every wizard-enabled authoring collection', () => {
    expect(assertNewEntityWizardCoverage()).toEqual([]);
    expect(
      new Set(
        newEntityWizardCollectionKeys.map(
          (collection) => newEntityWizardDefinition(collection).collection,
        ),
      ),
    ).toEqual(new Set(newEntityWizardCollectionKeys));
  });

  it('excludes records that should use dedicated flows instead of the generic wizard', () => {
    expect(newEntityWizardExcludedCollections).toEqual(['assets', 'variables', 'tests']);
    expect(newEntityWizardDefinitions.map((definition) => definition.collection)).not.toContain(
      'assets',
    );
    expect(newEntityWizardDefinitions.map((definition) => definition.collection)).not.toContain(
      'variables',
    );
    expect(newEntityWizardDefinitions.map((definition) => definition.collection)).not.toContain(
      'tests',
    );
    expect(newEntityWizardCollectionKeys).toEqual(
      authoringCollectionKeys.filter(
        (collection) => !newEntityWizardExcludedCollections.includes(collection as never),
      ),
    );
  });

  it('builds material data with an optional shader reference', () => {
    const project = createAuthoringProject();
    project.shaders.sprite = { id: 'sprite', label: 'Sprite', data: {} as never };
    const payload = newEntityWizardDefinition('materials').buildPayload({
      project,
      draft: draft('materials', {
        shaderId: 'sprite',
        previewGeometry: 'sprite',
        previewBackground: 'dark',
      }),
    });
    expect(payload.data).toMatchObject({
      kind: 'material',
      shader: { $ref: { collection: 'shaders', id: 'sprite' } },
      preview: { geometry: 'sprite', background: 'dark' },
    });
  });

  it('builds room data with visual defaults', () => {
    const project = createAuthoringProject();
    const payload = newEntityWizardDefinition('rooms').buildPayload({
      project,
      draft: draft('rooms', {
        backgroundAssetId: 'foyer-image',
        materialId: 'painted',
        fit: 'contain',
        description: 'A quiet foyer.',
      }),
    });
    expect(payload.data).toMatchObject({
      kind: 'room',
      background: {
        asset: { $ref: { collection: 'assets', id: 'foyer-image' } },
        material: { $ref: { collection: 'materials', id: 'painted' } },
        fit: 'contain',
      },
      description: { source: { kind: 'inline', text: 'A quiet foyer.' } },
    });
  });

  it('builds dialogue data with speaker and initial line', () => {
    const project = createAuthoringProject();
    const payload = newEntityWizardDefinition('dialogues').buildPayload({
      project,
      draft: draft('dialogues', { speakerId: 'ada', lineText: 'Hello.' }),
    });
    expect(payload.data).toMatchObject({
      defaultSpeaker: { $ref: { collection: 'characters', id: 'ada' } },
      blocks: [
        {
          defaultSpeaker: { $ref: { collection: 'characters', id: 'ada' } },
          segments: [
            {
              speaker: { $ref: { collection: 'characters', id: 'ada' } },
              text: { source: { kind: 'inline', text: 'Hello.' } },
            },
          ],
        },
      ],
    });
  });

  it('creates typed entity records without placeholder payloads', () => {
    const project = createAuthoringProject();
    const interactableDefinition = newEntityWizardDefinition('interactables');
    expect(interactableDefinition.supportLevel).toBe('typed');
    expect(interactableDefinition.basicFields).toBe('identity-only');
    expect(
      interactableDefinition.buildPayload({
        project,
        draft: draft('interactables'),
      }),
    ).toMatchObject({
      data: {
        kind: 'interactable',
        presentation: { sprite: null, hotspots: { kind: 'none' } },
      },
    });
    project.assets.key = {
      id: 'key',
      label: 'Key Sprite',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/key.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    expect(
      interactableDefinition.buildPayload({
        project,
        draft: draft('interactables', { spriteId: 'key' }),
      }),
    ).toMatchObject({
      data: {
        presentation: {
          sprite: { $ref: { collection: 'assets', id: 'key' } },
          hotspots: { kind: 'sprite-alpha' },
        },
      },
    });
    expect(newEntityWizardDefinition('verbs').supportLevel).toBe('typed');
    expect(newEntityWizardDefinition('interactions').supportLevel).toBe('typed');
    expect(newEntityWizardDefinition('maps').supportLevel).toBe('typed');
    expect(newEntityWizardDefinition('scripts').supportLevel).toBe('typed');
    expect(
      newEntityWizardDefinition('scripts').buildPayload({ project, draft: draft('scripts') }),
    ).toEqual({ data: { kind: 'script-module', source: { kind: 'inline-lua', source: '' } } });
  });
});
