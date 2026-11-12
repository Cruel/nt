import { Plus } from 'lucide-react';
import { CollectionMasterDetail } from '@/components/collection-master-detail';
import { Label } from '@/components/ui/label';
import { useGameplayRecordField } from '@/commands/gameplay-record-fields';
import {
  relocatePendingItem,
  RoomCollectionIdInput,
  RoomCollectionNumber,
} from './RoomSemanticInputs';
import { ProjectFieldError } from '@/commands/use-project-field';
import { toJsonValue } from '@/project/json-value';
import { buildJsonPointer } from '@/project/json-pointer';
import { nativeFieldKey, useNativeFieldDraftStore } from '@/commands/native-field-drafts';
import { useProjectStore } from '@/project/project-store';
import type { RoomAnchorData, RoomData } from '../../../shared/project-schema/authoring-rooms';

type NamedCameraView = RoomData['presentationSpace']['views'][number];

function availableId(items: readonly { id: string }[], prefix: string): string {
  const ids = new Set(items.map((item) => item.id));
  if (!ids.has(prefix)) return prefix;
  let candidate = 2;
  while (ids.has(`${prefix}-${candidate}`)) candidate++;
  return `${prefix}-${candidate}`;
}

/**
 * The *collection* is one recoverable native field, not an array-index path.
 * Updates target semantic item IDs in the immediately visible draft. A native
 * CAS rejects concurrent external changes to the array instead of replacing
 * reordered/deleted items using obsolete indices.
 */
function useRoomCollection<T extends { id: string }>(
  roomId: string,
  tabId: string,
  field: '/presentationSpace/views' | '/anchors',
  value: readonly T[],
  label: string,
) {
  const draft = useGameplayRecordField({
    record: { collection: 'rooms', id: roomId },
    tabId,
    field,
    value: toJsonValue(value),
    label,
  });
  const items = draft.value as T[];
  // A second input handler may fire before React commits a render of the
  // first. Read the current staged collection at the event boundary so a
  // batched update to a sibling semantic ID never replaces the first edit.
  const latestItems = () => {
    const staged = useNativeFieldDraftStore.getState().entries[draft.fieldKey]?.value;
    return Array.isArray(staged) ? (staged as T[]) : items;
  };
  return {
    items,
    draft,
    insert(item: T) {
      draft.change(toJsonValue([...latestItems(), item]));
    },
    update(id: string, patch: Partial<T>) {
      const current = latestItems();
      if (!current.some((item) => item.id === id)) return;
      const newId = typeof patch.id === 'string' ? patch.id : id;
      if (newId !== id && current.some((item) => item.id === newId)) return;
      draft.change(
        toJsonValue(current.map((item) => (item.id === id ? { ...item, ...patch } : item))),
      );
    },
    remove(id: string) {
      draft.change(toJsonValue(latestItems().filter((item) => item.id !== id)));
      draft.endSession();
    },
  };
}

function useOptimisticRoomNumber(roomId: string, parts: readonly string[], acknowledged: number) {
  const sessionId = useProjectStore((state) => state.projectSessionId);
  const instanceId = useProjectStore((state) => state.projectInstanceId);
  const path = buildJsonPointer(['rooms', roomId, 'data', ...parts]);
  const staged = useNativeFieldDraftStore(
    (state) => state.entries[nativeFieldKey(sessionId ?? '', instanceId ?? '', path)]?.value,
  );
  return typeof staged === 'number' && Number.isFinite(staged) ? staged : acknowledged;
}

