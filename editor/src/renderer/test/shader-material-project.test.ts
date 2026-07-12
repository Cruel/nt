import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultFragmentShaderSource, defaultShaderData, defaultVertexShaderSource } from '../../shared/project-schema/authoring-shaders';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { buildShaderMaterialProject, buildShaderPreviewDocumentData, shaderPreviewRevision } from '../../shared/project-schema/shader-material-project';

function projectWithShaderMaterial() {
  const project = createAuthoringProject();
  project.assets['noise-fs'] = {
    id: 'noise-fs',
    label: 'noise.fs.sc',
    data: {
      kind: 'shader-source',
      source: { type: 'project-file', path: 'assets/shaders/noise.fs.sc' },
      aliases: [],
    },
  };
  project.assets['noise-texture'] = {
    id: 'noise-texture',
    label: 'noise.png',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/noise.png' },
      aliases: [],
    },
  };
  project.shaders.noise = {
    id: 'noise',
    label: 'Noise',
        data: {
      ...defaultShaderData('Noise'),
      stages: [
        { stage: 'vertex', sourceMode: 'inline', sourceText: 'void main() {}', compiled: {} },
        { stage: 'fragment', sourceMode: 'asset', sourceAsset: { $ref: { collection: 'assets', id: 'noise-fs' } }, compiled: { 'glsl-120': 'project:/shaders/bgfx/glsl-120/noise.fs.bin' } },
      ],
      uniforms: [{ name: 'u_amount', type: 'float', default: 0.5 }],
      samplers: [{ name: 's_noise', type: 'texture2d' }],
      roles: ['engine-2d'],
    },
  };
  project.materials.panel = {
    id: 'panel',
    label: 'Panel',
        data: {
      ...defaultMaterialData('Panel', 'noise'),
      uniforms: [{ name: 'u_amount', value: 0.75 }],
      textures: [{ sampler: 's_noise', source: { $ref: { collection: 'assets', id: 'noise-texture' } }, filtering: 'clamp-linear' }],
    },
  };
  return project;
}

describe('buildShaderMaterialProject', () => {
  it('creates functional inline shader source for new shaders', () => {
    const data = defaultShaderData('Starter');
    expect(data.stages).toMatchObject([
      { stage: 'vertex', sourceMode: 'inline', sourceText: defaultVertexShaderSource, compiled: {} },
      { stage: 'fragment', sourceMode: 'inline', sourceText: defaultFragmentShaderSource, compiled: {} },
    ]);
    expect(data.uniforms).toContainEqual({ name: 'u_tint', type: 'color', default: [1, 1, 1, 1], label: 'Tint' });
  });

  it('converts authoring shader and material records into runtime helper shape', () => {
    const result = buildShaderMaterialProject(projectWithShaderMaterial());
    expect(result.diagnostics).toEqual([]);
    expect(result.project.schema).toBe('noveltea.shader-materials.v1');
    expect(result.project.shaders.noise).toMatchObject({
      display_name: 'Noise',
      stages: {
        fragment: {
          source: 'project:/assets/shaders/noise.fs.sc',
          compiled: { 'glsl-120': 'project:/shaders/bgfx/glsl-120/noise.fs.bin' },
        },
      },
      uniforms: { u_amount: { type: 'float', default: 0.5 } },
      samplers: { s_noise: { type: 'texture2d' } },
      roles: ['engine-2d'],
    });
    expect(result.project.materials.panel).toMatchObject({
      display_name: 'Panel',
      role: 'engine-2d',
      shader: 'noise',
      uniforms: { u_amount: 0.75 },
      textures: { s_noise: { source: 'project:/assets/images/noise.png', sampler: 'clamp-linear' } },
      blend: 'premultiplied-alpha',
    });
  });

  it('builds shader square preview data with internal template references', () => {
    const project = projectWithShaderMaterial();
    expect(shaderPreviewRevision(project, 'noise')).toContain('noise');
    expect(buildShaderPreviewDocumentData(project, 'noise')).toMatchObject({
      schema: 'noveltea.shader-preview.v1',
      shaderId: 'noise',
      previewMaterialId: 'editor/preview/shader/noise',
      template: {
        rml: '/editor-assets/internal-preview/shader-square-preview.rml',
        rcss: '/editor-assets/internal-preview/shader-square-preview.rcss',
        materialPlaceholder: '__NT_PREVIEW_MATERIAL_ID__',
      },
    });
  });
});
