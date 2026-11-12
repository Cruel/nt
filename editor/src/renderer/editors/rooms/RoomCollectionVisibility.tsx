import { ProjectFieldError } from '@/commands/use-project-field';
import { useRoomCollectionItem, type RoomContentsCollection } from './use-room-collection-item';

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
  collection: RoomContentsCollection;
  items: readonly VisibleItem[];
  itemId: string;
}) {
  const { draft, entry, update } = useRoomCollectionItem({
    roomId,
    tabId,
    collection,
    items,
    itemId,
    label: `Update Room ${collection} visibility`,
  });
  return (
    <>
      <input
        type="checkbox"
        checked={entry?.visible ?? false}
        disabled={!entry}
        aria-invalid={Boolean(draft.error)}
        onChange={(event) => {
          update({ visible: event.currentTarget.checked });
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
