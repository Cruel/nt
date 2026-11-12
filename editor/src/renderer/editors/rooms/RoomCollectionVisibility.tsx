import { useGameplayRecordField } from '@/commands/gameplay-record-fields';
import { useNativeFieldDraftStore } from '@/commands/native-field-drafts';
import { ProjectFieldError } from '@/commands/use-project-field';
import { toJsonValue } from '@/project/json-value';

type VisibilityCollection = 'overlays' | 'cast' | 'props' | 'environments';
interface VisibleItem {
  id: string;
  visible: boolean;
}

/**
 * One shared owner/field intent per Room collection. The checkbox is a
 * presentation of its semantic-ID member, not an index-scoped JSON patch.
 * Changes to two members while native is blocked combine in the latest
 * optimistic collection before being sent as one revision-checked command.
 */
export function RoomCollectionVisibility({
  roomId,
  tabId,
  collection,
  items,
  itemId,
}: {
  roomId: string;
  tabId: string;
  collection: VisibilityCollection;
  items: readonly VisibleItem[];
  itemId: string;
}) {
  const draft = useGameplayRecordField({
    record: { collection: 'rooms', id: roomId },
    tabId,
    field: `/${collection}`,
    value: toJsonValue(items),
    label: `Update Room ${collection} visibility`,
  });
  const current = draft.value as unknown as VisibleItem[];
  const entry = current.find((item) => item.id === itemId);
  return (
    <>
      <input
        type="checkbox"
        checked={entry?.visible ?? false}
        disabled={!entry}
        aria-invalid={Boolean(draft.error)}
        onChange={(event) => {
          const staged = useNativeFieldDraftStore.getState().entries[draft.fieldKey]?.value;
          const latest = Array.isArray(staged) ? (staged as unknown as VisibleItem[]) : current;
          if (!latest.some((item) => item.id === itemId)) return;
          draft.change(
            toJsonValue(
              latest.map((item) =>
                item.id === itemId ? { ...item, visible: event.currentTarget.checked } : item,
              ),
            ),
          );
          draft.endSession();
        }}
        onBlur={() => {
          draft.endSession();
          void draft.flush();
        }}
      />
      <ProjectFieldError field={draft} />
    </>
  );
}
