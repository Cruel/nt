import type { MaterialApplication } from '../../../shared/project-schema/authoring-material-applications';
import type {
  RoomCameraView,
  RoomData,
  RoomNormalizedRect,
  RoomPresentationSpace,
} from '../../../shared/project-schema/authoring-rooms';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import { resolveGameplayInstanceRecord } from '../../../shared/project-schema/authoring-archetypes';
import { effectiveMaterialApplication } from '../../../shared/project-schema/authoring-material-applications';
import { parseInteractableData } from '../../../shared/project-schema/authoring-interactables';
import { effectiveInteractableInstanceProperties } from '../../../shared/project-schema/authoring-interactable-properties';

export interface RoomEditSize {
  width: number;
  height: number;
}

export interface RoomEditRect extends RoomEditSize {
  x: number;
  y: number;
}

export type RoomEditUvRect = RoomEditRect;

export interface RoomEditProjectedRect {
  rect: RoomEditRect;
  rotationDegrees: number;
}

export interface RoomEditBackgroundProjection extends RoomEditProjectedRect {
  assetId: string | null;
  fit: RoomData['background']['fit'];
  uv: RoomEditUvRect;
  color: string | null;
  materialApplication: MaterialApplication | null;
}

export interface RoomEditPlacementProjection extends RoomEditProjectedRect {
  id: string;
  normalizedBounds: RoomNormalizedRect;
}

export interface RoomEditInteractableProjection extends RoomEditProjectedRect {
  occurrenceId: string;
  instanceId: string;
  placementId: string;
  normalizedBounds: RoomNormalizedRect;
  order: number;
  spriteAssetId: string | null;
  materialApplication: MaterialApplication | null;
  propertyValues: Readonly<Record<string, unknown>>;
}

export interface RoomEditProjection {
  viewport: RoomEditSize;
  camera: RoomCameraView;
  backgroundColor: RoomEditProjectedRect;
  background: RoomEditBackgroundProjection;
  placements: readonly RoomEditPlacementProjection[];
  interactables: readonly RoomEditInteractableProjection[];
}

const fullUv: RoomEditUvRect = { x: 0, y: 0, width: 1, height: 1 };

export function fitRoomEditBackground(
  viewport: RoomEditSize,
  texture: RoomEditSize | null,
  fit: RoomData['background']['fit'],
): { rect: RoomEditRect; uv: RoomEditUvRect } {
  const rect: RoomEditRect = { x: 0, y: 0, ...viewport };
  const uv = { ...fullUv };
  if (!texture || texture.width <= 0 || texture.height <= 0 || fit === 'stretch')
    return { rect, uv };

  const textureAspect = texture.width / texture.height;
  const viewportAspect = viewport.width / viewport.height;
  if (fit === 'cover') {
    if (textureAspect > viewportAspect) {
      uv.width = viewportAspect / textureAspect;
      uv.x = (1 - uv.width) * 0.5;
    } else if (textureAspect < viewportAspect) {
      uv.height = textureAspect / viewportAspect;
      uv.y = (1 - uv.height) * 0.5;
    }
    return { rect, uv };
  }

  if (fit === 'contain') {
    const scale = Math.min(viewport.width / texture.width, viewport.height / texture.height);
    rect.width = texture.width * scale;
    rect.height = texture.height * scale;
  } else {
    rect.width = texture.width;
    rect.height = texture.height;
  }
  rect.x = (viewport.width - rect.width) * 0.5;
  rect.y = (viewport.height - rect.height) * 0.5;
  return { rect, uv };
}

