import type { JsonPatchOperation } from '@/project/json-patch';
import type { EntityOperationResult } from './entity-operations';
import { resolveGameplayInstanceRecord } from '../../shared/project-schema/authoring-archetypes';
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
import { replaceInteractableDataPatches } from './interactable-operations';
import { replaceRoomDataPatches } from './room-operations';

const error = (message: string, path?: string) => ({ severity: 'error' as const, message, path });

function resolvedRoomData(
  document: Parameters<typeof resolveGameplayInstanceRecord>[0],
  roomId: string,
) {
  const record = document.rooms[roomId];
  return record
    ? parseRoomData(resolveGameplayInstanceRecord(document, 'room', record)?.data)
    : null;
}

function resolvedInteractableData(
  document: Parameters<typeof resolveGameplayInstanceRecord>[0],
  interactableId: string,
) {
  const record = document.interactables[interactableId];
  return record
    ? parseInteractableData(resolveGameplayInstanceRecord(document, 'interactable', record)?.data)
    : null;
}

export function updateRoomHotspots(
  document: unknown,
  roomId: string,
  update: (data: RoomData) => RoomData | null,
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const data = resolvedRoomData(document, roomId);
  if (!data)
    return { patches: [], diagnostics: [error('Room record does not exist or is invalid.')] };
  const next = update(data);
  if (!next) return { patches: [], diagnostics: [error('Hotspot operation was refused.')] };
  return replaceRoomDataPatches(document, { roomId, data: next });
}

export function updateInteractableHotspots(
  document: unknown,
  interactableId: string,
  update: (data: InteractableData) => InteractableData | null,
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const data = resolvedInteractableData(document, interactableId);
  if (!data)
    return {
      patches: [],
      diagnostics: [error('Interactable record does not exist or is invalid.')],
    };
  const next = update(data);
  if (!next) return { patches: [], diagnostics: [error('Hotspot operation was refused.')] };
  return replaceInteractableDataPatches(document, { interactableId, data: next });
}

export function deleteRoomHotspot(
  document: unknown,
  roomId: string,
  hotspotId: string,
): EntityOperationResult {
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
    const data = resolvedRoomData(document, ownerId);
    if (!data)
      return { patches: [], diagnostics: [error('Room record does not exist or is invalid.')] };
    if (!data.hotspots.some((item) => item.id === hotspotId))
      return { patches: [], diagnostics: [error('Hotspot does not exist.')] };
    if (hotspotId !== nextId && data.hotspots.some((item) => item.id === nextId))
      return { patches: [], diagnostics: [error('Hotspot ID is invalid or already exists.')] };
    const replacement = replaceRoomDataPatches(document, {
      roomId: ownerId,
      data: {
        ...data,
        hotspots: data.hotspots.map((item) =>
          item.id === hotspotId ? { ...item, id: nextId } : item,
        ),
      },
    });
    if (replacement.diagnostics?.some((item) => item.severity === 'error')) return replacement;
    patches.push(...replacement.patches);
  } else {
    const data = resolvedInteractableData(document, ownerId);
    if (!data) return { patches: [], diagnostics: [error('Interactable record is invalid.')] };
    const items =
      data.presentation.hotspots.kind === 'none'
        ? []
        : data.presentation.hotspots.kind === 'sprite-alpha'
          ? [data.presentation.hotspots.hotspot]
          : data.presentation.hotspots.hotspots;
    if (!items.some((item) => item.id === hotspotId))
      return { patches: [], diagnostics: [error('Hotspot does not exist.')] };
    if (hotspotId !== nextId && items.some((item) => item.id === nextId))
      return { patches: [], diagnostics: [error('Hotspot ID is invalid or already exists.')] };
    if (data.presentation.hotspots.kind === 'none')
      return { patches: [], diagnostics: [error('Hotspot does not exist.')] };
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
    const replacement = replaceInteractableDataPatches(document, {
      interactableId: ownerId,
      data: { ...data, presentation: { ...data.presentation, hotspots } },
    });
    if (replacement.diagnostics?.some((item) => item.severity === 'error')) return replacement;
    patches.push(...replacement.patches);
  }
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function setInteractableHotspotMode(
  document: unknown,
  interactableId: string,
  kind: 'none' | 'sprite-alpha' | 'custom',
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const data = resolvedInteractableData(document, interactableId);
  if (!data) return { patches: [], diagnostics: [error('Interactable record is invalid.')] };
  if (data.presentation.hotspots.kind === kind) return { patches: [], affectedPaths: [] };
  const hotspots =
    kind === 'none'
      ? { kind: 'none' as const }
      : kind === 'custom'
        ? { kind: 'custom' as const, hotspots: [] }
        : { kind: 'sprite-alpha' as const, hotspot: defaultHotspotBehavior(data.displayName) };
  return replaceInteractableDataPatches(document, {
    interactableId,
    data: {
      ...data,
      presentation: { ...data.presentation, hotspots },
    },
  });
}

export function validBounds(value: unknown) {
  return imageNormalizedRectSchema.safeParse(value).success;
}

export type RoomHotspotUpdate = Omit<RoomHotspotData, 'id' | 'shape'>;
