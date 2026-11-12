import { RecursiveConditionEditor } from '@/components/conditions/ConditionEditor';
import { ProjectFieldError } from '@/commands/use-project-field';
import type { AuthoringEditorProject } from '@/editors/interactions/InteractionProgramEditor';
import type { RoomContentsCollection } from './use-room-collection-item';
import { useRoomCollectionItem } from './use-room-collection-item';
import type { Condition } from '../../../shared/project-schema/authoring-flow';

interface ConditionItem {
  id: string;
  condition: Condition;
}

/** Compound condition editor over the same semantic-ID collection field as
 * visibility. The active editor reads its latest optimistic sibling values. */
export function RoomCollectionCondition({
  roomId,
  tabId,
  collection,
  items,
  itemId,
  project,
  compact,
}: {
  roomId: string;
  tabId: string;
  collection: RoomContentsCollection;
  items: readonly ConditionItem[];
  itemId: string;
  project: AuthoringEditorProject;
  compact?: boolean;
}) {
  const { draft, entry, update } = useRoomCollectionItem({
    roomId,
    tabId,
    collection,
    items,
    itemId,
    label: `Update Room ${collection} condition`,
  });
  if (!entry) return null;
  return (
    <>
      <RecursiveConditionEditor
        value={entry.condition}
        project={project}
        scope={{ currentRoom: true }}
        compact={compact}
        onChange={(condition) => update({ condition })}
      />
      <ProjectFieldError field={draft} />
    </>
  );
}
