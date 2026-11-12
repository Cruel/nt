import { useGameplayRecordField } from '@/commands/gameplay-record-fields';
import { useNativeFieldDraftStore } from '@/commands/native-field-drafts';
import { toJsonValue } from '@/project/json-value';

export type RoomContentsCollection = 'overlays' | 'cast' | 'props' | 'environments';

/** A collection is one recoverable native field; the child uses its stable ID,
 * never an array-index pointer. The event handler reads the latest staged
 * array so two distinct children cannot replace one another's optimistic edit. */
export function useRoomCollectionItem<T extends { id: string }>({
  roomId,
  tabId,
  collection,
  items,
  itemId,
  label,
}: {
  roomId: string;
  tabId: string;
  collection: RoomContentsCollection;
  items: readonly T[];
  itemId: string;
  label: string;
}) {
  const draft = useGameplayRecordField({
    record: { collection: 'rooms', id: roomId },
    tabId,
    field: `/${collection}`,
    value: toJsonValue(items),
    label,
  });
  const entries = draft.value as unknown as T[];
  const entry = entries.find((item) => item.id === itemId);
  return {
    draft,
    entry,
    update: (patch: Partial<T>) => {
      const staged = useNativeFieldDraftStore.getState().entries[draft.fieldKey]?.value;
      const latest = Array.isArray(staged) ? (staged as unknown as T[]) : entries;
      if (!latest.some((item) => item.id === itemId)) return;
      draft.change(
        toJsonValue(latest.map((item) => (item.id === itemId ? { ...item, ...patch } : item))),
      );
    },
  };
}
