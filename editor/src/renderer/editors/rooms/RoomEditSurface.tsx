import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthoringWebGlGroupRenderer } from '@/authoring-renderer/authoring-webgl-provider';
import type {
  AuthoringWebGlMaterialDraw,
  AuthoringWebGlMaterialResource,
  AuthoringWebGlTextureResource,
} from '@/authoring-renderer/authoring-webgl-renderer';
import {
  useMaterialPreviewProjectGeneration,
  useMaterialPreviewProjectResources,
} from '@/material-preview/material-preview-provider';
import type { MaterialPreviewProjectResources } from '@/material-preview/material-preview-resources';
import type { MaterialPreviewResource } from '@/material-preview/material-preview-resources';
import type { MaterialApplication } from '../../../shared/project-schema/authoring-material-applications';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import type { RoomData } from '../../../shared/project-schema/authoring-rooms';
import {
  projectRoomEditRect,
  resolveRoomEditProjection,
  type RoomEditProjectedRect,
  type RoomEditProjection,
  type RoomEditResolvedVisibility,
  type RoomEditUvRect,
} from './room-edit-projection';
import {
  clampRoomEditNavigation,
  panRoomEditNavigation,
  ROOM_EDIT_FIT_NAVIGATION,
  zoomRoomEditNavigationAtPoint,
  type RoomEditNavigation,
} from './room-edit-navigation';

interface PreparedVisual {
  texture: AuthoringWebGlTextureResource | null;
  material: AuthoringWebGlMaterialResource;
  textureOverrides: Readonly<Record<string, AuthoringWebGlTextureResource>>;
}

interface PreparedRoomEditScene {
  background: PreparedVisual | null;
  worldDraws: ReadonlyMap<string, PreparedVisual>;
}

const fallbackEngine2dMaterial: AuthoringWebGlMaterialResource = {
  materialId: '__room-edit-default-engine-2d',
  resolved: { role: 'engine-2d', textures: {}, parameters: {} },
  vertexShaderSource: null,
  fragmentShaderSource: null,
  textures: {},
};

const whiteTexture: AuthoringWebGlTextureResource = {
  key: '__room-edit-white',
  image: null,
  sampling: 'linear',
  fallbackColor: [1, 1, 1, 1],
};

function materialResource(resource: MaterialPreviewResource): AuthoringWebGlMaterialResource {
  return {
    materialId: resource.materialId,
    resolved: resource.resolved,
    vertexShaderSource: resource.vertexShaderSource,
    fragmentShaderSource: resource.fragmentShaderSource,
    textures: resource.textures,
  };
}

function colorChannels(value: string | null): readonly [number, number, number, number] {
  if (!value) return [0, 0, 0, 0];
  const match = /^#([0-9a-f]{6}|[0-9a-f]{8})$/iu.exec(value.trim());
  if (!match) return [0, 0, 0, 0];
  const hex = match[1]!;
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
    alpha,
  ];
}

