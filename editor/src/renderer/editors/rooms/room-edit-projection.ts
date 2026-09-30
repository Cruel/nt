import type { MaterialApplication } from '../../../shared/project-schema/authoring-material-applications';
import type {
  RoomCameraView,
  RoomData,
  RoomNormalizedRect,
  RoomPresentationSpace,
} from '../../../shared/project-schema/authoring-rooms';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  resolveArchetypeConfiguration,
  resolveGameplayInstanceRecord,
} from '../../../shared/project-schema/authoring-archetypes';
import type { AuthoringRecordBase } from '../../../shared/project-schema/authoring-project';
import { effectiveMaterialApplication } from '../../../shared/project-schema/authoring-material-applications';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { parseCharacterData } from '../../../shared/project-schema/authoring-characters';
import { resolveCharacterPresentationLayers } from '../../../shared/project-schema/character-project';
import type { Condition } from '../../../shared/project-schema/authoring-flow';
import { parseInteractableData } from '../../../shared/project-schema/authoring-interactables';
import { effectiveInteractableInstanceProperties } from '../../../shared/project-schema/authoring-interactable-properties';
import { parseVariableData } from '../../../shared/project-schema/authoring-variables';
import type { RoomPresentationPlane } from '../../../shared/project-schema/room-presentation-order';

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
  plane: 'world-content';
  order: number;
  spriteAssetId: string | null;
  materialApplication: MaterialApplication | null;
  propertyValues: Readonly<Record<string, unknown>>;
}

export interface RoomEditPropProjection extends RoomEditProjectedRect {
  occurrenceId: string;
  placementId: string;
  normalizedBounds: RoomNormalizedRect;
  plane: 'world-content';
  order: number;
  assetId: string | null;
  materialApplication: MaterialApplication | null;
}

export interface RoomEditEnvironmentProjection extends RoomEditProjectedRect {
  occurrenceId: string;
  normalizedBounds: RoomNormalizedRect;
  plane: RoomPresentationPlane;
  order: number;
  assetId: string | null;
  materialApplication: MaterialApplication;
  opacity: number;
  clock: RoomData['environments'][number]['clock'];
  scrollPerSecond: { x: number; y: number };
}

export interface RoomEditCastLayerProjection extends RoomEditProjectedRect {
  layerId: string;
  spriteAssetId: string | null;
  materialApplication: MaterialApplication | null;
  propertyValues: Readonly<Record<string, unknown>>;
}

export interface RoomEditCastProjection {
  occurrenceId: string;
  characterId: string;
  placementId: string;
  plane: 'world-content';
  order: number;
  layers: readonly RoomEditCastLayerProjection[];
}

export interface RoomEditLayoutPlaceholderProjection extends RoomEditProjectedRect {
  placementId: string;
  layoutId: string;
  label: string;
  plane: 'world-overlay';
  order: number;
  hasRenderedOccupants: boolean;
}

export type RoomEditWorldDraw =
  | ({ kind: 'environment' } & RoomEditEnvironmentProjection)
  | ({ kind: 'prop' } & RoomEditPropProjection)
  | ({ kind: 'interactable' } & RoomEditInteractableProjection)
  | ({
      kind: 'cast-layer';
      occurrenceId: string;
      characterId: string;
      placementId: string;
      plane: 'world-content';
      order: number;
      sublayer: number;
    } & RoomEditCastLayerProjection);

export interface RoomEditProjection {
  viewport: RoomEditSize;
  camera: RoomCameraView;
  backgroundColor: RoomEditProjectedRect;
  background: RoomEditBackgroundProjection;
  placements: readonly RoomEditPlacementProjection[];
  interactables: readonly RoomEditInteractableProjection[];
  props: readonly RoomEditPropProjection[];
  environments: readonly RoomEditEnvironmentProjection[];
  cast: readonly RoomEditCastProjection[];
  layoutPlaceholders: readonly RoomEditLayoutPlaceholderProjection[];
  worldDraws: readonly RoomEditWorldDraw[];
}

