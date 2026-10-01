import type {
  AuthoringProject,
  AuthoringRecordBase,
} from '../../../shared/project-schema/authoring-project';
import type { RoomData } from '../../../shared/project-schema/authoring-rooms';
import { resolveGameplayInstanceRecord } from '../../../shared/project-schema/authoring-archetypes';

function ownerState(record: AuthoringRecordBase | null | undefined) {
  if (!record) return null;
  return {
    id: record.id,
    traits: record.traits ?? [],
    localProperties: record.localProperties ?? [],
    defaultProperties: record.defaultProperties ?? [],
  };
}

function effectiveOwner(
  project: AuthoringProject,
  kind: 'room' | 'character' | 'interactable',
  record: AuthoringRecordBase | undefined,
) {
  return record ? (resolveGameplayInstanceRecord(project, kind, record) ?? record) : null;
}

function sortedRecordValues<T>(records: Readonly<Record<string, T>>): readonly T[] {
  return Object.keys(records)
    .sort()
    .map((id) => records[id]!);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

/**
 * Semantic authority key for focused-native Room visibility. Spatial and presentation-only fields
 * are deliberately excluded so direct manipulation can retain a still-valid native resolution.
 */
export function roomEditVisibilityKey(project: AuthoringProject, roomId: string, room: RoomData) {
  const snapshot = {
    roomId,
    roomOwner: ownerState(
      effectiveOwner(project, 'room', project.rooms[roomId] as AuthoringRecordBase | undefined),
    ),
    room: {
      lifecycle: room.lifecycle,
      scriptHooks: room.scriptHooks,
      cast: room.cast.map((item) => ({
        id: item.id,
        character: item.character,
        condition: item.condition,
        visible: item.visible,
      })),
      interactables: room.interactables.map((item) => ({
        id: item.id,
        interactable: item.interactable,
        condition: item.condition,
        visible: item.visible,
      })),
      props: room.props.map((item) => ({
        id: item.id,
        condition: item.condition,
        visible: item.visible,
      })),
      environments: room.environments.map((item) => ({
        id: item.id,
        condition: item.condition,
        visible: item.visible,
      })),
    },
    variables: sortedRecordValues(project.variables).map((record) => ({
      id: record.id,
      data: record.data,
    })),
    characters: sortedRecordValues(project.characters).map((record) => {
      const effective = effectiveOwner(project, 'character', record);
      return {
        ...ownerState(effective),
        initialWorldState:
          effective?.data &&
          typeof effective.data === 'object' &&
          'initialWorldState' in effective.data
            ? effective.data.initialWorldState
            : null,
      };
    }),
    interactables: sortedRecordValues(project.interactables).map((record) => {
      const effective = effectiveOwner(project, 'interactable', record);
      return {
        ...ownerState(effective),
        features:
          effective?.data && typeof effective.data === 'object' && 'features' in effective.data
            ? effective.data.features
            : null,
      };
    }),
    interactableInstances: sortedRecordValues(project.interactableInstances).map((instance) => ({
      id: instance.id,
      definition: instance.definition,
      location: instance.location,
      enabled: instance.enabled,
      visible: instance.visible,
      quantity: instance.quantity,
      traits: instance.traits,
      localProperties: instance.localProperties,
      featureOverrides: instance.featureOverrides,
    })),
    traits: sortedRecordValues(project.traits),
    scripts: sortedRecordValues(project.scripts).map((record) => ({
      id: record.id,
      data: record.data,
    })),
  };
  return JSON.stringify(stableValue(snapshot));
}
