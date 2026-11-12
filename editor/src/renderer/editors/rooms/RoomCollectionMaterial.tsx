import type { ComponentProps } from 'react';
import { MaterialApplicationEditor } from '@/components/materials/MaterialApplicationEditor';
import { ProjectFieldError } from '@/commands/use-project-field';
import { useRoomCollectionItem } from './use-room-collection-item';
import type { RoomData } from '../../../shared/project-schema/authoring-rooms';

type MaterialItem = RoomData['props'][number] | RoomData['environments'][number];

/** Shared optimistic material editor for Room Props and Environment layers.
 * A material change can coexist with a queued visibility/condition edit on
 * another member, because all controls share the same staged collection. */
export function RoomCollectionMaterial({
  roomId,
  tabId,
  collection,
  items,
  itemId,
  project,
  properties,
  ariaLabel,
  overrideLabel,
  allowClear,
}: {
  roomId: string;
  tabId: string;
  collection: 'props' | 'environments';
  items: readonly MaterialItem[];
  itemId: string;
  project: ComponentProps<typeof MaterialApplicationEditor>['project'];
  properties: ComponentProps<typeof MaterialApplicationEditor>['properties'];
  ariaLabel: string;
  overrideLabel: string;
  allowClear?: boolean;
}) {
  const { draft, entry, update } = useRoomCollectionItem({
    roomId,
    tabId,
    collection,
    items,
    itemId,
    label: `Update Room ${collection} Material`,
  });
  if (!entry) return null;
  return (
    <>
      <MaterialApplicationEditor
        project={project}
        value={entry.materialApplication}
        expectedRole="engine-2d"
        properties={properties}
        ariaLabel={ariaLabel}
        overrideLabel={overrideLabel}
        allowClear={allowClear}
        onChange={(materialApplication) => {
          if (collection === 'environments' && materialApplication === null) return;
          update({ materialApplication });
        }}
      />
      <ProjectFieldError field={draft} />
    </>
  );
}
