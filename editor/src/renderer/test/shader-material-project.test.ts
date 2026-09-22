import { describe, expect, it } from 'vite-plus/test';
import type { ShaderCompileOutput } from '../../shared/editor-tooling';
import {
  defaultMaterialData,
  materialCanInheritFrom,
  materialDataWithBase,
  resolveMaterialData,
  validateMaterialData,
} from '../../shared/project-schema/authoring-materials';
import { materialPresets } from '../../shared/project-schema/authoring-material-presets';
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
      textures: {},
    });
    expect(built.project.shaders['preset-engine-2d']).toMatchObject({
      stages: {
        vertex: { compiled: expect.any(Object) },
        fragment: { compiled: expect.any(Object) },
      },
      roles: ['engine-2d'],
      samplers: { s_texColor: { type: 'texture2d', binding: null } },
    });
  });

  it('keeps postprocess source renderer-owned and does not publish Material-level scope', async () => {
    const project = createAuthoringProject();
    project.materials.grade = {
      id: 'grade',
      label: 'Grade',
      data: {
        ...defaultMaterialData('Grade', 'postprocess-tint'),
        textures: { s_texColor: { source: { uri: 'project:/assets/images/source.png' } } },
      },
    };

    const diagnostics = validateMaterialData(project, 'grade', project.materials.grade);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/materials/grade/data/textures/s_texColor/source',
          message: expect.stringContaining("Renderer-bound texture 's_texColor'"),
        }),
      ]),
    );

    project.materials.grade.data = defaultMaterialData('Grade', 'postprocess-tint');
    const built = await buildShaderMaterialProject(project);
    expect(built.diagnostics).toEqual([]);
    expect(built.project.materials.grade).toMatchObject({
      display_name: 'Grade',
      role: 'postprocess',
      shader: 'preset-postprocess-tint',
      textures: {},
    });
    expect(built.project.materials.grade).not.toHaveProperty('postprocess_scope');
    expect(built.project.shaders['preset-postprocess-tint']).toMatchObject({
      samplers: {
        s_texColor: { type: 'texture2d', binding: null },
      },
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

  it('preserves authored semantic values and editor metadata when changing Material base contracts', () => {
    const data = {
      ...defaultMaterialData('Tinted', 'postprocess-tint'),
      parameters: {
        u_tint: {
          value: [0.2, 0.3, 0.4, 1] as [number, number, number, number],
          editor: { label: 'Accent', control: 'color' as const },
        },
        legacy_amount: { value: 0.5, editor: { range: [0, 1] as [number, number] } },
      },
    };

    const changed = materialDataWithBase(data, { kind: 'preset', preset: 'engine-2d' });

    expect(changed.base).toEqual({ kind: 'preset', preset: 'engine-2d' });
    expect(changed.parameters).toEqual(data.parameters);
  });

  it('rejects descendant bases before they can create a Material inheritance cycle', () => {
    const project = createAuthoringProject();
    project.materials.base = {
      id: 'base',
      label: 'Base',
      data: defaultMaterialData('Base'),
    };
    project.materials.child = {
      id: 'child',
      label: 'Child',
      data: {
        ...defaultMaterialData('Child'),
        base: { kind: 'material', material: { $ref: { collection: 'materials', id: 'base' } } },
      },
    };
    project.materials.grandchild = {
      id: 'grandchild',
      label: 'Grandchild',
      data: {
        ...defaultMaterialData('Grandchild'),
        base: { kind: 'material', material: { $ref: { collection: 'materials', id: 'child' } } },
      },
    };

    expect(materialCanInheritFrom(project, 'base', 'child')).toBe(false);
    expect(materialCanInheritFrom(project, 'base', 'grandchild')).toBe(false);
    expect(materialCanInheritFrom(project, 'grandchild', 'base')).toBe(true);
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

  it('treats engine-stage overrides as custom source programs without Shader records', async () => {
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: {
        ...defaultMaterialData('Panel', 'engine-2d'),
        shader: { fragment: { kind: 'engine', path: 'engine:/fs_custom.sc' } },
      },
    };

    const built = await buildShaderMaterialProject(project);
    expect(Object.values(built.compilation.programs)).toContainEqual(
      expect.objectContaining({
        vertexSource: 'engine:/vs_quad.sc',
        fragmentSource: 'engine:/fs_custom.sc',
        interfaceContract: 'noveltea.material-preset:engine-2d:1',
        interfaceFingerprint: materialPresets['engine-2d'].interfaceFingerprint,
      }),
    );
    expect(built.project.materials.panel?.shader).toMatch(/^program-/u);
  });

  it('preserves explicit author-settable ownership for reflected custom inputs', async () => {
    const project = createAuthoringProject();
    project.materials.hotspot = {
      id: 'hotspot',
      label: 'Hotspot',
      data: {
        ...defaultMaterialData('Hotspot', 'hotspot-overlay-alpha'),
        shader: { fragment: { kind: 'project', path: 'shaders/hotspot.fs.sc' } },
        parameters: { u_time: { binding: null, value: 0.5 } },
      },
    };

    const source = await buildShaderMaterialProject(project);
    const [program] = Object.keys(source.compilation.programs);
    expect(program).toBeDefined();
    const output = (stage: 'vertex' | 'fragment'): ShaderCompileOutput => ({
      program: program!,
      programIdentity: 'program-identity',
      stage,
      variant: 'glsl-330',
      sourceIdentity: stage === 'vertex' ? 'engine:/vs_quad.sc' : 'project:/shaders/hotspot.fs.sc',
      dependencies: [],
      dependencyRevisions: [],
      outputPath: `/tmp/${stage}.bin`,
      runtimePath: `project:/shaders/derived/glsl-330/program-identity.${stage === 'vertex' ? 'vs' : 'fs'}.bin`,
      cacheKey: `${stage}-cache`,
      byteHash: `sha256:${stage === 'vertex' ? 'a'.repeat(64) : 'b'.repeat(64)}`,
      byteSize: 32,
      reflectedInputs:
        stage === 'fragment'
          ? [{ name: 'u_time', kind: 'uniform', type: 'vec4', arraySize: 1 }]
          : [{ name: 'u_modelViewProj', kind: 'uniform', type: 'mat4', arraySize: 1 }],
      cacheHit: false,
    });

    const built = await buildShaderMaterialProject(project, [output('vertex'), output('fragment')]);
    const shaderId = built.project.materials.hotspot?.shader;
    expect(shaderId).toBeDefined();
    expect(built.project.shaders[shaderId!]?.uniforms.u_time).toMatchObject({
      type: 'float',
      default: 0.5,
    });
    expect(built.project.shaders[shaderId!]?.uniforms.u_time).not.toHaveProperty('binding');
    expect(built.project.shaders[shaderId!]?.uniforms).not.toHaveProperty('u_modelViewProj');
    expect(built.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("'u_modelViewProj'") }),
      ]),
    );
    expect(built.project.materials.hotspot?.uniforms).toEqual({ u_time: 0.5 });
  });

  it('deduplicates custom program binaries without sharing Material-specific reflected metadata', async () => {
    const project = createAuthoringProject();
    const custom = {
      ...defaultMaterialData('Shared', 'engine-2d'),
      shader: { fragment: { kind: 'project' as const, path: 'shaders/shared.fs.sc' } },
    };
    project.materials.first = {
      id: 'first',
      label: 'First',
      data: {
        ...custom,
        displayName: 'First',
        parameters: { u_amount: { type: 'float', value: 0.25 } },
      },
    };
    project.materials.second = {
      id: 'second',
      label: 'Second',
      data: {
        ...custom,
        displayName: 'Second',
        parameters: {
          u_amount: { type: 'float', binding: 'engine.time' },
          old_uniform: { value: 1 },
        },
      },
    };

    const source = await buildShaderMaterialProject(project);
    const [program] = Object.keys(source.compilation.programs);
    expect(Object.keys(source.compilation.programs)).toHaveLength(1);
    const output = (stage: 'vertex' | 'fragment'): ShaderCompileOutput => ({
      program: program!,
      programIdentity: 'shared-program',
      stage,
      variant: 'glsl-330',
      sourceIdentity: stage === 'vertex' ? 'engine:/vs_quad.sc' : 'project:/shaders/shared.fs.sc',
      dependencies: [],
      dependencyRevisions: [],
      outputPath: `/tmp/shared.${stage}.bin`,
      runtimePath: `project:/shaders/derived/glsl-330/shared-program.${stage === 'vertex' ? 'vs' : 'fs'}.bin`,
      cacheKey: `${stage}-cache`,
      byteHash: `sha256:${stage === 'vertex' ? 'a'.repeat(64) : 'b'.repeat(64)}`,
      byteSize: 32,
      reflectedInputs:
        stage === 'fragment'
          ? [{ name: 'u_amount', kind: 'uniform', type: 'vec4', arraySize: 1 }]
          : [],
      cacheHit: false,
    });

    const built = await buildShaderMaterialProject(project, [output('vertex'), output('fragment')]);
    const firstShaderId = built.project.materials.first?.shader;
    const secondShaderId = built.project.materials.second?.shader;
    expect(firstShaderId).not.toBe(secondShaderId);
    expect(built.project.shaders[firstShaderId!]?.uniforms.u_amount).toMatchObject({
      default: 0.25,
    });
    expect(built.project.shaders[firstShaderId!]?.uniforms.u_amount).not.toHaveProperty('binding');
    expect(built.project.shaders[secondShaderId!]?.uniforms.u_amount).toMatchObject({
      binding: 'engine.time',
    });
    expect(built.project.shaders[secondShaderId!]?.uniforms.u_amount).not.toHaveProperty('default');
    expect(
      built.project.shaders[firstShaderId!]?.stages.fragment?.compiled?.['glsl-330']?.runtimePath,
    ).toBe(
      built.project.shaders[secondShaderId!]?.stages.fragment?.compiled?.['glsl-330']?.runtimePath,
    );
    expect(built.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/materials/second/data/parameters/old_uniform',
          message: expect.stringContaining("parameter 'old_uniform'"),
        }),
      ]),
    );
  });

  it('maps physical vec4 inputs to stable logical types and deterministic defaults', async () => {
    const project = createAuthoringProject();
    project.materials.base = {
      id: 'base',
      label: 'Base',
      data: {
        ...defaultMaterialData('Base', 'engine-2d'),
        shader: { fragment: { kind: 'project', path: 'shaders/logical.fs.sc' } },
        parameters: {
          u_float: { type: 'float' },
          u_vec2: { type: 'vec2' },
          u_vec3: { type: 'vec3' },
          u_color: { type: 'color' },
          u_int: { type: 'int' },
          u_bool: { type: 'bool' },
          u_time: { binding: 'engine.time' },
        },
      },
    };
    project.materials.child = {
      id: 'child',
      label: 'Child',
      data: {
        kind: 'material',
        base: { kind: 'material', material: { $ref: { collection: 'materials', id: 'base' } } },
        parameters: { u_float: { type: 'vec2' } },
        textures: {},
      },
    };

    expect(validateMaterialData(project, 'child', project.materials.child)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/materials/child/data/parameters/u_float/type',
          message: expect.stringContaining("cannot reinterpret inherited logical type 'float'"),
        }),
      ]),
    );

    const source = await buildShaderMaterialProject(project);
    const [program] = Object.keys(source.compilation.programs);
    expect(program).toBeDefined();
    const output = (stage: 'vertex' | 'fragment'): ShaderCompileOutput => ({
      program: program!,
      programIdentity: 'logical-program',
      stage,
      variant: 'glsl-330',
      sourceIdentity: stage === 'vertex' ? 'engine:/vs_quad.sc' : 'project:/shaders/logical.fs.sc',
      dependencies: [],
      dependencyRevisions: [],
      outputPath: `/tmp/logical.${stage}.bin`,
      runtimePath: `project:/shaders/derived/glsl-330/logical-program.${stage === 'vertex' ? 'vs' : 'fs'}.bin`,
      cacheKey: `${stage}-cache`,
      byteHash: `sha256:${stage === 'vertex' ? 'a'.repeat(64) : 'b'.repeat(64)}`,
      byteSize: 32,
      reflectedInputs:
        stage === 'fragment'
          ? ['u_float', 'u_vec2', 'u_vec3', 'u_vec4', 'u_color', 'u_int', 'u_bool', 'u_time'].map(
              (name) => ({ name, kind: 'uniform' as const, type: 'vec4', arraySize: 1 }),
            )
          : [],
      cacheHit: false,
    });
    const metalFragment = {
      ...output('fragment'),
      variant: 'metal',
      reflectedInputs: output('fragment').reflectedInputs.map((input, index) => ({
        ...input,
        registerIndex: index * 16,
        registerCount: 1,
      })),
    };
    const built = await buildShaderMaterialProject(project, [
      output('vertex'),
      output('fragment'),
      metalFragment,
    ]);
    expect(built.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('inconsistent declarations') }),
      ]),
    );
    const shaderId = built.project.materials.base?.shader;
    expect(built.project.shaders[shaderId!]?.uniforms).toMatchObject({
      u_float: { type: 'float', default: 0 },
      u_vec2: { type: 'vec2', default: [0, 0] },
      u_vec3: { type: 'vec3', default: [0, 0, 0] },
      u_vec4: { type: 'vec4', default: [0, 0, 0, 0] },
      u_color: { type: 'color', default: [0, 0, 0, 0] },
      u_int: { type: 'int', default: 0 },
      u_bool: { type: 'bool', default: false },
      u_time: { type: 'float', binding: 'engine.time' },
    });
    expect(built.project.shaders[shaderId!]?.uniforms.u_time).not.toHaveProperty('default');

    project.materials.base.data.parameters.u_int = { type: 'int', value: 16_777_217 };
    const invalidInt = await buildShaderMaterialProject(project, [
      output('vertex'),
      output('fragment'),
    ]);
    expect(invalidInt.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/materials/base/data/parameters/u_int/value',
          message: expect.stringContaining("logical shader type 'int'"),
        }),
      ]),
    );
  });

  it('adds built-in preset programs to certification requests only at certification boundaries', async () => {
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel', 'engine-2d'),
    };
    project.materials.decorator = {
      id: 'decorator',
      label: 'Decorator',
      data: defaultMaterialData('Decorator', 'rmlui-decorator'),
    };
    const ordinary = await buildShaderMaterialProject(project);
    expect(ordinary.compilation.programs).toEqual({});
    const certified = await buildShaderMaterialProject(project, [], {
      certifyPresetPrograms: true,
    });
    expect(certified.compilation.programs['preset-engine-2d']).toMatchObject({
      vertexSource: 'engine:/vs_quad.sc',
      fragmentSource: 'engine:/fs_quad.sc',
      varyingDefinition: 'engine:/varying.def.sc',
      interfaceContract: 'noveltea.material-preset:engine-2d:1',
      interfaceFingerprint: materialPresets['engine-2d'].interfaceFingerprint,
    });
    expect(certified.compilation.programs['preset-rmlui-decorator']).toMatchObject({
      interfaceContract: 'noveltea.material-preset:rmlui-decorator:1',
      interfaceFingerprint: materialPresets['rmlui-decorator'].interfaceFingerprint,
    });
  });

  it('uses the RmlUi decorator ABI for custom decorator compilation', async () => {
    const project = createAuthoringProject();
    project.materials.decorator = {
      id: 'decorator',
      label: 'Decorator',
      data: {
        ...defaultMaterialData('Decorator', 'rmlui-decorator'),
        shader: { fragment: { kind: 'project', path: 'shaders/decorator.fs.sc' } },
      },
    };

    const request = await buildShaderMaterialProject(project);
    const programs = Object.values(request.compilation.programs);
    expect(programs).toHaveLength(1);
    expect(programs[0]).toMatchObject({
      interfaceContract: 'noveltea.material-preset:rmlui-decorator:1',
      interfaceFingerprint: materialPresets['rmlui-decorator'].interfaceFingerprint,
    });
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
          u_amount: { type: 'float', value: 0.75, editor: { label: 'Amount' } },
        },
        textures: {
          s_noise: {
            source: { $ref: { collection: 'assets', id: 'noise-texture' } },
            filtering: 'clamp-linear',
          },
        },
      },
    };

    expect(validateMaterialData(project, 'panel', project.materials.panel)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("parameter 'u_amount'") }),
      ]),
    );

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
        {
          name: 's_texColor',
          kind: 'sampled-image',
          type: 'sampler2D',
          arraySize: 1,
          registerIndex: 0,
          registerCount: 1,
        },
        {
          name: 's_noise',
          kind: 'sampled-image',
          type: 'sampler2D',
          arraySize: 1,
          registerIndex: 3,
          registerCount: 1,
        },
      ]),
    ]);

    const shaderId = built.project.materials.panel?.shader;
    expect(shaderId).toMatch(new RegExp(`^${program}-material-panel$`, 'u'));
    expect(built.project.materials.panel).toMatchObject({
      shader: shaderId,
      uniforms: { u_amount: 0.75 },
      textures: {
        s_noise: { source: 'project:/assets/images/noise.png', sampler: 'clamp-linear' },
      },
    });
    expect(built.project.shaders[shaderId!]).toMatchObject({
      interface_contract: materialPresets['engine-2d'].interfaceContract,
      interface_fingerprint: materialPresets['engine-2d'].interfaceFingerprint,
      uniforms: { u_amount: { type: 'float' } },
      samplers: {
        s_texColor: { type: 'texture2d', stage: 0 },
        s_noise: { type: 'texture2d', stage: 3 },
      },
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
    expect(built.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("parameter 'u_useTexture'") }),
        expect.objectContaining({ message: expect.stringContaining("texture 's_texColor'") }),
      ]),
    );
    expect(project.materials.panel.data).not.toHaveProperty('compiled');

    project.materials.panel.data.parameters.u_amount = {
      type: 'float',
      value: [1, 1, 1, 1],
    };
    const incompatible = await buildShaderMaterialProject(project, [
      output('vertex', []),
      output('fragment', [{ name: 'u_amount', kind: 'uniform', type: 'vec4', arraySize: 1 }]),
    ]);
    expect(incompatible.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("does not match logical shader type 'float'"),
        }),
      ]),
    );
    expect(incompatible.project.materials.panel?.uniforms).not.toHaveProperty('u_amount');
  });
});
