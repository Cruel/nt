import type { MaterialStandardFacet } from '../../shared/project-schema/authoring-material-applications';
import type { ShaderUniformValue } from '../../shared/project-schema/authoring-shaders';
import {
  AuthoringWebGlGroupRenderer,
  type AuthoringWebGlFrame,
  type AuthoringWebGlSceneRegistration,
} from '@/authoring-renderer/authoring-webgl-renderer';
import { AuthoringWebGlShaderProgramError } from '@/authoring-renderer/authoring-webgl-backend';
import { materialContractRegistry } from '../../shared/project-schema/material-contract-registry.generated';
import type {
  MaterialPreviewProjectResources,
  MaterialPreviewResource,
  MaterialPreviewTextureResource,
} from './material-preview-resources';

export interface MaterialPreviewPointerState {
  x: number;
  y: number;
  pressed: boolean;
}

export type MaterialPreviewParameterOverride =
  | ShaderUniformValue
  | { kind: 'standard-facet'; facet: MaterialStandardFacet };

export interface MaterialPreviewSurfaceState {
  canvas: HTMLCanvasElement;
  materialId: string;
  width: number;
  height: number;
  visible: boolean;
  pointer: MaterialPreviewPointerState;
  resources?: MaterialPreviewProjectResources;
  parameterOverrides?: Readonly<Record<string, MaterialPreviewParameterOverride>>;
  textureOverrides?: Readonly<Record<string, MaterialPreviewTextureResource>>;
  onShaderProgramStatus?: (status: { stale: boolean; message: string | null }) => void;
}

export interface MaterialPreviewGroupRendererStatus {
  available: boolean;
  code: string | null;
  message: string | null;
}

interface RegisteredSurface {
  state: MaterialPreviewSurfaceState;
  resource: MaterialPreviewResource | null;
  resourceGeneration: number;
}

export type MaterialPreviewSurfaceRenderer = (
  frame: AuthoringWebGlFrame,
  surface: MaterialPreviewSurfaceState,
  resource: MaterialPreviewResource,
) => void;

function isStandardFacetOverride(
  value: MaterialPreviewParameterOverride,
): value is { kind: 'standard-facet'; facet: MaterialStandardFacet } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'kind' in value;
}

function previewStandardFacetValue(
  facet: MaterialStandardFacet,
  timeSeconds: number,
  width: number,
  height: number,
): number {
  switch (facet) {
    case 'occurrence-time':
      return timeSeconds;
    case 'paint-width':
    case 'viewport-width':
      return width;
    case 'paint-height':
    case 'viewport-height':
      return height;
    case 'camera-zoom':
      return 1;
  }
}

function backgroundColor(background: MaterialPreviewResource['resolved']['preview']['background']) {
  if (background === 'light') return [0.88, 0.88, 0.88, 1] as const;
  if (background === 'dark') return [0.08, 0.08, 0.1, 1] as const;
  return [0, 0, 0, 0] as const;
}

function paintCheckerBackground(context: CanvasRenderingContext2D, width: number, height: number) {
  const cell = 8;
  context.fillStyle = 'rgb(52, 52, 57)';
  context.fillRect(0, 0, width, height);
  context.fillStyle = 'rgb(78, 78, 84)';
  for (let y = 0; y < height; y += cell) {
    for (let x = (Math.floor(y / cell) % 2) * cell; x < width; x += cell * 2) {
      context.fillRect(x, y, cell, cell);
    }
  }
}

function rendererFixtureTextures(resource: MaterialPreviewResource) {
  const roleContract = materialContractRegistry.roles.find(
    (role) => role.id === resource.resolved.role,
  );
  return Object.fromEntries(
    (roleContract?.reservedInterface.samplers ?? [])
      .filter((sampler) => sampler.sourceOwnership === 'renderer')
      .map((sampler) => [
        sampler.name,
        {
          key: `__renderer_fixture_${sampler.semantic}__`,
          image: null,
          sampling: 'linear' as const,
        },
      ]),
  );
}

function previewGeometry(resource: MaterialPreviewResource) {
  const geometry = resource.resolved.preview.geometry;
  return {
    kind: 'quad' as const,
    inset: geometry === 'glyphs' ? 0.22 : geometry === 'rounded-rect' ? 0.08 : 0,
  };
}

