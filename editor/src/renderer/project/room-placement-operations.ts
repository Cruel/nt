import { buildJsonPointer } from '@/project/json-pointer';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';
import { resolveGameplayInstanceRecord } from '../../shared/project-schema/authoring-archetypes';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import {
  defaultInteractableInstanceData,
  parseInteractableData,
  type InteractableData,
} from '../../shared/project-schema/authoring-interactables';
import {
  parseRoomData,
  roomNormalizedRectSchema,
  type RoomData,
  type RoomNormalizedRect,
  type RoomPlacementData,
} from '../../shared/project-schema/authoring-rooms';
import { emptyMaterialApplication } from '../../shared/project-schema/authoring-material-applications';
import { replaceRoomDataPatches } from './room-operations';
import { toJsonValue } from './json-value';
import {
  allocateRoomPresentationOrder,
  allocateRoomPresentationOrders,
  reorderRoomPresentation,
  reorderRoomPresentationSelection,
  setRoomPresentationOrder,
  type RoomPresentationOrderTarget,
  type RoomPresentationReorderAction,
} from '../../shared/project-schema/room-presentation-order';

export type RoomManipulationSelectionKind =
  | 'placement'
  | 'placement-layout'
  | 'interactable'
  | 'prop'
  | 'cast'
  | 'environment'
  | 'overlay'
  | 'hotspot';

export interface RoomManipulationSelection {
  kind: RoomManipulationSelectionKind;
  id: string;
}

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function roomPath(roomId: string) {
  return buildJsonPointer(['rooms', roomId, 'data']);
}

function validBounds(bounds: RoomNormalizedRect) {
  return (
    roomNormalizedRectSchema.safeParse(bounds).success &&
    bounds.x + bounds.width <= 1 &&
    bounds.y + bounds.height <= 1
  );
}

function loadedRecords(
  document: unknown,
  roomId: string,
  interactableId?: string,
):
  | {
      room: RoomData;
      interactable?: InteractableData;
    }
  | EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const roomRecord = document.rooms[roomId];
  const room = roomRecord
    ? parseRoomData(resolveGameplayInstanceRecord(document, 'room', roomRecord)?.data)
    : null;
  if (!room)
    return {
      patches: [],
      diagnostics: [error('Room record does not exist.', roomPath(roomId))],
    };
  if (!interactableId) return { room };
  const interactableRecord = document.interactables[interactableId];
  const interactable = interactableRecord
    ? parseInteractableData(
        resolveGameplayInstanceRecord(document, 'interactable', interactableRecord)?.data,
      )
    : null;
  if (!interactable)
    return {
      patches: [],
      diagnostics: [
        error(
          'Interactable record does not exist.',
          buildJsonPointer(['interactables', interactableId, 'data']),
        ),
      ],
    };
  return { room, interactable };
}

function roomResult(document: unknown, roomId: string, room: RoomData): EntityOperationResult {
  return replaceRoomDataPatches(document, { roomId, data: room });
}

export function setRoomPlacementBoundsPatches(
  document: unknown,
  payload: { roomId: string; placementId: string; bounds: RoomNormalizedRect },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  if (!validBounds(payload.bounds))
    return {
      patches: [],
      diagnostics: [
        error(
          'Room placement bounds are invalid.',
          buildJsonPointer([
            'rooms',
            payload.roomId,
            'data',
            'placements',
            payload.placementId,
            'bounds',
          ]),
        ),
      ],
    };
  const index = loaded.room.placements.findIndex((item) => item.id === payload.placementId);
  if (index < 0)
    return {
      patches: [],
      diagnostics: [error('Room placement does not exist.', roomPath(payload.roomId))],
    };
  const placements = [...loaded.room.placements];
  placements[index] = { ...placements[index]!, bounds: payload.bounds };
  return roomResult(document, payload.roomId, { ...loaded.room, placements });
}

function placementOccupants(room: RoomData, placementId: string) {
  return [
    ...room.interactables
      .filter((item) => item.placementId === placementId)
      .map((item) => ({ kind: 'interactable' as const, id: item.id })),
    ...room.props
      .filter((item) => item.placementId === placementId)
      .map((item) => ({ kind: 'prop' as const, id: item.id })),
    ...room.cast
      .filter((item) => item.placementId === placementId)
      .map((item) => ({ kind: 'cast' as const, id: item.id })),
  ];
}

function occurrencePlacementId(room: RoomData, selection: RoomManipulationSelection) {
  switch (selection.kind) {
    case 'interactable':
      return room.interactables.find((item) => item.id === selection.id)?.placementId ?? null;
    case 'prop':
      return room.props.find((item) => item.id === selection.id)?.placementId ?? null;
    case 'cast':
      return room.cast.find((item) => item.id === selection.id)?.placementId ?? null;
    default:
      return null;
  }
}

