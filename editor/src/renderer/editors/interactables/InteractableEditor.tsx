import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  defaultHotspotViewState,
  parseHotspotViewTabState,
  restoreHotspotViewState,
  type HotspotEditorViewState,
} from '@/components/image-stage/hotspot-view-state';
import { GameplayArchetypeControls } from '@/components/GameplayArchetypeControls';
import {
  InteractableDefinitionPropertiesEditor,
  InteractableInstancePropertiesEditor,
} from '@/components/properties/InteractablePropertyEditors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FeatureAuthoringPanel } from '@/components/features/FeatureAuthoringPanel';
import { HotspotAuthoringPanel } from '@/components/hotspots/HotspotAuthoringPanel';
import { InventoryDeclarationsEditor } from '@/components/inventories/InventoryControls';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useCommandStore } from '@/commands/command-store';
import { renameOwnerLocalPropertyReferencePatches } from '@/project/owner-local-property-references';
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

function escapePointerSegment(value: string) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
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
  const declaredInstances = useMemo(
    () =>
      project
        ? Object.entries(project.interactableInstances)
            .filter(([, instance]) => instance.definition.$ref.id === interactableId)
            .sort(([left], [right]) => left.localeCompare(right))
        : [],
    [interactableId, project],
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
  const applyProjectPatches = (label: string, patches: Array<Record<string, unknown>>) =>
    useCommandStore.getState().executeCommand({
      type: 'project.applyPatch',
      label,
      payload: patches,
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
      <div className="mt-4 max-w-3xl">
        <InteractableDefinitionPropertiesEditor
          project={project}
          definitionId={interactableId}
          properties={record.defaultProperties ?? []}
          attachedTraits={effectiveRecord?.traits ?? record.traits ?? []}
          onChange={(state) => {
            const base = `/interactables/${escapePointerSegment(interactableId)}`;
            const patches: Array<Record<string, unknown>> = [
              {
                op: Object.prototype.hasOwnProperty.call(record, 'defaultProperties')
                  ? 'replace'
                  : 'add',
                path: `${base}/defaultProperties`,
                value: state.properties,
              },
            ];
            if (record.archetype) {
              patches.push({
                op: Object.prototype.hasOwnProperty.call(record, 'archetypeOverrides')
                  ? 'replace'
                  : 'add',
                path: `${base}/archetypeOverrides`,
                value: { ...record.archetypeOverrides, '/traits': state.traits },
              });
            } else {
              patches.push({
                op: Object.prototype.hasOwnProperty.call(record, 'traits') ? 'replace' : 'add',
                path: `${base}/traits`,
                value: state.traits,
              });
            }
            applyProjectPatches('Update Interactable Properties', patches);
          }}
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
        <div className="space-y-2" data-workbench-anchor="interactable.stackable">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor={`interactable-stackable-${interactableId}`}>Stackable</Label>
              <p className="text-xs text-muted-foreground">
                Stackable instances carry a positive quantity on one identity.
              </p>
            </div>
            <Switch
              id={`interactable-stackable-${interactableId}`}
              checked={data.stackable}
              onCheckedChange={(stackable) =>
                commit({ ...data, stackable }, 'Update interactable stackability')
              }
            />
          </div>
        </div>
        <div data-workbench-anchor="interactable.stack-limit">
          <Label htmlFor={`interactable-stack-limit-${interactableId}`}>Stack limit</Label>
          <Input
            id={`interactable-stack-limit-${interactableId}`}
            type="number"
            min={1}
            step={1}
            placeholder="Unlimited"
            value={data.stackLimit ?? ''}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              const parsed = raw === '' ? null : Number(raw);
              if (parsed !== null && (!Number.isSafeInteger(parsed) || parsed <= 0)) return;
              commit({ ...data, stackLimit: parsed }, 'Update interactable stack limit');
            }}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Optional for stackable Interactables. Incompatible authored stacks are preserved and
            reported as validation errors.
          </p>
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
      </div>
      <div
        className="mt-4 max-w-2xl rounded border p-3"
        data-workbench-anchor="interactable.instances"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>{data.stackable ? 'Initial Stacks' : 'Declared Instances'}</Label>
            <p className="text-xs text-muted-foreground">
              {data.stackable
                ? 'Exact initial identities and their authored quantities.'
                : 'Exact live identities using this immutable definition.'}
            </p>
          </div>
          <Badge variant="secondary">{declaredInstances.length}</Badge>
        </div>
        {declaredInstances.length ? (
          <div className="mt-3 divide-y rounded border">
            {declaredInstances.map(([instanceId, instance]) => (
              <div key={instanceId} className="space-y-2 px-3 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{instance.editorLabel ?? instanceId}</div>
                    {instance.editorLabel ? (
                      <div className="truncate text-xs text-muted-foreground">{instanceId}</div>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-xs text-muted-foreground">
                    {instance.location.kind === 'room'
                      ? `Room: ${instance.location.room.$ref.id}`
                      : instance.location.kind === 'inventory'
                        ? `Inventory: ${instance.location.inventory.inventoryId}`
                        : 'Unplaced'}
                  </div>
                </div>
                <div className="max-w-40">
                  <Label htmlFor={`interactable-quantity-${instanceId}`}>Quantity</Label>
                  <Input
                    id={`interactable-quantity-${instanceId}`}
                    type="number"
                    min={1}
                    step={1}
                    value={instance.quantity}
                    onChange={(event) => {
                      const quantity = Number(event.currentTarget.value);
                      if (!Number.isSafeInteger(quantity) || quantity <= 0) return;
                      applyProjectPatches('Update Interactable Instance Quantity', [
                        {
                          op: 'replace',
                          path: `/interactableInstances/${escapePointerSegment(instanceId)}/quantity`,
                          value: quantity,
                        },
                      ]);
                    }}
                  />
                  {!data.stackable && instance.quantity !== 1 ? (
                    <p className="mt-1 text-xs text-destructive">
                      Non-stackable Interactable Instances must use quantity 1.
                    </p>
                  ) : null}
                </div>
                <InteractableInstancePropertiesEditor
                  compact
                  project={project}
                  instanceId={instanceId}
                  instance={instance}
                  onChange={(next, change) =>
                    applyProjectPatches('Update Interactable Instance Properties', [
                      {
                        op: 'replace',
                        path: `/interactableInstances/${escapePointerSegment(instanceId)}`,
                        value: next,
                      },
                      ...(change
                        ? renameOwnerLocalPropertyReferencePatches(
                            project,
                            { kind: 'interactable', id: instanceId },
                            change.fromId,
                            change.toId,
                          )
                        : []),
                    ])
                  }
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            No declared instances. Add this Interactable from a Room editor.
          </p>
        )}
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
          propertyMode="default"
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
