import type { ReactNode } from 'react';
import { gameplayFieldOptions, useGameplayRecordField } from '@/commands/gameplay-record-fields';
import { projectEdits } from '@/commands/project-editing';
import { nativeFieldKey, useNativeFieldDraftStore } from '@/commands/native-field-drafts';
import { ProjectFieldError } from '@/commands/use-project-field';
import { useProjectStore } from '@/project/project-store';
import { toJsonValue } from '@/project/json-value';
import type { RoomExitData } from '../../../shared/project-schema/authoring-rooms';

interface RoomExitChanges {
  update: (id: string, patch: Partial<RoomExitData>) => void;
  add: (item: RoomExitData) => void;
  remove: (id: string) => void;
}

/** Also used by the Room destination-search dialog, which is mounted outside
 * the Navigation editor. Shares exactly the same field owner and scheduler. */
export function stageRoomExitSelection({
  roomId,
  tabId,
  exits,
  exitId,
  patch,
}: {
  roomId: string;
  tabId: string;
  exits: readonly RoomExitData[];
  exitId: string;
  patch: Partial<RoomExitData>;
}): boolean {
  const identity = useProjectStore.getState();
  if (!identity.projectSessionId || !identity.projectInstanceId) return false;
  const options = gameplayFieldOptions({
    record: { collection: 'rooms', id: roomId },
    field: '/exits',
    tabId,
    value: toJsonValue(exits),
    label: 'Update Room exit',
  });
  const fieldKey = nativeFieldKey(
    identity.projectSessionId,
    identity.projectInstanceId,
    options.path,
  );
  const staged = useNativeFieldDraftStore.getState().entries[fieldKey]?.value;
  const current = Array.isArray(staged) ? (staged as RoomExitData[]) : exits;
  if (!current.some((entry) => entry.id === exitId)) return false;
  return projectEdits.field({
    ...options,
    value: toJsonValue(
      current.map((entry) => (entry.id === exitId ? { ...entry, ...patch } : entry)),
    ),
  });
}

/** Route all Room exit controls through one recoverable, field-scoped
 * projection, without copying the entire Room or array-index overlays. */
export function RoomExitsField({
  roomId,
  tabId,
  exits,
  children,
}: {
  roomId: string;
  tabId: string;
  exits: readonly RoomExitData[];
  children: (exits: RoomExitData[], actions: RoomExitChanges) => ReactNode;
}) {
  const draft = useGameplayRecordField({
    record: { collection: 'rooms', id: roomId },
    field: '/exits',
    tabId,
    value: toJsonValue(exits),
    label: 'Update Room exits',
  });
  const shown = draft.value as RoomExitData[];
  const latest = () => {
    const staged = useNativeFieldDraftStore.getState().entries[draft.fieldKey]?.value;
    return Array.isArray(staged) ? (staged as RoomExitData[]) : shown;
  };
  const actions: RoomExitChanges = {
    update(id, patch) {
      const current = latest();
      if (!current.some((entry) => entry.id === id)) return;
      if (patch.id && patch.id !== id && current.some((entry) => entry.id === patch.id)) return;
      draft.change(
        toJsonValue(current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))),
      );
    },
    add(item) {
      const current = latest();
      if (current.some((entry) => entry.id === item.id)) return;
      draft.change(toJsonValue([...current, item]));
    },
    remove(id) {
      draft.change(toJsonValue(latest().filter((entry) => entry.id !== id)));
      draft.endSession();
    },
  };
  return (
    <>
      {children(shown, actions)}
      <ProjectFieldError field={draft} />
    </>
  );
}
