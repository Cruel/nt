import { MotionPlaybackEditor } from '../animations/MotionPlaybackEditor';
import {
  animationDataSchema,
  visualImageAssetId,
} from '../../../shared/project-schema/authoring-animations';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import {
  defaultHotspotViewState,
  parseHotspotViewTabState,
  restoreHotspotViewState,
  type HotspotEditorViewState,
} from '@/components/image-stage/hotspot-view-state';
import { GameplayArchetypeControls } from '@/components/GameplayArchetypeControls';
import { MaterialApplicationEditor } from '@/components/materials/MaterialApplicationEditor';
import { MaterialApplicationSpecializationEditor } from '@/components/materials/MaterialApplicationSpecializationEditor';
import {
  InteractableDefinitionPropertiesEditor,
  InteractableInstanceFeatureOverridesEditor,
  InteractableInstancePropertiesEditor,
} from '@/components/properties/InteractablePropertyEditors';
import { ExactInstanceDrafts } from '@/components/properties/ExactInstanceDrafts';
import { RecordPropertyArrayDrafts } from '@/components/properties/RecordPropertyArrayDrafts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FeatureAuthoringPanel } from '@/components/features/FeatureAuthoringPanel';
import { HotspotAuthoringPanel } from '@/components/hotspots/HotspotAuthoringPanel';
import { HotspotFocusWorkspace } from '@/components/hotspots/HotspotFocusWorkspace';
import { useHotspotFocusStore } from '@/components/hotspots/hotspot-focus-store';
import { GameplayInventoriesField } from '@/components/inventories/GameplayInventoriesField';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { projectEdits } from '@/commands/project-editing';
import {
  ProjectFieldError,
  ProjectFieldInput,
  ProjectFieldNumber,
  ProjectFieldSwitch,
} from '@/commands/use-project-field';
import { useGameplayRecordField } from '@/commands/gameplay-record-fields';
import { jsonValuesEqual, toJsonValue } from '@/project/json-value';
import { buildJsonPointer, hasJsonAtPointer } from '@/project/json-pointer';
import { useCurrentAuthoringDependencyGraphSnapshot } from '@/project/authoring-dependency-graph-runtime';
import { renameInteractableInstancePatches } from '@/project/interactable-instance-operations';
import { renameOwnerLocalPropertyReferencePatches } from '@/project/owner-local-property-references';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import {
  findAuthoringDependencyUsages,
  nestedNodeKey,
} from '../../../shared/authoring-graph-queries';
import { resolveGameplayInstanceRecord } from '../../../shared/project-schema/authoring-archetypes';
import {
  defaultInteractableData,
  interactableAssetRef,
  parseInteractableData,
  type InteractableData,
} from '../../../shared/project-schema/authoring-interactables';
import { isAuthoringProjectView } from '../../../shared/project-schema/authoring-project-view';
import {
  effectiveInteractableDefinitionProperties,
  effectiveInteractableInstanceProperties,
} from '../../../shared/project-schema/authoring-interactable-properties';
import { entityIdSchema } from '../../../shared/project-schema/authoring-common';
import { systemCursorNames } from '../../../shared/project-schema/authoring-cursor-vocabulary';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import type { AnimationMotion } from '../../../shared/animation-timeline';
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

