import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultFragmentShaderSource,
  defaultShaderData,
  defaultVertexShaderSource,
  shaderCompileInputFingerprint,
} from '../../shared/project-schema/authoring-shaders';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import {
  buildShaderMaterialProject,
  buildShaderPreviewDocumentData,
  runtimeShaderDefinitionSchema,
  shaderPreviewRevision,
} from '../../shared/project-schema/shader-material-project';

async function projectWithShaderMaterial() {
  const project = createAuthoringProject();
  project.assets['noise-fs'] = {
    id: 'noise-fs',
    label: 'noise.fs.sc',
    data: {
      kind: 'shader-source',
      source: { type: 'project-file', path: 'assets/shaders/noise.fs.sc' },
      aliases: [],
      imageMetadata: null,
    },
  };
  project.assets['noise-texture'] = {
    id: 'noise-texture',
    label: 'noise.png',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/noise.png' },
      aliases: [],
      imageMetadata: { width: 512, height: 512, hasAlpha: true, orientation: 1 },
    },
  };
  project.shaders.noise = {
    id: 'noise',
    label: 'Noise',
    data: {
      ...defaultShaderData('Noise'),
      stages: [
        { stage: 'vertex', sourceMode: 'inline', sourceText: 'void main() {}', compiled: {} },
        {
          stage: 'fragment',
          sourceMode: 'asset',
          sourceAsset: { $ref: { collection: 'assets', id: 'noise-fs' } },
          compiled: {
            'glsl-120': {
              path: 'project:/shaders/bgfx/glsl-120/noise.fs.bin',
              byteHash: `sha256:${'a'.repeat(64)}`,
              byteSize: 4,
              compileInputFingerprint: `sha256:${'b'.repeat(64)}`,
            },
          },
        },
      ],
      uniforms: [{ name: 'u_amount', type: 'float', default: 0.5 }],
      samplers: [{ name: 's_noise', type: 'texture2d', binding: null }],
      roles: ['engine-2d'],
    },
  };
  project.materials.panel = {
    id: 'panel',
    label: 'Panel',
    data: {
      ...defaultMaterialData('Panel', 'noise'),
      uniforms: [{ name: 'u_amount', value: 0.75 }],
      textures: [
        {
          sampler: 's_noise',
          source: { $ref: { collection: 'assets', id: 'noise-texture' } },
          filtering: 'clamp-linear',
        },
      ],
    },
  };
  const fingerprint = await shaderCompileInputFingerprint(project, 'noise', 1, 'glsl-120');
  if (!fingerprint) throw new Error('Expected Shader compile fingerprint fixture.');
  const shader = project.shaders.noise.data as ReturnType<typeof defaultShaderData>;
  shader.stages[1]!.compiled['glsl-120']!.compileInputFingerprint = fingerprint;
  return project;
}