export class MaterialPreviewShaderProgramError extends Error {
  constructor(
    readonly stale: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'MaterialPreviewShaderProgramError';
  }
}

export const renderMaterialPreviewSurface: MaterialPreviewSurfaceRenderer = (
  frame,
  surface,
  resource,
) => {
  const width = Math.max(1, Math.round(surface.width));
  const height = Math.max(1, Math.round(surface.height));
  frame.beginTarget(width, height, backgroundColor(resource.resolved.preview.background));

  const parameterOverrides = Object.fromEntries(
    Object.entries(surface.parameterOverrides ?? {}).map(([name, override]) => [
      name,
      isStandardFacetOverride(override)
        ? previewStandardFacetValue(override.facet, frame.timeSeconds, width, height)
        : override,
    ]),
  );
  let shaderProgramError: MaterialPreviewShaderProgramError | null = null;
  try {
    frame.drawMaterial({
      resource,
      geometry: previewGeometry(resource),
      parameterOverrides,
      textureOverrides: surface.textureOverrides,
      rendererTextures: rendererFixtureTextures(resource),
      uniformOverrides: {
        u_hotspotHovered: surface.pointer.x >= 0 && surface.pointer.y >= 0,
        u_hotspotPressed: surface.pointer.pressed,
        u_hotspotBounds: [0, 0, width, height],
        u_hotspotImageDimensions: [width, height],
        u_hotspotMaskDimensions: [width, height],
      },
    });
  } catch (error) {
    if (!(error instanceof AuthoringWebGlShaderProgramError)) throw error;
    shaderProgramError = new MaterialPreviewShaderProgramError(error.stale, error.message);
    if (!error.stale) throw shaderProgramError;
  }

  if (surface.canvas.width !== width) surface.canvas.width = width;
  if (surface.canvas.height !== height) surface.canvas.height = height;
  const target = surface.canvas.getContext('2d');
  if (target) {
    target.clearRect(0, 0, width, height);
    if (resource.resolved.preview.background === 'checker') {
      paintCheckerBackground(target, width, height);
    }
    frame.copyTargetToCanvas(
      surface.canvas,
      width,
      height,
      resource.resolved.preview.background === 'checker' ? 'over' : 'replace',
    );
  }
  if (shaderProgramError) throw shaderProgramError;
};

const MATERIAL_PREVIEW_SCENE_ORDER = 100;

export class MaterialPreviewGroupRenderer {
  private readonly surfaces = new Map<object, RegisteredSurface>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeAuthoringStatus: () => void;
  private sceneRegistration: AuthoringWebGlSceneRegistration | null = null;
  private disposed = false;
  private renderFailed = false;
  private lastAuthoringCode: string | null = null;
  private statusValue: MaterialPreviewGroupRendererStatus = {
    available: true,
    code: null,
    message: null,
  };

  constructor(
    private readonly resources: MaterialPreviewProjectResources,
    private readonly authoringRenderer: AuthoringWebGlGroupRenderer,
    private readonly renderSurface: MaterialPreviewSurfaceRenderer = renderMaterialPreviewSurface,
  ) {
    this.unsubscribeAuthoringStatus = authoringRenderer.subscribe(() => this.syncAuthoringStatus());
    this.syncAuthoringStatus();
  }

