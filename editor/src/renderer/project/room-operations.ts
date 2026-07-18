import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { parseInteractableData } from '../../shared/project-schema/authoring-interactables';
import { parseCharacterData } from '../../shared/project-schema/authoring-characters';
import { parseInteractionData, type InteractionData } from '../../shared/project-schema/authoring-interactions';
import type { InteractionProgram } from '../../shared/project-schema/authoring-interaction-programs';
import { parseRoomData, validateRoomData, type RoomData } from '../../shared/project-schema/authoring-rooms';
import { parseVerbData, type VerbData } from '../../shared/project-schema/authoring-verbs';
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

interface PlacementChanges {
  nextIds: Set<string>;
  renamed: Map<string, string>;
}

function placementChanges(previous: RoomData, next: RoomData): PlacementChanges {
  const nextIds = new Set(next.placements.map((placement) => placement.id));
  return {
    nextIds,
    renamed: new Map(previous.placements.flatMap((placement, index) => {
      const replacement = next.placements[index];
      return replacement && replacement.id !== placement.id && !nextIds.has(placement.id)
        ? [[placement.id, replacement.id] as const]
        : [];
    })),
  };
}

function repairedPlacementId(placementId: string, changes: PlacementChanges) {
  return changes.nextIds.has(placementId) ? placementId : changes.renamed.get(placementId) ?? null;
}

function repairLocalPlacementReferences(data: RoomData, changes: PlacementChanges): RoomData {
  return {
    ...data,
    cast: data.cast.map((entry) => ({ ...entry, placementId: repairedPlacementId(entry.placementId, changes) ?? entry.placementId })),
    props: data.props.map((entry) => ({ ...entry, placementId: repairedPlacementId(entry.placementId, changes) ?? entry.placementId })),
  };
}

function repairProgramPlacements(
  program: InteractionProgram,
  roomId: string,
  changes: PlacementChanges,
  path: string,
): { program: InteractionProgram; changed: boolean; failure?: EntityOperationDiagnostic } {
  let changed = false;
  const instructions = program.instructions.map((instruction) => {
    if (instruction.kind !== 'move-interactable' || instruction.target.kind !== 'room-placement' || instruction.target.placement.room !== roomId) return instruction;
    const nextPlacement = repairedPlacementId(instruction.target.placement.placement, changes);
    if (!nextPlacement) return instruction;
    if (nextPlacement === instruction.target.placement.placement) return instruction;
    changed = true;
    return { ...instruction, target: { ...instruction.target, placement: { room: roomId, placement: nextPlacement } } };
  });
  const missing = program.instructions.findIndex((instruction) => instruction.kind === 'move-interactable'
    && instruction.target.kind === 'room-placement'
    && instruction.target.placement.room === roomId
    && !repairedPlacementId(instruction.target.placement.placement, changes));
  if (missing >= 0) return { program, changed: false, failure: error('Room placement is referenced by an Interaction program and cannot be removed.', `${path}/instructions/${missing}/target/placement/placement`) };
  return { program: changed ? { ...program, instructions } : program, changed };
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
      if (!nextPlacement) return { data, changed: false, failure: error('Room placement is referenced by an Interaction context and cannot be removed.', buildJsonPointer(['interactions', interactionId, 'data', 'rules', String(index), 'context', 'placement', 'placement'])) };
      if (nextPlacement !== context.placement.placement) {
        context = { ...context, placement: { room: roomId, placement: nextPlacement } };
        changed = true;
      }
    }
    const repairedProgram = repairProgramPlacements(rule.program, roomId, changes, buildJsonPointer(['interactions', interactionId, 'data', 'rules', String(index), 'program']));
    if (repairedProgram.failure) return { data, changed: false, failure: repairedProgram.failure };
    changed ||= repairedProgram.changed;
    rules.push(context === rule.context && !repairedProgram.changed ? rule : { ...rule, context, program: repairedProgram.program });
  }
  return { data: changed ? { ...data, rules } : data, changed };
}