describe('buildShaderMaterialProject', () => {
  it('rejects noncanonical runtime role membership and binding shapes', () => {
    const base = {
      display_name: 'Shader',
      stages: {},
      uniforms: {},
      samplers: {},
    };
    expect(
      runtimeShaderDefinitionSchema.safeParse({
        ...base,
        roles: { 'engine-2d': {} },
        role_bindings: {},
      }).success,
    ).toBe(false);
    expect(runtimeShaderDefinitionSchema.safeParse({ ...base, roles: ['engine-2d'] }).success).toBe(
      false,
    );
    expect(
      runtimeShaderDefinitionSchema.safeParse({
        ...base,
        roles: ['engine-2d', 'engine-2d'],
        role_bindings: {},
      }).success,
    ).toBe(false);
    expect(
      runtimeShaderDefinitionSchema.safeParse({
        ...base,
        roles: ['engine-2d'],
        role_bindings: { 'active-text': { vertex: 'shader' } },
      }).success,
    ).toBe(false);
    expect(
      runtimeShaderDefinitionSchema.safeParse({
        ...base,
        roles: ['engine-2d'],
        role_bindings: { 'engine-2d': {} },
      }).success,
    ).toBe(false);
  });

  it('creates functional inline shader source for new shaders', () => {
    const data = defaultShaderData('Starter');
    expect(data.stages).toMatchObject([
      {
        stage: 'vertex',
        sourceMode: 'inline',
        sourceText: defaultVertexShaderSource,
        compiled: {},
      },
      {
        stage: 'fragment',
        sourceMode: 'inline',
        sourceText: defaultFragmentShaderSource,
        compiled: {},
      },
    ]);
    expect(data.uniforms).toContainEqual({
      name: 'u_tint',
      type: 'color',
      default: [1, 1, 1, 1],
      label: 'Tint',
    });
  });

  it('converts authoring shader and material records into runtime helper shape', async () => {
    const project = await projectWithShaderMaterial();
    const authoredOutput = (project.shaders.noise.data as ReturnType<typeof defaultShaderData>)
      .stages[1]!.compiled['glsl-120']!;
    const result = await buildShaderMaterialProject(project);
    expect(result.diagnostics).toEqual([]);
    expect(result.project.schema).toBe('noveltea.shader-materials');
    expect(result.project.shaders.noise).toMatchObject({
      display_name: 'Noise',
      stages: {
        fragment: {
          source: 'project:/assets/shaders/noise.fs.sc',
          compiled: {
            'glsl-120': {
              runtimePath: authoredOutput.path,
              byteHash: authoredOutput.byteHash,
              byteSize: authoredOutput.byteSize,
            },
          },
        },
      },
      uniforms: { u_amount: { type: 'float', default: 0.5 } },
      samplers: { s_noise: { type: 'texture2d', binding: null } },
      roles: ['engine-2d'],
      role_bindings: {},
    });
    expect(result.project.shaders.noise.stages.fragment?.compiled?.['glsl-120']).not.toHaveProperty(
      'compileInputFingerprint',
    );
    expect(result.project.materials.panel).toMatchObject({
      display_name: 'Panel',
      role: 'engine-2d',
      shader: 'noise',
      uniforms: { u_amount: 0.75 },
      textures: {
        s_noise: { source: 'project:/assets/images/noise.png', sampler: 'clamp-linear' },
      },
      blend: 'premultiplied-alpha',
    });
  });

  it('preserves declared roles independently from role bindings', async () => {
    const project = await projectWithShaderMaterial();
    project.shaders.vertex = {
      id: 'vertex',
      label: 'Vertex',
      data: { ...defaultShaderData('Vertex'), roles: ['engine-2d', 'active-text'] },
    };
    project.shaders.noise.data = {
      ...project.shaders.noise.data,
      roles: ['engine-2d', 'active-text'],
      roleBindings: [
        {
          role: 'active-text',
          vertexShader: { $ref: { collection: 'shaders', id: 'vertex' } },
        },
      ],
    };
    const shader = project.shaders.noise.data as ReturnType<typeof defaultShaderData>;
    const fingerprint = await shaderCompileInputFingerprint(project, 'noise', 1, 'glsl-120');
    if (!fingerprint) throw new Error('Expected updated Shader compile fingerprint fixture.');
    shader.stages[1]!.compiled['glsl-120']!.compileInputFingerprint = fingerprint;

    const result = await buildShaderMaterialProject(project);
    expect(result.diagnostics).toEqual([]);
    expect(result.project.shaders.noise.roles).toEqual(['engine-2d', 'active-text']);
    expect(result.project.shaders.noise.role_bindings).toEqual({
      'active-text': { vertex: 'vertex' },
    });
  });

  it('emits postprocess scope with world as the authored default', async () => {
    const project = await projectWithShaderMaterial();
    project.shaders.noise.data = {
      ...project.shaders.noise.data,
      roles: ['postprocess'],
    };
    const shader = project.shaders.noise.data as ReturnType<typeof defaultShaderData>;
    const fingerprint = await shaderCompileInputFingerprint(project, 'noise', 1, 'glsl-120');
    if (!fingerprint) throw new Error('Expected updated Shader compile fingerprint fixture.');
    shader.stages[1]!.compiled['glsl-120']!.compileInputFingerprint = fingerprint;
    project.materials.panel.data = {
      ...defaultMaterialData('Panel', 'noise'),
      role: 'postprocess',
    };

    let result = await buildShaderMaterialProject(project);
    expect(result.diagnostics).toEqual([]);
    expect(result.project.materials.panel).toMatchObject({
      role: 'postprocess',
      postprocess_scope: 'world',
    });

    project.materials.panel.data = {
      ...project.materials.panel.data,
      postprocessScope: 'full-game-viewport',
    };
    result = await buildShaderMaterialProject(project);
    expect(result.diagnostics).toEqual([]);
    expect(result.project.materials.panel).toMatchObject({
      postprocess_scope: 'full-game-viewport',
    });
  });

  it('validates and flattens authored material inheritance into the runtime manifest', async () => {
    const project = await projectWithShaderMaterial();
    project.materials.base = {
      id: 'base',
      label: 'Base',
      data: {
        ...defaultMaterialData('Base', 'noise'),
        uniforms: [{ name: 'u_amount', value: 0.25 }],
      },
    };
    project.materials.child = {
      id: 'child',
      label: 'Child',
      data: {
        ...defaultMaterialData('Child', 'noise'),
        baseMaterialId: 'base',
        textures: [
          {
            sampler: 's_noise',
            source: { $ref: { collection: 'assets', id: 'noise-texture' } },
            filtering: 'repeat-linear',
          },
        ],
      },
    };

    const built = await buildShaderMaterialProject(project);
    expect(built.diagnostics).toEqual([]);
    expect(built.project.materials.child).toMatchObject({
      shader: 'noise',
      uniforms: { u_amount: 0.25 },
      textures: {
        s_noise: { source: 'project:/assets/images/noise.png', sampler: 'repeat-linear' },
      },
    });
    expect(built.project.materials.child).not.toHaveProperty('baseMaterialId');

    project.materials.base.data = {
      ...defaultMaterialData('Base', 'noise'),
      baseMaterialId: 'child',
    };
    expect(
      (await buildShaderMaterialProject(project)).diagnostics.some((item) =>
        item.message.includes('cycle'),
      ),
    ).toBe(true);
  });

  it('builds shader square preview data with internal template references', async () => {
    const project = await projectWithShaderMaterial();
    expect(shaderPreviewRevision(project, 'noise')).toContain('noise');
    expect(await buildShaderPreviewDocumentData(project, 'noise')).toMatchObject({
      schema: 'noveltea.shader-preview',
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
