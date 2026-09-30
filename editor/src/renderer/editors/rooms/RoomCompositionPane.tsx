import type { ReactNode } from 'react';
import { ChevronLeft, MousePointerClick, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import type { RoomData } from '../../../shared/project-schema/authoring-rooms';
import type { RoomPresentationReorderAction } from '../../../shared/project-schema/room-presentation-order';
import {
  describeRoomEditSelection,
  roomEditSelectionKey,
  type RoomEditSelection,
} from './room-edit-selection';

function ContentsEntry({
  depth = 0,
  label,
  secondary,
  onClick,
}: {
  depth?: number;
  label: string;
  secondary?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      onClick={onClick}
    >
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      {secondary ? (
        <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">
          {secondary}
        </span>
      ) : null}
    </button>
  );
}

function ContentsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5 rounded-md border bg-background/40 p-1.5">
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

export function RoomCompositionPane({
  project,
  room,
  selection,
  disabled,
  expandedSelectionKeys,
  onExpandedSelectionKeysChange,
  onSelectionChange,
  renderInspector,
  addActions,
  onBeginAdd,
  onAddToPlacement,
  onDeleteSelection,
  bulkStackingActions,
  onBulkStackingAction,
  onEditHotspots,
}: {
  project: AuthoringProject;
  room: RoomData;
  selection: readonly RoomEditSelection[];
  disabled: boolean;
  expandedSelectionKeys: ReadonlySet<string>;
  onExpandedSelectionKeysChange: (keys: ReadonlySet<string>) => void;
  onSelectionChange: (selection: readonly RoomEditSelection[]) => void;
  renderInspector: (selection: RoomEditSelection) => ReactNode;
  addActions: readonly { id: string; label: string; disabled?: boolean }[];
  onBeginAdd: (actionId: string) => void;
  onAddToPlacement: (actionId: string, placementId: string) => void;
  onDeleteSelection: () => void;
  bulkStackingActions?: readonly {
    action: RoomPresentationReorderAction;
    label: string;
  }[];
  onBulkStackingAction?: (action: RoomPresentationReorderAction, label: string) => void;
  onEditHotspots?: () => void;
}) {
  const { t } = useTranslation('workspace');
  const select = (item: RoomEditSelection) => onSelectionChange([item]);
  const placementChildren = (placementId: string) => [
    ...room.interactables
      .filter((item) => item.placementId === placementId)
      .map((item) => ({ selection: { kind: 'interactable', id: item.id } as const })),
    ...room.props
      .filter((item) => item.placementId === placementId)
      .map((item) => ({ selection: { kind: 'prop', id: item.id } as const })),
    ...room.cast
      .filter((item) => item.placementId === placementId)
      .map((item) => ({ selection: { kind: 'cast', id: item.id } as const })),
    ...(room.placements.find((item) => item.id === placementId)?.presentation.layout
      ? [{ selection: { kind: 'placement-layout', id: placementId } as const }]
      : []),
  ];

  const hasContents =
    room.placements.length > 0 ||
    room.environments.length > 0 ||
    room.overlays.length > 0 ||
    room.hotspots.length > 0;

  return (
    <section
      className={disabled ? 'pointer-events-none select-none opacity-50' : undefined}
      aria-disabled={disabled}
      data-testid="room-composition-pane"
      data-disabled={disabled ? 'true' : 'false'}
      inert={disabled || undefined}
    >
      {selection.length === 0 ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">{t('roomEditor.compositionPane.contents')}</h3>
              <p className="text-xs text-muted-foreground">
                {t('roomEditor.compositionPane.contentsDescription')}
              </p>
            </div>
            <div
              className="flex flex-wrap justify-end gap-1"
              data-testid="room-composition-add-actions"
            >
              {onEditHotspots ? (
                <Button type="button" size="sm" variant="outline" onClick={onEditHotspots}>
                  <MousePointerClick className="size-3.5" aria-hidden="true" />
                  {t('roomEditor.compositionPane.editHotspots')}
                </Button>
              ) : null}
              {addActions.map((action) => (
                <Button
                  key={action.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={action.disabled}
                  onClick={() => onBeginAdd(action.id)}
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                  {action.label}
                </Button>
              ))}
            </div>
          </div>
          {!hasContents ? (
            <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              {t('roomEditor.compositionPane.empty')}
            </div>
          ) : null}
          {room.placements.length > 0 ? (
            <ContentsGroup title={t('roomEditor.compositionPane.placements')}>
              {room.placements.map((placement) => {
                const children = placementChildren(placement.id);
                return (
                  <div key={placement.id}>
                    <ContentsEntry
                      label={describeRoomEditSelection(
                        project,
                        room,
                        {
                          kind: 'placement',
                          id: placement.id,
                        },
                        t,
                      )}
                      secondary={placement.id}
                      onClick={() => select({ kind: 'placement', id: placement.id })}
                    />
                    {children.map(({ selection: child }) => (
                      <ContentsEntry
                        key={roomEditSelectionKey(child)}
                        depth={1}
                        label={describeRoomEditSelection(project, room, child, t)}
                        secondary={child.id}
                        onClick={() => select(child)}
                      />
                    ))}
                  </div>
                );
              })}
            </ContentsGroup>
          ) : null}
          {room.environments.length > 0 ? (
            <ContentsGroup title={t('roomEditor.compositionPane.environments')}>
              {room.environments.map((environment) => (
                <ContentsEntry
                  key={environment.id}
                  label={describeRoomEditSelection(
                    project,
                    room,
                    {
                      kind: 'environment',
                      id: environment.id,
                    },
                    t,
                  )}
                  secondary={environment.id}
                  onClick={() => select({ kind: 'environment', id: environment.id })}
                />
              ))}
            </ContentsGroup>
          ) : null}
          {room.overlays.length > 0 ? (
            <ContentsGroup title={t('roomEditor.compositionPane.overlays')}>
              {room.overlays.map((overlay) => (
                <ContentsEntry
                  key={overlay.id}
                  label={describeRoomEditSelection(
                    project,
                    room,
                    {
                      kind: 'overlay',
                      id: overlay.id,
                    },
                    t,
                  )}
                  secondary={overlay.id}
                  onClick={() => select({ kind: 'overlay', id: overlay.id })}
                />
              ))}
            </ContentsGroup>
          ) : null}
          {room.hotspots.length > 0 ? (
            <ContentsGroup title={t('roomEditor.compositionPane.hotspots')}>
              {room.hotspots.map((hotspot) => (
                <ContentsEntry
                  key={hotspot.id}
                  label={describeRoomEditSelection(
                    project,
                    room,
                    {
                      kind: 'hotspot',
                      id: hotspot.id,
                    },
                    t,
                  )}
                  secondary={hotspot.id}
                  onClick={() => select({ kind: 'hotspot', id: hotspot.id })}
                />
              ))}
            </ContentsGroup>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 border-b pb-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => onSelectionChange([])}>
              <ChevronLeft className="size-3.5" aria-hidden="true" />
              {t('roomEditor.compositionPane.contents')}
            </Button>
            <div className="flex items-center gap-2">
              {selection.length > 1 ? (
                <span className="text-xs text-muted-foreground">
                  {t('roomEditor.compositionPane.selectedCount', { count: selection.length })}
                </span>
              ) : null}
              {onEditHotspots ? (
                <Button type="button" size="sm" variant="outline" onClick={onEditHotspots}>
                  <MousePointerClick className="size-3.5" aria-hidden="true" />
                  {t('roomEditor.compositionPane.editHotspots')}
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="outline" onClick={onDeleteSelection}>
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t('roomEditor.compositionPane.deleteSelection')}
              </Button>
            </div>
          </div>
          {selection.length === 1 && selection[0]?.kind === 'placement' ? (
            <div className="flex flex-wrap items-center gap-1 rounded-md border bg-muted/20 p-2">
              <span className="mr-1 text-xs font-medium text-muted-foreground">
                {t('roomEditor.compositionPane.addToPlacement')}
              </span>
              {addActions
                .filter((action) => action.id !== 'placement' && action.id !== 'environment')
                .map((action) => (
                  <Button
                    key={action.id}
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={action.disabled}
                    onClick={() => onAddToPlacement(action.id, selection[0]!.id)}
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    {action.label}
                  </Button>
                ))}
            </div>
          ) : null}
          {selection.length > 1 && bulkStackingActions && onBulkStackingAction ? (
            <div
              className="grid grid-cols-2 gap-1 rounded-md border bg-muted/20 p-2"
              data-testid="room-bulk-presentation-order-controls"
            >
              {bulkStackingActions.map(({ action, label }) => (
                <Button
                  key={action}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onBulkStackingAction(action, label)}
                >
                  {label}
                </Button>
              ))}
            </div>
          ) : null}
          {selection.length === 1 ? (
            renderInspector(selection[0]!)
          ) : (
            <div className="space-y-2" data-testid="room-multi-selection-inspectors">
              {selection.map((item) => {
                const key = roomEditSelectionKey(item);
                const open = expandedSelectionKeys.has(key);
                return (
                  <details
                    key={key}
                    className="rounded-md border bg-background/50"
                    open={open}
                    onToggle={(event) => {
                      const next = new Set(expandedSelectionKeys);
                      if (event.currentTarget.open) next.add(key);
                      else next.delete(key);
                      onExpandedSelectionKeysChange(next);
                    }}
                  >
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                      {describeRoomEditSelection(project, room, item, t)}
                    </summary>
                    <div className="border-t p-3">{renderInspector(item)}</div>
                  </details>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