export function replaceRoomDataPatches(
  document: JsonValue | unknown,
  payload: ReplaceRoomDataPayload,
): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const record = document.rooms[payload.roomId];
  if (!record) return { patches: [], diagnostics: [error('Room record does not exist.', pathForRoom(payload.roomId))] };
  const incoming = parseRoomData(payload.data);
  if (!incoming) return { patches: [], diagnostics: [error('Room data is invalid.', pathForRoomData(payload.roomId))] };
  const previous = parseRoomData(record.data);
  const changes = previous ? placementChanges(previous, incoming) : null;
  const data = changes ? repairLocalPlacementReferences(incoming, changes) : incoming;
  const diagnostics = validateRoomData(document, payload.roomId, { ...record, data });
  const failure = diagnostics.find((item) => item.severity === 'error');
  if (failure) return { patches: [], diagnostics: [error(failure.message, failure.path)] };
  const patches: JsonPatchOperation[] = [{ op: 'replace', path: pathForRoomData(payload.roomId), value: toJsonValue(data) }];

  if (previous && changes) {
    for (const [interactionId, interactionRecord] of Object.entries(document.interactions)) {
      const interaction = parseInteractionData(interactionRecord.data);
      if (!interaction) continue;
      const repaired = repairInteractionPlacements(interaction, payload.roomId, changes, interactionId);
      if (repaired.failure) return { patches: [], diagnostics: [repaired.failure] };
      if (repaired.changed) patches.push({ op: 'replace', path: buildJsonPointer(['interactions', interactionId, 'data']), value: toJsonValue(repaired.data) });
    }
    for (const [verbId, verbRecord] of Object.entries(document.verbs)) {
      const verb = parseVerbData(verbRecord.data);
      if (!verb) continue;
      const repaired = repairProgramPlacements(verb.defaultProgram, payload.roomId, changes, buildJsonPointer(['verbs', verbId, 'data', 'defaultProgram']));
      if (repaired.failure) return { patches: [], diagnostics: [repaired.failure] };
      if (repaired.changed) {
        const next: VerbData = { ...verb, defaultProgram: repaired.program };
        patches.push({ op: 'replace', path: buildJsonPointer(['verbs', verbId, 'data']), value: toJsonValue(next) });
      }
    }
    for (const [interactableId, interactableRecord] of Object.entries(document.interactables)) {
      const interactable = parseInteractableData(interactableRecord.data);
      const location = interactable?.initialState.location;
      if (!interactable || location?.kind !== 'room-placement' || location.placement.room !== payload.roomId) continue;

      if (changes.nextIds.has(location.placement.placement)) continue;
      const renamed = changes.renamed.get(location.placement.placement);
      const next = {
        ...interactable,
        initialState: {
          ...interactable.initialState,
          location: renamed
            ? { kind: 'room-placement' as const, placement: { room: payload.roomId, placement: renamed } }
            : { kind: 'nowhere' as const },
        },
      };
      patches.push({
        op: 'replace',
        path: buildJsonPointer(['interactables', interactableId, 'data']),
        value: toJsonValue(next),
      });
    }
    for (const [characterId, characterRecord] of Object.entries(document.characters)) {
      const character = parseCharacterData(characterRecord.data);
      const location = character?.initialWorldState.location;
      if (!character || location?.kind !== 'room-placement' || location.placement.room !== payload.roomId || changes.nextIds.has(location.placement.placement)) continue;
      const renamed = changes.renamed.get(location.placement.placement);
      const next = { ...character, initialWorldState: { ...character.initialWorldState, location: renamed ? { kind: 'room-placement' as const, placement: { room: payload.roomId, placement: renamed } } : { kind: 'nowhere' as const } } };
      patches.push({ op: 'replace', path: buildJsonPointer(['characters', characterId, 'data']), value: toJsonValue(next) });
    }
  }

  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}
