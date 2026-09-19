import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import {
  MaterialPreviewProjectResources,
  type MaterialPreviewResourceDependencies,
} from '@/material-preview/material-preview-resources';
import {
  MaterialPreviewGroupRenderer,
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

  it('does not schedule hidden-only surfaces and resumes when one becomes visible', async () => {
    const resources = createResources();
    resources.updateProject(materialProject());
    const clock = manualScheduler();
    const backend = fakeBackendFactory();
    const renderer = new MaterialPreviewGroupRenderer(resources, backend.factory, clock.scheduler);
    const registration = renderer.registerSurface(surface('panel', false));
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.pending).toBe(0);

    registration.update(surface('panel', true));
    expect(clock.pending).toBe(1);
    renderer.dispose();
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