export interface RoomEditResolvedVisibility {
  castEntryIds: readonly string[];
  interactableOccurrenceIds: readonly string[];
  propIds: readonly string[];
  environmentIds: readonly string[];
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

function compareScalar(left: unknown, right: unknown, operator: string): boolean | null {
  if (operator === 'truthy') return Boolean(left);
  if (operator === 'falsy') return !left;
  if (operator === 'equal') return left === right;
  if (operator === 'not-equal') return left !== right;
  if (typeof left === 'number' && typeof right === 'number') {
    if (operator === 'less') return left < right;
    if (operator === 'less-equal') return left <= right;
    if (operator === 'greater') return left > right;
    if (operator === 'greater-equal') return left >= right;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (operator === 'less') return left < right;
    if (operator === 'less-equal') return left <= right;
    if (operator === 'greater') return left > right;
    if (operator === 'greater-equal') return left >= right;
  }
  return null;
}

type ConditionActivity = 'active' | 'inactive' | 'unknown';

function conditionActivity(project: AuthoringProject, condition: Condition): ConditionActivity {
  switch (condition.kind) {
    case 'always':
      return 'active';
    case 'all': {
      const children = condition.conditions.map((child) => conditionActivity(project, child));
      if (children.includes('inactive')) return 'inactive';
      return children.includes('unknown') ? 'unknown' : 'active';
    }
    case 'any': {
      const children = condition.conditions.map((child) => conditionActivity(project, child));
      if (children.includes('active')) return 'active';
      return children.includes('unknown') ? 'unknown' : 'inactive';
    }
    case 'not': {
      const child = conditionActivity(project, condition.condition);
      return child === 'unknown' ? 'unknown' : child === 'active' ? 'inactive' : 'active';
    }
    case 'variable-comparison': {
      const variable = parseVariableData(project.variables[condition.variable.$ref.id]?.data);
      if (!variable) return 'unknown';
      const result = compareScalar(variable.value, condition.value, condition.operator);
      return result === null ? 'unknown' : result ? 'active' : 'inactive';
    }
    default:
      return 'unknown';
  }
}

function conditionContributesDraw(project: AuthoringProject, condition: Condition): boolean {
  return conditionActivity(project, condition) === 'active';
}

function resolvedOccurrenceContributesDraw(
  resolvedIds: ReadonlySet<string> | null,
  occurrenceId: string,
  project: AuthoringProject,
  condition: Condition,
) {
  return resolvedIds ? resolvedIds.has(occurrenceId) : conditionContributesDraw(project, condition);
}

function imageSize(project: AuthoringProject, assetId: string | null): RoomEditSize | null {
  if (!assetId) return null;
  const asset = parseAssetData(project.assets[assetId]?.data);
  if (asset?.kind !== 'image' || !asset.imageMetadata) return null;
  return { width: asset.imageMetadata.width, height: asset.imageMetadata.height };
}

function ownerPropertyValues(
  project: AuthoringProject,
  record: AuthoringRecordBase,
  effectiveRecord: AuthoringRecordBase,
): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const traitId of effectiveRecord.traits ?? record.traits ?? []) {
    for (const property of project.traits[traitId]?.properties ?? []) {
      if (property.defaultValue !== undefined) values[property.id] = property.defaultValue;
    }
  }
  const archetypeDefaults = record.archetype
    ? (resolveArchetypeConfiguration(project, record.archetype.$ref.id)?.defaultProperties ?? [])
    : [];
  for (const property of archetypeDefaults) {
    if (property.defaultValue !== undefined) values[property.id] = property.defaultValue;
  }
  for (const property of record.defaultProperties ?? []) {
    if (property.defaultValue !== undefined) values[property.id] = property.defaultValue;
  }
  for (const property of record.localProperties ?? []) values[property.id] = property.value;
  return values;
}

function actorLayerRect(
  placement: RoomEditRect,
  layer: {
    spriteAssetId: string | null;
    offset: { x: number; y: number };
    scale: number;
    anchor: { x: number; y: number };
  },
  project: AuthoringProject,
  viewport: RoomEditSize,
): RoomEditRect {
  const size = imageSize(project, layer.spriteAssetId) ?? {
    width: viewport.width * 0.32,
    height: viewport.height * 0.78,
  };
  const width = size.width * layer.scale;
  const height = size.height * layer.scale;
  const anchorX = placement.x + placement.width * 0.5 + layer.offset.x * layer.scale;
  const anchorY = placement.y + placement.height + layer.offset.y * layer.scale;
  return {
    x: anchorX - layer.anchor.x * width,
    y: anchorY - layer.anchor.y * height,
    width,
    height,
  };
}

