import { useMemo, useState } from 'react';
import {
  defaultHotspotViewState,
  parseHotspotViewTabState,
  restoreHotspotViewState,
  type HotspotEditorViewStateV1,
} from '@/components/image-stage/hotspot-view-state';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import {
  defaultInteractableData,
  interactableAssetRef,
  interactableMaterialRef,
  parseInteractableData,
  type InteractableData,
} from '../../../shared/project-schema/authoring-interactables';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { parseRoomData } from '../../../shared/project-schema/authoring-rooms';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  useWorkbenchEditorTabState,
  useWorkbenchTabStateStore,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

const INTERACTABLE_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.interactable';
type InteractableEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof INTERACTABLE_EDITOR_TAB_STATE_SCHEMA;
  schemaVersion: 1;
  payload: { hotspotView: HotspotEditorViewStateV1 };
};

function parseInteractableEditorTabState(
  value: WorkbenchTabStatePayload,
): InteractableEditorTabState['payload'] | null {
  if (
    value.schema !== INTERACTABLE_EDITOR_TAB_STATE_SCHEMA ||
    value.schemaVersion !== 1 ||
    typeof value.payload !== 'object' ||
    value.payload === null ||
    Array.isArray(value.payload)
  )
    return null;
  const hotspotView = parseHotspotViewTabState(
    (value.payload as Record<string, unknown>).hotspotView,
  );
  return hotspotView ? { hotspotView } : null;
}

const refValue = (ref: { $ref: { id: string } } | null) => ref?.$ref.id ?? '__none__';
export function InteractableEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const project = isAuthoringProject(document) ? document : null;
  const interactableId = tab.resource?.entityId;
  const record = interactableId && project ? project.interactables[interactableId] : null;
  const data =
    parseInteractableData(record?.data) ??
    defaultInteractableData(record?.label ?? interactableId ?? 'Interactable');
  const hotspotIds = useMemo(
    () =>
      data.presentation.hotspots.kind === 'sprite-alpha'
        ? [data.presentation.hotspots.hotspot.id]
        : data.presentation.hotspots.hotspots.map((item) => item.id),
    [data.presentation.hotspots],
  );
  const [hotspotView, setHotspotView] = useState<HotspotEditorViewStateV1>(() => {
    const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    return savedState
      ? (parseInteractableEditorTabState(savedState)?.hotspotView ?? defaultHotspotViewState())
      : defaultHotspotViewState();
  });
  useWorkbenchEditorTabState<InteractableEditorTabState>(
    tab.id,
    useMemo(
      () => ({
        schema: INTERACTABLE_EDITOR_TAB_STATE_SCHEMA,
        schemaVersion: 1,
        captureTabState: () => ({
          schema: INTERACTABLE_EDITOR_TAB_STATE_SCHEMA,
          schemaVersion: 1,
          payload: { hotspotView },
        }),
        restoreTabState: (state) => {
          const parsed = parseInteractableEditorTabState(state);
          if (parsed) setHotspotView(restoreHotspotViewState(parsed.hotspotView, hotspotIds));
        },
      }),
      [hotspotIds, hotspotView],
    ),
  );
  const placementOptions = useMemo(
    () =>
      project
        ? Object.entries(project.rooms).flatMap(([roomId, room]) => {
            const roomData = parseRoomData(room.data);
            return (
              roomData?.placements.map((placement) => ({ roomId, placementId: placement.id })) ?? []
            );
          })
        : [],
    [project],
  );
  if (!project || !record || !interactableId)
    return <div className="p-4 text-sm text-muted-foreground">Interactable record not found.</div>;
  const commit = (next: InteractableData, label: string) =>
    useCommandStore.getState().executeCommand({
      type: 'interactable.replaceData',
      label,
      payload: { interactableId, data: next },
      originSaveUnitId: recordSaveUnitId('interactables', interactableId),
      persistencePolicy: 'manual-save',
    });
  return (
    <div className="h-full overflow-auto bg-background p-4">
      <div className="flex gap-2">
        <h2 className="text-lg font-semibold">{record.label}</h2>
        <Badge variant="outline">{interactableId}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Unique Interactable definition and initial state declaration.
      </p>
      <div className="mt-4 grid max-w-2xl gap-3 rounded border p-3 md:grid-cols-2">
        <div>
          <Label>Display name</Label>
          <Input
            value={data.displayName}
            onChange={(event) =>
              commit(
                { ...data, displayName: event.currentTarget.value },
                'Update interactable name',
              )
            }
          />
        </div>
        <div>
          <Label>Sprite</Label>
          <Select
            value={refValue(data.presentation.sprite)}
            onValueChange={(value) =>
              commit(
                {
                  ...data,
                  presentation: {
                    ...data.presentation,
                    sprite: value === '__none__' ? null : interactableAssetRef(String(value)),
                  },
                },
                'Update interactable sprite',
              )
            }
          >
            <SelectItem value="__none__">No sprite</SelectItem>
            {Object.entries(project.assets).map(([id, asset]) => (
              <SelectItem key={id} value={id}>
                {asset.label}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div>
          <Label>Material</Label>
          <Select
            value={refValue(data.presentation.material)}
            onValueChange={(value) =>
              commit(
                {
                  ...data,
                  presentation: {
                    ...data.presentation,
                    material: value === '__none__' ? null : interactableMaterialRef(String(value)),
                  },
                },
                'Update interactable material',
              )
            }
          >
            <SelectItem value="__none__">No material</SelectItem>
            {Object.entries(project.materials).map(([id, material]) => (
              <SelectItem key={id} value={id}>
                {material.label}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div>
          <Label>Initial location</Label>
          <Select
            value={
              data.initialState.location.kind === 'room-placement'
                ? `${data.initialState.location.placement.room}:${data.initialState.location.placement.placement}`
                : data.initialState.location.kind
            }
            onValueChange={(value) => {
              const selected = String(value);
              const location =
                selected === 'inventory'
                  ? { kind: 'inventory' as const }
                  : selected === 'nowhere'
                    ? { kind: 'nowhere' as const }
                    : (() => {
                        const [room, placement] = selected.split(':');
                        return { kind: 'room-placement' as const, placement: { room, placement } };
                      })();
              commit(
                { ...data, initialState: { ...data.initialState, location } },
                'Update interactable location',
              );
            }}
          >
            <SelectItem value="nowhere">Nowhere</SelectItem>
            <SelectItem value="inventory">Inventory</SelectItem>
            {placementOptions.map((option) => (
              <SelectItem
                key={`${option.roomId}:${option.placementId}`}
                value={`${option.roomId}:${option.placementId}`}
              >
                {option.roomId} / {option.placementId}
              </SelectItem>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={data.initialState.enabled}
            onChange={(event) =>
              commit(
                {
                  ...data,
                  initialState: { ...data.initialState, enabled: event.currentTarget.checked },
                },
                'Update interactable enabled state',
              )
            }
          />
          Enabled initially
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={data.initialState.visible}
            onChange={(event) =>
              commit(
                {
                  ...data,
                  initialState: { ...data.initialState, visible: event.currentTarget.checked },
                },
                'Update interactable visibility',
              )
            }
          />
          Visible initially
        </label>
      </div>
    </div>
  );
}