export function RoomNamedCameraViews({
  roomId,
  tabId,
  views,
  defaultView,
  selectedId,
  onSelectedIdChange,
}: {
  roomId: string;
  tabId: string;
  views: readonly NamedCameraView[];
  defaultView: RoomData['presentationSpace']['defaultView'];
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
}) {
  const centerX = useOptimisticRoomNumber(
    roomId,
    ['presentationSpace', 'defaultView', 'center', 'x'],
    defaultView.center.x,
  );
  const centerY = useOptimisticRoomNumber(
    roomId,
    ['presentationSpace', 'defaultView', 'center', 'y'],
    defaultView.center.y,
  );
  const zoom = useOptimisticRoomNumber(
    roomId,
    ['presentationSpace', 'defaultView', 'zoom'],
    defaultView.zoom,
  );
  const rotationDegrees = useOptimisticRoomNumber(
    roomId,
    ['presentationSpace', 'defaultView', 'rotationDegrees'],
    defaultView.rotationDegrees,
  );
  const collection = useRoomCollection(
    roomId,
    tabId,
    '/presentationSpace/views',
    views,
    'Update Camera Views',
  );
  const { items } = collection;
  const selected = items.some((item) => item.id === selectedId)
    ? selectedId
    : (items[0]?.id ?? null);
  const update = (id: string, patch: Partial<NamedCameraView>) => {
    collection.update(id, patch);
    if (
      patch.id !== undefined &&
      patch.id !== id &&
      !items.some((entry) => entry.id === patch.id)
    ) {
      relocatePendingItem(roomId, 'views', id, patch.id);
      onSelectedIdChange(patch.id);
    }
  };
  return (
    <>
      <CollectionMasterDetail
        title="Named Camera Views"
        description="Reusable logical framing targets for presentation operations."
        items={items}
        getKey={(item) => item.id}
        selectedKey={selected}
        onSelectedKeyChange={(key) => onSelectedIdChange(key)}
        listAriaLabel="Named Camera Views"
        emptyState="No named Camera Views."
        listAction={{
          label: 'Add View',
          icon: <Plus className="size-3.5" aria-hidden="true" />,
          onClick: () => {
            const id = availableId(items, 'view');
            collection.insert({
              id,
              view: {
                center: { x: centerX, y: centerY },
                zoom,
                rotationDegrees,
              },
            });
            onSelectedIdChange(id);
          },
        }}
        getDeleteLabel={(item) => `Delete Camera View ${item.id}`}
        onDeleteItem={(item) => {
          relocatePendingItem(roomId, 'views', item.id, null);
          collection.remove(item.id);
          if (selected === item.id)
            onSelectedIdChange(items.find((candidate) => candidate.id !== item.id)?.id ?? null);
        }}
        getItemPresentation={(item) => ({
          label: item.id,
          trailing: `${item.view.zoom}×`,
        })}
        renderDetail={(item) => (
          <div className="rounded-md border bg-background/50 p-2.5">
            <div className="flex items-center justify-between gap-2 border-b pb-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">View details</div>
                <div className="truncate text-[10px] text-muted-foreground">
                  Center {item.view.center.x}, {item.view.center.y} · {item.view.zoom}× ·{' '}
                  {item.view.rotationDegrees}°
                </div>
              </div>
            </div>
            <div className="grid gap-2 pt-2 @3xl:grid-cols-5">
              <div className="space-y-1 @3xl:col-span-2">
                <Label>View ID</Label>
                <RoomCollectionIdInput
                  key={item.id}
                  roomId={roomId}
                  collection="views"
                  itemId={item.id}
                  allIds={items.map((entry) => entry.id)}
                  label="Camera View ID"
                  onCommit={(id) => update(item.id, { id })}
                />
              </div>
              {(['x', 'y'] as const).map((axis) => (
                <div key={axis} className="space-y-1">
                  <Label>Center {axis.toUpperCase()}</Label>
                  <RoomCollectionNumber
                    key={`${item.id}-${axis}`}
                    roomId={roomId}
                    collection="views"
                    itemId={item.id}
                    property={`center-${axis}`}
                    label={`Camera View center ${axis}`}
                    value={item.view.center[axis]}
                    onChange={(next) =>
                      update(item.id, {
                        view: {
                          ...item.view,
                          center: {
                            ...item.view.center,
                            [axis]: next,
                          },
                        },
                      })
                    }
                  />
                </div>
              ))}
              <div className="space-y-1">
                <Label>Zoom</Label>
                <RoomCollectionNumber
                  key={item.id}
                  roomId={roomId}
                  collection="views"
                  itemId={item.id}
                  property="zoom"
                  label="Camera View zoom"
                  min={0.001}
                  step={0.05}
                  value={item.view.zoom}
                  onChange={(next) =>
                    update(item.id, {
                      view: {
                        ...item.view,
                        zoom: next,
                      },
                    })
                  }
                />
              </div>
              <div className="space-y-1 @3xl:col-start-5">
                <Label>Rotation</Label>
                <RoomCollectionNumber
                  key={item.id}
                  roomId={roomId}
                  collection="views"
                  itemId={item.id}
                  property="rotation"
                  label="Camera View rotation"
                  value={item.view.rotationDegrees}
                  onChange={(next) =>
                    update(item.id, {
                      view: {
                        ...item.view,
                        rotationDegrees: next,
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>
        )}
      />
      <ProjectFieldError field={collection.draft} />
    </>
  );
}

export function RoomAnchors({
  roomId,
  tabId,
  anchors,
  selectedId,
  onSelectedIdChange,
}: {
  roomId: string;
  tabId: string;
  anchors: readonly RoomAnchorData[];
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
}) {
  const collection = useRoomCollection(roomId, tabId, '/anchors', anchors, 'Update Room Anchors');
  const { items } = collection;
  const selected = items.some((item) => item.id === selectedId)
    ? selectedId
    : (items[0]?.id ?? null);
  const update = (id: string, patch: Partial<RoomAnchorData>) => {
    collection.update(id, patch);
    if (
      patch.id !== undefined &&
      patch.id !== id &&
      !items.some((entry) => entry.id === patch.id)
    ) {
      relocatePendingItem(roomId, 'anchors', id, patch.id);
      onSelectedIdChange(patch.id);
    }
  };
  return (
    <>
      <CollectionMasterDetail
        anchor="room.anchors"
        title="Anchors"
        description="Stable authored regions that Focus captures without live tracking."
        items={items}
        getKey={(item) => item.id}
        selectedKey={selected}
        onSelectedKeyChange={(key) => onSelectedIdChange(key)}
        listAriaLabel="Anchors"
        emptyState="No anchors."
        listAction={{
          label: 'Add Anchor',
          icon: <Plus className="size-3.5" aria-hidden="true" />,
          onClick: () => {
            const id = availableId(items, 'anchor');
            collection.insert({ id, bounds: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } });
            onSelectedIdChange(id);
          },
        }}
        getDeleteLabel={(item) => `Delete Room Anchor ${item.id}`}
        onDeleteItem={(item) => {
          relocatePendingItem(roomId, 'anchors', item.id, null);
          collection.remove(item.id);
          if (selected === item.id)
            onSelectedIdChange(items.find((candidate) => candidate.id !== item.id)?.id ?? null);
        }}
        getItemPresentation={(item) => ({
          label: item.id,
          trailing: `${item.bounds.width}×${item.bounds.height}`,
        })}
        renderDetail={(item) => (
          <div className="rounded-md border bg-background/50 p-2.5">
            <div className="flex items-center justify-between gap-2 border-b pb-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">Anchor details</div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {item.bounds.x}, {item.bounds.y} · {item.bounds.width} × {item.bounds.height}
                </div>
              </div>
            </div>
            <div className="grid gap-2 pt-2 @3xl:grid-cols-6">
              <div className="space-y-1 @3xl:col-span-2">
                <Label>Anchor ID</Label>
                <RoomCollectionIdInput
                  key={item.id}
                  roomId={roomId}
                  collection="anchors"
                  itemId={item.id}
                  allIds={items.map((entry) => entry.id)}
                  label="Room Anchor ID"
                  onCommit={(id) => update(item.id, { id })}
                />
              </div>
              {(['x', 'y', 'width', 'height'] as const).map((axis) => (
                <div key={axis} className="space-y-1">
                  <Label>{axis}</Label>
                  <RoomCollectionNumber
                    key={`${item.id}-${axis}`}
                    roomId={roomId}
                    collection="anchors"
                    itemId={item.id}
                    property={axis}
                    label={`Room Anchor ${axis}`}
                    min={0}
                    max={1}
                    step={0.01}
                    value={item.bounds[axis]}
                    onChange={(next) =>
                      update(item.id, {
                        bounds: {
                          ...item.bounds,
                          [axis]: next,
                        },
                      })
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      />
      <ProjectFieldError field={collection.draft} />
    </>
  );
}