function modelViewProjection(
  projected: RoomEditProjectedRect,
  viewport: { width: number; height: number },
) {
  const radians = (projected.rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rectCenterX = projected.rect.x + projected.rect.width * 0.5;
  const rectCenterY = projected.rect.y + projected.rect.height * 0.5;
  const viewportCenterX = viewport.width * 0.5;
  const viewportCenterY = viewport.height * 0.5;
  const localCenterX = rectCenterX - viewportCenterX;
  const localCenterY = rectCenterY - viewportCenterY;
  const rotatedCenterX = viewportCenterX + localCenterX * cosine - localCenterY * sine;
  const rotatedCenterY = viewportCenterY + localCenterX * sine + localCenterY * cosine;
  const translateX = (rotatedCenterX / viewport.width) * 2 - 1;
  const translateY = 1 - (rotatedCenterY / viewport.height) * 2;
  return new Float32Array([
    (cosine * projected.rect.width) / viewport.width,
    (-sine * projected.rect.width) / viewport.height,
    0,
    0,
    (sine * projected.rect.height) / viewport.width,
    (cosine * projected.rect.height) / viewport.height,
    0,
    0,
    0,
    0,
    1,
    0,
    translateX,
    translateY,
    0,
    1,
  ]);
}

function parameterOverrides(
  application: MaterialApplication | null,
  projected: RoomEditProjectedRect,
  projection: RoomEditProjection,
  timeSeconds: number,
  propertyValues?: Readonly<Record<string, unknown>>,
) {
  if (!application) return undefined;
  const result: Record<string, unknown> = {};
  for (const [name, override] of Object.entries(application.parameters)) {
    if (override.source.kind === 'literal') result[name] = override.source.value;
    else if (override.source.kind === 'property') {
      if (propertyValues && override.source.property in propertyValues)
        result[name] = propertyValues[override.source.property];
    } else if (override.source.kind === 'standard-facet') {
      switch (override.source.facet) {
        case 'paint-width':
          result[name] = projected.rect.width;
          break;
        case 'paint-height':
          result[name] = projected.rect.height;
          break;
        case 'viewport-width':
          result[name] = projection.viewport.width;
          break;
        case 'viewport-height':
          result[name] = projection.viewport.height;
          break;
        case 'camera-zoom':
          result[name] = projection.camera.zoom;
          break;
        case 'occurrence-time':
          result[name] = timeSeconds;
          break;
      }
    }
  }
  return result;
}

function drawVisual(
  projection: RoomEditProjection,
  projected: RoomEditProjectedRect,
  prepared: PreparedVisual,
  application: MaterialApplication | null,
  timeSeconds: number,
  propertyValues?: Readonly<Record<string, unknown>>,
  uv?: RoomEditUvRect,
  color?: readonly [number, number, number, number],
): AuthoringWebGlMaterialDraw {
  return {
    resource: prepared.material,
    geometry: { kind: 'quad', ...(uv ? { uv } : {}), ...(color ? { color } : {}) },
    modelViewProjection: modelViewProjection(projected, projection.viewport),
    parameterOverrides: parameterOverrides(
      application,
      projected,
      projection,
      timeSeconds,
      propertyValues,
    ),
    textureOverrides: prepared.textureOverrides,
    rendererTextures: { s_texColor: prepared.texture ?? whiteTexture },
  };
}

function colorTexture(
  color: readonly [number, number, number, number],
): AuthoringWebGlTextureResource {
  return {
    key: `__room-edit-color:${color.join(',')}`,
    image: null,
    sampling: 'linear',
    fallbackColor: color,
  };
}

async function prepareVisual(
  resources: MaterialPreviewProjectResources,
  assetId: string | null,
  application: MaterialApplication | null,
): Promise<PreparedVisual | null> {
  const [texture, material, textureOverrideEntries] = await Promise.all([
    assetId ? resources.getTexture(assetId) : Promise.resolve(null),
    application ? resources.getMaterial(application.material.$ref.id) : Promise.resolve(null),
    Promise.all(
      Object.entries(application?.textures ?? {}).map(
        async ([name, override]) =>
          [name, await resources.getTexture(override.source.$ref.id)] as const,
      ),
    ),
  ]);
  if (application && !material) return null;
  if (!texture && !material) return null;
  return {
    texture,
    material: material ? materialResource(material) : fallbackEngine2dMaterial,
    textureOverrides: Object.fromEntries(textureOverrideEntries),
  };
}

function overlayStyle(projected: RoomEditProjectedRect, projection: RoomEditProjection) {
  const centerX =
    ((projection.viewport.width * 0.5 - projected.rect.x) / projected.rect.width) * 100;
  const centerY =
    ((projection.viewport.height * 0.5 - projected.rect.y) / projected.rect.height) * 100;
  return {
    left: `${(projected.rect.x / projection.viewport.width) * 100}%`,
    top: `${(projected.rect.y / projection.viewport.height) * 100}%`,
    width: `${(projected.rect.width / projection.viewport.width) * 100}%`,
    height: `${(projected.rect.height / projection.viewport.height) * 100}%`,
    transform: `rotate(${projected.rotationDegrees}deg)`,
    transformOrigin: `${centerX}% ${centerY}%`,
  };
}

export function RoomEditSurface({
  project,
  roomId,
  room,
  referenceResolution,
  backgroundImageSize,
  roomPropertyValues,
  resolvedVisibility = null,
  navigation = ROOM_EDIT_FIT_NAVIGATION,
  onNavigationChange = () => {},
  gestureCancellationToken = 0,
  interactionEnabled = true,
}: {
  project: AuthoringProject;
  roomId: string;
  room: RoomData;
  referenceResolution: { width: number; height: number };
  backgroundImageSize: { width: number; height: number } | null;
  roomPropertyValues: Readonly<Record<string, unknown>>;
  resolvedVisibility?: RoomEditResolvedVisibility | null;
  navigation?: RoomEditNavigation;
  onNavigationChange?: (navigation: RoomEditNavigation) => void;
  gestureCancellationToken?: number;
  interactionEnabled?: boolean;
}) {
  const { t } = useTranslation('workspace');
  const renderer = useAuthoringWebGlGroupRenderer();
  const resources = useMaterialPreviewProjectResources();
  const resourcesGeneration = useMaterialPreviewProjectGeneration();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const navigationRef = useRef(navigation);
  const projectionRef = useRef<RoomEditProjection | null>(null);
  const panGestureRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const spaceHeldRef = useRef(false);
  const pointerInsideRef = useRef(false);
  const [panning, setPanning] = useState(false);
  const [preparedScene, setPreparedScene] = useState<PreparedRoomEditScene | null>(null);
  navigationRef.current = navigation;
  const canonicalSurface = useMemo(
    () =>
      projectRoomEditRect(
        { x: 0, y: 0, ...referenceResolution },
        referenceResolution,
        room.presentationSpace,
        room.presentationSpace.defaultView,
      ).rect,
    [referenceResolution, room.presentationSpace],
  );
  const projection = useMemo(
    () =>
      resolveRoomEditProjection({
        project,
        roomId,
        room,
        viewport: referenceResolution,
        backgroundImageSize,
        resolvedVisibility,
        navigation,
      }),
    [
      backgroundImageSize,
      navigation,
      project,
      referenceResolution,
      resolvedVisibility,
      room,
      roomId,
    ],
  );
  projectionRef.current = projection;
  const preparationProjection = useMemo(
    () =>
      resolveRoomEditProjection({
        project,
        roomId,
        room,
        viewport: referenceResolution,
        backgroundImageSize,
        resolvedVisibility,
      }),
    [backgroundImageSize, project, referenceResolution, resolvedVisibility, room, roomId],
  );

  useEffect(() => {
    const isTextInput = (target: EventTarget | null) => {
      const element = target instanceof HTMLElement ? target : null;
      return Boolean(
        element &&
        (element.isContentEditable ||
          element.tagName === 'INPUT' ||
          element.tagName === 'TEXTAREA' ||
          element.tagName === 'SELECT'),
      );
    };
    const keyDown = (event: KeyboardEvent) => {
      if (!interactionEnabled || event.code !== 'Space' || isTextInput(event.target)) return;
      spaceHeldRef.current = true;
      if (pointerInsideRef.current) event.preventDefault();
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceHeldRef.current = false;
    };
    const blur = () => {
      spaceHeldRef.current = false;
    };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
    };
  }, [interactionEnabled]);

  useEffect(() => {
    const gesture = panGestureRef.current;
    panGestureRef.current = null;
    setPanning(false);
    if (gesture && surfaceRef.current?.hasPointerCapture?.(gesture.pointerId))
      surfaceRef.current.releasePointerCapture(gesture.pointerId);
  }, [gestureCancellationToken, interactionEnabled]);

  const viewportPoint = (clientX: number, clientY: number) => {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      x: ((clientX - bounds.left) / bounds.width) * referenceResolution.width,
      y: ((clientY - bounds.top) / bounds.height) * referenceResolution.height,
      scaleX: referenceResolution.width / bounds.width,
      scaleY: referenceResolution.height / bounds.height,
    };
  };

  const updateNavigation = (next: RoomEditNavigation) =>
    onNavigationChange(clampRoomEditNavigation(next, referenceResolution, canonicalSurface));

  useEffect(() => {
    let active = true;
    const generation = resourcesGeneration;
    void (async () => {
      const [background, worldDrawEntries] = await Promise.all([
        prepareVisual(
          resources,
          preparationProjection.background.assetId,
          preparationProjection.background.materialApplication,
        ),
        Promise.all(
          preparationProjection.worldDraws.map(async (item) => {
            const assetId =
              item.kind === 'interactable' || item.kind === 'cast-layer'
                ? item.spriteAssetId
                : item.assetId;
            return [
              `${item.kind}:${item.occurrenceId}`,
              await prepareVisual(resources, assetId, item.materialApplication),
            ] as const;
          }),
        ),
      ]);
      if (!active || generation !== resources.generation) return;
      const preparedWorldDrawEntries = worldDrawEntries.flatMap(([key, value]) =>
        value ? ([[key, value]] as const) : [],
      );
      setPreparedScene({
        background,
        worldDraws: new Map<string, PreparedVisual>(preparedWorldDrawEntries),
      });
    })();
    return () => {
      active = false;
    };
  }, [preparationProjection, resources, resourcesGeneration]);

  useEffect(() => {
    const registration = renderer.registerSceneWork({
      order: 0,
      visible: true,
      render: (frame) => {
        const projection = projectionRef.current;
        const canvas = canvasRef.current;
        if (!canvas || !projection) return;
        frame.beginTarget(projection.viewport.width, projection.viewport.height, [0, 0, 0, 0]);
        if (projection.background.color) {
          frame.drawMaterial(
            drawVisual(
              projection,
              projection.backgroundColor,
              {
                texture: colorTexture(colorChannels(projection.background.color)),
                material: fallbackEngine2dMaterial,
                textureOverrides: {},
              },
              null,
              frame.timeSeconds,
            ),
          );
        }
        if (preparedScene?.background) {
          frame.drawMaterial(
            drawVisual(
              projection,
              projection.background,
              preparedScene.background,
              projection.background.materialApplication,
              frame.timeSeconds,
              roomPropertyValues,
              projection.background.uv,
            ),
          );
        }
        for (const item of projection.worldDraws) {
          const prepared = preparedScene?.worldDraws.get(`${item.kind}:${item.occurrenceId}`);
          if (!prepared) continue;
          const propertyValues =
            item.kind === 'interactable' || item.kind === 'cast-layer'
              ? item.propertyValues
              : roomPropertyValues;
          const color =
            item.kind === 'environment' && item.opacity < 1
              ? ([1, 1, 1, item.opacity] as const)
              : undefined;
          const uv =
            item.kind === 'environment'
              ? {
                  x: item.scrollPerSecond.x * frame.timeSeconds,
                  y: item.scrollPerSecond.y * frame.timeSeconds,
                  width: 1,
                  height: 1,
                }
              : undefined;
          frame.drawMaterial(
            drawVisual(
              projection,
              item,
              prepared,
              item.materialApplication,
              frame.timeSeconds,
              propertyValues,
              uv,
              color,
            ),
          );
        }
        frame.copyTargetToCanvas(canvas, projection.viewport.width, projection.viewport.height);
      },
      onError: (error) => {
        console.error('Room Edit authoring render failed.', error);
      },
    });
    return () => registration.unregister();
  }, [preparedScene, renderer, roomPropertyValues]);

  return (
    <div
      ref={surfaceRef}
      className="relative w-full min-h-0 min-w-0 shrink-0 overflow-hidden bg-muted/20"
      style={{ aspectRatio: `${referenceResolution.width} / ${referenceResolution.height}` }}
      data-testid="room-edit-surface"
      data-panning={panning ? 'true' : 'false'}
      data-interaction-enabled={interactionEnabled ? 'true' : 'false'}
      onPointerEnter={() => {
        pointerInsideRef.current = true;
      }}
      onPointerLeave={() => {
        pointerInsideRef.current = false;
      }}
      onWheel={(event) => {
        if (!interactionEnabled) return;
        event.preventDefault();
        const point = viewportPoint(event.clientX, event.clientY);
        if (!point) return;
        const zoomFactor = Math.exp(-event.deltaY * 0.0015);
        updateNavigation(
          zoomRoomEditNavigationAtPoint(
            navigationRef.current,
            referenceResolution,
            point,
            navigationRef.current.zoom * zoomFactor,
          ),
        );
      }}
      onPointerDown={(event) => {
        if (!interactionEnabled) return;
        const shouldPan = event.button === 1 || (event.button === 0 && spaceHeldRef.current);
        if (!shouldPan) return;
        event.preventDefault();
        panGestureRef.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
        };
        surfaceRef.current?.setPointerCapture?.(event.pointerId);
        setPanning(true);
      }}
      onPointerMove={(event) => {
        const gesture = panGestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        const point = viewportPoint(event.clientX, event.clientY);
        if (!point) return;
        const delta = {
          x: (event.clientX - gesture.clientX) * point.scaleX,
          y: (event.clientY - gesture.clientY) * point.scaleY,
        };
        gesture.clientX = event.clientX;
        gesture.clientY = event.clientY;
        updateNavigation(panRoomEditNavigation(navigationRef.current, delta));
      }}
      onPointerUp={(event) => {
        const gesture = panGestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        panGestureRef.current = null;
        setPanning(false);
        if (surfaceRef.current?.hasPointerCapture?.(event.pointerId))
          surfaceRef.current.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        const gesture = panGestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        panGestureRef.current = null;
        setPanning(false);
      }}
    >
      <canvas
        ref={canvasRef}
        width={referenceResolution.width}
        height={referenceResolution.height}
        className="absolute inset-0 size-full"
        aria-label={t('roomEditor.presentationModes.editWorldRendering')}
        data-testid="room-edit-canvas"
      />
      <div className="pointer-events-none absolute inset-0" data-testid="room-edit-overlays">
        {projection.layoutPlaceholders.map((placeholder) => (
          <div
            key={`layout:${placeholder.placementId}`}
            className={`absolute border border-dotted border-primary/60 bg-primary/5 ${placeholder.hasRenderedOccupants ? 'opacity-40' : 'opacity-75'}`}
            style={overlayStyle(placeholder, projection)}
            data-testid={`room-edit-layout-placeholder-${placeholder.placementId}`}
          >
            <span className="absolute bottom-0 left-0 max-w-full truncate bg-background/75 px-1 py-0.5 text-[10px] font-medium">
              {placeholder.label} · {placeholder.layoutId}
            </span>
          </div>
        ))}
        {projection.placements.map((placement) => (
          <div
            key={placement.id}
            className="absolute border border-dashed border-foreground/40"
            style={overlayStyle(placement, projection)}
            data-testid={`room-edit-placement-${placement.id}`}
          >
            <span className="absolute left-0 top-0 max-w-full -translate-y-full truncate bg-background/80 px-1 py-0.5 text-[10px] font-medium">
              {placement.id}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
