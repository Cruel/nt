import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { resolveGameplayInstanceRecord } from '../../shared/project-schema/authoring-archetypes';
import {
  parseInteractionData,
  type InteractionData,
} from '../../shared/project-schema/authoring-interactions';
import {
  parseRoomData,
  validateRoomData,
  type RoomData,
} from '../../shared/project-schema/authoring-rooms';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';
import { overridesForGameplayInstanceEdit } from './archetype-operations';

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

function placementChanges(previous: RoomData, next: RoomData): PlacementChanges {
  const nextIds = new Set(next.placements.map((placement) => placement.id));
  return {
    nextIds,
    renamed: new Map(
      previous.placements.flatMap((placement, index) => {
        const replacement = next.placements[index];
        return replacement && replacement.id !== placement.id && !nextIds.has(placement.id)
          ? [[placement.id, replacement.id] as const]
          : [];
      }),
    ),
  };
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

function repairInteractionPlacements(
  data: InteractionData,
  roomId: string,
  changes: PlacementChanges,
  interactionId: string,
): { data: InteractionData; changed: boolean; failure?: EntityOperationDiagnostic } {
  let changed = false;
  const rules = [] as InteractionData['rules'];
  for (const [index, rule] of data.rules.entries()) {
    let context = rule.context;
    if (context.kind === 'room-placement' && context.placement.room === roomId) {
      const nextPlacement = repairedPlacementId(context.placement.placement, changes);
      if (!nextPlacement)
        return {
          data,
          changed: false,
          failure: error(
            'Room placement is referenced by an Interaction context and cannot be removed.',
            buildJsonPointer([
              'interactions',
              interactionId,
              'data',
              'rules',
              String(index),
              'context',
              'placement',
              'placement',
            ]),
          ),
        };
      if (nextPlacement !== context.placement.placement) {
        context = { ...context, placement: { room: roomId, placement: nextPlacement } };
        changed = true;
      }
    }
    rules.push(context === rule.context ? rule : { ...rule, context });
  }
  return { data: changed ? { ...data, rules } : data, changed };
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
  const patches: JsonPatchOperation[] = [
    { op: 'replace', path: pathForRoomData(payload.roomId), value: toJsonValue(data) },
  ];
  if (record.archetype)
    patches.push({
      op: Object.prototype.hasOwnProperty.call(record, 'archetypeOverrides') ? 'replace' : 'add',
      path: buildJsonPointer(['rooms', payload.roomId, 'archetypeOverrides']),
      value: toJsonValue(overrides),
    });

  if (previous && changes) {
    for (const [interactionId, interactionRecord] of Object.entries(document.interactions)) {
      const interaction = parseInteractionData(interactionRecord.data);
      if (!interaction) continue;
      const repaired = repairInteractionPlacements(
        interaction,
        payload.roomId,
        changes,
        interactionId,
      );
      if (repaired.failure) return { patches: [], diagnostics: [repaired.failure] };
      if (repaired.changed)
        patches.push({
          op: 'replace',
          path: buildJsonPointer(['interactions', interactionId, 'data']),
          value: toJsonValue(repaired.data),
        });
    }
  }

  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}
