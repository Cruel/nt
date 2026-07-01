import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
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
  const patch: JsonPatchOperation = { op: 'replace', path: pathForRoomData(payload.roomId), value: toJsonValue(data) };
  return { patches: [patch], affectedPaths: [patch.path] };
}
