import type { ResolvedMaterialData } from '../../shared/project-schema/authoring-materials';

export interface AuthoringWebGlGeometry {
  kind: 'quad';
  inset?: number;
  color?: readonly [number, number, number, number];
  uv?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface AuthoringWebGlTextureResource {
  key: string;
  image: TexImageSource | null;
  sampling: 'nearest' | 'linear';
  fallbackColor?: readonly [number, number, number, number];
}

export interface AuthoringWebGlMaterialResource {
  materialId: string;
  resolved: Pick<ResolvedMaterialData, 'role' | 'textures' | 'parameters'>;
  vertexShaderSource: string | null;
  fragmentShaderSource: string | null;
  textures: Readonly<Record<string, AuthoringWebGlTextureResource>>;
}

export interface AuthoringWebGlMaterialDraw {
  resource: AuthoringWebGlMaterialResource;
  geometry: AuthoringWebGlGeometry;
  modelViewProjection?: Float32Array;
  parameterOverrides?: Readonly<Record<string, unknown>>;
  textureOverrides?: Readonly<Record<string, AuthoringWebGlTextureResource>>;
  rendererTextures?: Readonly<Record<string, AuthoringWebGlTextureResource>>;
  uniformOverrides?: Readonly<Record<string, unknown>>;
}

export interface AuthoringWebGlFrame {
  readonly timeSeconds: number;
  beginTarget: (
    width: number,
    height: number,
    clearColor?: readonly [number, number, number, number],
  ) => void;
  drawMaterial: (draw: AuthoringWebGlMaterialDraw) => void;
  copyTargetToCanvas: (
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    composition?: 'replace' | 'over',
  ) => void;
}

export interface AuthoringWebGlBackend {
  frame: (timeSeconds: number) => AuthoringWebGlFrame;
  invalidateProjectResources: () => void;
  reset: () => void;
  dispose: () => void;
}

export interface AuthoringWebGlBackendFactoryOptions {
  onContextLost: () => void;
  onContextRestored: () => void;
}

export type AuthoringWebGlBackendFactory = (
  options: AuthoringWebGlBackendFactoryOptions,
) => AuthoringWebGlBackend | null;

export interface AuthoringWebGlScheduler {
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
}

export interface AuthoringWebGlRendererStatus {
  available: boolean;
  code: 'authoring-webgl.webgl2-unavailable' | 'authoring-webgl.context-lost' | null;
  message: string | null;
}

export interface AuthoringWebGlSceneWork {
  order: number;
  visible: boolean;
  render: (frame: AuthoringWebGlFrame) => void;
  onError: (error: unknown) => void;
}

export interface AuthoringWebGlSceneRegistration {
  update: (work: AuthoringWebGlSceneWork) => void;
  unregister: () => void;
}

const browserScheduler: AuthoringWebGlScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (id) => window.cancelAnimationFrame(id),
};

interface RegisteredSceneWork {
  sequence: number;
  work: AuthoringWebGlSceneWork;
}

export class AuthoringWebGlGroupRenderer {
  private readonly sceneWork = new Map<object, RegisteredSceneWork>();
  private readonly listeners = new Set<() => void>();
  private backend: AuthoringWebGlBackend | null | undefined;
  private frameRequest: number | null = null;
  private disposed = false;
  private contextLost = false;
  private nextSequence = 0;
  private statusValue: AuthoringWebGlRendererStatus = {
    available: true,
    code: null,
    message: null,
  };

  constructor(
    private readonly backendFactory: AuthoringWebGlBackendFactory,
    private readonly scheduler: AuthoringWebGlScheduler = browserScheduler,
  ) {}

  get status() {
    return this.statusValue;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerSceneWork(work: AuthoringWebGlSceneWork): AuthoringWebGlSceneRegistration {
    const token = {};
    this.sceneWork.set(token, { sequence: this.nextSequence++, work });
    this.ensureBackend();
    this.schedule();
    return {
      update: (next) => {
        const registered = this.sceneWork.get(token);
        if (!registered) return;
        registered.work = next;
        this.schedule();
      },
      unregister: () => {
        this.sceneWork.delete(token);
        if (!this.hasVisibleWork() && this.frameRequest !== null) {
          this.scheduler.cancel(this.frameRequest);
          this.frameRequest = null;
        }
      },
    };
  }

  invalidateProjectResources() {
    this.backend?.invalidateProjectResources();
    this.schedule();
  }

  dispose() {
    this.disposed = true;
    if (this.frameRequest !== null) this.scheduler.cancel(this.frameRequest);
    this.frameRequest = null;
    this.sceneWork.clear();
    this.listeners.clear();
    this.backend?.dispose();
    this.backend = undefined;
  }

  private hasVisibleWork() {
    return [...this.sceneWork.values()].some(({ work }) => work.visible);
  }

  private schedule() {
    if (
      this.disposed ||
      !this.backend ||
      this.contextLost ||
      this.frameRequest !== null ||
      !this.hasVisibleWork()
    )
      return;
    this.frameRequest = this.scheduler.request((timestamp) => {
      this.frameRequest = null;
      this.renderFrame(timestamp);
      if (this.hasVisibleWork()) this.schedule();
    });
  }

  private renderFrame(timestamp: number) {
    if (!this.backend || this.contextLost) return;
    const frame = this.backend.frame(timestamp / 1000);
    const work = [...this.sceneWork.values()]
      .filter((entry) => entry.work.visible)
      .sort((left, right) => left.work.order - right.work.order || left.sequence - right.sequence);
    for (const entry of work) {
      try {
        entry.work.render(frame);
      } catch (error) {
        entry.work.onError(error);
      }
    }
  }

  private ensureBackend() {
    if (this.backend !== undefined || this.disposed) return;
    this.backend = this.backendFactory({
      onContextLost: () => {
        if (this.disposed) return;
        this.contextLost = true;
        if (this.frameRequest !== null) this.scheduler.cancel(this.frameRequest);
        this.frameRequest = null;
        this.setStatus({
          available: false,
          code: 'authoring-webgl.context-lost',
          message: 'Authoring WebGL is temporarily unavailable.',
        });
      },
      onContextRestored: () => {
        if (this.disposed) return;
        this.backend?.reset();
        this.contextLost = false;
        this.setStatus({ available: true, code: null, message: null });
        this.schedule();
      },
    });
    if (!this.backend) {
      this.setStatus({
        available: false,
        code: 'authoring-webgl.webgl2-unavailable',
        message: 'Authoring rendering requires WebGL2.',
      });
    }
  }

  private setStatus(status: AuthoringWebGlRendererStatus) {
    if (
      this.statusValue.available === status.available &&
      this.statusValue.code === status.code &&
      this.statusValue.message === status.message
    )
      return;
    this.statusValue = status;
    for (const listener of this.listeners) listener();
  }
}
