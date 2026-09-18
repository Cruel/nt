import { describe, expect, it } from 'vite-plus/test';
import { resolveAssetProfilerIdentityTarget } from '@/asset-profiler/asset-profiler-navigation';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

describe('asset profiler navigation', () => {
  it('resolves unique project assets, fonts, and materials', () => {
    const project = createAuthoringProject();
    project.assets.hero = {
      id: 'hero',
      label: 'Hero',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/hero.png',
        imageMetadata: { width: 512, height: 1024, hasAlpha: true, orientation: 1 },
      }),
    };
    project.assets['body-font'] = {
      id: 'body-font',
      label: 'Body Font',
      data: assetDataFromImportMetadata({
        kind: 'font',
        projectRelativePath: 'assets/fonts/body.ttf',
        imageMetadata: null,
      }),
    };
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel'),
    };

    expect(
      resolveAssetProfilerIdentityTarget(project, 'image', 'project:/assets/images/hero.png'),
    ).toMatchObject({ tab: { resource: { stableId: 'record:assets:hero' } } });
    expect(resolveAssetProfilerIdentityTarget(project, 'font', 'body-font|0')).toMatchObject({
      tab: { resource: { stableId: 'record:assets:body-font' } },
    });
    expect(resolveAssetProfilerIdentityTarget(project, 'material', 'panel')).toMatchObject({
      tab: { resource: { stableId: 'record:materials:panel' } },
    });
  });

  it('omits navigation for ambiguous physical assets and derived shader programs', () => {
    const project = createAuthoringProject();
    const image = assetDataFromImportMetadata({
      kind: 'image',
      projectRelativePath: 'assets/images/shared.png',
      imageMetadata: { width: 64, height: 64, hasAlpha: true, orientation: 1 },
    });
    project.assets.first = { id: 'first', label: 'First', data: image };
    project.assets.second = { id: 'second', label: 'Second', data: image };

    expect(
      resolveAssetProfilerIdentityTarget(project, 'image', 'project:/assets/images/shared.png'),
    ).toBeNull();
    expect(
      resolveAssetProfilerIdentityTarget(
        project,
        'shader',
        'source_program|program-identity|essl-300|project:/shaders/effect.fs.sc',
      ),
    ).toBeNull();
  });
});