export function resolveRoomEditCamera(
  presentationSpace: RoomPresentationSpace,
  camera: RoomCameraView,
): RoomCameraView {
  if (presentationSpace.edgePolicy !== 'contain') return camera;
  const bounds = presentationSpace.bounds ?? {
    x: 0,
    y: 0,
    width: presentationSpace.size.width,
    height: presentationSpace.size.height,
  };
  const radians = (camera.rotationDegrees * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const halfWidth =
    (cosine * presentationSpace.size.width + sine * presentationSpace.size.height) /
    (2 * camera.zoom);
  const halfHeight =
    (sine * presentationSpace.size.width + cosine * presentationSpace.size.height) /
    (2 * camera.zoom);
  const clampAxis = (center: number, start: number, extent: number, halfExtent: number) => {
    if (halfExtent * 2 >= extent) return start + extent * 0.5;
    return Math.min(start + extent - halfExtent, Math.max(start + halfExtent, center));
  };
  return {
    ...camera,
    center: {
      x: clampAxis(camera.center.x, bounds.x, bounds.width, halfWidth),
      y: clampAxis(camera.center.y, bounds.y, bounds.height, halfHeight),
    },
  };
}

export function projectRoomEditRect(
  rect: RoomEditRect,
  viewport: RoomEditSize,
  presentationSpace: RoomPresentationSpace,
  camera: RoomCameraView,
): RoomEditProjectedRect {
  const resolved = resolveRoomEditCamera(presentationSpace, camera);
  const centerX = (resolved.center.x / presentationSpace.size.width) * viewport.width;
  const centerY = (resolved.center.y / presentationSpace.size.height) * viewport.height;
  return {
    rect: {
      x: (rect.x - centerX) * resolved.zoom + viewport.width * 0.5,
      y: (rect.y - centerY) * resolved.zoom + viewport.height * 0.5,
      width: rect.width * resolved.zoom,
      height: rect.height * resolved.zoom,
    },
    rotationDegrees: -resolved.rotationDegrees,
  };
}

function normalizedRect(bounds: RoomNormalizedRect, viewport: RoomEditSize): RoomEditRect {
  return {
    x: bounds.x * viewport.width,
    y: bounds.y * viewport.height,
    width: bounds.width * viewport.width,
    height: bounds.height * viewport.height,
  };
}

export function resolveRoomEditProjection({
  project,
  roomId,
  room,
  viewport,
  backgroundImageSize,
}: {
  project: AuthoringProject;
  roomId: string;
  room: RoomData;
  viewport: RoomEditSize;
  backgroundImageSize: RoomEditSize | null;
}): RoomEditProjection {
  const camera = resolveRoomEditCamera(room.presentationSpace, room.presentationSpace.defaultView);
  const backgroundColor = projectRoomEditRect(
    { x: 0, y: 0, ...viewport },
    viewport,
    room.presentationSpace,
    camera,
  );
  const backgroundFit = fitRoomEditBackground(viewport, backgroundImageSize, room.background.fit);
  const projectedBackground = projectRoomEditRect(
    backgroundFit.rect,
    viewport,
    room.presentationSpace,
    camera,
  );
  const placements = room.placements.map((placement) => ({
    id: placement.id,
    normalizedBounds: placement.bounds,
    ...projectRoomEditRect(
      normalizedRect(placement.bounds, viewport),
      viewport,
      room.presentationSpace,
      camera,
    ),
  }));
  const placementsById = new Map(placements.map((placement) => [placement.id, placement]));
  const interactables = room.interactables.flatMap(
    (occurrence): RoomEditInteractableProjection[] => {
      if (!occurrence.visible) return [];
      const instance = project.interactableInstances[occurrence.interactable.$ref.id];
      if (
        !instance ||
        !instance.enabled ||
        !instance.visible ||
        instance.location.kind !== 'room' ||
        instance.location.room.$ref.id !== roomId
      )
        return [];
      const definitionRecord = project.interactables[instance.definition.$ref.id];
      const effectiveDefinitionRecord = definitionRecord
        ? resolveGameplayInstanceRecord(project, 'interactable', definitionRecord)
        : null;
      const definition = parseInteractableData(effectiveDefinitionRecord?.data);
      const placement = placementsById.get(occurrence.placementId);
      if (!definition || !placement) return [];
      return [
        {
          occurrenceId: occurrence.id,
          instanceId: instance.id,
          placementId: occurrence.placementId,
          normalizedBounds: placement.normalizedBounds,
          order: occurrence.order,
          spriteAssetId: definition.presentation.sprite?.$ref.id ?? null,
          materialApplication: effectiveMaterialApplication(
            definition.presentation.materialApplication,
            instance.materialApplication,
          ),
          propertyValues: Object.fromEntries(
            effectiveInteractableInstanceProperties(project, instance).flatMap((property) =>
              property.hasValue ? [[property.id, property.value] as const] : [],
            ),
          ),
          rect: placement.rect,
          rotationDegrees: placement.rotationDegrees,
        },
      ];
    },
  );
  interactables.sort(
    (left, right) => left.order - right.order || left.instanceId.localeCompare(right.instanceId),
  );

  return {
    viewport,
    camera,
    backgroundColor,
    background: {
      assetId: room.background.asset?.$ref.id ?? null,
      fit: room.background.fit,
      uv: backgroundFit.uv,
      color: room.background.color,
      materialApplication: room.background.materialApplication,
      ...projectedBackground,
    },
    placements,
    interactables,
  };
}