const planeRank: Record<RoomPresentationPlane, number> = {
  'world-background': 0,
  'world-content': 1,
  'world-overlay': 2,
};

const drawFamilyRank: Record<RoomEditWorldDraw['kind'], number> = {
  environment: 1,
  prop: 2,
  interactable: 3,
  'cast-layer': 4,
};

function worldDrawStableIdentity(draw: RoomEditWorldDraw) {
  switch (draw.kind) {
    case 'environment':
    case 'prop':
      return draw.occurrenceId;
    case 'interactable':
      return draw.instanceId;
    case 'cast-layer':
      return draw.characterId;
  }
}

export function resolveRoomEditProjection({
  project,
  roomId,
  room,
  viewport,
  backgroundImageSize,
  resolvedVisibility = null,
}: {
  project: AuthoringProject;
  roomId: string;
  room: RoomData;
  viewport: RoomEditSize;
  backgroundImageSize: RoomEditSize | null;
  resolvedVisibility?: RoomEditResolvedVisibility | null;
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
  const resolvedInteractables = resolvedVisibility
    ? new Set(resolvedVisibility.interactableOccurrenceIds)
    : null;
  const resolvedProps = resolvedVisibility ? new Set(resolvedVisibility.propIds) : null;
  const resolvedEnvironments = resolvedVisibility
    ? new Set(resolvedVisibility.environmentIds)
    : null;
  const resolvedCast = resolvedVisibility ? new Set(resolvedVisibility.castEntryIds) : null;
  const interactables = room.interactables.flatMap(
    (occurrence): RoomEditInteractableProjection[] => {
      if (
        !occurrence.visible ||
        !resolvedOccurrenceContributesDraw(
          resolvedInteractables,
          occurrence.id,
          project,
          occurrence.condition,
        )
      )
        return [];
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
          plane: 'world-content',
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

  const props = room.props.flatMap((occurrence): RoomEditPropProjection[] => {
    if (
      !occurrence.visible ||
      !resolvedOccurrenceContributesDraw(
        resolvedProps,
        occurrence.id,
        project,
        occurrence.condition,
      )
    )
      return [];
    const placement = placementsById.get(occurrence.placementId);
    if (!placement) return [];
    return [
      {
        occurrenceId: occurrence.id,
        placementId: occurrence.placementId,
        normalizedBounds: placement.normalizedBounds,
        plane: 'world-content',
        order: occurrence.order,
        assetId: occurrence.asset?.$ref.id ?? null,
        materialApplication: occurrence.materialApplication,
        rect: placement.rect,
        rotationDegrees: placement.rotationDegrees,
      },
    ];
  });

  const environments = room.environments.flatMap((occurrence): RoomEditEnvironmentProjection[] => {
    if (
      !occurrence.visible ||
      !resolvedOccurrenceContributesDraw(
        resolvedEnvironments,
        occurrence.id,
        project,
        occurrence.condition,
      )
    )
      return [];
    const projected = projectRoomEditRect(
      normalizedRect(occurrence.bounds, viewport),
      viewport,
      room.presentationSpace,
      camera,
    );
    return [
      {
        occurrenceId: occurrence.id,
        normalizedBounds: occurrence.bounds,
        plane: occurrence.plane,
        order: occurrence.order,
        assetId: occurrence.asset?.$ref.id ?? null,
        materialApplication: occurrence.materialApplication,
        opacity: occurrence.opacity,
        clock: occurrence.clock,
        scrollPerSecond: occurrence.scrollPerSecond,
        ...projected,
      },
    ];
  });

  const cast = room.cast.flatMap((occurrence): RoomEditCastProjection[] => {
    if (
      !occurrence.visible ||
      !resolvedOccurrenceContributesDraw(resolvedCast, occurrence.id, project, occurrence.condition)
    )
      return [];
    const placement = placementsById.get(occurrence.placementId);
    if (!placement) return [];
    const characterRecord = project.characters[occurrence.character.$ref.id];
    const effectiveRecord = characterRecord
      ? resolveGameplayInstanceRecord(project, 'character', characterRecord)
      : null;
    const character = parseCharacterData(effectiveRecord?.data);
    if (
      !effectiveRecord ||
      !character ||
      !character.initialWorldState.enabled ||
      !character.initialWorldState.visible ||
      character.initialWorldState.location.kind !== 'room' ||
      character.initialWorldState.location.room.$ref.id !== roomId
    )
      return [];
    const propertyValues = ownerPropertyValues(project, characterRecord, effectiveRecord);
    const layers = resolveCharacterPresentationLayers(
      character,
      occurrence.profileId ?? character.defaults.profileId,
      occurrence.poseId,
      occurrence.expressionId ?? character.defaults.expressionId,
      occurrence.appearanceId ?? character.defaults.appearanceId,
    ).flatMap((layer): RoomEditCastLayerProjection[] => {
      if (!layer.visible) return [];
      const spriteAssetId = layer.sprite?.$ref.id ?? null;
      const rawRect = actorLayerRect(
        normalizedRect(placement.normalizedBounds, viewport),
        {
          spriteAssetId,
          offset: layer.offset,
          scale: layer.scale,
          anchor: layer.anchor,
        },
        project,
        viewport,
      );
      return [
        {
          layerId: layer.id,
          spriteAssetId,
          materialApplication: layer.materialApplication,
          propertyValues,
          ...projectRoomEditRect(rawRect, viewport, room.presentationSpace, camera),
        },
      ];
    });
    return [
      {
        occurrenceId: occurrence.id,
        characterId: occurrence.character.$ref.id,
        placementId: occurrence.placementId,
        plane: 'world-content',
        order: occurrence.order,
        layers,
      },
    ];
  });

  const renderedPlacementIds = new Set<string>([
    ...interactables.flatMap((item) =>
      item.spriteAssetId || item.materialApplication ? [item.placementId] : [],
    ),
    ...props.flatMap((item) =>
      item.assetId || item.materialApplication ? [item.placementId] : [],
    ),
    ...cast.flatMap((item) =>
      item.layers.some((layer) => layer.spriteAssetId || layer.materialApplication)
        ? [item.placementId]
        : [],
    ),
  ]);
  const layoutPlaceholders = room.placements.flatMap(
    (placement): RoomEditLayoutPlaceholderProjection[] => {
      if (!placement.presentation.layout) return [];
      const projected = placementsById.get(placement.id);
      if (!projected) return [];
      const layoutId = placement.presentation.layout.$ref.id;
      return [
        {
          placementId: placement.id,
          layoutId,
          label: project.layouts[layoutId]?.label ?? layoutId,
          plane: 'world-overlay',
          order: placement.presentation.layoutOrder,
          hasRenderedOccupants: renderedPlacementIds.has(placement.id),
          rect: projected.rect,
          rotationDegrees: projected.rotationDegrees,
        },
      ];
    },
  );

  const worldDraws: RoomEditWorldDraw[] = [
    ...environments.map((item) => ({ kind: 'environment' as const, ...item })),
    ...props.flatMap((item) =>
      item.assetId || item.materialApplication ? [{ kind: 'prop' as const, ...item }] : [],
    ),
    ...interactables.flatMap((item) =>
      item.spriteAssetId || item.materialApplication
        ? [{ kind: 'interactable' as const, ...item }]
        : [],
    ),
    ...cast.flatMap((item) =>
      item.layers.flatMap((layer, sublayer) =>
        layer.spriteAssetId || layer.materialApplication
          ? [
              {
                kind: 'cast-layer' as const,
                occurrenceId: `${item.occurrenceId}:${layer.layerId}`,
                characterId: item.characterId,
                placementId: item.placementId,
                plane: item.plane,
                order: item.order,
                sublayer,
                ...layer,
              },
            ]
          : [],
      ),
    ),
  ];
  worldDraws.sort((left, right) => {
    const byPlane = planeRank[left.plane] - planeRank[right.plane];
    if (byPlane !== 0) return byPlane;
    const byOrder = left.order - right.order;
    if (byOrder !== 0) return byOrder;
    const byFamily = drawFamilyRank[left.kind] - drawFamilyRank[right.kind];
    if (byFamily !== 0) return byFamily;
    const byIdentity = worldDrawStableIdentity(left).localeCompare(worldDrawStableIdentity(right));
    if (byIdentity !== 0) return byIdentity;
    const leftSublayer = left.kind === 'cast-layer' ? left.sublayer : 0;
    const rightSublayer = right.kind === 'cast-layer' ? right.sublayer : 0;
    return leftSublayer - rightSublayer;
  });

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
    props,
    environments,
    cast,
    layoutPlaceholders,
    worldDraws,
  };
}
