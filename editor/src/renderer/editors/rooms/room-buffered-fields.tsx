import type { CommandRequest } from '@/commands/command-types';
import { gameplayRecordFieldCommand, rebasedGameplayDataCommand } from '@/commands/project-editing';
import { toJsonValue } from '@/project/json-value';
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
  return gameplayRecordFieldCommand(
    'room',
    roomId,
    `/${field}`,
    toJsonValue(next),
    label,
    (_project, record) => parseRoomData(record.data) ?? defaultRoomData(record.label ?? roomId),
  );
}

/** Defer whole-Room semantic planning until native commands before this intent
 * have published, retaining disjoint edits made while the worker was busy. */
export function rebasedRoomDataCommand(
  roomId: string,
  previous: RoomData,
  next: RoomData,
  label: string,
): (() => CommandRequest) | null {
  return rebasedGameplayDataCommand(
    'room',
    roomId,
    previous,
    next,
    label,
    (_project, record) => parseRoomData(record.data) ?? defaultRoomData(record.label ?? roomId),
  );
}
