import { describe, expect, it, vi } from 'vite-plus/test';
import {
  AuthoringWebGlGroupRenderer,
  type AuthoringWebGlBackend,
  type AuthoringWebGlBackendFactoryOptions,
  type AuthoringWebGlFrame,
  type AuthoringWebGlScheduler,
} from '@/authoring-renderer/authoring-webgl-renderer';
import {
  AuthoringWebGlShaderProgramError,
  resolveAuthoringWebGlProgramSources,
} from '@/authoring-renderer/authoring-webgl-backend';

function manualScheduler() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const scheduler: AuthoringWebGlScheduler = {
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
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(timestamp);
    },
    get pending() {
      return callbacks.size;
    },
  };
}

function fakeBackendFactory() {
  const callbacks: AuthoringWebGlBackendFactoryOptions[] = [];
  const frame: AuthoringWebGlFrame = {
    timeSeconds: 0,
    beginTarget: vi.fn(),
    drawMaterial: vi.fn(),
    copyTargetToCanvas: vi.fn(),
  };
  const backend: AuthoringWebGlBackend = {
    frame: vi.fn((timeSeconds) => ({ ...frame, timeSeconds })),
    invalidateProjectResources: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
  const factory = vi.fn((options: AuthoringWebGlBackendFactoryOptions) => {
    callbacks.push(options);
    return backend;
  });
  return { backend, callbacks, factory };
}

describe('workbench-group authoring WebGL renderer', () => {
  it('preserves CPU-side stale and hard Material failure status before browser compilation', () => {
    const base = {
      materialId: 'panel',
      resolved: { role: 'engine-2d' as const, textures: {}, parameters: {} },
      vertexShaderSource: '#version 300 es\nvoid main() {}',
      fragmentShaderSource: '#version 300 es\nvoid main() {}',
      textures: {},
      requiresCompiledShader: true,
      requiresCompiledFragmentShader: true,
      compileDiagnostics: [{ severity: 'error', message: 'CPU compile failed' }],
      diagnostics: [],
    };

    const stale = resolveAuthoringWebGlProgramSources({ ...base, stale: true });
    expect(stale.staleError).toBeInstanceOf(AuthoringWebGlShaderProgramError);
    expect(stale.staleError).toMatchObject({ stale: true, message: 'CPU compile failed' });
    expect(stale.vertexSource).toBe(base.vertexShaderSource);

    const fragmentOnly = resolveAuthoringWebGlProgramSources({
      ...base,
      stale: false,
      vertexShaderSource: null,
    });
    expect(fragmentOnly.vertexSource).toContain('u_modelViewProj');
    expect(fragmentOnly.fragmentSource).toBe(base.fragmentShaderSource);

    expect(() =>
      resolveAuthoringWebGlProgramSources({
        ...base,
        stale: false,
        fragmentShaderSource: null,
      }),
    ).toThrowError(
      expect.objectContaining({ stale: false, message: 'CPU compile failed' }) as Error,
    );
  });

  it('runs ordered consumers on one backend and one shared frame clock', () => {
    const clock = manualScheduler();
    const gpu = fakeBackendFactory();
    const renderer = new AuthoringWebGlGroupRenderer(gpu.factory, clock.scheduler);
    const rendered: string[] = [];

    renderer.registerSceneWork({
      order: 20,
      visible: true,
      render: (frame) => rendered.push(`material:${frame.timeSeconds}`),
      onError: vi.fn(),
    });
    renderer.registerSceneWork({
      order: 10,
      visible: true,
      render: (frame) => rendered.push(`room:${frame.timeSeconds}`),
      onError: vi.fn(),
    });

    expect(gpu.factory).toHaveBeenCalledTimes(1);
    expect(clock.pending).toBe(1);

    clock.flush(2500);

    expect(rendered).toEqual(['room:2.5', 'material:2.5']);
    expect(gpu.backend.frame).toHaveBeenCalledTimes(1);
    expect(clock.pending).toBe(1);
    renderer.dispose();
  });

  it('centralizes context loss and resumes all consumers on the existing backend', () => {
    const clock = manualScheduler();
    const gpu = fakeBackendFactory();
    const renderer = new AuthoringWebGlGroupRenderer(gpu.factory, clock.scheduler);
    const first = vi.fn();
    const second = vi.fn();
    const listener = vi.fn();
    renderer.subscribe(listener);
    renderer.registerSceneWork({ order: 0, visible: true, render: first, onError: vi.fn() });
    renderer.registerSceneWork({ order: 1, visible: true, render: second, onError: vi.fn() });

    gpu.callbacks[0]!.onContextLost();
    expect(renderer.status).toEqual({
      available: false,
      code: 'authoring-webgl.context-lost',
      message: 'Authoring WebGL is temporarily unavailable.',
    });
    expect(clock.pending).toBe(0);

    gpu.callbacks[0]!.onContextRestored();
    expect(renderer.status).toEqual({ available: true, code: null, message: null });
    expect(gpu.factory).toHaveBeenCalledTimes(1);
    expect(gpu.backend.reset).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(clock.pending).toBe(1);

    clock.flush(3000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });
});