function uniquePlacementId(room: RoomData, base: string) {
  const ids = new Set(room.placements.map((item) => item.id));
  const stem = `${base}-placement`;
  if (!ids.has(stem)) return stem;
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
}

function uniqueId(used: Iterable<string>, base: string) {
  const ids = new Set(used);
  if (!ids.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
}

function centeredBounds(point: { x: number; y: number }, width = 0.2, height = 0.2) {
  return {
    x: Math.max(0, Math.min(1 - width, point.x - width * 0.5)),
    y: Math.max(0, Math.min(1 - height, point.y - height * 0.5)),
    width,
    height,
  };
}

function reassignOccurrencePlacement(
  room: RoomData,
  selection: RoomManipulationSelection,
  placementId: string,
): RoomData {
  switch (selection.kind) {
    case 'interactable':
      return {
        ...room,
        interactables: room.interactables.map((item) =>
          item.id === selection.id ? { ...item, placementId } : item,
        ),
      };
    case 'prop':
      return {
        ...room,
        props: room.props.map((item) =>
          item.id === selection.id ? { ...item, placementId } : item,
        ),
      };
    case 'cast':
      return {
        ...room,
        cast: room.cast.map((item) => (item.id === selection.id ? { ...item, placementId } : item)),
      };
    default:
      return room;
  }
}

function clampTranslation(bounds: readonly RoomNormalizedRect[], delta: { x: number; y: number }) {
  if (bounds.length === 0) return { x: 0, y: 0 };
  const minimumX = Math.max(...bounds.map((item) => -item.x));
  const maximumX = Math.min(...bounds.map((item) => 1 - item.x - item.width));
  const minimumY = Math.max(...bounds.map((item) => -item.y));
  const maximumY = Math.min(...bounds.map((item) => 1 - item.y - item.height));
  return {
    x: Math.max(minimumX, Math.min(maximumX, delta.x)),
    y: Math.max(minimumY, Math.min(maximumY, delta.y)),
  };
}

type RoomManipulationDataResult = { room: RoomData } | { error: string };

function translatedRoomSelectionData(
  room: RoomData,
  selection: readonly RoomManipulationSelection[],
  requestedDelta: { x: number; y: number },
): RoomManipulationDataResult {
  if (!Number.isFinite(requestedDelta.x) || !Number.isFinite(requestedDelta.y))
    return { error: 'Room translation delta is invalid.' };

  const selectedPlacementIds = new Set(
    selection.flatMap((item) => (item.kind === 'placement' ? [item.id] : [])),
  );
  const selectedOccurrencesByPlacement = new Map<string, RoomManipulationSelection[]>();
  const selectedEnvironments = new Set<string>();
  for (const item of selection) {
    if (item.kind === 'environment') {
      if (!room.environments.some((environment) => environment.id === item.id))
        return { error: 'Selected Room environment does not exist.' };
      selectedEnvironments.add(item.id);
      continue;
    }
    if (item.kind === 'placement') {
      if (!room.placements.some((placement) => placement.id === item.id))
        return { error: 'Selected Room placement does not exist.' };
      continue;
    }
    const placementId = occurrencePlacementId(room, item);
    if (placementId) {
      const current = selectedOccurrencesByPlacement.get(placementId) ?? [];
      current.push(item);
      selectedOccurrencesByPlacement.set(placementId, current);
      continue;
    }
    return { error: 'Room selection contains an item that cannot be translated.' };
  }

  let nextRoom = room;
  const movingPlacementIds = new Set(selectedPlacementIds);
  for (const [sourcePlacementId, selectedOccurrences] of selectedOccurrencesByPlacement) {
    if (selectedPlacementIds.has(sourcePlacementId)) continue;
    const source = nextRoom.placements.find((item) => item.id === sourcePlacementId);
    if (!source) return { error: 'Selected occurrence placement does not exist.' };
    const occupants = placementOccupants(nextRoom, sourcePlacementId);
    const selectedKeys = new Set(selectedOccurrences.map((item) => `${item.kind}:${item.id}`));
    const allSpatialOccupantsSelected = occupants.every((item) =>
      selectedKeys.has(`${item.kind}:${item.id}`),
    );
    if (allSpatialOccupantsSelected && !source.presentation.layout) {
      movingPlacementIds.add(sourcePlacementId);
      continue;
    }

    const newPlacementId = uniquePlacementId(
      nextRoom,
      selectedOccurrences[0]?.id ?? sourcePlacementId,
    );
    nextRoom = {
      ...nextRoom,
      placements: [
        ...nextRoom.placements,
        {
          ...source,
          id: newPlacementId,
          presentation: { label: source.presentation.label, layout: null },
        },
      ],
    };
    for (const item of selectedOccurrences)
      nextRoom = reassignOccurrencePlacement(nextRoom, item, newPlacementId);
    movingPlacementIds.add(newPlacementId);
  }

  const movingBounds = [
    ...nextRoom.placements
      .filter((item) => movingPlacementIds.has(item.id))
      .map((item) => item.bounds),
    ...nextRoom.environments
      .filter((item) => selectedEnvironments.has(item.id))
      .map((item) => item.bounds),
  ];
  const delta = clampTranslation(movingBounds, requestedDelta);
  return {
    room: {
      ...nextRoom,
      placements: nextRoom.placements.map((item) =>
        movingPlacementIds.has(item.id)
          ? {
              ...item,
              bounds: { ...item.bounds, x: item.bounds.x + delta.x, y: item.bounds.y + delta.y },
            }
          : item,
      ),
      environments: nextRoom.environments.map((item) =>
        selectedEnvironments.has(item.id)
          ? {
              ...item,
              bounds: { ...item.bounds, x: item.bounds.x + delta.x, y: item.bounds.y + delta.y },
            }
          : item,
      ),
    },
  };
}

export function translateRoomSelectionData(
  room: RoomData,
  selection: readonly RoomManipulationSelection[],
  delta: { x: number; y: number },
) {
  const result = translatedRoomSelectionData(room, selection, delta);
  return 'room' in result ? result.room : null;
}

export function translateRoomSelectionPatches(
  document: unknown,
  payload: {
    roomId: string;
    selection: readonly RoomManipulationSelection[];
    delta: { x: number; y: number };
  },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  const translated = translatedRoomSelectionData(loaded.room, payload.selection, payload.delta);
  if ('error' in translated)
    return { patches: [], diagnostics: [error(translated.error, roomPath(payload.roomId))] };
  return roomResult(document, payload.roomId, translated.room);
}

function sameBounds(left: RoomNormalizedRect, right: RoomNormalizedRect) {
  const sameNumber = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
  return (
    sameNumber(left.x, right.x) &&
    sameNumber(left.y, right.y) &&
    sameNumber(left.width, right.width) &&
    sameNumber(left.height, right.height)
  );
}

function resizedRoomSelectionData(
  room: RoomData,
  selection: RoomManipulationSelection,
  bounds: RoomNormalizedRect,
): RoomManipulationDataResult {
  if (!validBounds(bounds)) return { error: 'Room resize bounds are invalid.' };

  if (selection.kind === 'environment') {
    const environment = room.environments.find((item) => item.id === selection.id);
    if (!environment) return { error: 'Selected Room environment does not exist.' };
    if (sameBounds(environment.bounds, bounds)) return { room };
    return {
      room: {
        ...room,
        environments: room.environments.map((item) =>
          item.id === selection.id ? { ...item, bounds } : item,
        ),
      },
    };
  }
  if (selection.kind === 'placement') {
    const placement = room.placements.find((item) => item.id === selection.id);
    if (!placement) return { error: 'Selected Room placement does not exist.' };
    if (sameBounds(placement.bounds, bounds)) return { room };
    return {
      room: {
        ...room,
        placements: room.placements.map((item) =>
          item.id === selection.id ? { ...item, bounds } : item,
        ),
      },
    };
  }

  const placementId = occurrencePlacementId(room, selection);
  if (!placementId) return { error: 'Selected Room item cannot be resized.' };
  const source = room.placements.find((item) => item.id === placementId);
  if (!source) return { error: 'Selected occurrence placement does not exist.' };
  if (sameBounds(source.bounds, bounds)) return { room };
  const occupants = placementOccupants(room, placementId);
  if (occupants.length <= 1 && !source.presentation.layout)
    return {
      room: {
        ...room,
        placements: room.placements.map((item) =>
          item.id === placementId ? { ...item, bounds } : item,
        ),
      },
    };

  const newPlacementId = uniquePlacementId(room, selection.id);
  let nextRoom: RoomData = {
    ...room,
    placements: [
      ...room.placements,
      {
        ...source,
        id: newPlacementId,
        bounds,
        presentation: { label: source.presentation.label, layout: null },
      },
    ],
  };
  nextRoom = reassignOccurrencePlacement(nextRoom, selection, newPlacementId);
  return { room: nextRoom };
}

export function resizeRoomSelectionData(
  room: RoomData,
  selection: RoomManipulationSelection,
  bounds: RoomNormalizedRect,
) {
  const result = resizedRoomSelectionData(room, selection, bounds);
  return 'room' in result ? result.room : null;
}

export function resizeRoomSelectionPatches(
  document: unknown,
  payload: {
    roomId: string;
    selection: RoomManipulationSelection;
    bounds: RoomNormalizedRect;
  },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  const resized = resizedRoomSelectionData(loaded.room, payload.selection, payload.bounds);
  if ('error' in resized)
    return { patches: [], diagnostics: [error(resized.error, roomPath(payload.roomId))] };
  if (resized.room === loaded.room) return { patches: [], affectedPaths: [] };
  return roomResult(document, payload.roomId, resized.room);
}

export function deleteRoomSelectionPatches(
  document: unknown,
  payload: { roomId: string; selection: readonly RoomManipulationSelection[] },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  const placementIds = new Set(
    payload.selection.flatMap((item) => (item.kind === 'placement' ? [item.id] : [])),
  );
  const idsByKind = new Map<RoomManipulationSelectionKind, Set<string>>();
  for (const item of payload.selection) {
    const ids = idsByKind.get(item.kind) ?? new Set<string>();
    ids.add(item.id);
    idsByKind.set(item.kind, ids);
  }
  const has = (kind: RoomManipulationSelectionKind, id: string) =>
    idsByKind.get(kind)?.has(id) ?? false;
  const deletedByPlacement = (placementId: string) => placementIds.has(placementId);
  const room: RoomData = {
    ...loaded.room,
    placements: loaded.room.placements
      .filter((item) => !placementIds.has(item.id))
      .map((item) =>
        has('placement-layout', item.id) && item.presentation.layout
          ? { ...item, presentation: { label: item.presentation.label, layout: null } }
          : item,
      ),
    fallbackInteractablePlacementId:
      loaded.room.fallbackInteractablePlacementId &&
      placementIds.has(loaded.room.fallbackInteractablePlacementId)
        ? null
        : loaded.room.fallbackInteractablePlacementId,
    interactables: loaded.room.interactables.filter(
      (item) => !deletedByPlacement(item.placementId) && !has('interactable', item.id),
    ),
    props: loaded.room.props.filter(
      (item) => !deletedByPlacement(item.placementId) && !has('prop', item.id),
    ),
    cast: loaded.room.cast.filter(
      (item) => !deletedByPlacement(item.placementId) && !has('cast', item.id),
    ),
    environments: loaded.room.environments.filter((item) => !has('environment', item.id)),
    overlays: loaded.room.overlays.filter((item) => !has('overlay', item.id)),
    hotspots: loaded.room.hotspots.filter((item) => !has('hotspot', item.id)),
  };
  return roomResult(document, payload.roomId, room);
}

export function setRoomPresentationOrderPatches(
  document: unknown,
  payload: { roomId: string; target: RoomPresentationOrderTarget; order: number },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  const room = setRoomPresentationOrder(loaded.room, payload.target, payload.order);
  if (!room) return { patches: [], diagnostics: [error('Room presentation order is invalid.')] };
  if (room === loaded.room) return { patches: [], affectedPaths: [] };
  return roomResult(document, payload.roomId, room);
}

export type RoomAddPresentationContentPayload =
  | {
      roomId: string;
      kind: 'placement';
      point: { x: number; y: number };
    }
  | {
      roomId: string;
      kind: 'prop';
      point?: { x: number; y: number };
      placementId?: string;
      assetId?: string;
      materialId?: string;
    }
  | {
      roomId: string;
      kind: 'cast';
      point?: { x: number; y: number };
      placementId?: string;
      characterId: string;
    }
  | {
      roomId: string;
      kind: 'interactable';
      point?: { x: number; y: number };
      placementId?: string;
      interactableId: string;
    }
  | {
      roomId: string;
      kind: 'environment';
      point: { x: number; y: number };
      materialId: string;
      assetId?: string;
    };

export function addRoomPresentationContentPatches(
  document: unknown,
  payload: RoomAddPresentationContentPayload,
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  if ('point' in payload && payload.point) {
    if (
      !Number.isFinite(payload.point.x) ||
      !Number.isFinite(payload.point.y) ||
      payload.point.x < 0 ||
      payload.point.x > 1 ||
      payload.point.y < 0 ||
      payload.point.y > 1
    )
      return { patches: [], diagnostics: [error('Room add point is invalid.')] };
  }

  if (payload.kind === 'placement') {
    const id = uniqueId(
      loaded.room.placements.map((item) => item.id),
      'placement',
    );
    return roomResult(document, payload.roomId, {
      ...loaded.room,
      placements: [
        ...loaded.room.placements,
        {
          id,
          bounds: centeredBounds(payload.point),
          presentation: { label: null, layout: null },
        },
      ],
    });
  }

  const resolvePlacement = (base: string) => {
    if ('placementId' in payload && payload.placementId) {
      const existing = loaded.room.placements.find((item) => item.id === payload.placementId);
      return existing ? { room: loaded.room, placementId: existing.id } : null;
    }
    if (!payload.point) return null;
    const placementId = uniquePlacementId(loaded.room, base);
    const placement: RoomPlacementData = {
      id: placementId,
      bounds: centeredBounds(payload.point),
      presentation: { label: null, layout: null },
    };
    return {
      room: { ...loaded.room, placements: [...loaded.room.placements, placement] },
      placementId,
    };
  };

  if (payload.kind === 'prop') {
    if (!payload.assetId && !payload.materialId)
      return { patches: [], diagnostics: [error('A Prop requires an Asset or Material.')] };
    if (payload.assetId && !document.assets[payload.assetId])
      return { patches: [], diagnostics: [error('Prop Asset does not exist.')] };
    if (payload.materialId && !document.materials[payload.materialId])
      return { patches: [], diagnostics: [error('Prop Material does not exist.')] };
    const placement = resolvePlacement('prop');
    if (!placement) return { patches: [], diagnostics: [error('Prop placement is invalid.')] };
    const id = uniqueId(
      placement.room.props.map((item) => item.id),
      'prop',
    );
    const allocated = allocateRoomPresentationOrder(placement.room, 'world-content');
    return roomResult(document, payload.roomId, {
      ...allocated.room,
      props: [
        ...allocated.room.props,
        {
          id,
          condition: { kind: 'always' },
          placementId: placement.placementId,
          asset: payload.assetId
            ? { $ref: { collection: 'assets' as const, id: payload.assetId } }
            : null,
          materialApplication: payload.materialId
            ? emptyMaterialApplication(payload.materialId)
            : null,
          visible: true,
          order: allocated.order,
        },
      ],
    });
  }

  if (payload.kind === 'cast') {
    if (!document.characters[payload.characterId])
      return { patches: [], diagnostics: [error('Character does not exist.')] };
    const placement = resolvePlacement('cast');
    if (!placement) return { patches: [], diagnostics: [error('Cast placement is invalid.')] };
    const id = uniqueId(
      placement.room.cast.map((item) => item.id),
      'cast',
    );
    const allocated = allocateRoomPresentationOrder(placement.room, 'world-content');
    return roomResult(document, payload.roomId, {
      ...allocated.room,
      cast: [
        ...allocated.room.cast,
        {
          id,
          character: { $ref: { collection: 'characters' as const, id: payload.characterId } },
          condition: { kind: 'always' },
          placementId: placement.placementId,
          profileId: null,
          poseId: null,
          expressionId: null,
          appearanceId: null,
          idleId: null,
          visible: true,
          order: allocated.order,
        },
      ],
    });
  }

  if (payload.kind === 'environment') {
    if (!document.materials[payload.materialId])
      return { patches: [], diagnostics: [error('Environment Material does not exist.')] };
    if (payload.assetId && !document.assets[payload.assetId])
      return { patches: [], diagnostics: [error('Environment Asset does not exist.')] };
    const id = uniqueId(
      loaded.room.environments.map((item) => item.id),
      'environment',
    );
    const allocated = allocateRoomPresentationOrder(loaded.room, 'world-content');
    return roomResult(document, payload.roomId, {
      ...allocated.room,
      environments: [
        ...allocated.room.environments,
        {
          id,
          condition: { kind: 'always' },
          asset: payload.assetId
            ? { $ref: { collection: 'assets' as const, id: payload.assetId } }
            : null,
          materialApplication: emptyMaterialApplication(payload.materialId),
          bounds: centeredBounds(payload.point, 0.5, 0.5),
          plane: 'world-content',
          order: allocated.order,
          clock: 'gameplay',
          scrollPerSecond: { x: 0, y: 0 },
          opacity: 1,
          visible: true,
        },
      ],
    });
  }

  if (!document.interactables[payload.interactableId])
    return { patches: [], diagnostics: [error('Interactable definition does not exist.')] };
  if (!payload.placementId) {
    if (!payload.point)
      return { patches: [], diagnostics: [error('Interactable placement point is required.')] };
    const instanceId = uniqueId(
      Object.keys(document.interactableInstances),
      payload.interactableId,
    );
    return placeInteractablePatches(document, {
      roomId: payload.roomId,
      interactableId: payload.interactableId,
      instanceId,
      placementId: uniquePlacementId(loaded.room, instanceId),
      bounds: centeredBounds(payload.point),
    });
  }

  if (!loaded.room.placements.some((item) => item.id === payload.placementId))
    return { patches: [], diagnostics: [error('Room placement does not exist.')] };
  const instanceId = uniqueId(Object.keys(document.interactableInstances), payload.interactableId);
  const occurrenceId = uniqueId(
    loaded.room.interactables.map((item) => item.id),
    instanceId,
  );
  const location = {
    kind: 'room' as const,
    room: { $ref: { collection: 'rooms' as const, id: payload.roomId } },
  };
  const prospective = structuredClone(document);
  prospective.interactableInstances[instanceId] = defaultInteractableInstanceData(
    instanceId,
    payload.interactableId,
    location,
  );
  const allocated = allocateRoomPresentationOrder(loaded.room, 'world-content');
  const result = roomResult(prospective, payload.roomId, {
    ...allocated.room,
    interactables: [
      ...allocated.room.interactables,
      {
        id: occurrenceId,
        interactable: { $ref: { registry: 'interactableInstances' as const, id: instanceId } },
        condition: { kind: 'always' },
        placementId: payload.placementId,
        visible: true,
        order: allocated.order,
      },
    ],
  });
  if (result.diagnostics?.some((item) => item.severity === 'error')) return result;
  const addInstance = {
    op: 'add' as const,
    path: buildJsonPointer(['interactableInstances', instanceId]),
    value: toJsonValue(prospective.interactableInstances[instanceId]!),
  };
  const patches = [addInstance, ...result.patches];
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function placeInteractablePatches(
  document: unknown,
  payload: {
    roomId: string;
    interactableId: string;
    instanceId: string;
    occurrenceId?: string;
    placementId: string;
    bounds: RoomNormalizedRect;
    count?: number;
  },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId, payload.interactableId);
  if ('patches' in loaded) return loaded;
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  if (!validBounds(payload.bounds))
    return { patches: [], diagnostics: [error('Room placement bounds are invalid.')] };
  if (loaded.room.placements.some((item) => item.id === payload.placementId))
    return { patches: [], diagnostics: [error('Room placement ID already exists.')] };
  const count = payload.count ?? 1;
  if (!Number.isSafeInteger(count) || count <= 0)
    return {
      patches: [],
      diagnostics: [error('Interactable count must be a positive safe integer.')],
    };
  const existingInstance = document.interactableInstances[payload.instanceId];
  if (existingInstance && count !== 1)
    return {
      patches: [],
      diagnostics: [error('Placing an existing exact Interactable Instance requires count 1.')],
    };
  if (existingInstance && existingInstance.definition.$ref.id !== payload.interactableId)
    return {
      patches: [],
      diagnostics: [error('Interactable Instance does not use the selected definition.')],
    };
  if (
    existingInstance?.location.kind === 'room' &&
    existingInstance.location.room.$ref.id !== payload.roomId
  )
    return {
      patches: [],
      diagnostics: [error('Interactable Instance is assigned to a different Room.')],
    };
  const placement: RoomPlacementData = {
    id: payload.placementId,
    bounds: payload.bounds,
    presentation: {
      label: inlineTextContent(loaded.interactable!.displayName),
      layout: null,
    },
  };
  const usedInstanceIds = new Set(Object.keys(document.interactableInstances));
  const usedOccurrenceIds = new Set(loaded.room.interactables.map((item) => item.id));
  const nextGeneratedId = (base: string, used: Set<string>) => {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    for (let index = 2; ; index += 1) {
      const candidate = `${base}-${index}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };
  const stackLimit = loaded.interactable!.stackable
    ? (loaded.interactable!.stackLimit ?? Number.MAX_SAFE_INTEGER)
    : 1;
  const requestedInstances: Array<{ instanceId: string; occurrenceId: string; quantity: number }> =
    [];
  if (existingInstance) {
    const occurrenceId = payload.occurrenceId ?? payload.instanceId;
    if (usedOccurrenceIds.has(occurrenceId))
      return {
        patches: [],
        diagnostics: [error('Room Interactable occurrence ID already exists.')],
      };
    requestedInstances.push({
      instanceId: payload.instanceId,
      occurrenceId,
      quantity: existingInstance.quantity,
    });
  } else {
    let remaining = count;
    let first = true;
    while (remaining > 0) {
      const quantity = Math.min(remaining, stackLimit);
      const instanceId = first
        ? nextGeneratedId(payload.instanceId, usedInstanceIds)
        : nextGeneratedId(payload.instanceId, usedInstanceIds);
      const occurrenceBase = first && payload.occurrenceId ? payload.occurrenceId : instanceId;
      const occurrenceId = nextGeneratedId(occurrenceBase, usedOccurrenceIds);
      requestedInstances.push({ instanceId, occurrenceId, quantity });
      remaining -= quantity;
      first = false;
    }
  }
  const allocated = allocateRoomPresentationOrders(
    loaded.room,
    'world-content',
    requestedInstances.length,
  );
  const roomData: RoomData = {
    ...allocated.room,
    placements: [...allocated.room.placements, placement],
    interactables: [
      ...allocated.room.interactables,
      ...requestedInstances.map(({ instanceId, occurrenceId }, index) => ({
        id: occurrenceId,
        interactable: { $ref: { registry: 'interactableInstances' as const, id: instanceId } },
        condition: { kind: 'always' as const },
        placementId: payload.placementId,
        visible: true,
        order: allocated.orders[index]!,
      })),
    ],
  };
  const location = {
    kind: 'room' as const,
    room: { $ref: { collection: 'rooms' as const, id: payload.roomId } },
  };
  const prospectiveDocument = structuredClone(document);
  for (const requested of requestedInstances) {
    const instance = existingInstance
      ? { ...existingInstance, location }
      : {
          ...defaultInteractableInstanceData(
            requested.instanceId,
            payload.interactableId,
            location,
          ),
          quantity: requested.quantity,
        };
    prospectiveDocument.interactableInstances[requested.instanceId] = instance;
  }
  const room = roomResult(prospectiveDocument, payload.roomId, roomData);
  if (room.diagnostics?.some((item) => item.severity === 'error')) return room;
  const alreadyInRoom =
    existingInstance?.location.kind === 'room' &&
    existingInstance.location.room.$ref.id === payload.roomId;
  const patches = [
    ...(alreadyInRoom
      ? []
      : requestedInstances.map((requested) => {
          const instance = prospectiveDocument.interactableInstances[requested.instanceId]!;
          return {
            op: existingInstance ? ('replace' as const) : ('add' as const),
            path: buildJsonPointer(['interactableInstances', requested.instanceId]),
            value: toJsonValue(instance),
          };
        })),
    ...room.patches,
  ];
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function addInteractableOccurrencePatches(
  document: unknown,
  payload: {
    roomId: string;
    instanceId: string;
    occurrenceId: string;
    placementId: string;
    visible?: boolean;
  },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const instance = document.interactableInstances[payload.instanceId];
  if (!instance)
    return { patches: [], diagnostics: [error('Interactable Instance does not exist.')] };
  if (instance.location.kind !== 'room' || instance.location.room.$ref.id !== payload.roomId)
    return {
      patches: [],
      diagnostics: [error('Interactable Instance must be semantically present in this Room.')],
    };
  if (!loaded.room.placements.some((item) => item.id === payload.placementId))
    return { patches: [], diagnostics: [error('Room placement does not exist.')] };
  if (loaded.room.interactables.some((item) => item.id === payload.occurrenceId))
    return { patches: [], diagnostics: [error('Room Interactable occurrence ID already exists.')] };
  const allocated = allocateRoomPresentationOrder(loaded.room, 'world-content');
  return roomResult(document, payload.roomId, {
    ...allocated.room,
    interactables: [
      ...allocated.room.interactables,
      {
        id: payload.occurrenceId,
        interactable: { $ref: { registry: 'interactableInstances', id: payload.instanceId } },
        condition: { kind: 'always' },
        placementId: payload.placementId,
        visible: payload.visible ?? true,
        order: allocated.order,
      },
    ],
  });
}

export function removeInteractableOccurrencePatches(
  document: unknown,
  payload: { roomId: string; occurrenceId: string },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  if (!loaded.room.interactables.some((item) => item.id === payload.occurrenceId))
    return { patches: [], diagnostics: [error('Room Interactable occurrence does not exist.')] };
  return roomResult(document, payload.roomId, {
    ...loaded.room,
    interactables: loaded.room.interactables.filter((item) => item.id !== payload.occurrenceId),
  });
}

export function unplaceInteractableInstancePatches(
  document: unknown,
  payload: { instanceId: string },
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const instance = document.interactableInstances[payload.instanceId];
  if (!instance)
    return { patches: [], diagnostics: [error('Interactable Instance does not exist.')] };
  if (instance.location.kind === 'unplaced') return { patches: [], affectedPaths: [] };
  const prospective = structuredClone(document);
  prospective.interactableInstances[payload.instanceId] = {
    ...instance,
    location: { kind: 'unplaced' },
  };
  const patches: NonNullable<EntityOperationResult['patches']> = [];
  for (const roomId of Object.keys(document.rooms)) {
    const loaded = loadedRecords(prospective, roomId);
    if ('patches' in loaded) continue;
    const interactables = loaded.room.interactables.filter(
      (entry) => entry.interactable.$ref.id !== payload.instanceId,
    );
    if (interactables.length === loaded.room.interactables.length) continue;
    const result = roomResult(prospective, roomId, { ...loaded.room, interactables });
    if (result.diagnostics?.some((item) => item.severity === 'error')) return result;
    patches.push(...result.patches);
  }
  const locationPatch = {
    op: 'replace' as const,
    path: buildJsonPointer(['interactableInstances', payload.instanceId, 'location']),
    value: toJsonValue({ kind: 'unplaced' }),
  };
  patches.unshift(locationPatch);
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function destroyInteractableInstancePatches(
  document: unknown,
  payload: { instanceId: string },
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const instance = document.interactableInstances[payload.instanceId];
  if (!instance)
    return { patches: [], diagnostics: [error('Interactable Instance does not exist.')] };

  const contained = Object.entries(document.interactableInstances).find(([id, candidate]) => {
    if (id === payload.instanceId || candidate.location.kind !== 'inventory') return false;
    const owner = candidate.location.inventory.owner;
    return (
      (owner.kind === 'interactable' || owner.kind === 'interactable-feature') &&
      owner.interactable.$ref.id === payload.instanceId
    );
  });
  if (contained)
    return {
      patches: [],
      diagnostics: [
        error(
          `Interactable Instance '${payload.instanceId}' contains '${contained[0]}'; move or destroy contained Instances first.`,
        ),
      ],
    };

  const prospective = structuredClone(document);
  delete prospective.interactableInstances[payload.instanceId];
  const patches: NonNullable<EntityOperationResult['patches']> = [];
  for (const roomId of Object.keys(document.rooms)) {
    const loaded = loadedRecords(prospective, roomId);
    if ('patches' in loaded) continue;
    const interactables = loaded.room.interactables.filter(
      (entry) => entry.interactable.$ref.id !== payload.instanceId,
    );
    if (interactables.length === loaded.room.interactables.length) continue;
    const result = roomResult(prospective, roomId, { ...loaded.room, interactables });
    if (result.diagnostics?.some((item) => item.severity === 'error')) return result;
    patches.push(...result.patches);
    prospective.rooms[roomId] = {
      ...prospective.rooms[roomId]!,
      data: { ...loaded.room, interactables },
    };
  }
  const remove = {
    op: 'remove' as const,
    path: buildJsonPointer(['interactableInstances', payload.instanceId]),
  };
  patches.unshift(remove);
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function setRoomFallbackInteractablePlacementPatches(
  document: unknown,
  payload: { roomId: string; placementId: string | null },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  if (
    payload.placementId &&
    !loaded.room.placements.some((item) => item.id === payload.placementId)
  )
    return { patches: [], diagnostics: [error('Room placement does not exist.')] };
  return roomResult(document, payload.roomId, {
    ...loaded.room,
    fallbackInteractablePlacementId: payload.placementId,
  });
}

export function moveInteractableToPlacementPatches(
  document: unknown,
  payload: { roomId: string; occurrenceId: string; placementId: string },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  if (!loaded.room.placements.some((item) => item.id === payload.placementId))
    return { patches: [], diagnostics: [error('Room placement does not exist.')] };
  if (!loaded.room.interactables.some((item) => item.id === payload.occurrenceId))
    return { patches: [], diagnostics: [error('Room Interactable occurrence does not exist.')] };
  return roomResult(document, payload.roomId, {
    ...loaded.room,
    interactables: loaded.room.interactables.map((item) =>
      item.id === payload.occurrenceId ? { ...item, placementId: payload.placementId } : item,
    ),
  });
}

export function detachInteractablePlacementPatches(
  document: unknown,
  payload: {
    roomId: string;
    occurrenceId: string;
    sourcePlacementId: string;
    placementId: string;
  },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  if (loaded.room.placements.some((item) => item.id === payload.placementId))
    return { patches: [], diagnostics: [error('Room placement ID already exists.')] };
  const source = loaded.room.placements.find((item) => item.id === payload.sourcePlacementId);
  if (!source)
    return { patches: [], diagnostics: [error('Source Room placement does not exist.')] };
  const instance = loaded.room.interactables.find((item) => item.id === payload.occurrenceId);
  if (!instance || instance.placementId !== payload.sourcePlacementId)
    return {
      patches: [],
      diagnostics: [error('Interactable is not assigned to the source Room placement.')],
    };
  const placement: RoomPlacementData = {
    ...source,
    id: payload.placementId,
    presentation: {
      label: source.presentation.label,
      layout: null,
    },
  };
  return roomResult(document, payload.roomId, {
    ...loaded.room,
    placements: [...loaded.room.placements, placement],
    interactables: loaded.room.interactables.map((item) =>
      item.id === payload.occurrenceId ? { ...item, placementId: payload.placementId } : item,
    ),
  });
}

export function reorderRoomPresentationPatches(
  document: unknown,
  payload: {
    roomId: string;
    target: RoomPresentationOrderTarget;
    action: RoomPresentationReorderAction;
  },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  const room = reorderRoomPresentation(loaded.room, payload.target, payload.action);
  if (!room)
    return {
      patches: [],
      diagnostics: [
        error('Room presentation occurrence does not exist.', roomPath(payload.roomId)),
      ],
    };
  if (room === loaded.room) return { patches: [], affectedPaths: [] };
  return roomResult(document, payload.roomId, room);
}

export function reorderRoomPresentationSelectionPatches(
  document: unknown,
  payload: {
    roomId: string;
    targets: RoomPresentationOrderTarget[];
    action: RoomPresentationReorderAction;
  },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  const room = reorderRoomPresentationSelection(loaded.room, payload.targets, payload.action);
  if (!room)
    return {
      patches: [],
      diagnostics: [
        error(
          'Room presentation selection must contain unique occurrences in one Presentation Plane.',
          roomPath(payload.roomId),
        ),
      ],
    };
  if (room === loaded.room) return { patches: [], affectedPaths: [] };
  return roomResult(document, payload.roomId, room);
}