function InteractableAnimationControls({
  interactableId,
  tabId,
  visual,
  motions,
  defaultMotionId,
  motionLabel,
  defaultLabel,
}: {
  interactableId: string;
  tabId: string;
  visual: Extract<NonNullable<InteractableData['presentation']['visual']>, { kind: 'animation' }>;
  motions: readonly AnimationMotion[];
  defaultMotionId: string;
  motionLabel: string;
  defaultLabel: string;
}) {
  const record = { collection: 'interactables' as const, id: interactableId };
  const motionDraft = useGameplayRecordField({
    record,
    tabId,
    field: '/presentation/visual/motionId',
    value: visual.motionId,
    label: 'Update Interactable Visual motion',
  });
  const playbackDraft = useGameplayRecordField({
    record,
    tabId,
    field: '/presentation/visual/playback',
    value: toJsonValue(visual.playback),
    label: 'Update Interactable motion playback',
  });
  const selectedMotion = motions.find(
    (motion) => motion.id === (motionDraft.value ?? defaultMotionId),
  );
  return (
    <>
      <div>
        <Label>{motionLabel}</Label>
        <Select
          items={[
            { value: '__default__', label: defaultLabel },
            ...motions.map((motion) => ({ value: motion.id, label: motion.id })),
          ]}
          value={motionDraft.value ?? '__default__'}
          onValueChange={(value) => {
            if (!value) return;
            motionDraft.change(value === '__default__' ? null : value);
            motionDraft.endSession();
          }}
        >
          <SelectTrigger aria-label={motionLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">{defaultLabel}</SelectItem>
            {motions.map((motion) => (
              <SelectItem key={motion.id} value={motion.id}>
                {motion.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ProjectFieldError field={motionDraft} />
      </div>
      {selectedMotion ? (
        <>
          <MotionPlaybackEditor
            motion={selectedMotion}
            value={playbackDraft.value as typeof visual.playback}
            onChange={(playback) => playbackDraft.change(toJsonValue(playback))}
          />
          <ProjectFieldError field={playbackDraft} />
        </>
      ) : null}
    </>
  );
}

function InteractableMaterialField({
  interactableId,
  tabId,
  value,
  project,
  properties,
  ariaLabel,
}: {
  interactableId: string;
  tabId: string;
  value: InteractableData['presentation']['materialApplication'];
  project: ComponentProps<typeof MaterialApplicationEditor>['project'];
  properties: ComponentProps<typeof MaterialApplicationEditor>['properties'];
  ariaLabel: string;
}) {
  const draft = useGameplayRecordField({
    record: { collection: 'interactables', id: interactableId },
    tabId,
    field: '/presentation/materialApplication',
    value: toJsonValue(value),
    label: 'Update interactable Material Application',
  });
  return (
    <>
      <MaterialApplicationEditor
        project={project}
        value={draft.value as InteractableData['presentation']['materialApplication']}
        expectedRole="engine-2d"
        properties={properties}
        ariaLabel={ariaLabel}
        onChange={(next) => draft.change(toJsonValue(next))}
      />
      <ProjectFieldError field={draft} />
    </>
  );
}

function InteractableCursorField({
  interactableId,
  tabId,
  value,
  namedCursors,
}: {
  interactableId: string;
  tabId: string;
  value: InteractableData['presentation']['cursor'];
  namedCursors: readonly { id: string }[];
}) {
  const { t } = useTranslation('workspace');
  const draft = useGameplayRecordField({
    record: { collection: 'interactables', id: interactableId },
    tabId,
    field: '/presentation/cursor',
    value: toJsonValue(value),
    label: 'Update interactable cursor',
  });
  const cursor = draft.value as InteractableData['presentation']['cursor'];
  const current =
    cursor?.kind === 'system'
      ? `system:${cursor.cursor}`
      : cursor?.kind === 'named'
        ? `named:${cursor.id}`
        : cursor?.kind === 'none'
          ? 'none'
          : 'fallback';
  const missingNamed =
    cursor?.kind === 'named' && !namedCursors.some((item) => item.id === cursor.id)
      ? cursor.id
      : null;
  return (
    <>
      <Select
        value={current}
        onValueChange={(selected) => {
          if (!selected) return;
          const next =
            selected === 'fallback'
              ? null
              : selected === 'none'
                ? { kind: 'none' as const }
                : selected.startsWith('system:')
                  ? {
                      kind: 'system' as const,
                      cursor: selected.slice(
                        'system:'.length,
                      ) as (typeof systemCursorNames)[number],
                    }
                  : { kind: 'named' as const, id: selected.slice('named:'.length) };
          draft.change(toJsonValue(next));
          draft.endSession();
        }}
      >
        <SelectItem value="fallback">{t('hotspots.cursor.projectDefault')}</SelectItem>
        <SelectItem value="none">{t('hotspots.cursor.none')}</SelectItem>
        {systemCursorNames.map((name) => (
          <SelectItem key={name} value={`system:${name}`}>
            {name}
          </SelectItem>
        ))}
        {namedCursors.map((name) => (
          <SelectItem key={name.id} value={`named:${name.id}`}>
            {name.id}
          </SelectItem>
        ))}
        {missingNamed ? (
          <SelectItem value={`named:${missingNamed}`}>
            {t('hotspots.cursor.missingNamed', { id: missingNamed })}
          </SelectItem>
        ) : null}
      </Select>
      <ProjectFieldError field={draft} />
    </>
  );
}

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
  const graphSnapshot = useCurrentAuthoringDependencyGraphSnapshot();
  const project = isAuthoringProjectView(document) ? document : null;
  const interactableId = tab.resource?.entityId;
  const record = interactableId && project ? project.interactables[interactableId] : null;
  const effectiveRecord =
    project && record ? resolveGameplayInstanceRecord(project, 'interactable', record) : record;
  const acknowledgedData =
    parseInteractableData(effectiveRecord?.data) ??
    defaultInteractableData(record?.label ?? interactableId ?? 'Interactable');
  const featuresDraft = useGameplayRecordField({
    record: { collection: 'interactables', id: interactableId ?? '__missing__' },
    tabId: tab.id,
    field: '/features',
    value: toJsonValue(acknowledgedData.features),
    label: 'Update Interactable Features',
  });
  const data: InteractableData = {
    ...acknowledgedData,
    features: featuresDraft.value as InteractableData['features'],
  };
  const selectorItems = useMemo(() => buildCommandPaletteItems(project, t), [project, t]);
  const imageAssetItems = useMemo(
    () => [
      ...filterSelectorItems(selectorItems, {
        collections: ['assets'],
        assetKinds: ['image'],
        includeActions: false,
      }),
      ...filterSelectorItems(selectorItems, { collections: ['animations'], includeActions: false }),
    ],
    [selectorItems],
  );
  const selectedSpriteItem = imageAssetItems.find(
    (item) =>
      item.entityId ===
        (data.presentation.visual?.kind === 'image'
          ? data.presentation.visual.image.$ref.id
          : data.presentation.visual?.animation.$ref.id) &&
      item.collection ===
        (data.presentation.visual?.kind === 'animation' ? 'animations' : 'assets'),
  );
  const selectedAnimation =
    data.presentation.visual?.kind === 'animation'
      ? animationDataSchema.safeParse(
          project?.animations[data.presentation.visual.animation.$ref.id]?.data,
        )
      : null;
  const materialProperties = useMemo(
    () =>
      project && interactableId
        ? effectiveInteractableDefinitionProperties(project, interactableId)
        : [],
    [interactableId, project],
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
  const hotspotIds = useMemo(
    () =>
      data.presentation.hotspots.kind === 'none'
        ? []
        : data.presentation.hotspots.kind === 'visual-alpha'
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
  const hotspotFocusSession = useHotspotFocusStore((state) => state.sessionsByTabId[tab.id]);
  const startHotspotFocus = useHotspotFocusStore((state) => state.start);
  const restoreHotspotFocus = useHotspotFocusStore((state) => state.restore);
  const hotspotMode = data.presentation.hotspots;
  const hotspotItems = useMemo(
    () =>
      hotspotMode.kind === 'none'
        ? []
        : hotspotMode.kind === 'visual-alpha'
          ? [hotspotMode.hotspot]
          : hotspotMode.hotspots,
    [hotspotMode],
  );
  useEffect(() => {
    if (!project || !record || !interactableId || hotspotFocusSession) return;
    restoreHotspotFocus({
      tabId: tab.id,
      ownerKind: 'interactable',
      ownerId: interactableId,
      assetId: visualImageAssetId(project, data.presentation.visual),
      mode: hotspotMode.kind === 'custom' ? 'rectangles' : 'visual-alpha',
      items: hotspotItems,
    });
  }, [
    data.presentation.visual,
    hotspotFocusSession,
    hotspotItems,
    hotspotMode.kind,
    interactableId,
    project,
    record,
    restoreHotspotFocus,
    tab.id,
  ]);
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
  const commit = (next: InteractableData, label: string) => {
    const request = projectEdits.recordData({
      record: { collection: 'interactables', id: interactableId },
      before: data,
      after: next,
      label,
    });
    if (request) void projectEdits.execute(request);
  };
  const interactableField = (
    relativePath: string,
    value: string | number | boolean | null,
    label: string,
  ) =>
    projectEdits.recordField({
      record: { collection: 'interactables', id: interactableId },
      field: relativePath,
      value,
      label,
    });
  const executeHotspot = (type: string, label: string, payload: Record<string, unknown>) =>
    void projectEdits.execute({
      type,
      label,
      payload: { interactableId, ...payload },
      originSaveUnitId: recordSaveUnitId('interactables', interactableId),
      persistencePolicy: 'manual-save',
    });
  const applyProjectPatches = (label: string, patches: Array<Record<string, unknown>>) =>
    void projectEdits.execute({
      type: 'project.applyPatch',
      label,
      payload: patches,
      originSaveUnitId: recordSaveUnitId('interactables', interactableId),
      persistencePolicy: 'manual-save',
    });
  const chooseSprite = (item: SelectorItem) => {
    if (!item.entityId) return;
    commit(
      {
        ...data,
        presentation: {
          ...data.presentation,
          visual:
            item.collection === 'animations'
              ? {
                  kind: 'animation',
                  animation: { $ref: { collection: 'animations', id: item.entityId } },
                  motionId: null,
                  playback: null,
                }
              : { kind: 'image', image: interactableAssetRef(item.entityId) },
        },
      },
      'Update interactable sprite',
    );
  };
  if (hotspotFocusSession) {
    return (
      <HotspotFocusWorkspace
        tabId={tab.id}
        projectAssets={project.assets}
        createHotspot={(id, inputOrder, bounds) => ({
          id,
          label: t('hotspots.defaultLabel'),
          condition: { kind: 'always' },
          inputOrder,
          highlight: { kind: 'default' },
          target: { kind: 'owner' },
          shape: { kind: 'rect', bounds },
        })}
      />
    );
  }
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
        <RecordPropertyArrayDrafts
          collection="interactables"
          recordId={interactableId}
          tabId={tab.id}
          fieldName="defaultProperties"
          properties={record.defaultProperties ?? []}
        >
          {(properties, changeProperties) => (
            <InteractableDefinitionPropertiesEditor
              project={project}
              definitionId={interactableId}
              properties={properties}
              attachedTraits={effectiveRecord?.traits ?? record.traits ?? []}
              onChange={(state) => {
                // Changing only Property schemas or Defaults is a single stable
                // record field. Trait attachment is a coordinated semantic edit
                // and keeps its atomic command instead of splitting owners.
                if (
                  jsonValuesEqual(
                    toJsonValue(state.traits),
                    toJsonValue(effectiveRecord?.traits ?? record.traits ?? []),
                  )
                ) {
                  changeProperties(state.properties);
                  return;
                }
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
          )}
        </RecordPropertyArrayDrafts>
      </div>
      <div
        data-workbench-anchor="interactable.summary"
        className="mt-4 grid max-w-2xl gap-3 rounded border p-3 @3xl:grid-cols-2"
      >
        <div>
          <Label>Display name</Label>
          <ProjectFieldInput
            value={data.displayName}
            tabId={tab.id}
            saveUnitId={recordSaveUnitId('interactables', interactableId)}
            path={buildJsonPointer(['interactables', interactableId, 'data', 'displayName'])}
            label="Update interactable name"
            buildCommand={(next) =>
              interactableField('/displayName', next, 'Update interactable name')
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
            <ProjectFieldSwitch
              id={`interactable-stackable-${interactableId}`}
              value={data.stackable}
              tabId={tab.id}
              saveUnitId={recordSaveUnitId('interactables', interactableId)}
              path={buildJsonPointer(['interactables', interactableId, 'data', 'stackable'])}
              label="Update interactable stackability"
              buildCommand={(next) =>
                interactableField('/stackable', next, 'Update interactable stackability')
              }
            />
          </div>
        </div>
        <div data-workbench-anchor="interactable.stack-limit">
          <Label htmlFor={`interactable-stack-limit-${interactableId}`}>Stack limit</Label>
          <ProjectFieldNumber
            id={`interactable-stack-limit-${interactableId}`}
            type="number"
            min={1}
            step={1}
            optional
            placeholder="Unlimited"
            value={data.stackLimit}
            tabId={tab.id}
            saveUnitId={recordSaveUnitId('interactables', interactableId)}
            path={buildJsonPointer(['interactables', interactableId, 'data', 'stackLimit'])}
            label="Update interactable stack limit"
            buildCommand={(next) =>
              interactableField('/stackLimit', next, 'Update interactable stack limit')
            }
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Optional for stackable Interactables. Incompatible authored stacks are preserved and
            reported as validation errors.
          </p>
        </div>
        <div data-workbench-anchor="interactable.visual">
          <Label>{t('interactable.visual.label')}</Label>
          <div className="flex overflow-hidden rounded-md border bg-background">
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-w-0 flex-1 justify-start rounded-none px-3 py-2 text-left"
              onClick={() => setSpriteSelectorOpen(true)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {selectedSpriteItem?.title ?? t('interactable.visual.choose')}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {selectedSpriteItem?.entityId ??
                    t('interactable.visual.available', { count: imageAssetItems.length })}
                </span>
              </span>
            </Button>
            {data.presentation.visual ? (
              <Button
                type="button"
                variant="ghost"
                className="h-auto rounded-none border-l px-3"
                onClick={() =>
                  commit(
                    { ...data, presentation: { ...data.presentation, visual: null } },
                    'Clear interactable sprite',
                  )
                }
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>
        {data.presentation.visual?.kind === 'animation' && selectedAnimation?.success ? (
          <InteractableAnimationControls
            interactableId={interactableId}
            tabId={tab.id}
            visual={data.presentation.visual}
            motions={selectedAnimation.data.motions}
            defaultMotionId={selectedAnimation.data.defaultMotionId}
            motionLabel={t('interactable.visual.motion')}
            defaultLabel={t('interactable.visual.defaultMotion')}
          />
        ) : null}
        <div data-workbench-anchor="interactable.material">
          <Label>Material</Label>
          <InteractableMaterialField
            interactableId={interactableId}
            tabId={tab.id}
            project={project}
            value={data.presentation.materialApplication}
            properties={materialProperties}
            ariaLabel={t('materialSelector.interactableChoose')}
          />
        </div>
        <div data-workbench-anchor="interactable.cursor">
          <Label>{t('hotspots.fields.cursor')}</Label>
          <InteractableCursorField
            interactableId={interactableId}
            tabId={tab.id}
            value={data.presentation.cursor}
            namedCursors={project.settings.cursors.named}
          />
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
            {declaredInstances.map(([instanceId, acknowledgedInstance]) => (
              <ExactInstanceDrafts
                key={instanceId}
                instanceId={instanceId}
                instance={acknowledgedInstance}
                owner={{ collection: 'interactables', id: interactableId }}
                tabId={tab.id}
                onAtomicRename={(next, change) =>
                  applyProjectPatches('Update Interactable Instance Properties', [
                    {
                      op: 'replace',
                      path: `/interactableInstances/${escapePointerSegment(instanceId)}`,
                      value: next,
                    },
                    ...renameOwnerLocalPropertyReferencePatches(
                      project,
                      { kind: 'interactable', id: instanceId },
                      change.fromId,
                      change.toId,
                    ),
                  ])
                }
              >
                {(instance, updateInstance) => (
                  <div key={instanceId} className="space-y-2 px-3 py-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {instance.editorLabel ?? instanceId}
                        </div>
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
                    <div className="grid max-w-xl gap-1">
                      <Label htmlFor={`interactable-editor-label-${instanceId}`}>
                        Editor label
                      </Label>
                      <ProjectFieldInput
                        id={`interactable-editor-label-${instanceId}`}
                        value={instance.editorLabel ?? ''}
                        placeholder="Optional non-semantic label"
                        tabId={tab.id}
                        saveUnitId={recordSaveUnitId('interactables', interactableId)}
                        path={`/interactableInstances/${escapePointerSegment(instanceId)}/editorLabel`}
                        scope="exact-instance"
                        label="Update Interactable Instance editor label"
                        buildCommand={(next) => {
                          const latest = useProjectStore.getState().document;
                          if (!isAuthoringProjectView(latest))
                            throw new Error('The Project is no longer open.');
                          const current = latest.interactableInstances[instanceId];
                          if (!current) throw new Error('The exact Instance was removed.');
                          const owner = recordSaveUnitId('interactables', interactableId);
                          const root = buildJsonPointer(['interactableInstances', instanceId]);
                          const path = `${root}/editorLabel`;
                          if (next.trim())
                            return {
                              type: hasJsonAtPointer(latest, path)
                                ? 'project.replaceAtPath'
                                : 'project.addAtPath',
                              label: 'Update Interactable Instance editor label',
                              payload: { path, value: next },
                              originSaveUnitId: owner,
                              persistencePolicy: 'manual-save',
                            };
                          if (hasJsonAtPointer(latest, path))
                            return {
                              type: 'project.removeAtPath',
                              label: 'Clear Interactable Instance editor label',
                              payload: { path },
                              originSaveUnitId: owner,
                              persistencePolicy: 'manual-save',
                            };
                          // Clearing an already-empty optional field cannot
                          // issue a remove; preserve the latest Instance as-is.
                          return {
                            type: 'project.replaceAtPath',
                            label: 'Clear Interactable Instance editor label',
                            payload: { path: root, value: toJsonValue(current) },
                            originSaveUnitId: owner,
                            persistencePolicy: 'manual-save',
                          };
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        Editor-only. This does not change the exact gameplay identity.
                      </p>
                    </div>
                    <details className="max-w-xl rounded border p-2">
                      <summary className="cursor-pointer text-xs font-medium">
                        Advanced identity
                      </summary>
                      <div className="mt-2 grid gap-1">
                        <Label htmlFor={`interactable-instance-id-${instanceId}`}>
                          Instance ID
                        </Label>
                        <Input
                          key={instanceId}
                          id={`interactable-instance-id-${instanceId}`}
                          defaultValue={instanceId}
                          onBlur={(event) => {
                            const nextId = event.currentTarget.value.trim();
                            if (
                              nextId === instanceId ||
                              !entityIdSchema.safeParse(nextId).success ||
                              project.interactableInstances[nextId]
                            ) {
                              event.currentTarget.value = instanceId;
                              return;
                            }
                            const patches = renameInteractableInstancePatches(
                              project,
                              instanceId,
                              nextId,
                            );
                            if (patches.length)
                              applyProjectPatches('Rename Interactable Instance ID', patches);
                          }}
                        />
                        <p className="text-xs text-muted-foreground">
                          Advanced: rewrites typed references to preserve this exact identity under
                          a new authored ID.
                        </p>
                      </div>
                    </details>
                    <div className="max-w-40">
                      <Label htmlFor={`interactable-quantity-${instanceId}`}>Quantity</Label>
                      <ProjectFieldNumber
                        id={`interactable-quantity-${instanceId}`}
                        min={1}
                        step={1}
                        scope="exact-instance"
                        tabId={tab.id}
                        saveUnitId={recordSaveUnitId('interactables', interactableId)}
                        path={`/interactableInstances/${escapePointerSegment(instanceId)}/quantity`}
                        label="Update Interactable Instance Quantity"
                        value={instance.quantity}
                      />
                      {!data.stackable && instance.quantity !== 1 ? (
                        <p className="mt-1 text-xs text-destructive">
                          Non-stackable Interactable Instances must use quantity 1.
                        </p>
                      ) : null}
                    </div>
                    <MaterialApplicationSpecializationEditor
                      project={project}
                      inheritedValue={data.presentation.materialApplication}
                      value={instance.materialApplication}
                      properties={effectiveInteractableInstanceProperties(project, instance)}
                      ariaLabel={`Choose ${instance.editorLabel ?? instanceId} material`}
                      onChange={(materialApplication) =>
                        updateInstance({ ...instance, materialApplication })
                      }
                    />
                    <InteractableInstancePropertiesEditor
                      compact
                      project={project}
                      instanceId={instanceId}
                      instance={instance}
                      onChange={updateInstance}
                    />
                    {!data.stackable && data.features.length ? (
                      <div className="space-y-2 border-t pt-3">
                        <div>
                          <Label>Feature Overrides</Label>
                          <p className="text-xs text-muted-foreground">
                            Sparse Trait and Property state for Features realized on this exact
                            Instance.
                          </p>
                        </div>
                        {data.features.map((feature) => (
                          <InteractableInstanceFeatureOverridesEditor
                            key={feature.id}
                            project={project}
                            instanceId={instanceId}
                            instance={instance}
                            featureId={feature.id}
                            featureLabel={`${feature.label} (${feature.id})`}
                            onChange={updateInstance}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </ExactInstanceDrafts>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            No declared instances. Add this Interactable from a Room editor.
          </p>
        )}
      </div>
      <div className="mt-4 max-w-5xl space-y-4">
        <GameplayInventoriesField
          collection="interactables"
          recordId={interactableId}
          tabId={tab.id}
          inventories={data.inventories}
          title="Interactable Inventories"
        />
        <FeatureAuthoringPanel
          project={project}
          features={data.features}
          anchorPrefix="interactable"
          ownerId={interactableId}
          dependentReferenceCountFor={(featureId) => {
            if (!graphSnapshot) return 0;
            return findAuthoringDependencyUsages(
              graphSnapshot.graph,
              nestedNodeKey('interactables', interactableId, 'interactable-feature', featureId),
            ).filter(
              (edge) =>
                !edge.sourcePath.includes('/featureOverrides/') &&
                !(edge.role === 'explicit-ref' && edge.sourcePath.includes('/data/features/')),
            ).length;
          }}
          propertyMode="default"
          onChange={(features, label) => {
            if (label !== 'Delete Feature') {
              featuresDraft.change(toJsonValue(features));
              return;
            }
            const remainingIds = new Set(features.map((feature) => feature.id));
            const deletedFeature = data.features.find((feature) => !remainingIds.has(feature.id));
            if (!deletedFeature) {
              commit({ ...data, features }, label);
              return;
            }
            const patches: Array<Record<string, unknown>> = [
              {
                op: 'replace',
                path: `/interactables/${escapePointerSegment(interactableId)}/data/features`,
                value: features,
              },
            ];
            for (const [instanceId, instance] of Object.entries(project.interactableInstances)) {
              if (instance.definition.$ref.id !== interactableId) continue;
              const nextOverrides = instance.featureOverrides.filter(
                (override) => override.featureId !== deletedFeature.id,
              );
              if (nextOverrides.length === instance.featureOverrides.length) continue;
              patches.push({
                op: 'replace',
                path: `/interactableInstances/${escapePointerSegment(instanceId)}/featureOverrides`,
                value: nextOverrides,
              });
            }
            applyProjectPatches('Delete Interactable Feature', patches);
          }}
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
            variant={hotspotMode.kind === 'visual-alpha' ? 'default' : 'outline'}
            onClick={() =>
              executeHotspot('interactable.setHotspotMode', 'Use sprite alpha hotspot', {
                kind: 'visual-alpha',
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
                hotspotMode.kind === 'visual-alpha'
                  ? t('hotspots.mode.alphaTitle')
                  : t('hotspots.mode.customTitle')
              }
              assetId={visualImageAssetId(project, data.presentation.visual)}
              hotspots={hotspotItems}
              selectedView={hotspotView}
              ownerKind="interactable"
              ownerId={interactableId}
              materialProperties={materialProperties}
              localFeatures={data.features}
              alphaMode={hotspotMode.kind === 'visual-alpha'}
              onViewChange={setHotspotView}
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
              onEditGeometry={(selectedHotspotId) =>
                startHotspotFocus({
                  tabId: tab.id,
                  ownerKind: 'interactable',
                  ownerId: interactableId,
                  assetId: visualImageAssetId(project, data.presentation.visual),
                  mode: hotspotMode.kind === 'custom' ? 'rectangles' : 'visual-alpha',
                  items: hotspotItems,
                  selectedHotspotId,
                })
              }
            />
          )}
        </div>
      </div>
      <SearchSelectorDialog
        open={spriteSelectorOpen}
        title={t('workspace:interactable.visual.choose')}
        placeholder={t('workspace:interactable.visual.search')}
        emptyMessage={t('workspace:interactable.visual.empty')}
        items={imageAssetItems}
        selectedId={selectedSpriteItem?.id ?? null}
        leadingMediaSize={{ width: 80, height: 48 }}
        onOpenChange={setSpriteSelectorOpen}
        onSelect={chooseSprite}
      />
    </div>
  );
}
