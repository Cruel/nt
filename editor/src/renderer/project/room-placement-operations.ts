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
import { replaceRoomDataPatches } from './room-operations';
import { toJsonValue } from './json-value';

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
  const roomData: RoomData = {
    ...loaded.room,
    placements: [...loaded.room.placements, placement],
    interactables: [
      ...loaded.room.interactables,
      ...requestedInstances.map(({ instanceId, occurrenceId }, index) => ({
        id: occurrenceId,
        interactable: { $ref: { registry: 'interactableInstances' as const, id: instanceId } },
        condition: { kind: 'always' as const },
        placementId: payload.placementId,
        visible: true,
        order: loaded.room.interactables.length + index,
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
  return roomResult(document, payload.roomId, {
    ...loaded.room,
    interactables: [
      ...loaded.room.interactables,
      {
        id: payload.occurrenceId,
        interactable: { $ref: { registry: 'interactableInstances', id: payload.instanceId } },
        condition: { kind: 'always' },
        placementId: payload.placementId,
        visible: payload.visible ?? true,
        order: loaded.room.interactables.length,
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
