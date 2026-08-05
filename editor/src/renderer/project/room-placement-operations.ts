import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import {
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

const INT32_MAX = 2_147_483_647;

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function roomPath(roomId: string) {
  return buildJsonPointer(['rooms', roomId, 'data']);
}

function interactablePath(interactableId: string) {
  return buildJsonPointer(['interactables', interactableId, 'data']);
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
  const room = parseRoomData(document.rooms[roomId]?.data);
  if (!room)
    return {
      patches: [],
      diagnostics: [error('Room record does not exist.', roomPath(roomId))],
    };
  if (!interactableId) return { room };
  const interactable = parseInteractableData(document.interactables[interactableId]?.data);
  if (!interactable)
    return {
      patches: [],
      diagnostics: [
        error('Interactable record does not exist.', interactablePath(interactableId)),
      ],
    };
  return { room, interactable };
}

function locationAt(roomId: string, placementId: string) {
  return {
    kind: 'room-placement' as const,
    placement: { room: roomId, placement: placementId },
  };
}

function moveInteractable(
  interactable: InteractableData,
  roomId: string,
  placementId: string,
): InteractableData {
  return {
    ...interactable,
    initialState: {
      ...interactable.initialState,
      location: locationAt(roomId, placementId),
    },
  };
}

function crossRecordResult(
  roomId: string,
  room: RoomData,
  interactableId: string,
  interactable: InteractableData,
): EntityOperationResult {
  const patches = [
    { op: 'replace' as const, path: roomPath(roomId), value: toJsonValue(room) },
    {
      op: 'replace' as const,
      path: interactablePath(interactableId),
      value: toJsonValue(interactable),
    },
  ];
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
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
  const patch = {
    op: 'replace' as const,
    path: roomPath(payload.roomId),
    value: toJsonValue({ ...loaded.room, placements }),
  };
  return { patches: [patch], affectedPaths: [patch.path] };
}

export function placeInteractablePatches(
  document: unknown,
  payload: {
    roomId: string;
    interactableId: string;
    placementId: string;
    bounds: RoomNormalizedRect;
  },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId, payload.interactableId);
  if ('patches' in loaded) return loaded;
  if (!validBounds(payload.bounds))
    return { patches: [], diagnostics: [error('Room placement bounds are invalid.')] };
  if (loaded.room.placements.some((item) => item.id === payload.placementId))
    return { patches: [], diagnostics: [error('Room placement ID already exists.')] };
  const maximumOrder = loaded.room.placements.reduce(
    (maximum, placement) => Math.max(maximum, placement.order ?? 0),
    -1,
  );
  const placement: RoomPlacementData = {
    id: payload.placementId,
    bounds: payload.bounds,
    order: maximumOrder >= INT32_MAX ? INT32_MAX : maximumOrder + 1,
    presentation: {
      label: inlineTextContent(loaded.interactable!.displayName),
      layout: null,
    },
  };
  return crossRecordResult(
    payload.roomId,
    { ...loaded.room, placements: [...loaded.room.placements, placement] },
    payload.interactableId,
    moveInteractable(loaded.interactable!, payload.roomId, payload.placementId),
  );
}

export function moveInteractableToPlacementPatches(
  document: unknown,
  payload: { roomId: string; interactableId: string; placementId: string },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId, payload.interactableId);
  if ('patches' in loaded) return loaded;
  if (!loaded.room.placements.some((item) => item.id === payload.placementId))
    return { patches: [], diagnostics: [error('Room placement does not exist.')] };
  const patch = {
    op: 'replace' as const,
    path: interactablePath(payload.interactableId),
    value: toJsonValue(
      moveInteractable(loaded.interactable!, payload.roomId, payload.placementId),
    ),
  };
  return { patches: [patch], affectedPaths: [patch.path] };
}

export function detachInteractablePlacementPatches(
  document: unknown,
  payload: {
    roomId: string;
    interactableId: string;
    sourcePlacementId: string;
    placementId: string;
  },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId, payload.interactableId);
  if ('patches' in loaded) return loaded;
  if (loaded.room.placements.some((item) => item.id === payload.placementId))
    return { patches: [], diagnostics: [error('Room placement ID already exists.')] };
  const source = loaded.room.placements.find((item) => item.id === payload.sourcePlacementId);
  if (!source)
    return { patches: [], diagnostics: [error('Source Room placement does not exist.')] };
  const current = loaded.interactable!.initialState.location;
  if (
    current.kind !== 'room-placement' ||
    current.placement.room !== payload.roomId ||
    current.placement.placement !== payload.sourcePlacementId
  )
    return {
      patches: [],
      diagnostics: [error('Interactable is not assigned to the source Room placement.')],
    };
  const placement: RoomPlacementData = {
    ...source,
    id: payload.placementId,
    presentation: {
      label: inlineTextContent(loaded.interactable!.displayName),
      layout: null,
    },
  };
  return crossRecordResult(
    payload.roomId,
    { ...loaded.room, placements: [...loaded.room.placements, placement] },
    payload.interactableId,
    moveInteractable(loaded.interactable!, payload.roomId, payload.placementId),
  );
}
