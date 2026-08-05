import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import type { JsonPatchOperation } from '@/project/json-patch';
import type { EntityOperationResult } from './entity-operations';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  parseRoomData,
  type RoomData,
  type RoomHotspotData,
} from '../../shared/project-schema/authoring-rooms';
import {
  defaultHotspotBehavior,
  imageNormalizedRectSchema,
} from '../../shared/project-schema/authoring-hotspots';
import {
  parseInteractableData,
  type InteractableData,
} from '../../shared/project-schema/authoring-interactables';
import { parseInteractionData } from '../../shared/project-schema/authoring-interactions';

const error = (message: string, path?: string) => ({ severity: 'error' as const, message, path });

function hotspotReferences(
  document: unknown,
  kind: 'room' | 'interactable',
  ownerId: string,
  hotspotId: string,
) {
  if (!isAuthoringProject(document)) return [];
  return Object.entries(document.interactions).flatMap(([interactionId, record]) => {
    const data = parseInteractionData(record.data);
    return (
      data?.rules.flatMap((rule, index) => {
        if (rule.context.kind !== 'hotspot') return [];
        const ref = rule.context.hotspot;
        const matches =
          kind === 'room'
            ? ref.kind === 'room-hotspot' &&
              ref.room.$ref.id === ownerId &&
              ref.hotspotId === hotspotId
            : ref.kind === 'interactable-hotspot' &&
              ref.interactable.$ref.id === ownerId &&
              ref.hotspotId === hotspotId;
        return matches
          ? [
              buildJsonPointer([
                'interactions',
                interactionId,
                'data',
                'rules',
                String(index),
                'context',
                'hotspot',
              ]),
            ]
          : [];
      }) ?? []
    );
  });
}

function roomPatch(roomId: string, data: RoomData): JsonPatchOperation {
  return {
    op: 'replace',
    path: buildJsonPointer(['rooms', roomId, 'data']),
    value: toJsonValue(data),
  };
}

function interactablePatch(interactableId: string, data: InteractableData): JsonPatchOperation {
  return {
    op: 'replace',
    path: buildJsonPointer(['interactables', interactableId, 'data']),
    value: toJsonValue(data),
  };
}

export function updateRoomHotspots(
  document: unknown,
  roomId: string,
  update: (data: RoomData) => RoomData | null,
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const data = parseRoomData(document.rooms[roomId]?.data);
  if (!data)
    return { patches: [], diagnostics: [error('Room record does not exist or is invalid.')] };
  const next = update(data);
  if (!next) return { patches: [], diagnostics: [error('Hotspot operation was refused.')] };
  const patch = roomPatch(roomId, next);
  return { patches: [patch], affectedPaths: [patch.path] };
}

export function updateInteractableHotspots(
  document: unknown,
  interactableId: string,
  update: (data: InteractableData) => InteractableData | null,
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const data = parseInteractableData(document.interactables[interactableId]?.data);
  if (!data)
    return {
      patches: [],
      diagnostics: [error('Interactable record does not exist or is invalid.')],
    };
  const next = update(data);
  if (!next) return { patches: [], diagnostics: [error('Hotspot operation was refused.')] };
  const patch = interactablePatch(interactableId, next);
  return { patches: [patch], affectedPaths: [patch.path] };
}

export function deleteRoomHotspot(
  document: unknown,
  roomId: string,
  hotspotId: string,
): EntityOperationResult {
  const references = hotspotReferences(document, 'room', roomId, hotspotId);
  if (references.length)
    return {
      patches: [],
      diagnostics: [
        error('Hotspot is referenced by an Interaction rule and cannot be deleted.', references[0]),
      ],
    };
  return updateRoomHotspots(document, roomId, (data) => ({
    ...data,
    hotspots: data.hotspots.filter((item) => item.id !== hotspotId),
  }));
}

export function deleteInteractableHotspot(
  document: unknown,
  interactableId: string,
  hotspotId: string,
): EntityOperationResult {
  const references = hotspotReferences(document, 'interactable', interactableId, hotspotId);
  if (references.length)
    return {
      patches: [],
      diagnostics: [
        error('Hotspot is referenced by an Interaction rule and cannot be deleted.', references[0]),
      ],
    };
  return updateInteractableHotspots(document, interactableId, (data) =>
    data.presentation.hotspots.kind !== 'custom'
      ? null
      : {
          ...data,
          presentation: {
            ...data.presentation,
            hotspots: {
              kind: 'custom',
              hotspots: data.presentation.hotspots.hotspots.filter((item) => item.id !== hotspotId),
            },
          },
        },
  );
}

