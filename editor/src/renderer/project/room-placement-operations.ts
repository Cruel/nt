import { buildJsonPointer } from '@/project/json-pointer';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';
import { resolveGameplayInstanceRecord } from '../../shared/project-schema/authoring-archetypes';
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
import { replaceInteractableDataPatches } from './interactable-operations';
import { replaceRoomDataPatches } from './room-operations';

const INT32_MAX = 2_147_483_647;

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

export function placeInteractablePatches(
  document: unknown,
  payload: {
    roomId: string;
    interactableId: string;
    instanceId: string;
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
  if (loaded.room.interactables.some((item) => item.id === payload.instanceId))
    return { patches: [], diagnostics: [error('Room Interactable instance ID already exists.')] };
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
  const room = roomResult(document, payload.roomId, {
    ...loaded.room,
    placements: [...loaded.room.placements, placement],
    interactables: [
      ...loaded.room.interactables,
      {
        id: payload.instanceId,
        interactable: {
          $ref: { collection: 'interactables', id: payload.interactableId },
        },
        condition: { kind: 'always' },
        placementId: payload.placementId,
        visible: loaded.interactable!.initialState.visible,
        order: loaded.room.interactables.length,
      },
    ],
  });
  if (room.diagnostics?.some((item) => item.severity === 'error')) return room;
  const interactable = replaceInteractableDataPatches(document, {
    interactableId: payload.interactableId,
    data: {
      ...loaded.interactable!,
      initialState: {
        ...loaded.interactable!.initialState,
        location: {
          kind: 'room',
          room: { $ref: { collection: 'rooms', id: payload.roomId } },
        },
      },
    },
  });
  if (interactable.diagnostics?.some((item) => item.severity === 'error')) return interactable;
  const patches = [...room.patches, ...interactable.patches];
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function moveInteractableToPlacementPatches(
  document: unknown,
  payload: { roomId: string; interactableId: string; placementId: string },
): EntityOperationResult {
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  if (!loaded.room.placements.some((item) => item.id === payload.placementId))
    return { patches: [], diagnostics: [error('Room placement does not exist.')] };
  if (!loaded.room.interactables.some((item) => item.id === payload.interactableId))
    return { patches: [], diagnostics: [error('Room Interactable instance does not exist.')] };
  return roomResult(document, payload.roomId, {
    ...loaded.room,
    interactables: loaded.room.interactables.map((item) =>
      item.id === payload.interactableId ? { ...item, placementId: payload.placementId } : item,
    ),
  });
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
  const loaded = loadedRecords(document, payload.roomId);
  if ('patches' in loaded) return loaded;
  if (loaded.room.placements.some((item) => item.id === payload.placementId))
    return { patches: [], diagnostics: [error('Room placement ID already exists.')] };
  const source = loaded.room.placements.find((item) => item.id === payload.sourcePlacementId);
  if (!source)
    return { patches: [], diagnostics: [error('Source Room placement does not exist.')] };
  const instance = loaded.room.interactables.find((item) => item.id === payload.interactableId);
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
      item.id === payload.interactableId ? { ...item, placementId: payload.placementId } : item,
    ),
  });
}
