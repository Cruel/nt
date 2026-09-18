import { describe, expect, it } from 'vite-plus/test';
import type { ShaderCompileOutput } from '../../shared/editor-tooling';
import {
  defaultMaterialData,
  resolveMaterialData,
  validateMaterialData,
} from '../../shared/project-schema/authoring-materials';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  buildShaderMaterialProject,
  runtimeShaderDefinitionSchema,
} from '../../shared/project-schema/shader-material-project';

function imageAsset() {
  return {
    id: 'noise-texture',
    label: 'noise.png',
    data: {
      kind: 'image' as const,
      source: { type: 'project-file' as const, path: 'assets/images/noise.png' },
      aliases: [],
      imageMetadata: { width: 512, height: 512, hasAlpha: true, orientation: 1 as const },
    },
  };
}

describe('canonical Material shader lowering', () => {
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
  });

  it('lowers preset-backed Materials without project shader source or authored Shader records', async () => {
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel', 'engine-2d'),
    };

    const built = await buildShaderMaterialProject(project);
    expect(built.diagnostics).toEqual([]);
    expect(built.compilation).toEqual({ schema: 'noveltea.shader-source-programs', programs: {} });
    expect(built.project.materials.panel).toMatchObject({
      display_name: 'Panel',
      role: 'engine-2d',
      shader: 'preset-engine-2d',
      blend: 'premultiplied-alpha',
    });
    expect(built.project.shaders['preset-engine-2d']).toMatchObject({
      stages: {
        vertex: { compiled: expect.any(Object) },
        fragment: { compiled: expect.any(Object) },
      },
      roles: ['engine-2d'],
    });
  });

  it('resolves single-parent sparse overrides with provenance and rejects cycles', () => {
    const project = createAuthoringProject();
    project.materials.base = {
      id: 'base',
      label: 'Base',
      data: {
        ...defaultMaterialData('Base', 'postprocess-tint'),
        parameters: { u_tint: { value: [0.25, 0.5, 0.75, 1] } },
      },
    };
    project.materials.child = {
      id: 'child',
      label: 'Child',
      data: {
        kind: 'material',
        base: { kind: 'material', material: { $ref: { collection: 'materials', id: 'base' } } },
        parameters: {},
        textures: {},
        preview: { background: 'dark' },
      },
    };

    const resolved = resolveMaterialData(project, 'child');
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.data).toMatchObject({
      role: 'postprocess',
      parameters: { u_tint: { value: [0.25, 0.5, 0.75, 1] } },
      preview: { background: 'dark' },
    });
    expect(resolved.data?.provenance['parameters.u_tint']).toEqual({
      kind: 'material',
      id: 'base',
    });
    expect(resolved.data?.provenance['preview.background']).toEqual({
      kind: 'material',
      id: 'child',
    });

    project.materials.base.data = {
      kind: 'material',
      base: { kind: 'material', material: { $ref: { collection: 'materials', id: 'child' } } },
      parameters: {},
      textures: {},
    };
    expect(
      resolveMaterialData(project, 'child').diagnostics.some((item) =>
        item.message.includes('cycle'),
      ),
    ).toBe(true);
  });

  it('retains orphaned configuration diagnostically and separates engine-owned values', () => {
    const project = createAuthoringProject();
    project.materials.hotspot = {
      id: 'hotspot',
      label: 'Hotspot',
      data: {
        ...defaultMaterialData('Hotspot', 'hotspot-overlay-alpha'),
        parameters: {
          u_hotspotHovered: { value: true },
          old_uniform: { value: 1 },
        },
        textures: {
          s_hotspotImage: { source: { uri: 'project:/assets/images/noise.png' } },
          old_sampler: { source: { uri: 'project:/assets/images/noise.png' } },
        },
      },
    };

    const diagnostics = validateMaterialData(project, 'hotspot', project.materials.hotspot);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("Renderer-bound parameter 'u_hotspotHovered'"),
        }),
        expect.objectContaining({ message: expect.stringContaining("parameter 'old_uniform'") }),
        expect.objectContaining({
          message: expect.stringContaining("Renderer-bound texture 's_hotspotImage'"),
        }),
        expect.objectContaining({ message: expect.stringContaining("texture 'old_sampler'") }),
      ]),
    );
  });

  it('compiles custom source-backed Materials through derived program outputs and reflection', async () => {
    const project = createAuthoringProject();
    project.assets['noise-texture'] = imageAsset();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: {
        ...defaultMaterialData('Panel', 'engine-2d'),
        shader: {
          fragment: { kind: 'project', path: 'shaders/noise.fs.sc' },
        },
        parameters: {
          u_amount: { value: 0.75, editor: { label: 'Amount' } },
        },
        textures: {
          s_noise: {
            source: { $ref: { collection: 'assets', id: 'noise-texture' } },
            filtering: 'clamp-linear',
          },
        },
      },
    };

    const request = await buildShaderMaterialProject(project);
    const [program] = Object.keys(request.compilation.programs);
    expect(program).toBeDefined();
    expect(request.compilation.programs[program!]).toMatchObject({
      vertexSource: 'engine:/vs_quad.sc',
      fragmentSource: 'project:/shaders/noise.fs.sc',
      varyingDefinition: 'engine:/varying.def.sc',
    });

    const output = (
      stage: 'vertex' | 'fragment',
      reflectedInputs: ShaderCompileOutput['reflectedInputs'],
    ): ShaderCompileOutput => ({
      program: program!,
      programIdentity: 'program-identity',
      stage,
      variant: 'glsl-330',
      sourceIdentity: stage === 'vertex' ? 'engine:/vs_quad.sc' : 'project:/shaders/noise.fs.sc',
      dependencies: ['engine:/varying.def.sc'],
      dependencyRevisions: [
        { identity: 'engine:/varying.def.sc', contentHash: `sha256:${'c'.repeat(64)}` },
      ],
      outputPath: `/tmp/${stage}.bin`,
      runtimePath: `project:/shaders/derived/glsl-330/program-identity.${stage === 'vertex' ? 'vs' : 'fs'}.bin`,
      cacheKey: `${stage}-cache`,
      byteHash: `sha256:${stage === 'vertex' ? 'a' : 'b'.repeat(1)}`.replace(
        /:[ab]$/,
        `:${stage === 'vertex' ? 'a'.repeat(64) : 'b'.repeat(64)}`,
      ) as `sha256:${string}`,
      byteSize: 32,
      reflectedInputs,
      cacheHit: false,
    });
    const built = await buildShaderMaterialProject(project, [
      output('vertex', []),
      output('fragment', [
        { name: 'u_amount', kind: 'uniform', type: 'vec4', arraySize: 1 },
        { name: 's_noise', kind: 'sampled-image', type: 'sampler2D', arraySize: 1 },
      ]),
    ]);

    expect(built.project.materials.panel).toMatchObject({
      shader: program,
      uniforms: { u_amount: 0.75 },
      textures: {
        s_noise: { source: 'project:/assets/images/noise.png', sampler: 'clamp-linear' },
      },
    });
    expect(built.project.shaders[program!]).toMatchObject({
      uniforms: { u_amount: { type: 'vec4' } },
      samplers: { s_noise: { type: 'texture2d' } },
      stages: {
        fragment: {
          compiled: {
            'glsl-330': {
              runtimePath: 'project:/shaders/derived/glsl-330/program-identity.fs.bin',
            },
          },
        },
      },
    });
    expect(project.materials.panel.data).not.toHaveProperty('compiled');
  });
});
