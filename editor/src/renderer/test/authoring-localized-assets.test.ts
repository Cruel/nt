import { describe, expect, it } from 'vite-plus/test';
import {
  createLocalizedAssetVariant,
  localizationAssetWorkflowView,
} from '../../shared/authoring-localized-assets';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

function addImage(project: ReturnType<typeof createAuthoringProject>, id: string, hash: string) {
  project.assets[id] = {
    id,
    label: id,
    data: {
      kind: 'image',
      source: { type: 'project-file', path: `assets/images/${id}.png` },
      aliases: [],
      contentHash: hash,
      imageMetadata: { width: 64, height: 64, hasAlpha: true, orientation: 1 },
    },
  };
}

describe('localized Assets', () => {
  it('resolves explicit inheritance and marks independent variants outdated when the base changes', () => {
    const project = createAuthoringProject();
    addImage(project, 'logo', 'sha256:base-v1');
    addImage(project, 'logo-fr', 'sha256:fr-v1');
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.localization.locales['fr-CA'] = {
      supported: true,
      parentLocale: 'fr',
      fontStack: null,
    };
    const variant = createLocalizedAssetVariant(project, 'logo', 'logo-fr');
    expect(variant).not.toBeNull();
    project.localization.assets.fr = { logo: variant! };

    expect(localizationAssetWorkflowView(project, 'fr-CA', 'logo')).toMatchObject({
      effectiveLocale: 'fr',
      inherited: true,
      freshness: 'current',
      target: { asset: { $ref: { collection: 'assets', id: 'logo-fr' } } },
    });

    (project.assets.logo!.data as { contentHash?: string }).contentHash = 'sha256:base-v2';
    expect(localizationAssetWorkflowView(project, 'fr-CA', 'logo')?.freshness).toBe('outdated');
  });

  it('treats Use source intentionally as current and rejects incompatible variant creation', () => {
    const project = createAuthoringProject();
    addImage(project, 'logo', 'sha256:base-v1');
    project.assets.voice = {
      id: 'voice',
      label: 'Voice',
      data: {
        kind: 'audio',
        source: { type: 'project-file', path: 'assets/audio/voice.ogg' },
        aliases: [],
        contentHash: 'sha256:voice',
        imageMetadata: null,
      },
    };
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.localization.assets.fr = { logo: { useSource: true } };

    expect(localizationAssetWorkflowView(project, 'fr', 'logo')?.freshness).toBe('current');
    expect(createLocalizedAssetVariant(project, 'logo', 'voice')).toBeNull();
  });
});
