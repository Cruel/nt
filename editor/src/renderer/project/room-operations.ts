import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { parseInteractableData } from '../../shared/project-schema/authoring-interactables';
import { parseRoomData, validateRoomData, type RoomData } from '../../shared/project-schema/authoring-rooms';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';

export interface ReplaceRoomDataPayload {
  roomId: string;
  data: RoomData | unknown;
}

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function pathForRoom(roomId: string) {
  return buildJsonPointer(['rooms', roomId]);
}

function pathForRoomData(roomId: string) {
  return buildJsonPointer(['rooms', roomId, 'data']);
}

export function replaceRoomDataPatches(
  document: JsonValue | unknown,
  payload: ReplaceRoomDataPayload,
): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  const record = document.rooms[payload.roomId];
  if (!record) return { patches: [], diagnostics: [error('Room record does not exist.', pathForRoom(payload.roomId))] };
  const data = parseRoomData(payload.data);
  if (!data) return { patches: [], diagnostics: [error('Room data is invalid.', pathForRoomData(payload.roomId))] };
  const diagnostics = validateRoomData(document, payload.roomId, { ...record, data });
  const failure = diagnostics.find((item) => item.severity === 'error');
  if (failure) return { patches: [], diagnostics: [error(failure.message, failure.path)] };
  const previous = parseRoomData(record.data);
  const patches: JsonPatchOperation[] = [{ op: 'replace', path: pathForRoomData(payload.roomId), value: toJsonValue(data) }];

  if (previous) {
    const previousById = new Map(previous.placements.map((placement, index) => [placement.id, { placement, index }]));
    for (const [interactableId, interactableRecord] of Object.entries(document.interactables)) {
      const interactable = parseInteractableData(interactableRecord.data);
      const location = interactable?.initialState.location;
      if (!interactable || location?.kind !== 'room-placement' || location.placement.room !== payload.roomId) continue;

      const oldPlacement = previousById.get(location.placement.placement);
      if (!oldPlacement || oldPlacement.placement.interactable.$ref.id !== interactableId) continue;

      const sameId = data.placements.find((placement) => placement.id === oldPlacement.placement.id);
      if (sameId?.interactable.$ref.id === interactableId) continue;

      const sameIndex = data.placements[oldPlacement.index];
      const replacement = sameIndex?.interactable.$ref.id === interactableId ? sameIndex.id : null;
      const next = {
        ...interactable,
        initialState: {
          ...interactable.initialState,
          location: replacement
            ? { kind: 'room-placement' as const, placement: { room: payload.roomId, placement: replacement } }
            : { kind: 'nowhere' as const },
        },
      };
      patches.push({
        op: 'replace',
        path: buildJsonPointer(['interactables', interactableId, 'data']),
        value: toJsonValue(next),
      });
    }
  }

  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}
