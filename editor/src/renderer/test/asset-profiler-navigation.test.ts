import { describe, expect, it } from 'vite-plus/test';
import { resolveAssetProfilerIdentityTarget } from '@/asset-profiler/asset-profiler-navigation';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';

describe('asset profiler navigation', () => {
  it('resolves unique project assets, fonts, and materials', () => {
    const project = createAuthoringProject();
    project.assets.hero = {
      id: 'hero',
      label: 'Hero',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/hero.png',
      }),
    };
    project.assets['body-font'] = {
      id: 'body-font',
      label: 'Body Font',
      data: assetDataFromImportMetadata({
        kind: 'font',
        projectRelativePath: 'assets/fonts/body.ttf',
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

  it('omits navigation when an asset path or shader program is ambiguous', () => {
    const project = createAuthoringProject();
    const image = assetDataFromImportMetadata({
      kind: 'image',
      projectRelativePath: 'assets/images/shared.png',
    });
    project.assets.first = { id: 'first', label: 'First', data: image };
    project.assets.second = { id: 'second', label: 'Second', data: image };
    project.shaders.vertex = {
      id: 'vertex',
      label: 'Vertex',
      data: defaultShaderData('Vertex'),
    };
    project.shaders.fragment = {
      id: 'fragment',
      label: 'Fragment',
      data: defaultShaderData('Fragment'),
    };

    expect(
      resolveAssetProfilerIdentityTarget(project, 'image', 'project:/assets/images/shared.png'),
    ).toBeNull();
    expect(
      resolveAssetProfilerIdentityTarget(
        project,
        'shader',
        'direct_shader_pair|vertex|fragment|essl|vertex.sc|fragment.sc',
      ),
    ).toBeNull();
  });

  it('resolves a shader program only when one authored shader owns the key', () => {
    const project = createAuthoringProject();
    project.shaders.fragment = {
      id: 'fragment',
      label: 'Fragment',
      data: defaultShaderData('Fragment'),
    };

    expect(
      resolveAssetProfilerIdentityTarget(
        project,
        'shader',
        'direct_shader_pair|engine-vertex|fragment|essl|engine.sc|fragment.sc',
      ),
    ).toMatchObject({ tab: { resource: { stableId: 'record:shaders:fragment' } } });
  });
});
