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
  resolveRoomEditProjection,
  type RoomEditProjectedRect,
  type RoomEditProjection,
  type RoomEditUvRect,
} from './room-edit-projection';

interface PreparedVisual {
  texture: AuthoringWebGlTextureResource | null;
  material: AuthoringWebGlMaterialResource;
  textureOverrides: Readonly<Record<string, AuthoringWebGlTextureResource>>;
}

interface PreparedRoomEditScene {
  background: PreparedVisual | null;
  interactables: ReadonlyMap<string, PreparedVisual>;
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
): AuthoringWebGlMaterialDraw {
  return {
    resource: prepared.material,
    geometry: { kind: 'quad', ...(uv ? { uv } : {}) },
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
}: {
  project: AuthoringProject;
  roomId: string;
  room: RoomData;
  referenceResolution: { width: number; height: number };
  backgroundImageSize: { width: number; height: number } | null;
  roomPropertyValues: Readonly<Record<string, unknown>>;
}) {
  const { t } = useTranslation('workspace');
  const renderer = useAuthoringWebGlGroupRenderer();
  const resources = useMaterialPreviewProjectResources();
  const resourcesGeneration = useMaterialPreviewProjectGeneration();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [preparedScene, setPreparedScene] = useState<PreparedRoomEditScene | null>(null);
  const projection = useMemo(
    () =>
      resolveRoomEditProjection({
        project,
        roomId,
        room,
        viewport: referenceResolution,
        backgroundImageSize,
      }),
    [backgroundImageSize, project, referenceResolution, room, roomId],
  );

  useEffect(() => {
    let active = true;
    const generation = resourcesGeneration;
    void (async () => {
      const [background, interactableEntries] = await Promise.all([
        prepareVisual(
          resources,
          projection.background.assetId,
          projection.background.materialApplication,
        ),
        Promise.all(
          projection.interactables.map(
            async (item) =>
              [
                item.occurrenceId,
                await prepareVisual(resources, item.spriteAssetId, item.materialApplication),
              ] as const,
          ),
        ),
      ]);
      if (!active || generation !== resources.generation) return;
      setPreparedScene({
        background,
        interactables: new Map(
          interactableEntries.filter(
            (entry): entry is readonly [string, PreparedVisual] => entry[1] !== null,
          ),
        ),
      });
    })();
    return () => {
      active = false;
    };
  }, [projection, resources, resourcesGeneration]);

  useEffect(() => {
    const registration = renderer.registerSceneWork({
      order: 0,
      visible: true,
      render: (frame) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
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
        for (const item of projection.interactables) {
          const prepared = preparedScene?.interactables.get(item.occurrenceId);
          if (!prepared) continue;
          frame.drawMaterial(
            drawVisual(
              projection,
              item,
              prepared,
              item.materialApplication,
              frame.timeSeconds,
              item.propertyValues,
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
  }, [preparedScene, projection, renderer, roomPropertyValues]);

  return (
    <div
      className="relative w-full min-h-0 min-w-0 shrink-0 overflow-hidden bg-muted/20"
      style={{ aspectRatio: `${referenceResolution.width} / ${referenceResolution.height}` }}
      data-testid="room-edit-surface"
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
