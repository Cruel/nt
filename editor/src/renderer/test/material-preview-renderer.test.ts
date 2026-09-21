import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import {
  MaterialPreviewProjectResources,
  type MaterialPreviewResourceDependencies,
} from '@/material-preview/material-preview-resources';
import {
  createWebGlMaterialPreviewBackend,
  MaterialPreviewGroupRenderer,
  MaterialPreviewShaderProgramError,
  type MaterialPreviewBackend,
  type MaterialPreviewBackendFactoryOptions,
  type MaterialPreviewScheduler,
  type MaterialPreviewSurfaceState,
} from '@/material-preview/material-preview-renderer';

function materialProject() {
  const project = createAuthoringProject();
  project.materials.panel = {
    id: 'panel',
    label: 'Panel',
    data: defaultMaterialData('Panel'),
  };
  return project;
}

function createResources(overrides: Partial<MaterialPreviewResourceDependencies> = {}) {
  return new MaterialPreviewProjectResources({
    compileShaders: vi.fn().mockResolvedValue([]),
    resolveAssetUrl: vi.fn().mockResolvedValue(null),
    decodeImage: vi.fn().mockResolvedValue(null),
    ...overrides,
  });
}

function surface(materialId: string, visible = true): MaterialPreviewSurfaceState {
  return {
    canvas: document.createElement('canvas'),
    materialId,
    width: 160,
    height: 90,
    visible,
    pointer: { x: 4, y: 8, pressed: false },
  };
}

function manualScheduler() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const scheduler: MaterialPreviewScheduler = {
    request: vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    }),
    cancel: vi.fn((id: number) => callbacks.delete(id)),
  };
  return {
    scheduler,
    flush(timestamp = 1000) {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of pending) callback(timestamp);
    },
    get pending() {
      return callbacks.size;
    },
  };
}

function fakeWebGlContext() {
  const uniforms = [
    { name: 'u_time', type: 0x8b52 },
    { name: 'u_useTexture', type: 0x8b52 },
    { name: 'u_modelViewProj', type: 0x8b5c },
  ];
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ACTIVE_UNIFORMS: 0x8b86,
    FLOAT: 0x1406,
    FLOAT_VEC2: 0x8b50,
    FLOAT_VEC3: 0x8b51,
    FLOAT_VEC4: 0x8b52,
    FLOAT_MAT4: 0x8b5c,
    INT: 0x1404,
    BOOL: 0x8b56,
    SAMPLER_2D: 0x8b5e,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    LINEAR: 0x2601,
    REPEAT: 0x2901,
    CLAMP_TO_EDGE: 0x812f,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    COLOR_BUFFER_BIT: 0x4000,
    BLEND: 0x0be2,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TRIANGLE_STRIP: 5,
    createShader: vi.fn(() => ({ source: '' })),
    shaderSource: vi.fn((shader: { source: string }, source: string) => {
      shader.source = source;
    }),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn((shader: { source: string }) => !shader.source.includes('BROKEN')),
    getShaderInfoLog: vi.fn(() => 'broken preview shader'),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn((_program: object, parameter: number) =>
      parameter === 0x8b82 ? true : parameter === 0x8b86 ? uniforms.length : 0,
    ),
    getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(),
    getActiveUniform: vi.fn((_program: object, index: number) =>
      uniforms[index] ? { ...uniforms[index], size: 1 } : null,
    ),
    getUniformLocation: vi.fn((_program: object, name: string) => ({ name })),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform2fv: vi.fn(),
    uniform3fv: vi.fn(),
    uniform4fv: vi.fn(),
    uniformMatrix4fv: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn((_program: object, name: string) =>
      name === 'a_position' ? 0 : name === 'a_texcoord0' ? 1 : name === 'a_color0' ? 2 : -1,
    ),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    createTexture: vi.fn(() => ({})),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    useProgram: vi.fn(),
    enable: vi.fn(),
    blendFunc: vi.fn(),
    drawArrays: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteTexture: vi.fn(),
    getExtension: vi.fn(() => null),
  };
  return gl;
}

