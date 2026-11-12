import { toJsonValue, type JsonValue } from '@/project/json-value';
import { defaultRoomData, parseRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  defaultCharacterData,
  parseCharacterData,
} from '../../shared/project-schema/authoring-characters';
import {
  defaultInteractableData,
  parseInteractableData,
} from '../../shared/project-schema/authoring-interactables';
import type { AuthoringRecordBase } from '../../shared/project-schema/authoring-project';
import type { GameplayInstanceKind } from '../../shared/project-schema/authoring-archetypes';

export type GameplayRecordCollection = 'rooms' | 'characters' | 'interactables';
export interface GameplayRecordRef {
  readonly collection: GameplayRecordCollection;
  readonly id: string;
}

interface GameplayRecordDescriptor {
  kind: GameplayInstanceKind;
  readData(record: AuthoringRecordBase, id: string): JsonValue;
}

/** A single parser/default/command-kind owner for all three gameplay families. */
export const gameplayRecordDescriptors: Record<GameplayRecordCollection, GameplayRecordDescriptor> =
  {
    rooms: {
      kind: 'room',
      readData: (record, id) =>
        toJsonValue(parseRoomData(record.data) ?? defaultRoomData(record.label ?? id)),
    },
    characters: {
      kind: 'character',
      readData: (record, id) =>
        toJsonValue(parseCharacterData(record.data) ?? defaultCharacterData(record.label ?? id)),
    },
    interactables: {
      kind: 'interactable',
      readData: (record, id) =>
        toJsonValue(
          parseInteractableData(record.data) ?? defaultInteractableData(record.label ?? id),
        ),
    },
  };
