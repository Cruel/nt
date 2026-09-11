import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { resolveGameplayInstanceRecord } from '../../shared/project-schema/authoring-archetypes';
import {
  parseRoomData,
  validateRoomData,
  type RoomData,
} from '../../shared/project-schema/authoring-rooms';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';
import { overridesForGameplayInstanceEdit } from './archetype-operations';
import { preserveStructuredMessageIdentityPatches } from './structured-message-operations';

export interface ReplaceRoomDataPayload {
  roomId: string;
  data: unknown;
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

interface PlacementChanges {
  nextIds: Set<string>;
  renamed: Map<string, string>;
}

function renamedSemanticIds(
  previous: readonly { id: string }[],
  next: readonly { id: string }[],
): Map<string, string> {
  const nextIds = new Set(next.map((item) => item.id));
  return new Map(
    previous.flatMap((item, index) => {
      const replacement = next[index];
      return replacement && replacement.id !== item.id && !nextIds.has(item.id)
        ? [[item.id, replacement.id] as const]
        : [];
    }),
  );
}

function placementChanges(previous: RoomData, next: RoomData): PlacementChanges {
  const nextIds = new Set(next.placements.map((placement) => placement.id));
  return {
    nextIds,
    renamed: renamedSemanticIds(previous.placements, next.placements),
  };
}

function escapeSemanticPathToken(value: string) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function repairedPlacementId(placementId: string, changes: PlacementChanges) {
  return changes.nextIds.has(placementId)
    ? placementId
    : (changes.renamed.get(placementId) ?? null);
}

function repairLocalPlacementReferences(data: RoomData, changes: PlacementChanges): RoomData {
  return {
    ...data,
    cast: data.cast.map((entry) => ({
      ...entry,
      placementId: repairedPlacementId(entry.placementId, changes) ?? entry.placementId,
    })),
    props: data.props.map((entry) => ({
      ...entry,
      placementId: repairedPlacementId(entry.placementId, changes) ?? entry.placementId,
    })),
    interactables: data.interactables.flatMap((entry) => {
      const placementId = repairedPlacementId(entry.placementId, changes);
      return placementId ? [{ ...entry, placementId }] : [];
    }),
  };
}

export function replaceRoomDataPatches(
  document: unknown,
  payload: ReplaceRoomDataPayload,
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const record = document.rooms[payload.roomId];
  if (!record)
    return {
      patches: [],
      diagnostics: [error('Room record does not exist.', pathForRoom(payload.roomId))],
    };
  const incoming = parseRoomData(payload.data);
  if (!incoming)
    return {
      patches: [],
      diagnostics: [error('Room data is invalid.', pathForRoomData(payload.roomId))],
    };
  const previousRecord = resolveGameplayInstanceRecord(document, 'room', record) ?? record;
  const previous = parseRoomData(previousRecord.data);
  const changes = previous ? placementChanges(previous, incoming) : null;
  const data = changes ? repairLocalPlacementReferences(incoming, changes) : incoming;
  const diagnostics = validateRoomData(document, payload.roomId, { ...record, data });
  const failure = diagnostics.find((item) => item.severity === 'error');
  if (failure) return { patches: [], diagnostics: [error(failure.message, failure.path)] };
  const overrides = overridesForGameplayInstanceEdit(document, 'rooms', payload.roomId, {
    ...record,
    data,
  });
  if (overrides === null)
    return {
      patches: [],
      diagnostics: [error('Room Archetype configuration cannot be resolved.')],
    };
  const roomMessageBase = `/rooms/${escapeSemanticPathToken(payload.roomId)}/data`;
  const identityMoves = changes
    ? [
        ...[...changes.renamed].map(([fromId, toId]) => ({
          fromPrefix: `${roomMessageBase}/placements/@${escapeSemanticPathToken(fromId)}`,
          toPrefix: `${roomMessageBase}/placements/@${escapeSemanticPathToken(toId)}`,
        })),
        ...[...renamedSemanticIds(previous?.exits ?? [], data.exits)].map(([fromId, toId]) => ({
          fromPrefix: `${roomMessageBase}/exits/@${escapeSemanticPathToken(fromId)}`,
          toPrefix: `${roomMessageBase}/exits/@${escapeSemanticPathToken(toId)}`,
        })),
      ]
    : [];
  const messageIdentity = preserveStructuredMessageIdentityPatches(document, identityMoves);
  if (messageIdentity.conflict)
    return {
      patches: [],
      diagnostics: [error(messageIdentity.conflict.message, messageIdentity.conflict.path)],
    };

  const patches: JsonPatchOperation[] = [
    { op: 'replace', path: pathForRoomData(payload.roomId), value: toJsonValue(data) },
    ...messageIdentity.patches,
  ];
  if (record.archetype)
    patches.push({
      op: Object.prototype.hasOwnProperty.call(record, 'archetypeOverrides') ? 'replace' : 'add',
      path: buildJsonPointer(['rooms', payload.roomId, 'archetypeOverrides']),
      value: toJsonValue(overrides),
    });

  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}