function fakeBackendFactory() {
  const renders: Array<{
    surface: MaterialPreviewSurfaceState;
    resourcePreview: { geometry: string; background: string };
    time: number;
  }> = [];
  const backends: MaterialPreviewBackend[] = [];
  const callbacks: MaterialPreviewBackendFactoryOptions[] = [];
  const factory = vi.fn((options: MaterialPreviewBackendFactoryOptions): MaterialPreviewBackend => {
    callbacks.push(options);
    const backend: MaterialPreviewBackend = {
      render: vi.fn((nextSurface, resource, time) =>
        renders.push({
          surface: nextSurface,
          resourcePreview: resource.resolved.preview,
          time,
        }),
      ),
      invalidateProjectResources: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    };
    backends.push(backend);
    return backend;
  });
  return { factory, backends, callbacks, renders };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Material preview Project resources', () => {
  it('shares resolved Material work across group renderers and invalidates on Project generation changes', async () => {
    const compileShaders = vi.fn().mockResolvedValue([]);
    const resources = createResources({ compileShaders });
    const firstProject = materialProject();
    resources.updateProject(firstProject);

    const first = resources.getMaterial('panel');
    const second = resources.getMaterial('panel');
    expect(second).toBe(first);
    expect((await first)?.resolved.preview.geometry).toBe('quad');
    expect(compileShaders).not.toHaveBeenCalled();

    const nextProject = structuredClone(firstProject);
    nextProject.materials.panel!.data = {
      ...defaultMaterialData('Panel'),
      preview: { geometry: 'rounded-rect', background: 'dark' },
    };
    resources.updateProject(nextProject);
    const changed = await resources.getMaterial('panel');
    expect(changed?.resolved.preview).toEqual({ geometry: 'rounded-rect', background: 'dark' });
  });

  it('keeps preview resources stable when only the Project object identity changes under the same semantic authority', async () => {
    const project = materialProject();
    const resources = createResources();
    resources.updateProject(project, 'project-instance:7|shader-revisions');
    const firstGeneration = resources.generation;
    const first = resources.getMaterial('panel');

    const metadataOnlyReplacement = structuredClone(project);
    resources.updateProject(metadataOnlyReplacement, 'project-instance:7|shader-revisions');

    expect(resources.generation).toBe(firstGeneration);
    expect(resources.getMaterial('panel')).toBe(first);
    await expect(first).resolves.not.toBeNull();
  });

  it('invalidates the Project snapshot when shader-source authority advances without replacing the Project object', async () => {
    const project = materialProject();
    const resources = createResources();
    resources.updateProject(project, 'session|shaders/panel.sc:sha256:first');

    const first = resources.getMaterial('panel');
    await first;
    resources.updateProject(project, 'session|shaders/panel.sc:sha256:second');
    const second = resources.getMaterial('panel');

    expect(second).not.toBe(first);
    expect(resources.generation).toBe(2);
  });

  it('builds and compiles one shared Project snapshot for multiple custom Material previews', async () => {
    const project = materialProject();
    const custom = {
      ...defaultMaterialData('Custom'),
      shader: { fragment: { kind: 'project' as const, path: 'shaders/custom.sc' } },
    };
    project.materials.panel!.data = custom;
    project.materials.badge = {
      id: 'badge',
      label: 'Badge',
      data: { ...custom, displayName: 'Badge' },
    };
    const compileShaders = vi.fn().mockResolvedValue([]);
    const resources = createResources({ compileShaders });
    resources.updateProject(project, 'session|shaders/custom.sc:sha256:first');

    await Promise.all([resources.getMaterial('panel'), resources.getMaterial('badge')]);

    expect(compileShaders).toHaveBeenCalledTimes(1);
  });

  it('compiles only the ordinary Material preview that is actually requested', async () => {
    const project = materialProject();
    project.materials.panel!.data = {
      ...defaultMaterialData('Panel'),
      shader: { fragment: { kind: 'project' as const, path: 'shaders/panel.sc' } },
    };
    project.materials.badge = {
      id: 'badge',
      label: 'Badge',
      data: {
        ...defaultMaterialData('Badge'),
        shader: { fragment: { kind: 'project' as const, path: 'shaders/badge.sc' } },
      },
    };
    const compileShaders = vi.fn().mockResolvedValue([]);
    const resources = createResources({ compileShaders });
    resources.updateProject(project, 'session|persisted');

    await resources.getMaterial('panel');

    expect(compileShaders).toHaveBeenCalledTimes(1);
    const [compilation] = compileShaders.mock.calls[0]!;
    expect(
      Object.values(
        (compilation as { programs: Record<string, { fragmentSource: string }> }).programs,
      ),
    ).toEqual([expect.objectContaining({ fragmentSource: 'project:/shaders/panel.sc' })]);
  });

  it('limits source-workspace compilation to programs required by attached Material previews', async () => {
    const project = materialProject();
    project.materials.panel!.data = {
      ...defaultMaterialData('Panel'),
      shader: { fragment: { kind: 'project' as const, path: 'shaders/panel.sc' } },
    };
    project.materials.badge = {
      id: 'badge',
      label: 'Badge',
      data: {
        ...defaultMaterialData('Badge'),
        shader: { fragment: { kind: 'project' as const, path: 'shaders/badge.sc' } },
      },
    };
    const compileShaders = vi.fn().mockResolvedValue([]);
    const resources = createResources({ compileShaders });
    resources.updateProject(project, 'source-tab:panel', {
      materialIds: ['panel'],
      sourceOverlays: { 'shaders/panel.sc': 'unsaved panel source' },
    });

    await resources.getMaterial('panel');

    const [compilation, options] = compileShaders.mock.calls[0]!;
    expect(
      Object.values(
        (compilation as { programs: Record<string, { fragmentSource: string }> }).programs,
      ),
    ).toHaveLength(1);
    expect(
      Object.values(
        (compilation as { programs: Record<string, { fragmentSource: string }> }).programs,
      )[0]?.fragmentSource,
    ).toBe('project:/shaders/panel.sc');
    expect(options).toEqual({ sourceOverlays: { 'shaders/panel.sc': 'unsaved panel source' } });
  });

  it('turns thrown preview compiler failures into diagnostics instead of rejected Material loads', async () => {
    const project = materialProject();
    project.materials.panel!.data = {
      ...defaultMaterialData('Panel'),
      shader: { fragment: { kind: 'project' as const, path: 'shaders/panel.sc' } },
    };
    const resources = createResources({
      compileShaders: vi
        .fn()
        .mockRejectedValue(new Error('Shader preview compilation was cancelled.')),
    });
    resources.updateProject(project, 'source-tab:cancelled', { materialIds: ['panel'] });

    const material = await resources.getMaterial('panel');

    expect(material?.compileDiagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: 'Shader preview compilation was cancelled.',
      }),
    ]);
  });

  it('retains the last successful browser program and marks it stale after a live compile failure', async () => {
    const project = materialProject();
    project.materials.panel!.data = {
      ...defaultMaterialData('Panel'),
      shader: { fragment: { kind: 'project' as const, path: 'shaders/panel.sc' } },
    };
    let fail = false;
    const compileShaders = vi.fn().mockImplementation(async (compilation: unknown) => {
      const program = Object.keys(
        (compilation as { programs: Record<string, unknown> }).programs,
      )[0]!;
      if (fail)
        return {
          success: false,
          outputs: [],
          diagnostics: [{ severity: 'error' as const, message: 'broken shader' }],
        };
      return {
        success: true,
        diagnostics: [],
        outputs: [
          {
            program,
            programIdentity: 'program:first',
            stage: 'fragment' as const,
            variant: 'essl-300',
            sourceIdentity: 'project:/shaders/panel.sc',
            dependencies: [],
            dependencyRevisions: [],
            outputPath: '/tmp/panel.bin',
            runtimePath: 'shaders/panel.bin',
            cacheKey: 'first',
            byteHash: `sha256:${'a'.repeat(64)}` as const,
            byteSize: 16,
            reflectedInputs: [],
            browserPayload: '#version 300 es\nvoid main() {}',
            cacheHit: false,
          },
        ],
      };
    });
    const resources = createResources({ compileShaders });
    resources.updateProject(project, 'source-tab:first', { materialIds: ['panel'] });
    const first = await resources.getMaterial('panel');
    expect(first?.stale).toBe(false);
    expect(first?.fragmentShaderSource).toContain('void main');

    fail = true;
    resources.updateProject(project, 'source-tab:broken', { materialIds: ['panel'] });
    const broken = await resources.getMaterial('panel');

    expect(broken?.stale).toBe(true);
    expect(broken?.fragmentShaderSource).toBe(first?.fragmentShaderSource);
    expect(broken?.compileDiagnostics).toEqual([
      expect.objectContaining({ severity: 'error', message: 'broken shader' }),
    ]);
  });

  it('decodes one Project texture once when multiple Materials share it', async () => {
    const project = materialProject();
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/logo.png' },
        aliases: ['ui.logo'],
        imageMetadata: { width: 32, height: 32, hasAlpha: true, orientation: 1 },
      },
    };
    project.materials.panel!.data = {
      ...defaultMaterialData('Panel'),
      textures: {
        s_texColor: { source: { $ref: { collection: 'assets', id: 'logo' } } },
      },
    };
    project.materials.badge = {
      id: 'badge',
      label: 'Badge',
      data: {
        ...defaultMaterialData('Badge'),
        textures: { s_texColor: { source: { alias: 'ui.logo' } } },
      },
    };
    const image = document.createElement('img');
    const resolveAssetUrl = vi.fn().mockResolvedValue('noveltea://asset/logo');
    const decodeImage = vi.fn().mockResolvedValue(image);
    const resources = createResources({ resolveAssetUrl, decodeImage });
    resources.updateProject(project);

    const [panel, badge] = await Promise.all([
      resources.getMaterial('panel'),
      resources.getMaterial('badge'),
    ]);

    expect(resolveAssetUrl).toHaveBeenCalledTimes(1);
    expect(decodeImage).toHaveBeenCalledTimes(1);
    expect(panel?.textures.s_texColor?.image).toBe(image);
    expect(badge?.textures.s_texColor?.image).toBe(image);
  });
});