export function renameHotspot(
  document: unknown,
  kind: 'room' | 'interactable',
  ownerId: string,
  hotspotId: string,
  nextId: string,
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const patches: JsonPatchOperation[] = [];
  if (kind === 'room') {
    const data = parseRoomData(document.rooms[ownerId]?.data);
    if (!data || data.hotspots.some((item) => item.id === nextId))
      return { patches: [], diagnostics: [error('Hotspot ID is invalid or already exists.')] };
    patches.push(
      roomPatch(ownerId, {
        ...data,
        hotspots: data.hotspots.map((item) =>
          item.id === hotspotId ? { ...item, id: nextId } : item,
        ),
      }),
    );
  } else {
    const data = parseInteractableData(document.interactables[ownerId]?.data);
    if (!data) return { patches: [], diagnostics: [error('Interactable record is invalid.')] };
    const items =
      data.presentation.hotspots.kind === 'sprite-alpha'
        ? [data.presentation.hotspots.hotspot]
        : data.presentation.hotspots.hotspots;
    if (items.some((item) => item.id === nextId))
      return { patches: [], diagnostics: [error('Hotspot ID is invalid or already exists.')] };
    const hotspots =
      data.presentation.hotspots.kind === 'sprite-alpha'
        ? {
            kind: 'sprite-alpha' as const,
            hotspot: { ...data.presentation.hotspots.hotspot, id: nextId },
          }
        : {
            kind: 'custom' as const,
            hotspots: data.presentation.hotspots.hotspots.map((item) =>
              item.id === hotspotId ? { ...item, id: nextId } : item,
            ),
          };
    patches.push(
      interactablePatch(ownerId, { ...data, presentation: { ...data.presentation, hotspots } }),
    );
  }
  for (const [interactionId, record] of Object.entries(document.interactions)) {
    const data = parseInteractionData(record.data);
    if (!data) continue;
    let changed = false;
    const rules = data.rules.map((rule) => {
      if (rule.context.kind !== 'hotspot') return rule;
      const ref = rule.context.hotspot;
      const matches =
        kind === 'room'
          ? ref.kind === 'room-hotspot' &&
            ref.room.$ref.id === ownerId &&
            ref.hotspotId === hotspotId
          : ref.kind === 'interactable-hotspot' &&
            ref.interactable.$ref.id === ownerId &&
            ref.hotspotId === hotspotId;
      if (!matches) return rule;
      changed = true;
      return {
        ...rule,
        context: { kind: 'hotspot' as const, hotspot: { ...ref, hotspotId: nextId } },
      };
    });
    if (changed)
      patches.push({
        op: 'replace',
        path: buildJsonPointer(['interactions', interactionId, 'data']),
        value: toJsonValue({ ...data, rules }),
      });
  }
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function setInteractableHotspotMode(
  document: unknown,
  interactableId: string,
  kind: 'sprite-alpha' | 'custom',
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const data = parseInteractableData(document.interactables[interactableId]?.data);
  if (!data) return { patches: [], diagnostics: [error('Interactable record is invalid.')] };
  if (data.presentation.hotspots.kind === kind) return { patches: [], affectedPaths: [] };
  const removed =
    data.presentation.hotspots.kind === 'sprite-alpha'
      ? [data.presentation.hotspots.hotspot.id]
      : data.presentation.hotspots.hotspots.map((item) => item.id);
  const reference = removed.flatMap((id) =>
    hotspotReferences(document, 'interactable', interactableId, id),
  )[0];
  if (reference)
    return {
      patches: [],
      diagnostics: [
        error('Mode switch would remove a hotspot referenced by an Interaction rule.', reference),
      ],
    };
  const hotspots =
    kind === 'custom'
      ? { kind: 'custom' as const, hotspots: [] }
      : { kind: 'sprite-alpha' as const, hotspot: defaultHotspotBehavior(data.displayName) };
  const patch = interactablePatch(interactableId, {
    ...data,
    presentation: { ...data.presentation, hotspots },
  });
  return { patches: [patch], affectedPaths: [patch.path] };
}

export function validBounds(value: unknown) {
  return imageNormalizedRectSchema.safeParse(value).success;
}

export type RoomHotspotUpdate = Omit<RoomHotspotData, 'id' | 'shape'>;
