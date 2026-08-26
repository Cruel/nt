import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  defaultHotspotViewState,
  parseHotspotViewTabState,
  restoreHotspotViewState,
  type HotspotEditorViewState,
} from '@/components/image-stage/hotspot-view-state';
import { GameplayArchetypeControls } from '@/components/GameplayArchetypeControls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FeatureAuthoringPanel } from '@/components/features/FeatureAuthoringPanel';
import { HotspotAuthoringPanel } from '@/components/hotspots/HotspotAuthoringPanel';
import {
  InteractableLocationEditor,
  InventoryDeclarationsEditor,
} from '@/components/inventories/InventoryControls';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import { resolveGameplayInstanceRecord } from '../../../shared/project-schema/authoring-archetypes';
import {
  defaultInteractableData,
  interactableAssetRef,
  interactableMaterialRef,
  parseInteractableData,
  type InteractableData,
} from '../../../shared/project-schema/authoring-interactables';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  captureScrollViewState,
  restoreScrollViewState,
  useWorkbenchEditorTabState,
  useWorkbenchTabStateStore,
  type ScrollViewState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';
import { registerWorkbenchTargetHandler } from '@/workbench/workbench-navigation';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import {
  buildCommandPaletteItems,
  filterSelectorItems,
  type SelectorItem,
} from '@/workspace/command-palette-search';

const INTERACTABLE_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.interactable';
type InteractableEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof INTERACTABLE_EDITOR_TAB_STATE_SCHEMA;
  payload: { hotspotView: HotspotEditorViewState; scroll?: ScrollViewState };
};

function isScrollViewState(value: unknown): value is ScrollViewState {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as ScrollViewState).scrollTop === 'number' &&
    typeof (value as ScrollViewState).scrollLeft === 'number'
  );
}

function parseInteractableEditorTabState(
  value: WorkbenchTabStatePayload,
): InteractableEditorTabState['payload'] | null {
  if (
    value.schema !== INTERACTABLE_EDITOR_TAB_STATE_SCHEMA ||
    typeof value.payload !== 'object' ||
    value.payload === null ||
    Array.isArray(value.payload)
  )
    return null;
  const hotspotView = parseHotspotViewTabState(
    (value.payload as Record<string, unknown>).hotspotView,
  );
  const scrollValue = (value.payload as Record<string, unknown>).scroll;
  return hotspotView
    ? { hotspotView, scroll: isScrollViewState(scrollValue) ? scrollValue : undefined }
    : null;
}