describe('Material preview workbench-group renderer', () => {
  it('supplies the compiled quad interface with vertex color, transform, and correctly typed vec4 engine uniforms', async () => {
    const gl = fakeWebGlContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (type) {
      return type === 'webgl2' ? (gl as unknown as WebGL2RenderingContext) : null;
    } as typeof HTMLCanvasElement.prototype.getContext);
    const backend = createWebGlMaterialPreviewBackend({
      onContextLost: vi.fn(),
      onContextRestored: vi.fn(),
    });
    expect(backend).not.toBeNull();
    const resources = createResources();
    resources.updateProject(materialProject());
    const base = await resources.getMaterial('panel');
    expect(base).not.toBeNull();
    const resource = {
      ...base!,
      vertexShaderSource: '#version 300 es\nvoid main() {}',
      fragmentShaderSource: '#version 300 es\nvoid main() {}',
    };

    backend!.render(surface('panel'), resource, 2.5);

    expect(gl.getAttribLocation).toHaveBeenCalledWith(expect.anything(), 'a_color0');
    expect(gl.vertexAttribPointer).toHaveBeenCalledWith(2, 4, gl.FLOAT, false, 0, 0);
    expect(gl.uniformMatrix4fv).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'u_modelViewProj' }),
      false,
      expect.any(Float32Array),
    );
    expect(gl.uniform4fv).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'u_time' }),
      [2.5, 0, 0, 0],
    );
    expect(gl.uniform4fv).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'u_useTexture' }),
      [1, 0, 0, 0],
    );
  });

  it('normalizes native essl-300 browser payloads into valid WebGL2 shader sources', async () => {
    const gl = fakeWebGlContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (type) {
      return type === 'webgl2' ? (gl as unknown as WebGL2RenderingContext) : null;
    } as typeof HTMLCanvasElement.prototype.getContext);
    const backend = createWebGlMaterialPreviewBackend({
      onContextLost: vi.fn(),
      onContextRestored: vi.fn(),
    });
    const resources = createResources();
    resources.updateProject(materialProject());
    const base = await resources.getMaterial('panel');
    const compiled = {
      ...base!,
      vertexShaderSource:
        '\nuniform mat4 u_modelViewProj;\nlayout(location = 1) in vec2 a_position;\nvoid main() {}',
      fragmentShaderSource:
        'precision mediump float;\nlayout(location = 0) out vec4 bgfx_FragColor;\nvoid main() {}',
    };

    backend!.render(surface('panel'), compiled, 0);

    expect(vi.mocked(gl.shaderSource).mock.calls.map(([, source]) => source)).toEqual([
      expect.stringMatching(/^#version 300 es\n/u),
      expect.stringMatching(/^#version 300 es\n/u),
    ]);
  });

  it('reports an initial WebGL shader failure without rendering an unrelated fallback', async () => {
    const gl = fakeWebGlContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (type) {
      return type === 'webgl2' ? (gl as unknown as WebGL2RenderingContext) : null;
    } as typeof HTMLCanvasElement.prototype.getContext);
    const backend = createWebGlMaterialPreviewBackend({
      onContextLost: vi.fn(),
      onContextRestored: vi.fn(),
    });
    const resources = createResources();
    resources.updateProject(materialProject());
    const base = await resources.getMaterial('panel');
    const broken = {
      ...base!,
      vertexShaderSource: '#version 300 es\nvoid main() {}',
      fragmentShaderSource: 'BROKEN',
    };

    expect(() => backend!.render(surface('panel'), broken, 0)).toThrow('broken preview shader');
    expect(gl.drawArrays).not.toHaveBeenCalled();
  });

  it('renders the last good WebGL program on a shader failure and reports the actual compile error', async () => {
    const gl = fakeWebGlContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (type) {
      return type === 'webgl2' ? (gl as unknown as WebGL2RenderingContext) : null;
    } as typeof HTMLCanvasElement.prototype.getContext);
    const backend = createWebGlMaterialPreviewBackend({
      onContextLost: vi.fn(),
      onContextRestored: vi.fn(),
    });
    const resources = createResources();
    resources.updateProject(materialProject());
    const base = await resources.getMaterial('panel');
    const valid = {
      ...base!,
      vertexShaderSource: '#version 300 es\nvoid main() {}',
      fragmentShaderSource: '#version 300 es\nvoid main() {}',
    };
    backend!.render(surface('panel'), valid, 0);
    const broken = { ...valid, fragmentShaderSource: 'BROKEN' };

    expect(() => backend!.render(surface('panel'), broken, 1)).toThrow('broken preview shader');
    const compileCountAfterFailure = vi.mocked(gl.compileShader).mock.calls.length;
    expect(() => backend!.render(surface('panel'), broken, 2)).toThrow('broken preview shader');
    expect(gl.drawArrays).toHaveBeenCalledTimes(3);
    expect(gl.createProgram).toHaveBeenCalledTimes(1);
    expect(gl.compileShader).toHaveBeenCalledTimes(compileCountAfterFailure);
  });

  it('preserves the last-good WebGL program across ordinary Project resource invalidation', async () => {
    const gl = fakeWebGlContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (type) {
      return type === 'webgl2' ? (gl as unknown as WebGL2RenderingContext) : null;
    } as typeof HTMLCanvasElement.prototype.getContext);
    const backend = createWebGlMaterialPreviewBackend({
      onContextLost: vi.fn(),
      onContextRestored: vi.fn(),
    });
    const resources = createResources();
    resources.updateProject(materialProject());
    const base = await resources.getMaterial('panel');
    const valid = {
      ...base!,
      vertexShaderSource: '#version 300 es\nvoid main() {}',
      fragmentShaderSource: '#version 300 es\nvoid main() {}',
    };
    backend!.render(surface('panel'), valid, 0);

    backend!.invalidateProjectResources();
    const broken = { ...valid, fragmentShaderSource: 'BROKEN' };

    expect(() => backend!.render(surface('panel'), broken, 1)).toThrow('broken preview shader');
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    expect(gl.deleteProgram).not.toHaveBeenCalled();
  });

  it('selects cached shader-failure fallbacks independently for each Material', async () => {
    const gl = fakeWebGlContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (type) {
      return type === 'webgl2' ? (gl as unknown as WebGL2RenderingContext) : null;
    } as typeof HTMLCanvasElement.prototype.getContext);
    const backend = createWebGlMaterialPreviewBackend({
      onContextLost: vi.fn(),
      onContextRestored: vi.fn(),
    });
    const resources = createResources();
    resources.updateProject(materialProject());
    const base = await resources.getMaterial('panel');
    const first = {
      ...base!,
      materialId: 'first',
      vertexShaderSource: '#version 300 es\n// first vertex\nvoid main() {}',
      fragmentShaderSource: '#version 300 es\n// first fragment\nvoid main() {}',
    };
    const second = {
      ...base!,
      materialId: 'second',
      vertexShaderSource: '#version 300 es\n// second vertex\nvoid main() {}',
      fragmentShaderSource: '#version 300 es\n// second fragment\nvoid main() {}',
    };
    backend!.render(surface('first'), first, 0);
    backend!.render(surface('second'), second, 0);
    const firstProgram = vi.mocked(gl.useProgram).mock.calls[0]?.[0];
    const secondProgram = vi.mocked(gl.useProgram).mock.calls[1]?.[0];
    expect(firstProgram).not.toBe(secondProgram);

    const brokenVertex = '#version 300 es\n// shared broken request\nvoid main() {}';
    const brokenFirst = {
      ...first,
      vertexShaderSource: brokenVertex,
      fragmentShaderSource: 'BROKEN shared failure',
    };
    const brokenSecond = {
      ...second,
      vertexShaderSource: brokenVertex,
      fragmentShaderSource: 'BROKEN shared failure',
    };
    expect(() => backend!.render(surface('first'), brokenFirst, 1)).toThrow(
      'broken preview shader',
    );
    expect(() => backend!.render(surface('second'), brokenSecond, 1)).toThrow(
      'broken preview shader',
    );

    expect(vi.mocked(gl.useProgram).mock.calls[2]?.[0]).toBe(firstProgram);
    expect(vi.mocked(gl.useProgram).mock.calls[3]?.[0]).toBe(secondProgram);
  });

  it('uses one backend and one scheduler for multiple surfaces while preserving independent surface state', async () => {
    const resources = createResources();
    resources.updateProject(materialProject());
    await resources.getMaterial('panel');
    const clock = manualScheduler();
    const backend = fakeBackendFactory();
    const renderer = new MaterialPreviewGroupRenderer(resources, backend.factory, clock.scheduler);

    const first = {
      ...surface('panel'),
      parameterOverrides: { u_tint: [0.2, 0.3, 0.4, 1] as [number, number, number, number] },
    };
    const second = { ...surface('panel'), width: 320, pointer: { x: 20, y: 30, pressed: true } };
    renderer.registerSurface(first);
    renderer.registerSurface(second);
    await Promise.resolve();
    await Promise.resolve();

    expect(backend.factory).toHaveBeenCalledTimes(1);
    expect(clock.pending).toBe(1);
    clock.flush(2500);
    expect(backend.renders).toHaveLength(2);
    expect(backend.renders.map((entry) => entry.time)).toEqual([2.5, 2.5]);
    expect(backend.renders[0]?.surface.width).toBe(160);
    expect(backend.renders[0]?.surface.parameterOverrides).toEqual({
      u_tint: [0.2, 0.3, 0.4, 1],
    });
    expect(backend.renders[1]?.surface.parameterOverrides).toBeUndefined();
    expect(backend.renders[1]?.surface.width).toBe(320);
    expect(backend.renders[1]?.surface.pointer.pressed).toBe(true);
    renderer.dispose();
  });

  it('passes effective preview geometry and background metadata to the representative harness', async () => {
    const project = materialProject();
    project.materials.panel!.data = {
      ...defaultMaterialData('Panel'),
      preview: { geometry: 'glyphs', background: 'light' },
    };
    const resources = createResources();
    resources.updateProject(project);
    await resources.getMaterial('panel');
    const clock = manualScheduler();
    const backend = fakeBackendFactory();
    const renderer = new MaterialPreviewGroupRenderer(resources, backend.factory, clock.scheduler);

    renderer.registerSurface(surface('panel'));
    await Promise.resolve();
    await Promise.resolve();
    clock.flush();

    expect(backend.renders[0]?.resourcePreview).toEqual({
      geometry: 'glyphs',
      background: 'light',
    });
    renderer.dispose();
  });

  it('keeps side-by-side groups independent while reusing the same Project resources', async () => {
    const resources = createResources();
    resources.updateProject(materialProject());
    const firstBackend = fakeBackendFactory();
    const secondBackend = fakeBackendFactory();
    const firstClock = manualScheduler();
    const secondClock = manualScheduler();
    const first = new MaterialPreviewGroupRenderer(
      resources,
      firstBackend.factory,
      firstClock.scheduler,
    );
    const second = new MaterialPreviewGroupRenderer(
      resources,
      secondBackend.factory,
      secondClock.scheduler,
    );

    first.registerSurface(surface('panel'));
    second.registerSurface(surface('panel'));
    await Promise.resolve();
    await Promise.resolve();

    expect(firstBackend.factory).toHaveBeenCalledTimes(1);
    expect(secondBackend.factory).toHaveBeenCalledTimes(1);
    expect(resources.getMaterial('panel')).toBe(resources.getMaterial('panel'));
    first.dispose();
    second.dispose();
  });

  it('does not compile or schedule hidden-only surfaces and resumes when one becomes visible', async () => {
    const project = materialProject();
    project.materials.panel!.data = {
      ...defaultMaterialData('Panel'),
      shader: { fragment: { kind: 'project', path: 'shaders/panel.sc' } },
    };
    const compileShaders = vi.fn().mockResolvedValue([]);
    const resources = createResources({ compileShaders });
    resources.updateProject(project);
    const clock = manualScheduler();
    const backend = fakeBackendFactory();
    const renderer = new MaterialPreviewGroupRenderer(resources, backend.factory, clock.scheduler);
    const registration = renderer.registerSurface(surface('panel', false));
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.pending).toBe(0);
    expect(compileShaders).not.toHaveBeenCalled();

    registration.update(surface('panel', true));
    expect(clock.pending).toBe(1);
    await vi.waitFor(() => expect(compileShaders).toHaveBeenCalledTimes(1));
    renderer.dispose();
  });

  it('keeps shader failure state isolated per preview surface', async () => {
    const resources = createResources();
    resources.updateProject(materialProject());
    await resources.getMaterial('panel');
    const clock = manualScheduler();
    const backend: MaterialPreviewBackend = {
      render: vi.fn((nextSurface) => {
        if (nextSurface.width === 160)
          throw new MaterialPreviewShaderProgramError(true, 'panel compile failed');
      }),
      invalidateProjectResources: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    };
    const renderer = new MaterialPreviewGroupRenderer(resources, () => backend, clock.scheduler);
    const firstStatus = vi.fn();
    const secondStatus = vi.fn();
    renderer.registerSurface({ ...surface('panel'), onShaderProgramStatus: firstStatus });
    renderer.registerSurface({
      ...surface('panel'),
      width: 320,
      onShaderProgramStatus: secondStatus,
    });
    await Promise.resolve();
    await Promise.resolve();
    clock.flush();

    expect(firstStatus).toHaveBeenCalledWith({ stale: true, message: 'panel compile failed' });
    expect(secondStatus).toHaveBeenCalledWith({ stale: false, message: null });
    expect(renderer.status).toEqual({ available: true, code: null, message: null });
    renderer.dispose();
  });

  it('invalidates Project GPU resources without clearing retained shader programs', () => {
    const resources = createResources();
    resources.updateProject(materialProject());
    const clock = manualScheduler();
    const backend = fakeBackendFactory();
    const renderer = new MaterialPreviewGroupRenderer(resources, backend.factory, clock.scheduler);
    renderer.registerSurface(surface('panel'));

    renderer.invalidateProjectResources();

    expect(backend.backends[0]?.invalidateProjectResources).toHaveBeenCalledTimes(1);
    expect(backend.backends[0]?.reset).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('does not publish context-loss status when disposal intentionally releases WebGL', () => {
    const resources = createResources();
    resources.updateProject(materialProject());
    const clock = manualScheduler();
    let onContextLost: (() => void) | null = null;
    const renderer = new MaterialPreviewGroupRenderer(
      resources,
      (options) => {
        onContextLost = options.onContextLost;
        return {
          render: vi.fn(),
          invalidateProjectResources: vi.fn(),
          reset: vi.fn(),
          dispose: vi.fn(() => onContextLost?.()),
        };
      },
      clock.scheduler,
    );
    const listener = vi.fn();
    renderer.subscribe(listener);
    renderer.registerSurface(surface('panel'));

    renderer.dispose();

    expect(renderer.status).toEqual({ available: true, code: null, message: null });
    expect(listener).not.toHaveBeenCalled();
  });

  it('centralizes context-loss status and recovers the existing group renderer', () => {
    const resources = createResources();
    resources.updateProject(materialProject());
    const clock = manualScheduler();
    const backend = fakeBackendFactory();
    const renderer = new MaterialPreviewGroupRenderer(resources, backend.factory, clock.scheduler);
    const listener = vi.fn();
    renderer.subscribe(listener);
    renderer.registerSurface(surface('panel'));

    backend.callbacks[0]!.onContextLost();
    expect(renderer.status).toEqual({
      available: false,
      code: 'material-preview.context-lost',
      message: 'Material preview is temporarily unavailable.',
    });
    backend.callbacks[0]!.onContextRestored();
    expect(renderer.status).toEqual({ available: true, code: null, message: null });
    expect(backend.factory).toHaveBeenCalledTimes(1);
    expect(backend.backends[0]?.reset).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it('keeps one renderer and one scheduled frame for a representative many-preview workload', async () => {
    const resources = createResources();
    resources.updateProject(materialProject());
    await resources.getMaterial('panel');
    const clock = manualScheduler();
    const backend = fakeBackendFactory();
    const renderer = new MaterialPreviewGroupRenderer(resources, backend.factory, clock.scheduler);

    for (let index = 0; index < 64; index += 1) {
      const next = surface('panel');
      next.width += index;
      renderer.registerSurface(next);
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(backend.factory).toHaveBeenCalledTimes(1);
    expect(clock.pending).toBe(1);
    clock.flush(1000);
    expect(backend.renders).toHaveLength(64);
    expect(clock.pending).toBe(1);
    renderer.dispose();
  });

  it('reports stable WebGL2 unavailability without scheduling any preview work', () => {
    const resources = createResources();
    resources.updateProject(materialProject());
    const clock = manualScheduler();
    const renderer = new MaterialPreviewGroupRenderer(resources, () => null, clock.scheduler);
    renderer.registerSurface(surface('panel'));

    expect(renderer.status).toEqual({
      available: false,
      code: 'material-preview.webgl2-unavailable',
      message: 'Material preview requires WebGL2.',
    });
    expect(clock.pending).toBe(0);
    renderer.dispose();
  });
});