  get status() {
    return this.statusValue;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerSurface(state: MaterialPreviewSurfaceState) {
    const token = {};
    this.surfaces.set(token, { state, resource: null, resourceGeneration: -1 });
    this.ensureSceneRegistration();
    if (state.visible) void this.refreshSurface(token);
    this.updateSceneWork();
    return {
      update: (next: MaterialPreviewSurfaceState) => {
        const registered = this.surfaces.get(token);
        if (!registered) return;
        const previousResources = registered.state.resources ?? this.resources;
        const nextResources = next.resources ?? this.resources;
        const becameVisible = !registered.state.visible && next.visible;
        const resourceChanged =
          registered.state.materialId !== next.materialId ||
          previousResources !== nextResources ||
          registered.resourceGeneration !== nextResources.generation;
        registered.state = next;
        if (resourceChanged) {
          registered.resource = null;
          registered.resourceGeneration = -1;
        }
        if (next.visible && (resourceChanged || becameVisible)) void this.refreshSurface(token);
        this.updateSceneWork();
      },
      unregister: () => {
        this.surfaces.delete(token);
        this.updateSceneWork();
      },
    };
  }

  invalidateProjectResources() {
    this.authoringRenderer.invalidateProjectResources();
    this.renderFailed = false;
    for (const [token, registered] of this.surfaces) {
      registered.resource = null;
      registered.resourceGeneration = -1;
      if (registered.state.visible) void this.refreshSurface(token);
    }
    this.syncAuthoringStatus();
    this.updateSceneWork();
  }

  dispose() {
    this.disposed = true;
    this.sceneRegistration?.unregister();
    this.sceneRegistration = null;
    this.surfaces.clear();
    this.listeners.clear();
    this.unsubscribeAuthoringStatus();
  }

  private async refreshSurface(token: object) {
    const registered = this.surfaces.get(token);
    if (!registered || !registered.state.visible) return;
    const resources = registered.state.resources ?? this.resources;
    const generation = resources.generation;
    const materialId = registered.state.materialId;
    const resource = await resources.getMaterial(materialId);
    const current = this.surfaces.get(token);
    if (
      !current ||
      !current.state.visible ||
      current.state.materialId !== materialId ||
      (current.state.resources ?? this.resources) !== resources ||
      generation !== resources.generation
    )
      return;
    current.resource = resource;
    current.resourceGeneration = generation;
    this.updateSceneWork();
  }

  private ensureSceneRegistration() {
    if (this.sceneRegistration || this.disposed) return;
    this.sceneRegistration = this.authoringRenderer.registerSceneWork(this.sceneWork());
  }

  private sceneWork() {
    return {
      order: MATERIAL_PREVIEW_SCENE_ORDER,
      visible:
        !this.renderFailed && [...this.surfaces.values()].some((surface) => surface.state.visible),
      render: (frame: AuthoringWebGlFrame) => this.renderFrame(frame),
      onError: (error: unknown) => this.handleRenderFailure(error),
    };
  }

  private updateSceneWork() {
    this.sceneRegistration?.update(this.sceneWork());
  }

  private renderFrame(frame: AuthoringWebGlFrame) {
    for (const [token, registered] of this.surfaces) {
      if (!registered.state.visible) continue;
      const resources = registered.state.resources ?? this.resources;
      if (registered.resourceGeneration !== resources.generation) {
        void this.refreshSurface(token);
        continue;
      }
      if (!registered.resource) continue;
      try {
        this.renderSurface(frame, registered.state, registered.resource);
        registered.state.onShaderProgramStatus?.({ stale: false, message: null });
      } catch (error) {
        if (error instanceof MaterialPreviewShaderProgramError) {
          registered.state.onShaderProgramStatus?.({
            stale: error.stale,
            message: error.message,
          });
          continue;
        }
        throw error;
      }
    }
  }

  private handleRenderFailure(error: unknown) {
    this.renderFailed = true;
    this.setStatus({
      available: false,
      code: 'material-preview.render-failed',
      message: error instanceof Error ? error.message : 'Material preview rendering failed.',
    });
    this.updateSceneWork();
  }

  private syncAuthoringStatus() {
    const status = this.authoringRenderer.status;
    const restoredFromContextLoss =
      status.available && this.lastAuthoringCode === 'authoring-webgl.context-lost';
    this.lastAuthoringCode = status.code;
    if (restoredFromContextLoss) this.renderFailed = false;
    if (!status.available) {
      this.setStatus(
        status.code === 'authoring-webgl.context-lost'
          ? {
              available: false,
              code: 'material-preview.context-lost',
              message: 'Material preview is temporarily unavailable.',
            }
          : {
              available: false,
              code: 'material-preview.webgl2-unavailable',
              message: 'Material preview requires WebGL2.',
            },
      );
    } else if (!this.renderFailed) {
      this.setStatus({ available: true, code: null, message: null });
    }
    this.updateSceneWork();
  }

  private setStatus(status: MaterialPreviewGroupRendererStatus) {
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
