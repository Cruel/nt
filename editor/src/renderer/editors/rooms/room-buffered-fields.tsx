import { NativeBufferedInput } from '@/commands/use-native-field-draft';
import type { CommandRequest } from '@/commands/command-types';
import { useProjectStore } from '@/project/project-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { diffJsonDocuments } from '@/project/project-external-reconciliation';
import { applyJsonPatch } from '@/project/json-patch';
import { toJsonValue } from '@/project/json-value';
import { isAuthoringProjectView } from '../../../shared/project-schema/authoring-project-view';
import { resolveGameplayInstanceRecord } from '../../../shared/project-schema/authoring-archetypes';
import {
  defaultRoomData,
  parseRoomData,
  type RoomData,
} from '../../../shared/project-schema/authoring-rooms';

export function bufferedRoomFieldCommand<K extends keyof RoomData>(
  roomId: string,
  field: K,
  next: RoomData[K],
  label: string,
): CommandRequest {
  const project = useProjectStore.getState().document;
  if (!isAuthoringProjectView(project) || !project.rooms[roomId])
    throw new Error('The Room is no longer available.');
  const record = project.rooms[roomId]!;
  const saveUnit = recordSaveUnitId('rooms', roomId);
  if (record.archetype) {
    // The native command planner owns sparse archetype overrides. Compute
    // against the latest acknowledged Room, not a stale whole-record draft.
    const effective = resolveGameplayInstanceRecord(project, 'room', record) ?? record;
    const data = parseRoomData(effective.data) ?? defaultRoomData(record.label ?? roomId);
    return {
      type: 'room.replaceData',
      payload: { roomId, data: { ...data, [field]: next } },
      label,
      originSaveUnitId: saveUnit,
      persistencePolicy: 'manual-save',
    };
  }
  return {
    type: 'project.replaceAtPath',
    payload: {
      path: `/rooms/${roomId.replace(/~/gu, '~0').replace(/\//gu, '~1')}/data/${field}`,
      value: next,
    },
    label,
    originSaveUnitId: saveUnit,
    persistencePolicy: 'manual-save',
  };
}

/** Defer whole-Room semantic planning until native commands before this intent
 * have published, retaining disjoint edits made while the worker was busy. */
export function rebasedRoomDataCommand(
  roomId: string,
  previous: RoomData,
  next: RoomData,
  label: string,
): (() => CommandRequest) | null {
  const edits = diffJsonDocuments(toJsonValue(previous), toJsonValue(next));
  if (!edits.length) return null;
  return () => {
    const current = useProjectStore.getState().document;
    if (!isAuthoringProjectView(current) || !current.rooms[roomId])
      throw new Error('The edited Room is no longer available.');
    const record = current.rooms[roomId]!;
    const effective = resolveGameplayInstanceRecord(current, 'room', record) ?? record;
    const latest = parseRoomData(effective.data) ?? defaultRoomData(record.label ?? roomId);
    return {
      type: 'room.replaceData',
      label,
      payload: { roomId, data: applyJsonPatch(toJsonValue(latest), edits).document },
      originSaveUnitId: recordSaveUnitId('rooms', roomId),
      persistencePolicy: 'manual-save',
    };
  };
}

export function RoomDisplayNameField({
  roomId,
  tabId,
  value,
}: {
  roomId: string;
  tabId: string;
  value: string;
}) {
  return (
    <NativeBufferedInput
      aria-label="Room display name"
      tabId={tabId}
      path={`/rooms/${roomId.replace(/~/gu, '~0').replace(/\//gu, '~1')}/data/displayName`}
      saveUnitId={recordSaveUnitId('rooms', roomId)}
      value={value}
      label="Update room name"
      buildCommand={(next) =>
        bufferedRoomFieldCommand(roomId, 'displayName', next, 'Update room name')
      }
    />
  );
}