export function InteractableEditor({ tab }: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const document = useProjectStore((state) => state.document);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const project = isAuthoringProject(document) ? document : null;
  const interactableId = tab.resource?.entityId;
  const record = interactableId && project ? project.interactables[interactableId] : null;
  const effectiveRecord =
    project && record ? resolveGameplayInstanceRecord(project, 'interactable', record) : record;
  const data =
    parseInteractableData(effectiveRecord?.data) ??
    defaultInteractableData(record?.label ?? interactableId ?? 'Interactable');
  const selectorItems = useMemo(() => buildCommandPaletteItems(project, t), [project, t]);
  const imageAssetItems = useMemo(
    () =>
      filterSelectorItems(selectorItems, {
        collections: ['assets'],
        assetKinds: ['image'],
        includeActions: false,
      }),
    [selectorItems],
  );
  const materialItems = useMemo(
    () =>
      filterSelectorItems(selectorItems, {
        collections: ['materials'],
        includeActions: false,
      }),
    [selectorItems],
  );
  const selectedSpriteItem = imageAssetItems.find(
    (item) => item.entityId === data.presentation.sprite?.$ref.id,
  );
  const selectedMaterialItem = materialItems.find(
    (item) => item.entityId === data.presentation.material?.$ref.id,
  );
  const [spriteSelectorOpen, setSpriteSelectorOpen] = useState(false);
  const [materialSelectorOpen, setMaterialSelectorOpen] = useState(false);
  const hotspotIds = useMemo(
    () =>
      data.presentation.hotspots.kind === 'none'
        ? []
        : data.presentation.hotspots.kind === 'sprite-alpha'
          ? [data.presentation.hotspots.hotspot.id]
          : data.presentation.hotspots.hotspots.map((item) => item.id),
    [data.presentation.hotspots],
  );
  const [hotspotView, setHotspotView] = useState<HotspotEditorViewState>(() => {
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
        captureTabState: () => ({
          schema: INTERACTABLE_EDITOR_TAB_STATE_SCHEMA,
          payload: { hotspotView, scroll: captureScrollViewState(scrollRef.current) },
        }),
        restoreTabState: (state) => {
          const parsed = parseInteractableEditorTabState(state);
          if (!parsed) return;
          setHotspotView(restoreHotspotViewState(parsed.hotspotView, hotspotIds));
          window.requestAnimationFrame(() =>
            restoreScrollViewState(scrollRef.current, parsed.scroll),
          );
        },
      }),
      [hotspotIds, hotspotView],
    ),
  );
  useEffect(
    () =>
      registerWorkbenchTargetHandler(tab.id, 'interactable.hotspot', (target) => {
        const id = target.id.slice('interactable.hotspot.'.length);
        if (!hotspotIds.includes(id)) return false;
        setHotspotView((current) => ({ ...current, selectedHotspotId: id }));
        return false;
      }),
    [hotspotIds, tab.id],
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
  const executeHotspot = (type: string, label: string, payload: Record<string, unknown>) =>
    useCommandStore.getState().executeCommand({
      type,
      label,
      payload: { interactableId, ...payload },
      originSaveUnitId: recordSaveUnitId('interactables', interactableId),
      persistencePolicy: 'manual-save',
    });
  const hotspotMode = data.presentation.hotspots;
  const hotspotItems =
    hotspotMode.kind === 'none'
      ? []
      : hotspotMode.kind === 'sprite-alpha'
        ? [hotspotMode.hotspot]
        : hotspotMode.hotspots;
  const nextHotspotId = () => {
    const ids = new Set(hotspotItems.map((item) => item.id));
    let index = 1;
    while (ids.has(index === 1 ? 'hotspot' : `hotspot-${index}`)) index += 1;
    return index === 1 ? 'hotspot' : `hotspot-${index}`;
  };
  const nextInputOrder = hotspotItems.reduce((max, item) => Math.max(max, item.inputOrder), -1);
  const chooseSprite = (item: SelectorItem) => {
    if (!item.entityId) return;
    commit(
      {
        ...data,
        presentation: { ...data.presentation, sprite: interactableAssetRef(item.entityId) },
      },
      'Update interactable sprite',
    );
  };
  const chooseMaterial = (item: SelectorItem) => {
    if (!item.entityId) return;
    commit(
      {
        ...data,
        presentation: { ...data.presentation, material: interactableMaterialRef(item.entityId) },
      },
      'Update interactable material',
    );
  };
  return (
    <div
      ref={scrollRef}
      data-interactable-editor-scroll
      className="h-full overflow-auto bg-background p-4"
    >
      <div className="flex gap-2">
        <h2 className="text-lg font-semibold">{record.label}</h2>
        <Badge variant="outline">{interactableId}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Reusable Interactable definition. Add instances from a Room editor.
      </p>
      <div className="mt-4 max-w-2xl">
        <GameplayArchetypeControls
          project={project}
          collection="interactables"
          entityId={interactableId}
          record={record}
          kind="interactable"
        />
      </div>
      <div
        data-workbench-anchor="interactable.summary"
        className="mt-4 grid max-w-2xl gap-3 rounded border p-3 md:grid-cols-2"
      >
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
        <div data-workbench-anchor="interactable.sprite">
          <Label>Sprite</Label>
          <div className="flex overflow-hidden rounded-md border bg-background">
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-w-0 flex-1 justify-start rounded-none px-3 py-2 text-left"
              onClick={() => setSpriteSelectorOpen(true)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {selectedSpriteItem?.title ?? 'Choose sprite'}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {selectedSpriteItem?.entityId ??
                    `${imageAssetItems.length} image assets available`}
                </span>
              </span>
            </Button>
            {data.presentation.sprite ? (
              <Button
                type="button"
                variant="ghost"
                className="h-auto rounded-none border-l px-3"
                onClick={() =>
                  commit(
                    { ...data, presentation: { ...data.presentation, sprite: null } },
                    'Clear interactable sprite',
                  )
                }
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>
        <div data-workbench-anchor="interactable.material">
          <Label>Material</Label>
          <div className="flex overflow-hidden rounded-md border bg-background">
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-w-0 flex-1 justify-start rounded-none px-3 py-2 text-left"
              onClick={() => setMaterialSelectorOpen(true)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {selectedMaterialItem?.title ?? 'Choose material'}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {selectedMaterialItem?.entityId ?? `${materialItems.length} materials available`}
                </span>
              </span>
            </Button>
            {data.presentation.material ? (
              <Button
                type="button"
                variant="ghost"
                className="h-auto rounded-none border-l px-3"
                onClick={() =>
                  commit(
                    { ...data, presentation: { ...data.presentation, material: null } },
                    'Clear interactable material',
                  )
                }
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>
        <div className="md:col-span-2">
          <InteractableLocationEditor
            project={project}
            location={data.initialState.location}
            onChange={(location) =>
              commit(
                { ...data, initialState: { ...data.initialState, location } },
                'Update interactable initial location',
              )
            }
          />
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
      <div className="mt-4 max-w-5xl space-y-4">
        <InventoryDeclarationsEditor
          inventories={data.inventories}
          onChange={(inventories, label) => commit({ ...data, inventories }, label)}
          title="Interactable Inventories"
        />
        <FeatureAuthoringPanel
          project={project}
          features={data.features}
          anchorPrefix="interactable"
          onChange={(features, label) => commit({ ...data, features }, label)}
        />
        <div
          data-workbench-anchor="interactable.hotspot-mode"
          className="flex items-center gap-2"
          tabIndex={-1}
        >
          <Label>{t('hotspots.mode.label')}</Label>
          <Button
            size="sm"
            variant={hotspotMode.kind === 'none' ? 'default' : 'outline'}
            onClick={() =>
              executeHotspot('interactable.setHotspotMode', 'Disable interactable hotspots', {
                kind: 'none',
              })
            }
          >
            {t('hotspots.mode.none')}
          </Button>
          <Button
            size="sm"
            variant={hotspotMode.kind === 'sprite-alpha' ? 'default' : 'outline'}
            onClick={() =>
              executeHotspot('interactable.setHotspotMode', 'Use sprite alpha hotspot', {
                kind: 'sprite-alpha',
              })
            }
          >
            {t('hotspots.mode.alpha')}
          </Button>
          <Button
            size="sm"
            variant={hotspotMode.kind === 'custom' ? 'default' : 'outline'}
            onClick={() =>
              executeHotspot('interactable.setHotspotMode', 'Use custom hotspots', {
                kind: 'custom',
              })
            }
          >
            {t('hotspots.mode.custom')}
          </Button>
        </div>
        <div data-workbench-anchor="interactable.hotspots">
          {hotspotMode.kind === 'none' ? (
            <p className="text-sm text-muted-foreground">{t('hotspots.mode.noneDescription')}</p>
          ) : (
            <HotspotAuthoringPanel
              anchorPrefix="interactable"
              project={project}
              projectFilePath={projectFilePath}
              title={
                hotspotMode.kind === 'sprite-alpha'
                  ? t('hotspots.mode.alphaTitle')
                  : t('hotspots.mode.customTitle')
              }
              assetId={data.presentation.sprite?.$ref.id ?? null}
              hotspots={hotspotItems}
              selectedView={hotspotView}
              ownerKind="interactable"
              ownerId={interactableId}
              localFeatures={data.features}
              alphaMode={hotspotMode.kind === 'sprite-alpha'}
              onViewChange={setHotspotView}
              onAdd={(bounds, target) => {
                if (hotspotMode.kind !== 'custom') return;
                const id = nextHotspotId();
                executeHotspot('interactable.addHotspot', 'Add interactable hotspot', {
                  hotspot: {
                    id,
                    label: t('hotspots.defaultLabel'),
                    condition: { kind: 'always' },
                    inputOrder: Math.min(2147483647, nextInputOrder + 1),
                    highlight: { kind: 'default' },
                    target,
                    shape: { kind: 'rect', bounds },
                  },
                });
                setHotspotView((view) => ({ ...view, selectedHotspotId: id, tool: 'select' }));
              }}
              onDelete={(hotspotId) =>
                executeHotspot('interactable.deleteHotspot', 'Delete interactable hotspot', {
                  hotspotId,
                })
              }
              onRename={(hotspotId, nextId) =>
                executeHotspot('interactable.renameHotspot', 'Rename interactable hotspot', {
                  hotspotId,
                  nextId,
                })
              }
              onUpdate={(hotspotId, hotspot) =>
                executeHotspot('interactable.updateHotspot', 'Update interactable hotspot', {
                  hotspotId,
                  hotspot,
                })
              }
              onBounds={(hotspotId, bounds) =>
                executeHotspot('interactable.setHotspotBounds', 'Set interactable hotspot bounds', {
                  hotspotId,
                  bounds,
                })
              }
            />
          )}
        </div>
      </div>
      <SearchSelectorDialog
        open={spriteSelectorOpen}
        title="Choose Interactable sprite"
        placeholder="Search image assets..."
        emptyMessage="No image assets match your search."
        items={imageAssetItems}
        selectedId={selectedSpriteItem?.id ?? null}
        leadingMediaSize={{ width: 80, height: 48 }}
        onOpenChange={setSpriteSelectorOpen}
        onSelect={chooseSprite}
      />
      <SearchSelectorDialog
        open={materialSelectorOpen}
        title="Choose Interactable material"
        placeholder="Search materials..."
        emptyMessage="No materials match your search."
        items={materialItems}
        selectedId={selectedMaterialItem?.id ?? null}
        onOpenChange={setMaterialSelectorOpen}
        onSelect={chooseMaterial}
      />
    </div>
  );
}
