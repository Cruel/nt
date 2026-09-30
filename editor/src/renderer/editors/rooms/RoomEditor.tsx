import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { GameplayArchetypeControls } from '@/components/GameplayArchetypeControls';
import { CollectionMasterDetail } from '@/components/collection-master-detail';
import { EditorHelpIcon, EditorSectionHeading } from '@/components/editor-section-heading';
import { HookRegistryResolutionInspector } from '@/components/HookRegistryResolutionInspector';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Braces,
  Camera,
  ChevronsUpDown,
  Image,
  Layers3,
  MousePointerClick,
  Plus,
  Settings2,
  Trash2,
  Waypoints,
  Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ColorField } from '@/components/ui/color-field';
import {
  backgroundFitIconByMode,
  type BackgroundFitMode,
} from '@/components/icons/background-fit-icons';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LuaExplicitFallbackEditor } from '@/components/lua-explicit-fallback-editor';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import {
  ownerLocalPropertyReferences,
  renameOwnerLocalPropertyReferencePatches,
} from '@/project/owner-local-property-references';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import { DerivedPreviewPane } from '@/preview/DerivedPreviewPane';
import { EditorPreviewSplit } from '@/components/editor-preview-split';
import { FeatureAuthoringPanel } from '@/components/features/FeatureAuthoringPanel';
import {
  OwnerLocalPropertiesEditor,
  type OwnerPropertyTraitState,
} from '@/components/properties/OwnerLocalPropertiesEditor';
import { InteractableInstancePropertiesEditor } from '@/components/properties/InteractablePropertyEditors';
import { HotspotAuthoringPanel } from '@/components/hotspots/HotspotAuthoringPanel';
import { HotspotFocusWorkspace } from '@/components/hotspots/HotspotFocusWorkspace';
import { useHotspotFocusStore } from '@/components/hotspots/hotspot-focus-store';
import { MaterialApplicationEditor } from '@/components/materials/MaterialApplicationEditor';
import { RecursiveConditionEditor } from '@/components/conditions/ConditionEditor';
import {
  GameplayCommandListEditor,
  type GameplayCommandKind,
} from '@/components/gameplay-commands/GameplayCommandEditor';
import { RoomEditSurface } from '@/editors/rooms/RoomEditSurface';
import { RoomCompositionPane } from '@/editors/rooms/RoomCompositionPane';
import {
  interpolateRoomEditNavigation,
  fitRoomEditSurfaceFrame,
  ROOM_EDIT_FIT_NAVIGATION,
  ROOM_EDIT_NAVIGATION_TRANSITION_MS,
  sanitizeRoomEditNavigation,
  type RoomEditNavigation,
} from '@/editors/rooms/room-edit-navigation';
import {
  CategorizedEditorLayout,
  type CategorizedEditorCategory,
} from '@/components/CategorizedEditorLayout';
import { resolveEditorPreviewSplitOrientation } from '@/components/editor-preview-layout';
import {
  defaultHotspotViewState,
  parseHotspotViewTabState,
  restoreHotspotViewState,
  type HotspotEditorViewState,
} from '@/components/image-stage/hotspot-view-state';
import { containRect } from '@/components/image-stage/image-stage-transforms';
import { usePreferencesStore } from '@/stores/preferences-store';
import { AssetImageThumbnail } from '@/workspace/AssetImageThumbnail';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import {
  buildCommandPaletteItems,
  filterSelectorItems,
  type SelectorItem,
} from '@/workspace/command-palette-search';
import { escapeJsonPointerSegment } from '@/project/json-pointer';

const roomPrecommitGameplayCommandKinds: readonly GameplayCommandKind[] = [
  'set-global-property',
  'unset-global-property',
  'set-property',
  'unset-property',
  'add-trait',
  'remove-trait',
  'set-enabled',
  'set-visible',
  'move-instance',
  'create-room',
  'create-character',
  'create-interactable',
  'destroy-instance',
  'split-quantity',
  'merge-quantity',
  'transfer-quantity',
  'add-quantity',
  'consume-quantity',
  'present-inventory',
  'if',
];
import {
  defaultRoomData,
  parseRoomData,
  roomAssetRef,
  roomBackgroundFitValues,
  roomEnvironmentClockValues,
  roomEnvironmentPlaneValues,
  roomExitDirectionValues,
  roomLayoutRef,
  roomRoomRef,
  roomScriptHookKindValues,
  type RoomCastData,
  type RoomData,
  type RoomEnvironmentData,
  type RoomExitData,
  type RoomInteractableData,
  type RoomOverlayData,
  type RoomPlacementData,
  type RoomPropData,
} from '../../../shared/project-schema/authoring-rooms';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../../../shared/project-schema/authoring-project-settings';
import { inlineTextContent, type TextContent } from '../../../shared/project-schema/authoring-flow';
import { resolveMaterialData } from '../../../shared/project-schema/authoring-materials';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  captureScrollViewState,
  isScrollViewState,
  restoreScrollViewState,
  useWorkbenchEditorTabState,
  useWorkbenchTabStateStore,
  type ScrollViewState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';
import { recordTabPreviewVisible } from '@/workbench/preview-visibility-command';
import { buildRoomDetailTabForRecord } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useOptionalWorkbenchEditorLocation } from '@/workbench/workbench-editor-location';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import {
  registerWorkbenchTargetHandler,
  type PendingWorkbenchRevealTarget,
} from '@/workbench/workbench-navigation';
import { RoomExitDirectionSelector } from './RoomExitDirectionSelector';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { parseCharacterData } from '../../../shared/project-schema/authoring-characters';
import {
  resolveArchetypeConfiguration,
  resolveGameplayInstanceRecord,
} from '../../../shared/project-schema/authoring-archetypes';
import type { OwnerLocalProperty } from '../../../shared/project-schema/authoring-properties';
import {
  allocateRoomPresentationOrder,
  ROOM_PRESENTATION_ORDER_MAX,
  ROOM_PRESENTATION_ORDER_MIN,
  roomPresentationOrderEntries,
  roomPresentationPlaneForTarget,
  type RoomPresentationOrderTarget,
  type RoomPresentationReorderAction,
} from '../../../shared/project-schema/room-presentation-order';
import { analyzeHookRegistry } from '../../../shared/hook-registry-analysis';
import type { AppliedPreviewDocumentResult } from '../../../shared/focused-preview-contracts';
import { resolveRoomEditProjection, type RoomEditResolvedVisibility } from './room-edit-projection';
import {
  describeRoomEditSelection,
  roomEditSelectionExists,
  roomEditSelectionKey,
  type RoomEditSelection,
  type RoomEditSelectionKind,
} from './room-edit-selection';

const backgroundFitLabels = {
  cover: 'Cover',
  contain: 'Contain',
  stretch: 'Stretch',
  center: 'Center',
} satisfies Record<BackgroundFitMode, string>;

type RoomEditorCategory =
  | 'general'
  | 'camera'
  | 'composition'
  | 'hotspots'
  | 'navigation'
  | 'contents'
  | 'properties'
  | 'behavior';

type RoomAddSpatialTarget =
  | { kind: 'drop' }
  | { kind: 'point'; point: { x: number; y: number } }
  | { kind: 'placement'; placementId: string };
type RoomAddContent =
  | { kind: 'placement' }
  | {
      kind: 'prop';
      source: { kind: 'asset'; assetId: string } | { kind: 'material'; materialId: string };
    }
  | { kind: 'cast'; characterId: string }
  | {
      kind: 'interactable';
      source: { kind: 'new'; definitionId: string } | { kind: 'existing'; instanceId: string };
    }
  | { kind: 'environment'; materialId: string; assetId?: string };

type RoomAddRequest =
  | { kind: 'prop' | 'cast' | 'interactable'; target: RoomAddSpatialTarget }
  | { kind: 'environment'; target: RoomAddSpatialTarget; materialId?: string };

function roomPresentationTargetForSelection(
  selection: RoomEditSelection,
): RoomPresentationOrderTarget | null {
  switch (selection.kind) {
    case 'cast':
    case 'prop':
    case 'interactable':
    case 'environment':
    case 'overlay':
      return { kind: selection.kind, id: selection.id };
    case 'placement-layout':
      return { kind: 'placement-layout', id: selection.id };
    case 'placement':
    case 'hotspot':
      return null;
  }
}

type RoomEditorCategoryDefinition = Pick<
  CategorizedEditorCategory<RoomEditorCategory>,
  'id' | 'icon'
>;

const roomEditorCategories: readonly RoomEditorCategoryDefinition[] = [
  { id: 'general', icon: Settings2 },
  { id: 'camera', icon: Camera },
  { id: 'composition', icon: Boxes },
  { id: 'hotspots', icon: MousePointerClick },
  { id: 'navigation', icon: Waypoints },
  { id: 'contents', icon: Layers3 },
  { id: 'properties', icon: Braces },
  { id: 'behavior', icon: Workflow },
];

function isRoomEditorCategory(value: unknown): value is RoomEditorCategory {
  return roomEditorCategories.some((category) => category.id === value);
}

function roomEditorCategoryForTarget(targetId: string): RoomEditorCategory {
  if (targetId.startsWith('room.properties') || targetId.startsWith('room.property.'))
    return 'properties';
  if (targetId.startsWith('instance.property.')) return 'composition';
  if (targetId.startsWith('room.camera') || targetId.startsWith('room.anchor')) return 'camera';
  if (targetId.startsWith('room.hotspot')) return 'hotspots';
  if (targetId.startsWith('room.exit') || targetId === 'room.exits') return 'navigation';
  if (
    targetId.startsWith('room.composition') ||
    targetId.startsWith('room.placement') ||
    targetId === 'room.placements'
  )
    return 'composition';
  if (
    targetId.startsWith('room.overlay') ||
    targetId.startsWith('room.cast') ||
    targetId.startsWith('room.prop') ||
    targetId.startsWith('room.environment')
  )
    return 'contents';
  if (targetId.startsWith('room.lifecycle') || targetId.startsWith('room.script-hooks'))
    return 'behavior';
  return 'general';
}

function BackgroundFitOption({ fit }: { fit: BackgroundFitMode }) {
  const Icon = backgroundFitIconByMode[fit];
  return (
    <span className="flex flex-col items-center gap-1.5">
      <Icon className="size-10" />
      <span className="text-[10px] leading-none">{backgroundFitLabels[fit]}</span>
    </span>
  );
}

const ROOM_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.room';
type RoomPresentationMode = 'edit' | 'preview';
const isRoomPresentationMode = (value: unknown): value is RoomPresentationMode =>
  value === 'edit' || value === 'preview';
type RoomEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof ROOM_EDITOR_TAB_STATE_SCHEMA;
  payload: {
    scroll?: ScrollViewState;
    activeCategory: RoomEditorCategory;
    presentationMode: RoomPresentationMode;
    editNavigation: RoomEditNavigation;
    selection: RoomEditSelection[];
    expandedSelectionKeys: string[];
    previewCollapsed: boolean;
    hotspotView: HotspotEditorViewState;
  };
};

const roomEditSelectionKinds = new Set<RoomEditSelectionKind>([
  'placement',
  'placement-layout',
  'interactable',
  'prop',
  'cast',
  'environment',
  'overlay',
  'hotspot',
]);

function parseRoomEditSelection(value: unknown): RoomEditSelection[] | null {
  if (!Array.isArray(value)) return null;
  const result: RoomEditSelection[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.kind !== 'string' ||
      !roomEditSelectionKinds.has(candidate.kind as RoomEditSelectionKind) ||
      typeof candidate.id !== 'string' ||
      candidate.id.length === 0
    )
      return null;
    const selection = {
      kind: candidate.kind as RoomEditSelectionKind,
      id: candidate.id,
    };
    const key = roomEditSelectionKey(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(selection);
  }
  return result;
}

function parseRoomEditNavigation(value: unknown): RoomEditNavigation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const navigation = value as Record<string, unknown>;
  if (
    typeof navigation.zoom !== 'number' ||
    typeof navigation.pan !== 'object' ||
    navigation.pan === null ||
    Array.isArray(navigation.pan)
  )
    return null;
  const pan = navigation.pan as Record<string, unknown>;
  if (typeof pan.x !== 'number' || typeof pan.y !== 'number') return null;
  return sanitizeRoomEditNavigation({ zoom: navigation.zoom, pan: { x: pan.x, y: pan.y } });
}

function prefersReducedRoomEditMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function parseRoomEditorTabState(
  value: WorkbenchTabStatePayload,
): RoomEditorTabState['payload'] | null {
  if (
    value.schema !== ROOM_EDITOR_TAB_STATE_SCHEMA ||
    typeof value.payload !== 'object' ||
    value.payload === null ||
    Array.isArray(value.payload)
  )
    return null;
  const payload = value.payload as Record<string, unknown>;
  const hotspotView = parseHotspotViewTabState(payload.hotspotView);
  const editNavigation = parseRoomEditNavigation(payload.editNavigation);
  const selection = parseRoomEditSelection(payload.selection);
  const expandedSelectionKeys =
    Array.isArray(payload.expandedSelectionKeys) &&
    payload.expandedSelectionKeys.every((key) => typeof key === 'string')
      ? payload.expandedSelectionKeys
      : null;
  if (
    !isRoomEditorCategory(payload.activeCategory) ||
    !isRoomPresentationMode(payload.presentationMode) ||
    !editNavigation ||
    !selection ||
    !expandedSelectionKeys ||
    typeof payload.previewCollapsed !== 'boolean' ||
    !hotspotView
  )
    return null;
  return {
    scroll: isScrollViewState(payload.scroll) ? payload.scroll : undefined,
    activeCategory: payload.activeCategory,
    presentationMode: payload.presentationMode,
    editNavigation,
    selection,
    expandedSelectionKeys,
    previewCollapsed: payload.previewCollapsed,
    hotspotView,
  };
}
const nextId = (ids: Iterable<string>, base: string) => {
  const used = new Set(ids);
  for (let n = 1; n < 1000; n += 1) {
    const value = n === 1 ? base : `${base}-${n}`;
    if (!used.has(value)) return value;
  }
  return `${base}-${Date.now()}`;
};
const numberValue = (value: string, fallback: number) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const oppositeExitDirection: Record<RoomExitData['direction'], RoomExitData['direction']> = {
  northwest: 'southeast',
  north: 'south',
  northeast: 'southwest',
  west: 'east',
  custom: 'custom',
  east: 'west',
  southwest: 'northeast',
  south: 'north',
  southeast: 'northwest',
};

function TextContentEditor({
  value,
  onChange,
}: {
  value: TextContent;
  onChange: (next: TextContent) => void;
}) {
  const sourceValue =
    value.source.kind === 'inline'
      ? value.source.text
      : value.source.kind === 'localized'
        ? value.source.key
        : value.source.source;
  return (
    <div className="space-y-2">
      <div className="grid min-w-0 gap-2 @3xl:grid-cols-[9rem_minmax(0,1fr)]">
        <div className="grid gap-2">
          <Select
            items={[
              { value: 'inline', label: 'Inline' },
              { value: 'localized', label: 'Localized key' },
              { value: 'lua-expression', label: 'Lua string' },
            ]}
            value={value.source.kind}
            onValueChange={(kind) => {
              const source =
                kind === 'localized'
                  ? { kind: 'localized' as const, key: 'text.key' }
                  : kind === 'lua-expression'
                    ? {
                        kind: 'lua-expression' as const,
                        source: 'return ""',
                        additionalDependencies: { targets: [] },
                      }
                    : { kind: 'inline' as const, text: '' };
              onChange({ ...value, source });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inline">Inline</SelectItem>
              <SelectItem value="localized">Localized key</SelectItem>
              <SelectItem value="lua-expression">Lua string</SelectItem>
            </SelectContent>
          </Select>
          <Select
            items={[
              { value: 'active-text', label: 'ActiveText' },
              { value: 'plain', label: 'Plain' },
            ]}
            value={value.markup}
            onValueChange={(markup) =>
              onChange({ ...value, markup: markup as TextContent['markup'] })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active-text">ActiveText</SelectItem>
              <SelectItem value="plain">Plain</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <textarea
          className="min-h-16 w-full resize-y rounded-md border border-input bg-input/20 px-2 py-1.5 text-xs/relaxed outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/30"
          value={sourceValue}
          onChange={(event) => {
            const nextValue = event.currentTarget.value;
            const source =
              value.source.kind === 'inline'
                ? { kind: 'inline' as const, text: nextValue }
                : value.source.kind === 'localized'
                  ? { kind: 'localized' as const, key: nextValue }
                  : { ...value.source, kind: 'lua-expression' as const, source: nextValue };
            onChange({ ...value, source });
          }}
        />
      </div>
      {value.source.kind === 'lua-expression' ? (
        <LuaExplicitFallbackEditor
          value={value.source.additionalDependencies}
          onChange={(additionalDependencies) =>
            onChange({
              ...value,
              source: {
                kind: 'lua-expression',
                source: value.source.kind === 'lua-expression' ? value.source.source : '',
                additionalDependencies,
              },
            })
          }
        />
      ) : null}
    </div>
  );
}

export function RoomEditor({ tab }: WorkbenchEditorProps) {
  const editorLocation = useOptionalWorkbenchEditorLocation();
  const activeGroupId = useWorkbenchStore((state) => state.activeGroupId);
  const { t } = useTranslation('workspace');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [backgroundSelectorOpen, setBackgroundSelectorOpen] = useState(false);
  const [destinationSelectorExitId, setDestinationSelectorExitId] = useState<string | null>(null);
  const [roomSelection, setRoomSelection] = useState<RoomEditSelection[]>(() => {
    const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    return savedState ? (parseRoomEditorTabState(savedState)?.selection ?? []) : [];
  });
  const [pendingPlacementDeletion, setPendingPlacementDeletion] = useState<{
    selection: RoomEditSelection[];
    placements: { placementId: string; occupants: RoomEditSelection[] }[];
  } | null>(null);
  const [expandedRoomSelectionKeys, setExpandedRoomSelectionKeys] = useState<Set<string>>(() => {
    const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    return new Set(
      savedState ? (parseRoomEditorTabState(savedState)?.expandedSelectionKeys ?? []) : [],
    );
  });
  const [selectedCameraViewIndex, setSelectedCameraViewIndex] = useState(0);
  const [selectedAnchorIndex, setSelectedAnchorIndex] = useState(0);
  const [selectedOverlayIndex, setSelectedOverlayIndex] = useState(0);
  const [selectedCastIndex, setSelectedCastIndex] = useState(0);
  const [selectedPropIndex, setSelectedPropIndex] = useState(0);
  const [selectedEnvironmentIndex, setSelectedEnvironmentIndex] = useState(0);
  const [contentEntitySelector, setContentEntitySelector] = useState<{
    kind:
      | 'overlay-layout'
      | 'placement-layout'
      | 'new-overlay-layout'
      | 'cast-character'
      | 'prop-asset'
      | 'environment-asset';
    id: string;
  } | null>(null);
  const [roomAddGhost, setRoomAddGhost] = useState<RoomAddContent | null>(null);
  const [roomAddRequest, setRoomAddRequest] = useState<RoomAddRequest | null>(null);
  const continueRoomAddSelectionRef = useRef(false);
  const [activeCategory, setActiveCategory] = useState<RoomEditorCategory>(() => {
    const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    const parsed = savedState ? parseRoomEditorTabState(savedState) : null;
    return parsed?.presentationMode === 'edit'
      ? 'composition'
      : (parsed?.activeCategory ?? 'general');
  });
  const [presentationMode, setPresentationMode] = useState<RoomPresentationMode>(() => {
    const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    return savedState
      ? (parseRoomEditorTabState(savedState)?.presentationMode ?? 'preview')
      : 'preview';
  });
  const [rememberedEditNavigation, setRememberedEditNavigation] = useState<RoomEditNavigation>(
    () => {
      const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
      return savedState
        ? (parseRoomEditorTabState(savedState)?.editNavigation ?? ROOM_EDIT_FIT_NAVIGATION)
        : ROOM_EDIT_FIT_NAVIGATION;
    },
  );
  const [visibleEditNavigation, setVisibleEditNavigation] = useState<RoomEditNavigation>(() => {
    const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    return savedState
      ? (parseRoomEditorTabState(savedState)?.editNavigation ?? ROOM_EDIT_FIT_NAVIGATION)
      : ROOM_EDIT_FIT_NAVIGATION;
  });
  const [roomEditTransitioning, setRoomEditTransitioning] = useState(false);
  const [roomEditGestureCancellationToken, setRoomEditGestureCancellationToken] = useState(0);
  const roomEditAnimationFrameRef = useRef<number | null>(null);
  const roomEditViewportElementRef = useRef<HTMLDivElement | null>(null);
  const [roomEditViewportSize, setRoomEditViewportSize] = useState({ width: 0, height: 0 });
  const roomEditSurfaceElementRef = useRef<HTMLDivElement | null>(null);
  const roomPreviewSurfaceElementRef = useRef<HTMLDivElement | null>(null);
  const [hotspotFocusRoomViewportScreenRect, setHotspotFocusRoomViewportScreenRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const handleRoomEditSurfaceElementChange = useCallback((element: HTMLDivElement | null) => {
    roomEditSurfaceElementRef.current = element;
  }, []);
  useEffect(() => {
    const element = roomEditViewportElementRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setRoomEditViewportSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [presentationMode]);
  const [previewCollapsed, setPreviewCollapsed] = useState(() => {
    const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    return savedState ? (parseRoomEditorTabState(savedState)?.previewCollapsed ?? false) : false;
  });
  const [hotspotView, setHotspotView] = useState<HotspotEditorViewState>(() => {
    const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    return savedState
      ? (parseRoomEditorTabState(savedState)?.hotspotView ?? defaultHotspotViewState())
      : defaultHotspotViewState();
  });
  const hotspotFocusSession = useHotspotFocusStore((state) => state.sessionsByTabId[tab.id]);
  const startHotspotFocus = useHotspotFocusStore((state) => state.start);
  const restoreHotspotFocus = useHotspotFocusStore((state) => state.restore);
  const editorPreviewLayout = usePreferencesStore((state) => state.editorPreviewLayout);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const setUsages = useEntityUsagesStore((state) => state.setUsages);
  const setActiveBottomPanel = useBottomPanelStore((state) => state.setActivePanelId);
  const document = useProjectStore((state) => state.document);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const projectRevision = useProjectStore((state) => state.projectRevision);
  const roomId = tab.resource?.entityId;
  const project = isAuthoringProject(document) ? document : null;
  const hookRegistryAnalysis = useMemo(
    () => (project && activeCategory === 'behavior' ? analyzeHookRegistry(project) : null),
    [activeCategory, project],
  );
  const record = roomId && project ? project.rooms[roomId] : null;
  const effectiveRecord =
    project && record ? resolveGameplayInstanceRecord(project, 'room', record) : record;
  const inheritedPropertyConfiguration =
    project && record?.archetype
      ? resolveArchetypeConfiguration(project, record.archetype.$ref.id)
      : null;
  const data =
    parseRoomData(effectiveRecord?.data) ?? defaultRoomData(record?.label ?? roomId ?? 'Room');
  useEffect(() => {
    if (!project || !record || !roomId || hotspotFocusSession) return;
    restoreHotspotFocus({
      tabId: tab.id,
      ownerKind: 'room',
      ownerId: roomId,
      assetId: data.background.asset?.$ref.id ?? null,
      mode: 'rectangles',
      items: data.hotspots,
    });
  }, [
    data.background.asset?.$ref.id,
    data.hotspots,
    hotspotFocusSession,
    project,
    record,
    restoreHotspotFocus,
    roomId,
    tab.id,
  ]);
  const [roomEditResolution, setRoomEditResolution] = useState<{
    projectRevision: number;
    roomId: string;
    value: RoomEditResolvedVisibility;
  } | null>(null);
  const activeRoomEditResolution =
    roomEditResolution?.projectRevision === projectRevision && roomEditResolution.roomId === roomId
      ? roomEditResolution.value
      : null;
  const handleFocusedRoomApplied = useCallback(
    (result: AppliedPreviewDocumentResult) => {
      if (
        !roomId ||
        result.kind !== 'room-preview' ||
        result.recordId !== roomId ||
        !result.roomResolution
      )
        return;
      setRoomEditResolution((current) =>
        current?.projectRevision === projectRevision &&
        current.roomId === roomId &&
        current.value === result.roomResolution
          ? current
          : {
              projectRevision,
              roomId,
              value: result.roomResolution!,
            },
      );
    },
    [projectRevision, roomId],
  );
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
  const roomItems = useMemo(
    () =>
      filterSelectorItems(selectorItems, {
        collections: ['rooms'],
        includeActions: false,
      }),
    [selectorItems],
  );
  const layoutSelectorItems = useMemo(
    () => filterSelectorItems(selectorItems, { collections: ['layouts'], includeActions: false }),
    [selectorItems],
  );
  const characterSelectorItems = useMemo(
    () =>
      filterSelectorItems(selectorItems, { collections: ['characters'], includeActions: false }),
    [selectorItems],
  );
  const materialSelectorItems = useMemo(
    () =>
      filterSelectorItems(selectorItems, {
        collections: ['materials'],
        includeActions: false,
      }).filter(
        (item) =>
          item.entityId &&
          project &&
          resolveMaterialData(project, item.entityId).data?.role === 'engine-2d',
      ),
    [project, selectorItems],
  );
  const interactableDefinitionSelectorItems = useMemo(
    () =>
      filterSelectorItems(selectorItems, {
        collections: ['interactables'],
        includeActions: false,
      }),
    [selectorItems],
  );
  const compatibleInteractableInstanceItems = useMemo<SelectorItem[]>(
    () =>
      !project || !roomId
        ? []
        : Object.entries(project.interactableInstances).flatMap(([instanceId, instance]) => {
            const compatible =
              instance.location.kind === 'unplaced' ||
              (instance.location.kind === 'room' && instance.location.room.$ref.id === roomId);
            if (!compatible || !project.interactables[instance.definition.$ref.id]) return [];
            const definition = project.interactables[instance.definition.$ref.id]!;
            return [
              {
                id: `room-add:existing:${instanceId}`,
                kind: 'record' as const,
                title: t('roomEditor.compositionPane.editor.existingInstanceOption', {
                  label: instance.editorLabel ?? instanceId,
                }),
                subtitle: t('roomEditor.compositionPane.editor.existingInstanceSubtitle', {
                  definition: definition.label,
                  id: instanceId,
                }),
                entityId: instanceId,
                tags: [],
                collectionTerms: [t('roomEditor.compositionPane.editor.interactableInstances')],
                actionTerms: [],
              },
            ];
          }),
    [project, roomId, t],
  );
  const roomAddSelectorItems = useMemo<SelectorItem[]>(() => {
    if (!roomAddRequest) return [];
    switch (roomAddRequest.kind) {
      case 'prop':
        return [
          ...imageAssetItems.map((item) => ({
            ...item,
            id: `room-add:asset:${item.id}`,
            title: t('roomEditor.compositionPane.editor.imageOption', { label: item.title }),
          })),
          ...materialSelectorItems.map((item) => ({
            ...item,
            id: `room-add:material:${item.id}`,
            title: t('roomEditor.compositionPane.editor.materialOption', { label: item.title }),
          })),
        ];
      case 'cast':
        return characterSelectorItems;
      case 'interactable':
        return [
          ...interactableDefinitionSelectorItems.map((item) => ({
            ...item,
            id: `room-add:new:${item.id}`,
            title: t('roomEditor.compositionPane.editor.newInstanceOption', { label: item.title }),
          })),
          ...compatibleInteractableInstanceItems,
        ];
      case 'environment':
        return roomAddRequest.materialId
          ? [
              {
                id: 'room-add:environment-no-image',
                kind: 'record' as const,
                title: t('roomEditor.compositionPane.editor.noImageOption'),
                tags: [],
                collectionTerms: [],
                actionTerms: [],
              },
              ...imageAssetItems.map((item) => ({
                ...item,
                id: `room-add:environment-image:${item.id}`,
                title: t('roomEditor.compositionPane.editor.imageOption', { label: item.title }),
              })),
            ]
          : materialSelectorItems.map((item) => ({
              ...item,
              id: `room-add:environment-material:${item.id}`,
              title: t('roomEditor.compositionPane.editor.materialOption', { label: item.title }),
            }));
    }
  }, [
    characterSelectorItems,
    compatibleInteractableInstanceItems,
    imageAssetItems,
    interactableDefinitionSelectorItems,
    materialSelectorItems,
    roomAddRequest,
    t,
  ]);
  useWorkbenchEditorTabState<RoomEditorTabState>(
    tab.id,
    useMemo(
      () => ({
        schema: ROOM_EDITOR_TAB_STATE_SCHEMA,
        captureTabState: () => ({
          schema: ROOM_EDITOR_TAB_STATE_SCHEMA,
          payload: {
            scroll: captureScrollViewState(scrollRef.current),
            activeCategory,
            presentationMode,
            editNavigation: rememberedEditNavigation,
            selection: roomSelection,
            expandedSelectionKeys: [...expandedRoomSelectionKeys],
            previewCollapsed,
            hotspotView,
          },
        }),
        restoreTabState: (state) => {
          const parsed = parseRoomEditorTabState(state);
          if (!parsed) return;
          setActiveCategory(
            parsed.presentationMode === 'edit' ? 'composition' : parsed.activeCategory,
          );
          setPresentationMode(parsed.presentationMode);
          setRememberedEditNavigation(parsed.editNavigation);
          setVisibleEditNavigation(parsed.editNavigation);
          setRoomSelection(parsed.selection.filter((item) => roomEditSelectionExists(data, item)));
          setExpandedRoomSelectionKeys(new Set(parsed.expandedSelectionKeys));
          setPreviewCollapsed(parsed.previewCollapsed);
          setHotspotView(
            restoreHotspotViewState(
              parsed.hotspotView,
              data.hotspots.map((item) => item.id),
            ),
          );
          window.requestAnimationFrame(() =>
            restoreScrollViewState(scrollRef.current, parsed.scroll),
          );
        },
      }),
      [
        activeCategory,
        data,
        expandedRoomSelectionKeys,
        hotspotView,
        presentationMode,
        previewCollapsed,
        rememberedEditNavigation,
        roomSelection,
      ],
    ),
  );
  useEffect(() => {
    setRoomSelection((current) => {
      const next = current.filter((item) => roomEditSelectionExists(data, item));
      return next.length === current.length ? current : next;
    });
  }, [data]);

  useEffect(() => {
    setExpandedRoomSelectionKeys((current) => {
      const validSelectionKeys = new Set(roomSelection.map(roomEditSelectionKey));
      const next = new Set([...current].filter((key) => validSelectionKeys.has(key)));
      if (next.size === current.size && [...next].every((key) => current.has(key))) return current;
      return next;
    });
  }, [roomSelection]);

  const executeRoomSelectionDelete = useCallback(
    (selection: readonly RoomEditSelection[]) => {
      if (!roomId || selection.length === 0) return;
      useCommandStore.getState().executeCommand({
        type: 'room.deleteSelection',
        label: t('roomEditor.compositionPane.deleteSelection'),
        payload: { roomId, selection },
        originSaveUnitId: recordSaveUnitId('rooms', roomId),
        persistencePolicy: 'manual-save',
      });
      setRoomSelection([]);
    },
    [roomId, t],
  );

  const deleteCurrentRoomSelection = useCallback(() => {
    if (!project || !roomId || roomSelection.length === 0) return;
    const selectionSnapshot = [...roomSelection];
    const crowdedPlacements = selectionSnapshot.flatMap((selection) => {
      if (selection.kind !== 'placement') return [];
      const occupants: RoomEditSelection[] = [
        ...data.interactables
          .filter((item) => item.placementId === selection.id)
          .map((item) => ({ kind: 'interactable' as const, id: item.id })),
        ...data.props
          .filter((item) => item.placementId === selection.id)
          .map((item) => ({ kind: 'prop' as const, id: item.id })),
        ...data.cast
          .filter((item) => item.placementId === selection.id)
          .map((item) => ({ kind: 'cast' as const, id: item.id })),
        ...(data.placements.find((item) => item.id === selection.id)?.presentation.layout
          ? [{ kind: 'placement-layout' as const, id: selection.id }]
          : []),
      ];
      return occupants.length > 1 ? [{ placementId: selection.id, occupants }] : [];
    });
    if (crowdedPlacements.length > 0) {
      setPendingPlacementDeletion({ selection: selectionSnapshot, placements: crowdedPlacements });
      return;
    }
    executeRoomSelectionDelete(selectionSnapshot);
  }, [data, executeRoomSelectionDelete, project, roomId, roomSelection]);

  useEffect(() => {
    if (presentationMode !== 'edit' || hotspotFocusSession) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        editorLocation &&
        (!editorLocation.isActiveInGroup || editorLocation.groupId !== activeGroupId)
      )
        return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      )
        return;
      const deselect =
        event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'd';
      if (deselect) {
        event.preventDefault();
        setRoomSelection([]);
        return;
      }
      const deleteSelection =
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key === 'Delete' || event.key === 'Backspace');
      if (!deleteSelection || roomSelection.length === 0) return;
      event.preventDefault();
      deleteCurrentRoomSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeGroupId,
    deleteCurrentRoomSelection,
    editorLocation,
    hotspotFocusSession,
    presentationMode,
    roomSelection.length,
  ]);

  const animateRoomEditNavigation = useCallback(
    (from: RoomEditNavigation, to: RoomEditNavigation, onComplete?: () => void) => {
      if (roomEditAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(roomEditAnimationFrameRef.current);
        roomEditAnimationFrameRef.current = null;
      }
      if (prefersReducedRoomEditMotion()) {
        setVisibleEditNavigation(to);
        setRoomEditTransitioning(false);
        onComplete?.();
        return;
      }
      const startedAt = performance.now();
      setRoomEditTransitioning(true);
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / ROOM_EDIT_NAVIGATION_TRANSITION_MS);
        setVisibleEditNavigation(interpolateRoomEditNavigation(from, to, progress));
        if (progress < 1) {
          roomEditAnimationFrameRef.current = window.requestAnimationFrame(tick);
          return;
        }
        roomEditAnimationFrameRef.current = null;
        setVisibleEditNavigation(to);
        setRoomEditTransitioning(false);
        onComplete?.();
      };
      roomEditAnimationFrameRef.current = window.requestAnimationFrame(tick);
    },
    [],
  );
  useEffect(
    () => () => {
      if (roomEditAnimationFrameRef.current !== null)
        window.cancelAnimationFrame(roomEditAnimationFrameRef.current);
    },
    [],
  );
  const changeRoomPresentationMode = useCallback(
    (nextMode: RoomPresentationMode) => {
      if (roomEditTransitioning || nextMode === presentationMode) return;
      setRoomEditGestureCancellationToken((value) => value + 1);
      setRoomAddGhost(null);
      setRoomAddRequest(null);
      if (nextMode === 'preview') {
        const remembered = visibleEditNavigation;
        setRememberedEditNavigation(remembered);
        animateRoomEditNavigation(visibleEditNavigation, ROOM_EDIT_FIT_NAVIGATION, () =>
          setPresentationMode('preview'),
        );
        return;
      }
      setActiveCategory('composition');
      setPresentationMode('edit');
      setVisibleEditNavigation(ROOM_EDIT_FIT_NAVIGATION);
      animateRoomEditNavigation(ROOM_EDIT_FIT_NAVIGATION, rememberedEditNavigation);
    },
    [
      animateRoomEditNavigation,
      presentationMode,
      rememberedEditNavigation,
      roomEditTransitioning,
      visibleEditNavigation,
    ],
  );
  const handleRoomEditNavigationChange = useCallback(
    (navigation: RoomEditNavigation) => {
      if (roomEditTransitioning) return;
      const next = sanitizeRoomEditNavigation(navigation);
      setVisibleEditNavigation(next);
      setRememberedEditNavigation(next);
    },
    [roomEditTransitioning],
  );
  const fitRoomEditNavigation = useCallback(() => {
    if (roomEditTransitioning) return;
    setRoomEditGestureCancellationToken((value) => value + 1);
    setVisibleEditNavigation(ROOM_EDIT_FIT_NAVIGATION);
    setRememberedEditNavigation(ROOM_EDIT_FIT_NAVIGATION);
  }, [roomEditTransitioning]);
  useEffect(() => {
    const handleRoomTarget = (target: PendingWorkbenchRevealTarget) => {
      setActiveCategory(roomEditorCategoryForTarget(target.id));
      if (target.id.startsWith('room.hotspot.')) {
        const id = target.id.slice('room.hotspot.'.length);
        if (data.hotspots.some((hotspot) => hotspot.id === id))
          setHotspotView((current) => ({ ...current, selectedHotspotId: id }));
      }
      if (
        typeof target.payload === 'object' &&
        target.payload !== null &&
        (target.payload as { kind?: unknown }).kind === 'interactable-instance-property'
      ) {
        const payload = target.payload as {
          kind: 'interactable-instance-property';
          instanceId: string;
          placementId?: string;
        };
        const occurrence = data.interactables.find(
          (entry) => entry.interactable.$ref.id === payload.instanceId,
        );
        const placementId = payload.placementId ?? occurrence?.placementId;
        if (placementId && data.placements.some((placement) => placement.id === placementId)) {
          setRoomSelection(
            occurrence
              ? [{ kind: 'interactable', id: occurrence.id }]
              : [{ kind: 'placement', id: placementId }],
          );
        }
      }
      return false;
    };
    const disposeRoom = registerWorkbenchTargetHandler(tab.id, 'room', handleRoomTarget);
    const disposeInstanceProperty = registerWorkbenchTargetHandler(
      tab.id,
      'instance.property',
      handleRoomTarget,
    );
    return () => {
      disposeRoom();
      disposeInstanceProperty();
    };
  }, [data.hotspots, data.interactables, data.placements, tab.id]);
  const backgroundAssetId = data.background.asset?.$ref.id ?? null;
  const backgroundAssetData =
    project && backgroundAssetId ? parseAssetData(project.assets[backgroundAssetId]?.data) : null;
  const compositionBackgroundSize =
    backgroundAssetData?.kind === 'image' && backgroundAssetData.imageMetadata
      ? {
          width: backgroundAssetData.imageMetadata.width,
          height: backgroundAssetData.imageMetadata.height,
        }
      : null;
  useEffect(() => {
    let cancelled = false;
    if (!projectSessionId || !backgroundAssetId || backgroundAssetData?.kind !== 'image') {
      setCompositionBackgroundUrl(null);
      return;
    }
    window.noveltea
      .resolveProjectOriginalAssetUrl(projectSessionId, backgroundAssetId)
      .then((result) => !cancelled && setCompositionBackgroundUrl(result.ok ? result.url : null))
      .catch(() => !cancelled && setCompositionBackgroundUrl(null));
    return () => {
      cancelled = true;
    };
  }, [backgroundAssetData?.kind, backgroundAssetId, projectSessionId]);
  if (!project || !record || !roomId)
    return <div className="p-4 text-sm text-muted-foreground">Room record not found.</div>;
  const materialPropertyOptionsById = new Map<
    string,
    { id: string; contract: { type: string; label?: string | null } }
  >();
  for (const property of inheritedPropertyConfiguration?.defaultProperties ?? [])
    materialPropertyOptionsById.set(property.id, {
      id: property.id,
      contract: { type: property.type, label: property.label ?? property.id },
    });
  for (const traitId of effectiveRecord?.traits ?? record.traits ?? [])
    for (const property of project.traits[traitId]?.properties ?? [])
      materialPropertyOptionsById.set(property.id, {
        id: property.id,
        contract: { type: property.type, label: property.label ?? property.id },
      });
  for (const property of record.localProperties ?? [])
    materialPropertyOptionsById.set(property.id, {
      id: property.id,
      contract: { type: property.type, label: property.label ?? property.id },
    });
  const roomMaterialProperties = [...materialPropertyOptionsById.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const roomPropertyValues: Record<string, unknown> = {};
  for (const traitId of effectiveRecord?.traits ?? record.traits ?? [])
    for (const property of project.traits[traitId]?.properties ?? [])
      if (property.defaultValue !== undefined)
        roomPropertyValues[property.id] = property.defaultValue;
  for (const property of inheritedPropertyConfiguration?.defaultProperties ?? [])
    if (property.defaultValue !== undefined)
      roomPropertyValues[property.id] = property.defaultValue;
  for (const property of record.localProperties ?? [])
    roomPropertyValues[property.id] = property.value;
  const previewSplitOrientation = resolveEditorPreviewSplitOrientation(
    editorPreviewLayout,
    projectSettingsFromProject(project).display,
  );
  const commit = (next: RoomData, label: string) =>
    useCommandStore.getState().executeCommand({
      type: 'room.replaceData',
      label,
      payload: { roomId, data: next },
      originSaveUnitId: recordSaveUnitId('rooms', roomId),
      persistencePolicy: 'manual-save',
    });
  const executeRoomEditCommand = (type: string, label: string, payload: Record<string, unknown>) =>
    useCommandStore.getState().executeCommand({
      type,
      label,
      payload: { roomId, ...payload },
      originSaveUnitId: recordSaveUnitId('rooms', roomId),
      persistencePolicy: 'manual-save',
    });
  const bulkPresentationTargets = (() => {
    if (roomSelection.length < 2) return null;
    const targets = roomSelection.map(roomPresentationTargetForSelection);
    if (targets.some((target) => target === null)) return null;
    const concreteTargets = targets as RoomPresentationOrderTarget[];
    const planes = concreteTargets.map((target) => roomPresentationPlaneForTarget(data, target));
    const plane = planes[0];
    if (!plane || planes.some((candidate) => candidate !== plane)) return null;
    return concreteTargets;
  })();
  const reorderBulkPresentation = (action: RoomPresentationReorderAction, label: string) => {
    if (!bulkPresentationTargets) return;
    executeRoomEditCommand('room.reorderPresentationSelection', label, {
      targets: bulkPresentationTargets,
      action,
    });
  };
  const commitLocalProperties = (
    localProperties: OwnerLocalProperty[],
    change?: { kind: 'rename'; fromId: string; toId: string },
  ) =>
    useCommandStore.getState().executeCommand({
      type: 'project.applyPatch',
      label: `Update ${roomId} Properties`,
      payload: [
        {
          op: Object.prototype.hasOwnProperty.call(record, 'localProperties') ? 'replace' : 'add',
          path: `/rooms/${roomId}/localProperties`,
          value: localProperties,
        },
        ...(change
          ? renameOwnerLocalPropertyReferencePatches(
              project,
              { kind: 'room', id: roomId },
              change.fromId,
              change.toId,
            )
          : []),
      ],
      originSaveUnitId: recordSaveUnitId('rooms', roomId),
      persistencePolicy: 'manual-save',
    });
  const commitPropertyTraitState = (state: OwnerPropertyTraitState) =>
    useCommandStore.getState().executeCommand({
      type: 'project.applyPatch',
      label: `Update ${roomId} Trait Properties`,
      payload: [
        {
          op: Object.prototype.hasOwnProperty.call(record, 'traits') ? 'replace' : 'add',
          path: `/rooms/${roomId}/traits`,
          value: state.traits,
        },
        {
          op: Object.prototype.hasOwnProperty.call(record, 'localProperties') ? 'replace' : 'add',
          path: `/rooms/${roomId}/localProperties`,
          value: state.localProperties,
        },
      ],
      originSaveUnitId: recordSaveUnitId('rooms', roomId),
      persistencePolicy: 'manual-save',
    });
  const executeHotspot = (type: string, label: string, payload: Record<string, unknown>) =>
    useCommandStore.getState().executeCommand({
      type,
      label,
      payload: { roomId, ...payload },
      originSaveUnitId: recordSaveUnitId('rooms', roomId),
      persistencePolicy: 'manual-save',
    });
  const beginRoomHotspotFocus = (selectedHotspotId?: string | null) => {
    const bounds =
      presentationMode === 'edit'
        ? roomEditSurfaceElementRef.current?.getBoundingClientRect()
        : roomPreviewSurfaceElementRef.current?.getBoundingClientRect();
    const previewViewport =
      presentationMode === 'preview' && bounds
        ? containRect({ width: bounds.width, height: bounds.height }, referenceResolution)
        : null;
    setHotspotFocusRoomViewportScreenRect(
      bounds && bounds.width > 0 && bounds.height > 0
        ? previewViewport
          ? {
              x: bounds.left + previewViewport.x,
              y: bounds.top + previewViewport.y,
              width: previewViewport.width,
              height: previewViewport.height,
            }
          : { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }
        : null,
    );
    startHotspotFocus({
      tabId: tab.id,
      ownerKind: 'room',
      ownerId: roomId,
      assetId: data.background.asset?.$ref.id ?? null,
      mode: 'rectangles',
      items: data.hotspots,
      selectedHotspotId,
    });
  };
  const rooms = Object.entries(project.rooms).map(([id, value]) => ({ id, label: value.label }));
  const exitDestinationItems = data.exits.map((exit) => ({
    id: exit.target.$ref.id,
    label: rooms.find((room) => room.id === exit.target.$ref.id)?.label ?? exit.target.$ref.id,
  }));
  const usedExitDirections = new Set(data.exits.map((exit) => exit.direction));
  const nextExitDirection = roomExitDirectionValues.find(
    (direction) => !usedExitDirections.has(direction),
  );
  const assets = Object.entries(project.assets).map(([id, value]) => ({ id, label: value.label }));
  const selectedBackgroundItem = imageAssetItems.find(
    (item) => item.entityId === data.background.asset?.$ref.id,
  );
  const destinationSelectorExit = data.exits.find((exit) => exit.id === destinationSelectorExitId);
  const selectedDestinationItem = roomItems.find(
    (item) => item.entityId === destinationSelectorExit?.target.$ref.id,
  );
  const layouts = Object.entries(project.layouts).map(([id, value]) => ({
    id,
    label: value.label,
  }));
  const characters = Object.entries(project.characters).map(([id, value]) => ({
    id,
    label: value.label,
  }));
  const roomAddActions = [
    {
      id: 'placement',
      label: t('roomEditor.compositionPane.addPlacement'),
    },
    {
      id: 'prop',
      label: t('roomEditor.compositionPane.addProp'),
      disabled: imageAssetItems.length === 0 && materialSelectorItems.length === 0,
    },
    {
      id: 'cast',
      label: t('roomEditor.compositionPane.addCast'),
      disabled: characterSelectorItems.length === 0,
    },
    {
      id: 'interactable',
      label: t('roomEditor.compositionPane.addInteractable'),
      disabled:
        interactableDefinitionSelectorItems.length === 0 &&
        compatibleInteractableInstanceItems.length === 0,
    },
    {
      id: 'environment',
      label: t('roomEditor.compositionPane.addEnvironment'),
      disabled: materialSelectorItems.length === 0,
    },
  ] as const;
  const executeRoomAdd = (
    content: RoomAddContent,
    target: { point: { x: number; y: number } } | { placementId: string },
  ) => {
    let payload: Record<string, unknown> | null = null;
    switch (content.kind) {
      case 'placement':
        if (!('point' in target)) return;
        payload = { kind: 'placement', point: target.point };
        break;
      case 'prop': {
        const source = content.source;
        if (source.kind === 'asset') {
          if (!imageAssetItems.some((item) => item.entityId === source.assetId)) return;
        } else if (!materialSelectorItems.some((item) => item.entityId === source.materialId)) {
          return;
        }
        payload = {
          kind: 'prop',
          ...target,
          ...(source.kind === 'asset'
            ? { assetId: source.assetId }
            : { materialId: source.materialId }),
        };
        break;
      }
      case 'cast':
        if (!project.characters[content.characterId]) return;
        payload = { kind: 'cast', ...target, characterId: content.characterId };
        break;
      case 'interactable': {
        const source = content.source;
        if (source.kind === 'new') {
          if (!project.interactables[source.definitionId]) return;
        } else if (
          !compatibleInteractableInstanceItems.some((item) => item.entityId === source.instanceId)
        ) {
          return;
        }
        payload = {
          kind: 'interactable',
          ...target,
          source,
        };
        break;
      }
      case 'environment':
        if (
          !('point' in target) ||
          !materialSelectorItems.some((item) => item.entityId === content.materialId) ||
          (content.assetId !== undefined &&
            !imageAssetItems.some((item) => item.entityId === content.assetId))
        )
          return;
        payload = {
          kind: 'environment',
          point: target.point,
          materialId: content.materialId,
          ...(content.assetId ? { assetId: content.assetId } : {}),
        };
        break;
    }
    executeRoomEditCommand(
      'room.addPresentationContent',
      t('roomEditor.compositionPane.addContent'),
      payload,
    );
  };
  const completeRoomAdd = (content: RoomAddContent, target: RoomAddSpatialTarget) => {
    setRoomAddRequest(null);
    if (target.kind === 'drop') {
      setRoomAddGhost(content);
      return;
    }
    setRoomAddGhost(null);
    executeRoomAdd(
      content,
      target.kind === 'point' ? { point: target.point } : { placementId: target.placementId },
    );
  };
  const beginRoomAdd = (actionId: string, target: RoomAddSpatialTarget) => {
    if (
      actionId !== 'placement' &&
      actionId !== 'prop' &&
      actionId !== 'cast' &&
      actionId !== 'interactable' &&
      actionId !== 'environment'
    )
      return;
    setRoomAddGhost(null);
    if (actionId === 'placement') {
      if (target.kind === 'placement') return;
      completeRoomAdd(
        { kind: 'placement' },
        target.kind === 'drop' ? target : { kind: 'point', point: target.point },
      );
      return;
    }
    setRoomAddRequest({ kind: actionId, target });
  };
  const selectRoomAddContent = (item: SelectorItem) => {
    if (!roomAddRequest) return;
    if (roomAddRequest.kind === 'environment' && roomAddRequest.materialId) {
      if (item.id === 'room-add:environment-no-image') {
        completeRoomAdd(
          { kind: 'environment', materialId: roomAddRequest.materialId },
          roomAddRequest.target,
        );
        return;
      }
      if (
        !item.entityId ||
        !item.id.startsWith('room-add:environment-image:') ||
        !imageAssetItems.some((candidate) => candidate.entityId === item.entityId)
      )
        return;
      completeRoomAdd(
        {
          kind: 'environment',
          materialId: roomAddRequest.materialId,
          assetId: item.entityId,
        },
        roomAddRequest.target,
      );
      return;
    }
    if (!item.entityId) return;
    switch (roomAddRequest.kind) {
      case 'prop':
        if (item.id.startsWith('room-add:asset:')) {
          if (!imageAssetItems.some((candidate) => candidate.entityId === item.entityId)) return;
          completeRoomAdd(
            { kind: 'prop', source: { kind: 'asset', assetId: item.entityId } },
            roomAddRequest.target,
          );
          return;
        }
        if (!item.id.startsWith('room-add:material:')) return;
        if (!materialSelectorItems.some((candidate) => candidate.entityId === item.entityId))
          return;
        completeRoomAdd(
          { kind: 'prop', source: { kind: 'material', materialId: item.entityId } },
          roomAddRequest.target,
        );
        return;
      case 'cast':
        if (!project.characters[item.entityId]) return;
        completeRoomAdd({ kind: 'cast', characterId: item.entityId }, roomAddRequest.target);
        return;
      case 'interactable':
        if (item.id.startsWith('room-add:existing:')) {
          if (!compatibleInteractableInstanceItems.some((candidate) => candidate.id === item.id))
            return;
          completeRoomAdd(
            { kind: 'interactable', source: { kind: 'existing', instanceId: item.entityId } },
            roomAddRequest.target,
          );
          return;
        }
        if (!item.id.startsWith('room-add:new:') || !project.interactables[item.entityId]) return;
        completeRoomAdd(
          { kind: 'interactable', source: { kind: 'new', definitionId: item.entityId } },
          roomAddRequest.target,
        );
        return;
      case 'environment':
        if (
          !item.id.startsWith('room-add:environment-material:') ||
          !materialSelectorItems.some((candidate) => candidate.entityId === item.entityId)
        )
          return;
        continueRoomAddSelectionRef.current = true;
        setRoomAddRequest({ ...roomAddRequest, materialId: item.entityId });
        return;
    }
  };
  const roomAddSelectorTitle =
    roomAddRequest?.kind === 'prop'
      ? t('roomEditor.compositionPane.editor.choosePropSource')
      : roomAddRequest?.kind === 'cast'
        ? t('roomEditor.compositionPane.editor.chooseCharacter')
        : roomAddRequest?.kind === 'interactable'
          ? t('roomEditor.compositionPane.editor.chooseInteractable')
          : roomAddRequest?.kind === 'environment' && roomAddRequest.materialId
            ? t('roomEditor.compositionPane.editor.chooseEnvironmentImage')
            : t('roomEditor.compositionPane.editor.chooseEnvironmentMaterial');
  const scripts = Object.entries(project.scripts).map(([id, value]) => ({
    id,
    label: value.label,
  }));
  const replaceExit = (id: string, patch: Partial<RoomExitData>) =>
    commit(
      { ...data, exits: data.exits.map((exit) => (exit.id === id ? { ...exit, ...patch } : exit)) },
      'Update room exit',
    );
  const referenceResolution = projectSettingsFromProject(project).display.referenceResolution;
  const fittedRoomEditSurfaceSize = fitRoomEditSurfaceFrame(
    {
      width: Math.max(0, roomEditViewportSize.width - 16),
      height: Math.max(0, roomEditViewportSize.height - 16),
    },
    referenceResolution,
  );
  const replaceOverlay = (id: string, patch: Partial<RoomOverlayData>) =>
    commit(
      {
        ...data,
        overlays: data.overlays.map((overlay) =>
          overlay.id === id ? { ...overlay, ...patch } : overlay,
        ),
      },
      'Update room overlay',
    );
  const replaceCast = (id: string, patch: Partial<RoomCastData>) =>
    commit(
      {
        ...data,
        cast: data.cast.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
      },
      t('roomEditor.compositionPane.editor.updateRoomCast'),
    );
  const replaceProp = (id: string, patch: Partial<RoomPropData>) =>
    commit(
      {
        ...data,
        props: data.props.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
      },
      t('roomEditor.compositionPane.editor.updateRoomProp'),
    );
  const replaceEnvironment = (id: string, patch: Partial<RoomEnvironmentData>) =>
    commit(
      {
        ...data,
        environments: data.environments.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry,
        ),
      },
      t('roomEditor.compositionPane.editor.updateRoomEnvironment'),
    );
  const replaceInteractableOccurrence = (id: string, patch: Partial<RoomInteractableData>) =>
    commit(
      {
        ...data,
        interactables: data.interactables.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry,
        ),
      },
      t('roomEditor.compositionPane.editor.updateRoomInteractableOccurrence'),
    );
  const replacePlacement = (id: string, patch: Partial<RoomPlacementData>, label: string) =>
    commit(
      {
        ...data,
        placements: data.placements.map((placement) =>
          placement.id === id ? { ...placement, ...patch } : placement,
        ),
      },
      label,
    );
  const commitInteractableInstance = (
    instanceId: string,
    instance: (typeof project.interactableInstances)[string],
    change?: { kind: 'rename'; fromId: string; toId: string },
  ) =>
    useCommandStore.getState().executeCommand({
      type: 'project.applyPatch',
      label: t('roomEditor.compositionPane.editor.updateInteractableInstanceProperties'),
      payload: [
        {
          op: 'replace',
          path: `/interactableInstances/${escapeJsonPointerSegment(instanceId)}`,
          value: instance,
        },
        ...(change
          ? renameOwnerLocalPropertyReferencePatches(
              project,
              { kind: 'interactable', id: instanceId },
              change.fromId,
              change.toId,
            )
          : []),
      ],
      originSaveUnitId: recordSaveUnitId('rooms', roomId),
      persistencePolicy: 'manual-save',
    });
  const renameRoomHotspot = (hotspotId: string, nextId: string) => {
    const result = executeHotspot(
      'room.renameHotspot',
      t('roomEditor.compositionPane.editor.renameRoomHotspot'),
      {
        hotspotId,
        nextId,
      },
    );
    if (!result.ok) return;
    const previousSelectionKey = roomEditSelectionKey({ kind: 'hotspot', id: hotspotId });
    const nextSelectionKey = roomEditSelectionKey({ kind: 'hotspot', id: nextId });
    setRoomSelection((current) =>
      current.map((selection) =>
        selection.kind === 'hotspot' && selection.id === hotspotId
          ? { kind: 'hotspot', id: nextId }
          : selection,
      ),
    );
    setHotspotView((current) => ({
      ...current,
      selectedHotspotId:
        current.selectedHotspotId === hotspotId ? nextId : current.selectedHotspotId,
    }));
    setExpandedRoomSelectionKeys((current) => {
      if (!current.has(previousSelectionKey)) return current;
      const next = new Set(current);
      next.delete(previousSelectionKey);
      next.add(nextSelectionKey);
      return next;
    });
  };
  const renameRoomPlacement = (placementId: string, requestedId: string) => {
    const nextId = requestedId.trim();
    if (!nextId || nextId === placementId) return;
    const result = useCommandStore.getState().executeCommand({
      type: 'room.replaceData',
      label: t('roomEditor.compositionPane.editor.renamePlacement'),
      payload: {
        roomId,
        data: {
          ...data,
          placements: data.placements.map((placement) =>
            placement.id === placementId ? { ...placement, id: nextId } : placement,
          ),
        },
      },
      originSaveUnitId: recordSaveUnitId('rooms', roomId),
      persistencePolicy: 'manual-save',
    });
    if (!result.ok) return;
    const remap = (selection: RoomEditSelection): RoomEditSelection =>
      (selection.kind === 'placement' || selection.kind === 'placement-layout') &&
      selection.id === placementId
        ? { ...selection, id: nextId }
        : selection;
    setRoomSelection((current) => current.map(remap));
    setExpandedRoomSelectionKeys((current) => {
      const next = new Set<string>();
      for (const key of current) {
        if (key === roomEditSelectionKey({ kind: 'placement', id: placementId }))
          next.add(roomEditSelectionKey({ kind: 'placement', id: nextId }));
        else if (key === roomEditSelectionKey({ kind: 'placement-layout', id: placementId }))
          next.add(roomEditSelectionKey({ kind: 'placement-layout', id: nextId }));
        else next.add(key);
      }
      return next;
    });
    setContentEntitySelector((current) =>
      current?.kind === 'placement-layout' && current.id === placementId
        ? { ...current, id: nextId }
        : current,
    );
  };
  const effectiveRoomPropertyCount = new Set([
    ...(record.localProperties ?? []).map((property) => property.id),
    ...(inheritedPropertyConfiguration?.defaultProperties ?? []).map((property) => property.id),
    ...(effectiveRecord?.traits ?? record.traits ?? []).flatMap(
      (traitId) => project.traits[traitId]?.properties.map((property) => property.id) ?? [],
    ),
  ]).size;
  const categorizedRoomEditorCategories = roomEditorCategories.map((category) => {
    const localizedCategory = {
      ...category,
      label: t(`roomEditor.categories.${category.id}.label`),
      description: t(`roomEditor.categories.${category.id}.description`),
    };
    switch (category.id) {
      case 'camera':
        return {
          ...localizedCategory,
          trailing: data.presentationSpace.views.length + data.anchors.length,
        };
      case 'composition':
        return { ...localizedCategory, trailing: data.placements.length };
      case 'hotspots':
        return { ...localizedCategory, trailing: data.hotspots.length };
      case 'navigation':
        return { ...localizedCategory, trailing: data.exits.length };
      case 'contents':
        return {
          ...localizedCategory,
          trailing:
            data.overlays.length + data.cast.length + data.props.length + data.environments.length,
        };
      case 'properties':
        return { ...localizedCategory, trailing: effectiveRoomPropertyCount };
      default:
        return localizedCategory;
    }
  });
  const activeRoomCategory =
    categorizedRoomEditorCategories.find((category) => category.id === activeCategory) ??
    categorizedRoomEditorCategories[0]!;
  const activeCameraViewIndex =
    data.presentationSpace.views.length === 0
      ? -1
      : Math.min(selectedCameraViewIndex, data.presentationSpace.views.length - 1);
  const activeCameraView =
    activeCameraViewIndex >= 0 ? data.presentationSpace.views[activeCameraViewIndex] : null;
  const activeAnchorIndex =
    data.anchors.length === 0 ? -1 : Math.min(selectedAnchorIndex, data.anchors.length - 1);
  const activeAnchor = activeAnchorIndex >= 0 ? data.anchors[activeAnchorIndex] : null;
  const replaceCameraView = (cameraView: NonNullable<typeof activeCameraView>, label: string) => {
    if (activeCameraViewIndex < 0) return;
    const views = data.presentationSpace.views.map((candidate, index) =>
      index === activeCameraViewIndex ? cameraView : candidate,
    );
    commit({ ...data, presentationSpace: { ...data.presentationSpace, views } }, label);
  };
  const replaceAnchor = (anchor: NonNullable<typeof activeAnchor>, label: string) => {
    if (activeAnchorIndex < 0) return;
    commit(
      {
        ...data,
        anchors: data.anchors.map((candidate, index) =>
          index === activeAnchorIndex ? anchor : candidate,
        ),
      },
      label,
    );
  };
  const renderCameraViewDetail = (cameraView: NonNullable<typeof activeCameraView>) => (
    <div className="rounded-md border bg-background/50 p-2.5">
      <div className="flex items-center justify-between gap-2 border-b pb-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">View details</div>
          <div className="truncate text-[10px] text-muted-foreground">
            Center {cameraView.view.center.x}, {cameraView.view.center.y} · {cameraView.view.zoom}×
            · {cameraView.view.rotationDegrees}°
          </div>
        </div>
      </div>
      <div className="grid gap-2 pt-2 @3xl:grid-cols-5">
        <div className="space-y-1 @3xl:col-span-2">
          <Label>View ID</Label>
          <Input
            value={cameraView.id}
            onChange={(event) =>
              replaceCameraView(
                { ...cameraView, id: event.currentTarget.value },
                'Rename Camera View',
              )
            }
          />
        </div>
        <div className="space-y-1">
          <Label>Center X</Label>
          <Input
            type="number"
            value={cameraView.view.center.x}
            onChange={(event) =>
              replaceCameraView(
                {
                  ...cameraView,
                  view: {
                    ...cameraView.view,
                    center: {
                      ...cameraView.view.center,
                      x: numberValue(event.currentTarget.value, cameraView.view.center.x),
                    },
                  },
                },
                'Update Camera View',
              )
            }
          />
        </div>
        <div className="space-y-1">
          <Label>Center Y</Label>
          <Input
            type="number"
            value={cameraView.view.center.y}
            onChange={(event) =>
              replaceCameraView(
                {
                  ...cameraView,
                  view: {
                    ...cameraView.view,
                    center: {
                      ...cameraView.view.center,
                      y: numberValue(event.currentTarget.value, cameraView.view.center.y),
                    },
                  },
                },
                'Update Camera View',
              )
            }
          />
        </div>
        <div className="space-y-1">
          <Label>Zoom</Label>
          <Input
            type="number"
            min={0.001}
            step={0.05}
            value={cameraView.view.zoom}
            onChange={(event) =>
              replaceCameraView(
                {
                  ...cameraView,
                  view: {
                    ...cameraView.view,
                    zoom: Math.max(
                      0.001,
                      numberValue(event.currentTarget.value, cameraView.view.zoom),
                    ),
                  },
                },
                'Update Camera View zoom',
              )
            }
          />
        </div>
        <div className="space-y-1 @3xl:col-start-5">
          <Label>Rotation</Label>
          <Input
            type="number"
            value={cameraView.view.rotationDegrees}
            onChange={(event) =>
              replaceCameraView(
                {
                  ...cameraView,
                  view: {
                    ...cameraView.view,
                    rotationDegrees: numberValue(
                      event.currentTarget.value,
                      cameraView.view.rotationDegrees,
                    ),
                  },
                },
                'Update Camera View rotation',
              )
            }
          />
        </div>
      </div>
    </div>
  );
  const renderAnchorDetail = (anchor: NonNullable<typeof activeAnchor>) => (
    <div className="rounded-md border bg-background/50 p-2.5">
      <div className="flex items-center justify-between gap-2 border-b pb-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">Anchor details</div>
          <div className="truncate text-[10px] text-muted-foreground">
            {anchor.bounds.x}, {anchor.bounds.y} · {anchor.bounds.width} × {anchor.bounds.height}
          </div>
        </div>
      </div>
      <div className="grid gap-2 pt-2 @3xl:grid-cols-6">
        <div className="space-y-1 @3xl:col-span-2">
          <Label>Anchor ID</Label>
          <Input
            value={anchor.id}
            onChange={(event) =>
              replaceAnchor({ ...anchor, id: event.currentTarget.value }, 'Rename Room Anchor')
            }
          />
        </div>
        {(['x', 'y', 'width', 'height'] as const).map((field) => (
          <div key={field} className="space-y-1">
            <Label>{field}</Label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={anchor.bounds[field]}
              onChange={(event) => {
                const raw = numberValue(event.currentTarget.value, anchor.bounds[field]);
                const value = Math.max(
                  field === 'width' || field === 'height' ? 0.001 : 0,
                  Math.min(1, raw),
                );
                replaceAnchor(
                  { ...anchor, bounds: { ...anchor.bounds, [field]: value } },
                  'Update Room Anchor bounds',
                );
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
  const contentEntitySelectorItems =
    contentEntitySelector?.kind === 'overlay-layout' ||
    contentEntitySelector?.kind === 'placement-layout' ||
    contentEntitySelector?.kind === 'new-overlay-layout'
      ? layoutSelectorItems
      : contentEntitySelector?.kind === 'cast-character'
        ? characterSelectorItems
        : imageAssetItems;
  const contentEntitySelectorCurrentEntityId = (() => {
    if (!contentEntitySelector) return null;
    switch (contentEntitySelector.kind) {
      case 'overlay-layout':
        return (
          data.overlays.find((item) => item.id === contentEntitySelector.id)?.layout.$ref.id ?? null
        );
      case 'placement-layout':
        return (
          data.placements.find((item) => item.id === contentEntitySelector.id)?.presentation.layout
            ?.$ref.id ?? null
        );
      case 'new-overlay-layout':
        return null;
      case 'cast-character':
        return (
          data.cast.find((item) => item.id === contentEntitySelector.id)?.character.$ref.id ?? null
        );
      case 'prop-asset':
        return (
          data.props.find((item) => item.id === contentEntitySelector.id)?.asset?.$ref.id ?? null
        );
      case 'environment-asset':
        return (
          data.environments.find((item) => item.id === contentEntitySelector.id)?.asset?.$ref.id ??
          null
        );
    }
  })();
  const contentEntitySelectorTitle =
    contentEntitySelector?.kind === 'overlay-layout' ||
    contentEntitySelector?.kind === 'placement-layout' ||
    contentEntitySelector?.kind === 'new-overlay-layout'
      ? t('roomEditor.compositionPane.editor.chooseLayout')
      : contentEntitySelector?.kind === 'cast-character'
        ? t('roomEditor.compositionPane.editor.chooseCharacter')
        : t('roomEditor.compositionPane.editor.chooseAsset');
  const contentEntitySelectorSelectedId =
    contentEntitySelectorItems.find(
      (item) => item.entityId === contentEntitySelectorCurrentEntityId,
    )?.id ?? null;
  const renderRoomSelectionInspector = (selection: RoomEditSelection) => {
    const fields: Array<{ label: string; value: string }> = [];
    let semanticEditor: ReactNode = null;
    switch (selection.kind) {
      case 'placement': {
        const placement = data.placements.find((item) => item.id === selection.id);
        if (placement) {
          fields.push(
            {
              label: t('roomEditor.compositionPane.inspectorKind'),
              value: t('roomEditor.compositionPane.entityKinds.placement'),
            },
            { label: t('roomEditor.compositionPane.inspectorId'), value: placement.id },
            {
              label: t('roomEditor.compositionPane.inspectorBounds'),
              value: `${placement.bounds.x}, ${placement.bounds.y} · ${placement.bounds.width} × ${placement.bounds.height}`,
            },
            {
              label: t('roomEditor.compositionPane.inspectorLayout'),
              value: placement.presentation.layout?.$ref.id ?? '—',
            },
          );
          semanticEditor = (
            <div className="space-y-3 border-t pt-3">
              <div className="space-y-1">
                <Label htmlFor={`room-placement-${placement.id}-id`}>
                  {t('roomEditor.compositionPane.editor.placementId')}
                </Label>
                <Input
                  key={placement.id}
                  id={`room-placement-${placement.id}-id`}
                  defaultValue={placement.id}
                  onBlur={(event) => renameRoomPlacement(placement.id, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
                {(['x', 'y', 'width', 'height'] as const).map((field) => (
                  <div key={field} className="space-y-1">
                    <Label htmlFor={`room-placement-${placement.id}-${field}`}>
                      {t('roomEditor.compositionPane.editor.boundsField', { field })}
                    </Label>
                    <Input
                      id={`room-placement-${placement.id}-${field}`}
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={placement.bounds[field]}
                      onChange={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (
                          !Number.isFinite(value) ||
                          value < 0 ||
                          value > 1 ||
                          ((field === 'width' || field === 'height') && value <= 0)
                        )
                          return;
                        executeRoomEditCommand(
                          'room.setPlacementBounds',
                          t('roomEditor.compositionPane.editor.updatePlacementBounds'),
                          {
                            placementId: placement.id,
                            bounds: { ...placement.bounds, [field]: value },
                          },
                        );
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label>{t('roomEditor.compositionPane.inspectorLabel')}</Label>
                  {placement.presentation.label ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        replacePlacement(
                          placement.id,
                          {
                            presentation: {
                              ...placement.presentation,
                              label: null,
                            } as RoomPlacementData['presentation'],
                          },
                          t('roomEditor.compositionPane.editor.clearPlacementLabel'),
                        )
                      }
                    >
                      {t('roomEditor.compositionPane.editor.clear')}
                    </Button>
                  ) : null}
                </div>
                {placement.presentation.label ? (
                  <TextContentEditor
                    value={placement.presentation.label}
                    onChange={(label) =>
                      replacePlacement(
                        placement.id,
                        {
                          presentation: {
                            ...placement.presentation,
                            label,
                          } as RoomPlacementData['presentation'],
                        },
                        t('roomEditor.compositionPane.editor.updatePlacementLabel'),
                      )
                    }
                  />
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      replacePlacement(
                        placement.id,
                        {
                          presentation: {
                            ...placement.presentation,
                            label: inlineTextContent(''),
                          } as RoomPlacementData['presentation'],
                        },
                        t('roomEditor.compositionPane.editor.addPlacementLabel'),
                      )
                    }
                  >
                    {t('roomEditor.compositionPane.editor.addLabel')}
                  </Button>
                )}
              </div>
              <div className="space-y-1">
                <Label>{t('roomEditor.compositionPane.editor.attachedLayout')}</Label>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-w-0 flex-1 justify-start font-normal"
                    onClick={() =>
                      setContentEntitySelector({ kind: 'placement-layout', id: placement.id })
                    }
                  >
                    {placement.presentation.layout
                      ? (project.layouts[placement.presentation.layout.$ref.id]?.label ??
                        placement.presentation.layout.$ref.id)
                      : t('roomEditor.compositionPane.editor.chooseLayout')}
                  </Button>
                  {placement.presentation.layout ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        replacePlacement(
                          placement.id,
                          {
                            presentation: {
                              label: placement.presentation.label,
                              layout: null,
                            },
                          },
                          t('roomEditor.compositionPane.editor.detachPlacementLayout'),
                        )
                      }
                    >
                      {t('roomEditor.compositionPane.editor.clear')}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          );
        }
        break;
      }
      case 'placement-layout': {
        const placement = data.placements.find((item) => item.id === selection.id);
        if (placement?.presentation.layout) {
          fields.push(
            {
              label: t('roomEditor.compositionPane.inspectorKind'),
              value: t('roomEditor.compositionPane.entityKinds.placementLayout'),
            },
            { label: t('roomEditor.compositionPane.inspectorPlacement'), value: placement.id },
            {
              label: t('roomEditor.compositionPane.inspectorLayout'),
              value: placement.presentation.layout.$ref.id,
            },
            {
              label: t('roomEditor.compositionPane.inspectorOrder'),
              value: String(placement.presentation.layoutOrder),
            },
          );
          semanticEditor = (
            <div className="space-y-1 border-t pt-3">
              <Label>{t('roomEditor.compositionPane.editor.attachedLayout')}</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full justify-start font-normal"
                onClick={() =>
                  setContentEntitySelector({ kind: 'placement-layout', id: placement.id })
                }
              >
                {project.layouts[placement.presentation.layout.$ref.id]?.label ??
                  placement.presentation.layout.$ref.id}
              </Button>
            </div>
          );
        }
        break;
      }
      case 'interactable': {
        const occurrence = data.interactables.find((item) => item.id === selection.id);
        const instance = occurrence
          ? project.interactableInstances[occurrence.interactable.$ref.id]
          : null;
        if (occurrence) {
          fields.push(
            {
              label: t('roomEditor.compositionPane.inspectorKind'),
              value: t('roomEditor.compositionPane.entityKinds.interactableOccurrence'),
            },
            { label: t('roomEditor.compositionPane.inspectorId'), value: occurrence.id },
            {
              label: t('roomEditor.compositionPane.inspectorPlacement'),
              value: occurrence.placementId,
            },
            {
              label: t('roomEditor.compositionPane.inspectorInstance'),
              value: occurrence.interactable.$ref.id,
            },
            {
              label: t('roomEditor.compositionPane.inspectorDefinition'),
              value: instance?.definition.$ref.id ?? '—',
            },
            {
              label: t('roomEditor.compositionPane.inspectorOrder'),
              value: String(occurrence.order),
            },
          );
          semanticEditor = (
            <div className="space-y-3 border-t pt-3">
              <div className="grid gap-2 @3xl:grid-cols-2">
                <div className="space-y-1">
                  <Label>{t('roomEditor.compositionPane.inspectorPlacement')}</Label>
                  <Select
                    items={data.placements.map((item) => ({ value: item.id, label: item.id }))}
                    value={occurrence.placementId}
                    onValueChange={(value) =>
                      replaceInteractableOccurrence(occurrence.id, {
                        placementId: String(value),
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {data.placements.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-end gap-2 pb-2">
                  <input
                    type="checkbox"
                    checked={occurrence.visible}
                    onChange={(event) =>
                      replaceInteractableOccurrence(occurrence.id, {
                        visible: event.currentTarget.checked,
                      })
                    }
                  />
                  {t('roomEditor.compositionPane.editor.visible')}
                </label>
              </div>
              <RecursiveConditionEditor
                value={occurrence.condition}
                project={project}
                scope={{ currentRoom: true }}
                onChange={(condition) =>
                  replaceInteractableOccurrence(occurrence.id, { condition })
                }
              />
              {instance ? (
                <InteractableInstancePropertiesEditor
                  compact
                  project={project}
                  instanceId={occurrence.interactable.$ref.id}
                  instance={instance}
                  onChange={(next, change) =>
                    commitInteractableInstance(occurrence.interactable.$ref.id, next, change)
                  }
                />
              ) : null}
            </div>
          );
        }
        break;
      }
      case 'prop': {
        const occurrence = data.props.find((item) => item.id === selection.id);
        if (occurrence) {
          fields.push(
            {
              label: t('roomEditor.compositionPane.inspectorKind'),
              value: t('roomEditor.compositionPane.entityKinds.prop'),
            },
            { label: t('roomEditor.compositionPane.inspectorId'), value: occurrence.id },
            {
              label: t('roomEditor.compositionPane.inspectorPlacement'),
              value: occurrence.placementId,
            },
            {
              label: t('roomEditor.compositionPane.inspectorAsset'),
              value: occurrence.asset?.$ref.id ?? '—',
            },
            {
              label: t('roomEditor.compositionPane.inspectorOrder'),
              value: String(occurrence.order),
            },
          );
          semanticEditor = (
            <div className="space-y-3 border-t pt-3">
              <div className="grid gap-2 @3xl:grid-cols-2">
                <div className="space-y-1">
                  <Label>{t('roomEditor.compositionPane.inspectorPlacement')}</Label>
                  <Select
                    items={data.placements.map((item) => ({ value: item.id, label: item.id }))}
                    value={occurrence.placementId}
                    onValueChange={(value) =>
                      replaceProp(occurrence.id, { placementId: String(value) })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {data.placements.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-end gap-2 pb-2">
                  <input
                    type="checkbox"
                    checked={occurrence.visible}
                    onChange={(event) =>
                      replaceProp(occurrence.id, { visible: event.currentTarget.checked })
                    }
                  />
                  {t('roomEditor.compositionPane.editor.visible')}
                </label>
              </div>
              <div className="space-y-1">
                <Label>{t('roomEditor.compositionPane.editor.imageAsset')}</Label>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-w-0 flex-1 justify-start font-normal"
                    onClick={() =>
                      setContentEntitySelector({ kind: 'prop-asset', id: occurrence.id })
                    }
                  >
                    {occurrence.asset
                      ? (project.assets[occurrence.asset.$ref.id]?.label ??
                        occurrence.asset.$ref.id)
                      : t('roomEditor.compositionPane.editor.chooseImage')}
                  </Button>
                  {occurrence.asset ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => replaceProp(occurrence.id, { asset: null })}
                    >
                      {t('roomEditor.compositionPane.editor.clear')}
                    </Button>
                  ) : null}
                </div>
              </div>
              <MaterialApplicationEditor
                project={project}
                value={occurrence.materialApplication}
                expectedRole="engine-2d"
                properties={roomMaterialProperties}
                ariaLabel={t('roomEditor.compositionPane.editor.propMaterialAriaLabel', {
                  id: occurrence.id,
                })}
                overrideLabel={t('roomEditor.compositionPane.editor.propOverride')}
                onChange={(materialApplication) =>
                  replaceProp(occurrence.id, { materialApplication })
                }
              />
              <RecursiveConditionEditor
                value={occurrence.condition}
                project={project}
                scope={{ currentRoom: true }}
                onChange={(condition) => replaceProp(occurrence.id, { condition })}
              />
            </div>
          );
        }
        break;
      }
      case 'cast': {
        const occurrence = data.cast.find((item) => item.id === selection.id);
        if (occurrence) {
          const characterData = parseCharacterData(
            project.characters[occurrence.character.$ref.id]?.data,
          );
          const profileItems =
            characterData?.profiles.map((profile) => ({
              value: profile.id,
              label: profile.label,
            })) ?? [];
          const appearanceItems =
            characterData?.appearances.map((appearance) => ({
              value: appearance.id,
              label: appearance.label,
            })) ?? [];
          const selectedProfileId = occurrence.profileId ?? characterData?.defaults.profileId ?? '';
          fields.push(
            {
              label: t('roomEditor.compositionPane.inspectorKind'),
              value: t('roomEditor.compositionPane.entityKinds.castOccurrence'),
            },
            { label: t('roomEditor.compositionPane.inspectorId'), value: occurrence.id },
            {
              label: t('roomEditor.compositionPane.inspectorPlacement'),
              value: occurrence.placementId,
            },
            {
              label: t('roomEditor.compositionPane.inspectorCharacter'),
              value: occurrence.character.$ref.id,
            },
            {
              label: t('roomEditor.compositionPane.inspectorOrder'),
              value: String(occurrence.order),
            },
          );
          semanticEditor = (
            <div className="space-y-3 border-t pt-3">
              <div className="grid gap-2 @3xl:grid-cols-2">
                <div className="space-y-1">
                  <Label>{t('roomEditor.compositionPane.inspectorCharacter')}</Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-full justify-start font-normal"
                    onClick={() =>
                      setContentEntitySelector({ kind: 'cast-character', id: occurrence.id })
                    }
                  >
                    {project.characters[occurrence.character.$ref.id]?.label ??
                      occurrence.character.$ref.id}
                  </Button>
                </div>
                <div className="space-y-1">
                  <Label>{t('roomEditor.compositionPane.inspectorPlacement')}</Label>
                  <Select
                    items={data.placements.map((item) => ({ value: item.id, label: item.id }))}
                    value={occurrence.placementId}
                    onValueChange={(value) =>
                      replaceCast(occurrence.id, { placementId: String(value) })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {data.placements.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-2 @3xl:grid-cols-2">
                <div className="space-y-1">
                  <Label>{t('roomEditor.compositionPane.editor.profileId')}</Label>
                  <Select
                    items={profileItems}
                    value={selectedProfileId}
                    onValueChange={(value) =>
                      replaceCast(occurrence.id, { profileId: String(value) })
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t('roomEditor.compositionPane.editor.profileId')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {profileItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>{t('roomEditor.compositionPane.editor.appearanceId')}</Label>
                  <Select
                    items={[
                      {
                        value: '__none__',
                        label: t('roomEditor.compositionPane.editor.none'),
                      },
                      ...appearanceItems,
                    ]}
                    value={occurrence.appearanceId ?? '__none__'}
                    onValueChange={(value) =>
                      replaceCast(occurrence.id, {
                        appearanceId: value === '__none__' ? null : String(value),
                      })
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t('roomEditor.compositionPane.editor.appearanceId')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">
                        {t('roomEditor.compositionPane.editor.none')}
                      </SelectItem>
                      {appearanceItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={occurrence.visible}
                  onChange={(event) =>
                    replaceCast(occurrence.id, { visible: event.currentTarget.checked })
                  }
                />
                {t('roomEditor.compositionPane.editor.visible')}
              </label>
              <div className="grid gap-2 @3xl:grid-cols-3">
                {(
                  [
                    ['poseId', t('roomEditor.compositionPane.editor.poseId')],
                    ['expressionId', t('roomEditor.compositionPane.editor.expressionId')],
                    ['idleId', t('roomEditor.compositionPane.editor.idleId')],
                  ] as const
                ).map(([field, label]) => (
                  <div key={field} className="space-y-1">
                    <Label>{label}</Label>
                    <Input
                      value={occurrence[field] ?? ''}
                      onChange={(event) =>
                        replaceCast(occurrence.id, {
                          [field]: event.currentTarget.value || null,
                        })
                      }
                    />
                  </div>
                ))}
              </div>
              <RecursiveConditionEditor
                value={occurrence.condition}
                project={project}
                scope={{ currentRoom: true }}
                onChange={(condition) => replaceCast(occurrence.id, { condition })}
              />
            </div>
          );
        }
        break;
      }
      case 'environment': {
        const occurrence = data.environments.find((item) => item.id === selection.id);
        if (occurrence) {
          fields.push(
            {
              label: t('roomEditor.compositionPane.inspectorKind'),
              value: t('roomEditor.compositionPane.entityKinds.environment'),
            },
            { label: t('roomEditor.compositionPane.inspectorId'), value: occurrence.id },
            { label: t('roomEditor.compositionPane.inspectorPlane'), value: occurrence.plane },
            {
              label: t('roomEditor.compositionPane.inspectorOrder'),
              value: String(occurrence.order),
            },
            {
              label: t('roomEditor.compositionPane.inspectorAsset'),
              value: occurrence.asset?.$ref.id ?? '—',
            },
          );
          semanticEditor = (
            <div className="space-y-3 border-t pt-3">
              <div className="grid gap-2 @3xl:grid-cols-2">
                <div className="space-y-1">
                  <Label>{t('roomEditor.compositionPane.editor.imageAsset')}</Label>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-w-0 flex-1 justify-start font-normal"
                      onClick={() =>
                        setContentEntitySelector({ kind: 'environment-asset', id: occurrence.id })
                      }
                    >
                      {occurrence.asset
                        ? (project.assets[occurrence.asset.$ref.id]?.label ??
                          occurrence.asset.$ref.id)
                        : t('roomEditor.compositionPane.editor.chooseImage')}
                    </Button>
                    {occurrence.asset ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => replaceEnvironment(occurrence.id, { asset: null })}
                      >
                        {t('roomEditor.compositionPane.editor.clear')}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label>{t('roomEditor.compositionPane.inspectorPlane')}</Label>
                  <Select
                    items={roomEnvironmentPlaneValues.map((plane) => ({
                      value: plane,
                      label: plane,
                    }))}
                    value={occurrence.plane}
                    onValueChange={(value) => {
                      const plane = value as RoomEnvironmentData['plane'];
                      if (plane === occurrence.plane) return;
                      const allocated = allocateRoomPresentationOrder(data, plane);
                      commit(
                        {
                          ...allocated.room,
                          environments: allocated.room.environments.map((environment) =>
                            environment.id === occurrence.id
                              ? { ...environment, plane, order: allocated.order }
                              : environment,
                          ),
                        },
                        t('roomEditor.compositionPane.editor.updateRoomEnvironmentPlane'),
                      );
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roomEnvironmentPlaneValues.map((plane) => (
                        <SelectItem key={plane} value={plane}>
                          {plane}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <MaterialApplicationEditor
                project={project}
                value={occurrence.materialApplication}
                expectedRole="engine-2d"
                properties={roomMaterialProperties}
                ariaLabel={t('roomEditor.compositionPane.editor.environmentMaterialAriaLabel', {
                  id: occurrence.id,
                })}
                overrideLabel={t('roomEditor.compositionPane.editor.environmentOverride')}
                allowClear={false}
                onChange={(materialApplication) => {
                  if (materialApplication)
                    replaceEnvironment(occurrence.id, { materialApplication });
                }}
              />
              <div className="grid gap-2 @3xl:grid-cols-3">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={occurrence.visible}
                    onChange={(event) =>
                      replaceEnvironment(occurrence.id, { visible: event.currentTarget.checked })
                    }
                  />
                  {t('roomEditor.compositionPane.editor.visible')}
                </label>
                <div className="space-y-1">
                  <Label>{t('roomEditor.compositionPane.editor.opacity')}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={occurrence.opacity}
                    onChange={(event) => {
                      const opacity = Number(event.currentTarget.value);
                      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return;
                      replaceEnvironment(occurrence.id, { opacity });
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t('roomEditor.compositionPane.editor.clock')}</Label>
                  <Select
                    items={roomEnvironmentClockValues.map((clock) => ({
                      value: clock,
                      label: clock,
                    }))}
                    value={occurrence.clock}
                    onValueChange={(value) =>
                      replaceEnvironment(occurrence.id, {
                        clock: value as RoomEnvironmentData['clock'],
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roomEnvironmentClockValues.map((clock) => (
                        <SelectItem key={clock} value={clock}>
                          {clock}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
                {(['x', 'y', 'width', 'height'] as const).map((field) => (
                  <div key={field} className="space-y-1">
                    <Label>{t('roomEditor.compositionPane.editor.boundsField', { field })}</Label>
                    <Input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={occurrence.bounds[field]}
                      onChange={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (
                          !Number.isFinite(value) ||
                          value < 0 ||
                          value > 1 ||
                          ((field === 'width' || field === 'height') && value <= 0)
                        )
                          return;
                        replaceEnvironment(occurrence.id, {
                          bounds: { ...occurrence.bounds, [field]: value },
                        });
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="grid gap-2 @3xl:grid-cols-2">
                {(['x', 'y'] as const).map((axis) => (
                  <div key={axis} className="space-y-1">
                    <Label>
                      {t('roomEditor.compositionPane.editor.scrollPerSecond', {
                        axis: axis.toUpperCase(),
                      })}
                    </Label>
                    <Input
                      type="number"
                      step={0.01}
                      value={occurrence.scrollPerSecond[axis]}
                      onChange={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (!Number.isFinite(value)) return;
                        replaceEnvironment(occurrence.id, {
                          scrollPerSecond: { ...occurrence.scrollPerSecond, [axis]: value },
                        });
                      }}
                    />
                  </div>
                ))}
              </div>
              <RecursiveConditionEditor
                value={occurrence.condition}
                project={project}
                scope={{ currentRoom: true }}
                onChange={(condition) => replaceEnvironment(occurrence.id, { condition })}
              />
            </div>
          );
        }
        break;
      }
      case 'overlay': {
        const overlay = data.overlays.find((item) => item.id === selection.id);
        if (overlay) {
          fields.push(
            {
              label: t('roomEditor.compositionPane.inspectorKind'),
              value: t('roomEditor.compositionPane.entityKinds.overlay'),
            },
            { label: t('roomEditor.compositionPane.inspectorId'), value: overlay.id },
            {
              label: t('roomEditor.compositionPane.inspectorLayout'),
              value: overlay.layout.$ref.id,
            },
            { label: t('roomEditor.compositionPane.inspectorOrder'), value: String(overlay.order) },
          );
          semanticEditor = (
            <div className="space-y-3 border-t pt-3">
              <div className="grid gap-2 @3xl:grid-cols-2">
                <div className="space-y-1">
                  <Label>{t('roomEditor.compositionPane.inspectorLayout')}</Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-full justify-start font-normal"
                    onClick={() =>
                      setContentEntitySelector({ kind: 'overlay-layout', id: overlay.id })
                    }
                  >
                    {project.layouts[overlay.layout.$ref.id]?.label ?? overlay.layout.$ref.id}
                  </Button>
                </div>
                <label className="flex items-end gap-2 pb-2">
                  <input
                    type="checkbox"
                    checked={overlay.visible}
                    onChange={(event) =>
                      replaceOverlay(overlay.id, { visible: event.currentTarget.checked })
                    }
                  />
                  {t('roomEditor.compositionPane.editor.visible')}
                </label>
              </div>
              <RecursiveConditionEditor
                value={overlay.condition}
                project={project}
                scope={{ currentRoom: true }}
                onChange={(condition) => replaceOverlay(overlay.id, { condition })}
              />
            </div>
          );
        }
        break;
      }
      case 'hotspot': {
        const hotspot = data.hotspots.find((item) => item.id === selection.id);
        if (!hotspot) break;
        return (
          <HotspotAuthoringPanel
            anchorPrefix="room"
            project={project}
            projectFilePath={projectFilePath}
            title={t('roomEditor.compositionPane.selection.hotspot', {
              label: hotspot.label,
              id: hotspot.id,
            })}
            assetId={data.background.asset?.$ref.id ?? null}
            hotspots={[hotspot]}
            selectedView={{ ...hotspotView, selectedHotspotId: hotspot.id }}
            ownerKind="room"
            ownerId={roomId}
            materialProperties={roomMaterialProperties}
            localFeatures={data.features}
            exits={data.exits.map((exit) => ({ id: exit.id, label: exit.id }))}
            detailOnly
            onViewChange={setHotspotView}
            onDelete={(hotspotId) =>
              executeHotspot(
                'room.deleteHotspot',
                t('roomEditor.compositionPane.editor.deleteRoomHotspot'),
                { hotspotId },
              )
            }
            onRename={renameRoomHotspot}
            onUpdate={(hotspotId, nextHotspot) =>
              executeHotspot(
                'room.updateHotspot',
                t('roomEditor.compositionPane.editor.updateRoomHotspot'),
                {
                  hotspotId,
                  hotspot: nextHotspot,
                },
              )
            }
            onEditGeometry={(selectedHotspotId) => beginRoomHotspotFocus(selectedHotspotId)}
          />
        );
      }
    }
    const presentationTarget = roomPresentationTargetForSelection(selection);
    const presentationEntry = presentationTarget
      ? roomPresentationOrderEntries(data).find(
          (entry) =>
            entry.target.kind === presentationTarget.kind &&
            entry.target.id === presentationTarget.id,
        )
      : null;
    const presentationOrder =
      presentationTarget && presentationEntry
        ? { target: presentationTarget, order: presentationEntry.order }
        : null;
    return (
      <div className="space-y-3 rounded-md border bg-background/50 p-3">
        <div className="text-sm font-semibold">
          {describeRoomEditSelection(project, data, selection, t)}
        </div>
        <dl className="grid gap-x-4 gap-y-2 text-xs @3xl:grid-cols-[9rem_minmax(0,1fr)]">
          {fields.map((field) => (
            <div key={field.label} className="contents">
              <dt className="font-medium text-muted-foreground">{field.label}</dt>
              <dd className="min-w-0 break-words font-mono">{field.value}</dd>
            </div>
          ))}
        </dl>
        {semanticEditor}
        {presentationOrder ? (
          <div className="space-y-2 border-t pt-3" data-testid="room-presentation-order-controls">
            <div className="grid grid-cols-2 gap-1">
              {(
                [
                  ['backward', t('roomEditor.compositionPane.sendBackward')],
                  ['forward', t('roomEditor.compositionPane.bringForward')],
                  ['back', t('roomEditor.compositionPane.sendToBack')],
                  ['front', t('roomEditor.compositionPane.bringToFront')],
                ] as const
              ).map(([action, label]) => (
                <Button
                  key={action}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    executeRoomEditCommand('room.reorderPresentation', label, {
                      target: presentationOrder.target,
                      action,
                    })
                  }
                >
                  {label}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-2">
              <Label htmlFor={`room-order-${roomEditSelectionKey(selection)}`}>
                {t('roomEditor.compositionPane.advancedOrder')}
              </Label>
              <Input
                key={`${roomEditSelectionKey(selection)}:${presentationOrder.order}`}
                id={`room-order-${roomEditSelectionKey(selection)}`}
                type="number"
                min={ROOM_PRESENTATION_ORDER_MIN}
                max={ROOM_PRESENTATION_ORDER_MAX}
                defaultValue={presentationOrder.order}
                onBlur={(event) => {
                  const order = Number(event.currentTarget.value);
                  if (
                    !Number.isInteger(order) ||
                    order < ROOM_PRESENTATION_ORDER_MIN ||
                    order > ROOM_PRESENTATION_ORDER_MAX ||
                    order === presentationOrder.order
                  )
                    return;
                  executeRoomEditCommand(
                    'room.setPresentationOrder',
                    t('roomEditor.compositionPane.setOrder'),
                    { target: presentationOrder.target, order },
                  );
                }}
              />
            </div>
          </div>
        ) : null}
      </div>
    );
  };
  const hotspotFocusRoomPresentation =
    hotspotFocusSession && hotspotFocusRoomViewportScreenRect
      ? (() => {
          const projection = resolveRoomEditProjection({
            project,
            roomId,
            room: data,
            viewport: referenceResolution,
            backgroundImageSize: compositionBackgroundSize,
            resolvedVisibility: activeRoomEditResolution,
            navigation:
              presentationMode === 'edit' ? visibleEditNavigation : ROOM_EDIT_FIT_NAVIGATION,
          });
          return {
            viewport: referenceResolution,
            displayedViewportScreenRect: hotspotFocusRoomViewportScreenRect,
            visibleImageRect: projection.background.rect,
            visibleImageUv: projection.background.uv,
            rotationDegrees: projection.background.rotationDegrees,
          };
        })()
      : null;
  if (hotspotFocusSession) {
    return (
      <HotspotFocusWorkspace
        tabId={tab.id}
        projectAssets={project.assets}
        roomPresentation={hotspotFocusRoomPresentation}
        onDone={(selectedHotspotId) => {
          if (selectedHotspotId) {
            setRoomSelection([{ kind: 'hotspot', id: selectedHotspotId }]);
            setHotspotView((current) => ({ ...current, selectedHotspotId }));
          }
          if (presentationMode === 'edit') setActiveCategory('composition');
          else changeRoomPresentationMode('edit');
        }}
        createHotspot={(id, inputOrder, bounds) => ({
          id,
          label: t('hotspots.defaultLabel'),
          condition: { kind: 'always' },
          inputOrder,
          highlight: { kind: 'default' },
          target: { kind: 'none' },
          shape: { kind: 'rect', bounds },
        })}
      />
    );
  }
  return (
    <EditorPreviewSplit
      orientation={previewSplitOrientation}
      resizeLabel="Resize room preview"
      previewCollapsed={previewCollapsed}
      onPreviewCollapsedChange={(collapsed) => {
        recordTabPreviewVisible(tab, !collapsed);
        setPreviewCollapsed(collapsed);
      }}
      preview={
        <div className="flex h-full min-h-0 flex-col bg-background">
          <div
            className="flex shrink-0 items-center gap-1 border-b bg-muted/20 p-1"
            role="group"
            aria-label={t('roomEditor.presentationModes.label')}
          >
            <Button
              type="button"
              size="sm"
              variant={presentationMode === 'edit' ? 'secondary' : 'ghost'}
              aria-pressed={presentationMode === 'edit'}
              disabled={roomEditTransitioning}
              onClick={() => changeRoomPresentationMode('edit')}
            >
              {t('roomEditor.presentationModes.edit')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={presentationMode === 'preview' ? 'secondary' : 'ghost'}
              aria-pressed={presentationMode === 'preview'}
              disabled={roomEditTransitioning}
              onClick={() => changeRoomPresentationMode('preview')}
            >
              {t('roomEditor.presentationModes.preview')}
            </Button>
            {presentationMode === 'edit' ? (
              <>
                <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={roomEditTransitioning}
                  onClick={fitRoomEditNavigation}
                >
                  {t('roomEditor.presentationModes.fit')}
                </Button>
                <span
                  className="min-w-10 text-right text-xs tabular-nums text-muted-foreground"
                  aria-label={t('roomEditor.presentationModes.zoom')}
                >
                  {Math.round(visibleEditNavigation.zoom * 100)}%
                </span>
              </>
            ) : null}
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {presentationMode === 'edit' ? (
              <div
                ref={roomEditViewportElementRef}
                className="flex h-full min-h-0 items-center justify-center overflow-hidden p-2"
              >
                <div
                  className="shrink-0"
                  style={{
                    width: fittedRoomEditSurfaceSize.width || undefined,
                    height: fittedRoomEditSurfaceSize.height || undefined,
                  }}
                  data-testid="room-edit-fit-frame"
                >
                  <RoomEditSurface
                    project={project}
                    roomId={roomId}
                    room={data}
                    referenceResolution={referenceResolution}
                    backgroundImageSize={compositionBackgroundSize}
                    roomPropertyValues={roomPropertyValues}
                    resolvedVisibility={activeRoomEditResolution}
                    navigation={visibleEditNavigation}
                    onNavigationChange={handleRoomEditNavigationChange}
                    gestureCancellationToken={roomEditGestureCancellationToken}
                    interactionEnabled={!roomEditTransitioning}
                    selection={roomSelection}
                    onSelectionChange={(nextSelection) => setRoomSelection([...nextSelection])}
                    onTranslateSelection={(nextSelection, delta) =>
                      executeRoomEditCommand(
                        'room.translateSelection',
                        t('roomEditor.compositionPane.editor.moveRoomSelection'),
                        {
                          selection: nextSelection,
                          delta,
                        },
                      )
                    }
                    onResizeSelection={(nextSelection, bounds) =>
                      executeRoomEditCommand(
                        'room.resizeSelection',
                        t('roomEditor.compositionPane.editor.resizeRoomSelection'),
                        {
                          selection: nextSelection,
                          bounds,
                        },
                      )
                    }
                    addActions={roomAddActions}
                    pendingAddActionId={roomAddGhost?.kind ?? null}
                    onPendingAddActionCancel={() => setRoomAddGhost(null)}
                    onAddAtPoint={(actionId, point) => {
                      if (roomAddGhost && roomAddGhost.kind === actionId) {
                        executeRoomAdd(roomAddGhost, { point });
                        setRoomAddGhost(null);
                        return;
                      }
                      beginRoomAdd(actionId, { kind: 'point', point });
                    }}
                    onSurfaceElementChange={handleRoomEditSurfaceElementChange}
                  />
                </div>
              </div>
            ) : null}
            <div
              ref={roomPreviewSurfaceElementRef}
              data-room-preview-surface=""
              className={
                presentationMode === 'preview' ? 'absolute inset-0' : 'invisible absolute inset-0'
              }
              aria-hidden={presentationMode !== 'preview'}
            >
              <DerivedPreviewPane
                ownerTabId={tab.id}
                previewMode="room"
                enabled={!previewCollapsed}
                root={{ kind: 'room-preview', recordId: roomId }}
                inputs={{ displayPreference: { mode: 'project' } }}
                onFocusedDocumentApplied={handleFocusedRoomApplied}
                revealFocusedDocument={presentationMode === 'preview'}
              />
            </div>
          </div>
        </div>
      }
    >
      <CategorizedEditorLayout
        categories={categorizedRoomEditorCategories}
        activeCategory={activeCategory}
        onCategoryChange={setActiveCategory}
        navigationLabel={t('roomEditor.categories.navigationLabel')}
        contentRef={scrollRef}
        contentContainerClassName="max-w-6xl pb-8"
        header={<h2 className="truncate text-lg font-semibold">{activeRoomCategory.label}</h2>}
      >
        {activeCategory === 'general' ? (
          <section className="space-y-5" data-workbench-anchor="room.summary">
            <div className="grid gap-4 @5xl:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Display name</Label>
                <Input
                  value={data.displayName}
                  onChange={(event) =>
                    commit({ ...data, displayName: event.currentTarget.value }, 'Update room name')
                  }
                />
              </div>
              <GameplayArchetypeControls
                project={project}
                collection="rooms"
                entityId={roomId}
                record={record}
                kind="room"
                compact
              />
            </div>
            <div data-workbench-anchor="room.description" className="space-y-1.5">
              <Label>Description</Label>
              <TextContentEditor
                value={data.description}
                onChange={(description) =>
                  commit({ ...data, description }, 'Update room description')
                }
              />
            </div>
            <div data-workbench-anchor="room.background" className="space-y-3">
              <EditorSectionHeading title="Background" />
              <div className="grid items-start gap-4 @5xl:grid-cols-[minmax(0,1fr)_400px]">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Image</Label>
                    <div className="flex min-h-14 items-stretch overflow-hidden rounded-lg border bg-background">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3 p-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                        onClick={() => setBackgroundSelectorOpen(true)}
                      >
                        {selectedBackgroundItem?.preview?.kind === 'image' ? (
                          <AssetImageThumbnail
                            label={selectedBackgroundItem.preview.label}
                            source={selectedBackgroundItem.preview.source}
                            request={{ profile: 'wide' }}
                            requestMode="eager"
                            className="h-10 w-16"
                          />
                        ) : (
                          <span className="flex h-10 w-16 shrink-0 items-center justify-center rounded border border-dashed bg-muted/20">
                            <Image className="size-5 text-muted-foreground" aria-hidden="true" />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {selectedBackgroundItem?.title ?? 'Choose an image'}
                          </span>
                          {selectedBackgroundItem?.entityId &&
                          selectedBackgroundItem.entityId !== selectedBackgroundItem.title ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {selectedBackgroundItem.entityId}
                            </span>
                          ) : !selectedBackgroundItem ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {`${imageAssetItems.length} image${imageAssetItems.length === 1 ? '' : 's'} available`}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      {data.background.asset ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-auto rounded-none border-l px-3"
                          onClick={() =>
                            commit(
                              { ...data, background: { ...data.background, asset: null } },
                              'Clear room background',
                            )
                          }
                        >
                          Clear
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="grid gap-3 @3xl:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Material</Label>
                      <MaterialApplicationEditor
                        project={project}
                        value={data.background.materialApplication}
                        expectedRole="engine-2d"
                        properties={roomMaterialProperties}
                        ariaLabel="Room background Material"
                        overrideLabel="Room override"
                        onChange={(materialApplication) =>
                          commit(
                            {
                              ...data,
                              background: { ...data.background, materialApplication },
                            },
                            'Update room background Material',
                          )
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Fallback color</Label>
                      <ColorField
                        value={data.background.color}
                        ariaLabel="Fallback color"
                        onValueChange={(color) =>
                          commit(
                            {
                              ...data,
                              background: {
                                ...data.background,
                                color,
                              },
                            },
                            'Update room background color',
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Image fit</Label>
                  <div
                    className="grid grid-cols-4 overflow-hidden rounded-md border bg-input/20"
                    role="group"
                    aria-label="Image fit"
                  >
                    {roomBackgroundFitValues.map((fit) => {
                      const selected = data.background.fit === fit;
                      return (
                        <button
                          key={fit}
                          type="button"
                          aria-label={backgroundFitLabels[fit]}
                          aria-pressed={selected}
                          className="flex min-h-20 items-center justify-center border-r px-1.5 py-2 text-muted-foreground transition-colors last:border-r-0 hover:bg-muted/50 hover:text-foreground focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                          onClick={() =>
                            commit(
                              {
                                ...data,
                                background: {
                                  ...data.background,
                                  fit,
                                },
                              },
                              'Update room background fit',
                            )
                          }
                        >
                          <BackgroundFitOption fit={fit} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {activeCategory === 'properties' ? (
          <OwnerLocalPropertiesEditor
            ownerLabel={`Room '${record.label}'`}
            properties={record.localProperties ?? []}
            onChange={commitLocalProperties}
            traits={project.traits}
            ownerKind="room"
            attachedTraits={effectiveRecord?.traits ?? record.traits ?? []}
            inheritedTraits={inheritedPropertyConfiguration?.traits ?? []}
            inheritedProperties={(inheritedPropertyConfiguration?.defaultProperties ?? []).map(
              (property) => ({
                property,
                sourceLabel: record.archetype
                  ? (project.archetypes[record.archetype.$ref.id]?.label ?? 'Archetype')
                  : 'Archetype',
              }),
            )}
            traitColorFor={(traitId) =>
              project.editor.recordMetadata.traits?.[traitId]?.color ?? null
            }
            onTraitStateChange={commitPropertyTraitState}
            usageCountFor={(propertyId) =>
              ownerLocalPropertyReferences(project, { kind: 'room', id: roomId }, propertyId).length
            }
            onShowUsages={(propertyId) => {
              const usages = ownerLocalPropertyReferences(
                project,
                { kind: 'room', id: roomId },
                propertyId,
              );
              setUsages(
                { collection: 'rooms', id: roomId },
                usages,
                `room/${roomId} · ${propertyId}`,
              );
              setActiveBottomPanel('references');
            }}
            anchor="room.properties"
          />
        ) : null}

        {activeCategory === 'hotspots' ? (
          <div className="space-y-4">
            <FeatureAuthoringPanel
              project={project}
              features={data.features}
              anchorPrefix="room"
              propertyMode="value"
              onChange={(features, label) => commit({ ...data, features }, label)}
            />
            <HotspotAuthoringPanel
              anchorPrefix="room"
              project={project}
              projectFilePath={projectFilePath}
              title={t('hotspots.roomTitle')}
              assetId={data.background.asset?.$ref.id ?? null}
              hotspots={data.hotspots}
              selectedView={hotspotView}
              ownerKind="room"
              ownerId={roomId}
              materialProperties={roomMaterialProperties}
              localFeatures={data.features}
              exits={data.exits.map((exit) => ({ id: exit.id, label: exit.id }))}
              onViewChange={setHotspotView}
              onDelete={(hotspotId) =>
                executeHotspot(
                  'room.deleteHotspot',
                  t('roomEditor.compositionPane.editor.deleteRoomHotspot'),
                  { hotspotId },
                )
              }
              onRename={renameRoomHotspot}
              onUpdate={(hotspotId, hotspot) =>
                executeHotspot(
                  'room.updateHotspot',
                  t('roomEditor.compositionPane.editor.updateRoomHotspot'),
                  { hotspotId, hotspot },
                )
              }
              onEditGeometry={(selectedHotspotId) => beginRoomHotspotFocus(selectedHotspotId)}
            />
          </div>
        ) : null}

        {activeCategory === 'navigation' ? (
          <section
            className="overflow-hidden rounded-lg border bg-card/30"
            data-workbench-anchor="room.exits"
          >
            <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
              <div className="flex min-w-0 items-baseline gap-2">
                <h3 className="shrink-0 text-sm font-semibold">Exits</h3>
                {exitDestinationItems.length > 0 ? (
                  <div className="flex min-w-0 items-baseline gap-1 truncate text-xs text-muted-foreground">
                    <span aria-hidden="true">·</span>
                    {exitDestinationItems.map((destination, index) => (
                      <span key={`${destination.id}-${index}`} className="inline-flex min-w-0">
                        <button
                          type="button"
                          className="truncate text-left underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                          title={`Open ${destination.label}`}
                          onClick={() =>
                            openTab(buildRoomDetailTabForRecord(destination.id, destination.label))
                          }
                        >
                          {destination.label}
                        </button>
                        {index < exitDestinationItems.length - 1 ? <span>,</span> : null}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <Button
                size="sm"
                disabled={!nextExitDirection}
                onClick={() =>
                  nextExitDirection &&
                  commit(
                    {
                      ...data,
                      exits: [
                        ...data.exits,
                        {
                          id: nextId(
                            data.exits.map((exit) => exit.id),
                            'exit',
                          ),
                          label: 'Exit',
                          direction: nextExitDirection,
                          target: roomRoomRef(roomId),
                          condition: { kind: 'always' },
                          onRejected: [],
                          transition: null,
                        },
                      ],
                    },
                    'Add room exit',
                  )
                }
              >
                <Plus data-icon="inline-start" />
                Add exit
              </Button>
            </div>
            <div className="space-y-1.5 p-2">
              {data.exits.length === 0 ? (
                <div className="rounded-md border border-dashed px-3 py-5 text-center">
                  <ArrowRight className="mx-auto size-4 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-1.5 text-xs font-medium">No exits yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add an exit to connect this room to another room.
                  </p>
                </div>
              ) : null}
              {data.exits.map((exit) => {
                const targetRoom = rooms.find((room) => room.id === exit.target.$ref.id);
                const targetRecord = project.rooms[exit.target.$ref.id];
                const targetData =
                  exit.target.$ref.id === roomId
                    ? data
                    : targetRecord
                      ? parseRoomData(targetRecord.data)
                      : null;
                const returnDirection = oppositeExitDirection[exit.direction];
                const returnExits =
                  targetData?.exits.filter((candidate) => candidate.target.$ref.id === roomId) ??
                  [];
                const matchingReturnExit = returnExits.find(
                  (candidate) => candidate.direction === returnDirection,
                );
                const mismatchedReturnExit = returnExits.find(
                  (candidate) => candidate.direction !== returnDirection,
                );
                return (
                  <article
                    key={exit.id}
                    data-workbench-anchor={`room.exit.${exit.id}`}
                    className="overflow-hidden rounded-md border bg-background/80"
                  >
                    <div className="flex items-center gap-2 p-2">
                      <div className="shrink-0">
                        <RoomExitDirectionSelector
                          value={exit.direction}
                          disabledDirections={data.exits
                            .filter((candidate) => candidate.id !== exit.id)
                            .map((candidate) => candidate.direction)}
                          onValueChange={(direction) => replaceExit(exit.id, { direction })}
                        />
                      </div>
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="grid gap-6 @3xl:grid-cols-2 @7xl:grid-cols-3">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Label className="shrink-0 text-[11px]">Label</Label>
                            <Input
                              className="min-w-0 flex-1"
                              value={exit.label}
                              onChange={(event) =>
                                replaceExit(exit.id, { label: event.currentTarget.value })
                              }
                            />
                          </div>
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Label className="shrink-0 text-[11px]">Destination</Label>
                            <button
                              type="button"
                              aria-label={`Choose destination, currently ${
                                targetRoom?.label ?? exit.target.$ref.id
                              }`}
                              className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-background px-2 text-left text-xs transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                              onClick={() => setDestinationSelectorExitId(exit.id)}
                            >
                              <span className="min-w-0 flex-1 truncate font-medium">
                                {targetRoom?.label ?? exit.target.$ref.id}
                              </span>
                              <ChevronsUpDown
                                className="size-3.5 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                            </button>
                          </div>
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Label className="shrink-0 text-[11px]">Internal ID</Label>
                            <Input
                              className="min-w-0 flex-1 font-mono"
                              value={exit.id}
                              onChange={(event) =>
                                replaceExit(exit.id, { id: event.currentTarget.value })
                              }
                            />
                          </div>
                        </div>
                        {targetData && !matchingReturnExit ? (
                          <div className="flex flex-wrap items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-950 dark:text-amber-100">
                            <AlertTriangle
                              className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                              aria-hidden="true"
                            />
                            <p className="min-w-48 flex-1">
                              {mismatchedReturnExit
                                ? t('roomExits.mismatchedReturn', {
                                    actual: mismatchedReturnExit.direction,
                                    destination: targetRoom?.label ?? exit.target.$ref.id,
                                    expected: returnDirection,
                                    source: record.label || data.displayName || roomId,
                                  })
                                : t('roomExits.missingReturn', {
                                    destination: targetRoom?.label ?? exit.target.$ref.id,
                                    direction: returnDirection,
                                    source: record.label || data.displayName || roomId,
                                  })}
                            </p>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="border-amber-500/30 bg-background/80"
                              onClick={() => {
                                const targetRoomId = exit.target.$ref.id;
                                const nextTargetData = mismatchedReturnExit
                                  ? {
                                      ...targetData,
                                      exits: targetData.exits.map((candidate) =>
                                        candidate.id === mismatchedReturnExit.id
                                          ? { ...candidate, direction: returnDirection }
                                          : candidate,
                                      ),
                                    }
                                  : {
                                      ...targetData,
                                      exits: [
                                        ...targetData.exits,
                                        {
                                          id: nextId(
                                            targetData.exits.map((candidate) => candidate.id),
                                            'return-exit',
                                          ),
                                          label: `To ${record.label || data.displayName || roomId}`,
                                          direction: returnDirection,
                                          target: roomRoomRef(roomId),
                                          condition: { kind: 'always' as const },
                                          onRejected: [],
                                          transition: null,
                                        },
                                      ],
                                    };
                                useCommandStore.getState().executeCommand({
                                  type: 'room.replaceData',
                                  label: mismatchedReturnExit
                                    ? 'Correct reciprocal room exit direction'
                                    : 'Add reciprocal room exit',
                                  payload: {
                                    roomId: targetRoomId,
                                    data: nextTargetData,
                                  },
                                  originSaveUnitId: recordSaveUnitId('rooms', targetRoomId),
                                  persistencePolicy: 'manual-save',
                                });
                              }}
                            >
                              {mismatchedReturnExit
                                ? t('roomExits.fixReturn', { direction: returnDirection })
                                : t('roomExits.addReturn')}
                            </Button>
                          </div>
                        ) : null}
                        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded bg-muted/10 p-1.5">
                          <Label className="shrink-0 text-[11px]">Available when</Label>
                          <RecursiveConditionEditor
                            value={exit.condition}
                            project={project}
                            scope={{ currentRoom: true }}
                            compact
                            onChange={(condition) => replaceExit(exit.id, { condition })}
                          />
                        </div>
                        <details className="group rounded-md border bg-muted/10">
                          <summary className="cursor-pointer select-none px-2 py-1.5 text-[11px] font-medium marker:text-muted-foreground">
                            Transition{' '}
                            {exit.transition ? `· ${exit.transition.kind}` : '· Project default'}
                          </summary>
                          <div className="grid gap-2 border-t p-2 @3xl:grid-cols-3">
                            {exit.transition ? (
                              <>
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <Label className="shrink-0 text-[11px]">Style</Label>
                                  <Select
                                    items={[
                                      { value: 'cut', label: 'Cut' },
                                      { value: 'fade', label: 'Fade' },
                                      { value: 'dissolve', label: 'Dissolve' },
                                    ]}
                                    value={exit.transition.kind}
                                    onValueChange={(value) =>
                                      replaceExit(exit.id, {
                                        transition: {
                                          ...exit.transition!,
                                          kind: value as typeof exit.transition.kind,
                                        },
                                      })
                                    }
                                  >
                                    <SelectTrigger size="sm" aria-label="Transition style">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="cut">Cut</SelectItem>
                                      <SelectItem value="fade">Fade</SelectItem>
                                      <SelectItem value="dissolve">Dissolve</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <Label className="shrink-0 text-[11px]">Duration (ms)</Label>
                                  <Input
                                    className="min-w-0 flex-1"
                                    value={String(exit.transition.durationMs)}
                                    onChange={(event) =>
                                      replaceExit(exit.id, {
                                        transition: {
                                          ...exit.transition!,
                                          durationMs: numberValue(
                                            event.currentTarget.value,
                                            exit.transition!.durationMs,
                                          ),
                                        },
                                      })
                                    }
                                  />
                                </div>
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <Label className="shrink-0 text-[11px]">Fade color</Label>
                                  <Input
                                    className="min-w-0 flex-1"
                                    placeholder="Project default"
                                    value={exit.transition.color ?? ''}
                                    onChange={(event) =>
                                      replaceExit(exit.id, {
                                        transition: {
                                          ...exit.transition!,
                                          color: event.currentTarget.value || null,
                                        },
                                      })
                                    }
                                  />
                                </div>
                              </>
                            ) : (
                              <p className="self-center text-xs text-muted-foreground @3xl:col-span-2">
                                This exit uses the project transition settings.
                              </p>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              className="justify-self-start @3xl:col-start-3 @3xl:justify-self-end"
                              onClick={() =>
                                replaceExit(exit.id, {
                                  transition: exit.transition
                                    ? null
                                    : {
                                        kind: 'fade',
                                        durationMs: 250,
                                        color: null,
                                        skippable: true,
                                      },
                                })
                              }
                            >
                              {exit.transition ? 'Use project default' : 'Override transition'}
                            </Button>
                          </div>
                        </details>
                      </div>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${exit.label || exit.id}`}
                        title="Delete exit"
                        className="shrink-0 self-center"
                        onClick={() =>
                          commit(
                            { ...data, exits: data.exits.filter((item) => item.id !== exit.id) },
                            'Delete room exit',
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {activeCategory === 'camera' ? (
          <div className="space-y-3" data-workbench-anchor="room.camera">
            <section className="space-y-2.5">
              <EditorSectionHeading
                title="World Presentation Space"
                help="Logical world framing is independent of display resolution. Contain clamps the Camera View to authored bounds; Overscan allows framing outside them."
                helpLabel="About World Presentation Space"
              />
              <div className="grid gap-2.5 @3xl:grid-cols-3">
                <div className="space-y-1">
                  <Label>Width</Label>
                  <Input
                    type="number"
                    min={1}
                    value={data.presentationSpace.size.width}
                    onChange={(event) =>
                      commit(
                        {
                          ...data,
                          presentationSpace: {
                            ...data.presentationSpace,
                            size: {
                              ...data.presentationSpace.size,
                              width: Math.max(
                                1,
                                numberValue(
                                  event.currentTarget.value,
                                  data.presentationSpace.size.width,
                                ),
                              ),
                            },
                          },
                        },
                        'Update presentation space width',
                      )
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Height</Label>
                  <Input
                    type="number"
                    min={1}
                    value={data.presentationSpace.size.height}
                    onChange={(event) =>
                      commit(
                        {
                          ...data,
                          presentationSpace: {
                            ...data.presentationSpace,
                            size: {
                              ...data.presentationSpace.size,
                              height: Math.max(
                                1,
                                numberValue(
                                  event.currentTarget.value,
                                  data.presentationSpace.size.height,
                                ),
                              ),
                            },
                          },
                        },
                        'Update presentation space height',
                      )
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Edge policy</Label>
                  <Select
                    items={[
                      { value: 'contain', label: 'Contain' },
                      { value: 'overscan', label: 'Overscan' },
                    ]}
                    value={data.presentationSpace.edgePolicy}
                    onValueChange={(edgePolicy) => {
                      if (!edgePolicy) return;
                      commit(
                        {
                          ...data,
                          presentationSpace: {
                            ...data.presentationSpace,
                            edgePolicy: edgePolicy as 'contain' | 'overscan',
                          },
                        },
                        'Update camera edge policy',
                      );
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="contain">Contain</SelectItem>
                      <SelectItem value="overscan">Overscan</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-1.5">
                  <Label>Camera bounds</Label>
                  <EditorHelpIcon label="About Camera bounds">
                    Optional world-space rectangle used by the Contain policy.
                  </EditorHelpIcon>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    commit(
                      {
                        ...data,
                        presentationSpace: {
                          ...data.presentationSpace,
                          bounds: data.presentationSpace.bounds
                            ? null
                            : {
                                x: 0,
                                y: 0,
                                width: data.presentationSpace.size.width,
                                height: data.presentationSpace.size.height,
                              },
                        },
                      },
                      data.presentationSpace.bounds ? 'Remove camera bounds' : 'Add camera bounds',
                    )
                  }
                >
                  {data.presentationSpace.bounds ? 'Remove bounds' : 'Add bounds'}
                </Button>
              </div>
              {data.presentationSpace.bounds ? (
                <div className="grid gap-2.5 @3xl:grid-cols-4">
                  {(['x', 'y', 'width', 'height'] as const).map((field) => (
                    <div key={field} className="space-y-1">
                      <Label>{field[0]!.toUpperCase() + field.slice(1)}</Label>
                      <Input
                        type="number"
                        min={field === 'width' || field === 'height' ? 1 : undefined}
                        value={data.presentationSpace.bounds![field]}
                        onChange={(event) => {
                          const bounds = data.presentationSpace.bounds;
                          if (!bounds) return;
                          const raw = numberValue(event.currentTarget.value, bounds[field]);
                          const value =
                            field === 'width' || field === 'height' ? Math.max(1, raw) : raw;
                          commit(
                            {
                              ...data,
                              presentationSpace: {
                                ...data.presentationSpace,
                                bounds: { ...bounds, [field]: value },
                              },
                            },
                            'Update camera bounds',
                          );
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </section>

            <section className="space-y-2.5">
              <EditorSectionHeading
                title="Default Camera View"
                help="Reconstructible framing used when no higher-precedence View is active."
                helpLabel="About Default Camera View"
              />
              <div className="grid gap-2.5 @3xl:grid-cols-4">
                {(['x', 'y'] as const).map((axis) => (
                  <div key={axis} className="space-y-1">
                    <Label>Center {axis.toUpperCase()}</Label>
                    <Input
                      type="number"
                      value={data.presentationSpace.defaultView.center[axis]}
                      onChange={(event) =>
                        commit(
                          {
                            ...data,
                            presentationSpace: {
                              ...data.presentationSpace,
                              defaultView: {
                                ...data.presentationSpace.defaultView,
                                center: {
                                  ...data.presentationSpace.defaultView.center,
                                  [axis]: numberValue(
                                    event.currentTarget.value,
                                    data.presentationSpace.defaultView.center[axis],
                                  ),
                                },
                              },
                            },
                          },
                          'Update default Camera View',
                        )
                      }
                    />
                  </div>
                ))}
                <div className="space-y-1.5">
                  <Label>Zoom</Label>
                  <Input
                    type="number"
                    min={0.001}
                    step={0.05}
                    value={data.presentationSpace.defaultView.zoom}
                    onChange={(event) =>
                      commit(
                        {
                          ...data,
                          presentationSpace: {
                            ...data.presentationSpace,
                            defaultView: {
                              ...data.presentationSpace.defaultView,
                              zoom: Math.max(
                                0.001,
                                numberValue(
                                  event.currentTarget.value,
                                  data.presentationSpace.defaultView.zoom,
                                ),
                              ),
                            },
                          },
                        },
                        'Update default Camera View zoom',
                      )
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Rotation</Label>
                  <Input
                    type="number"
                    value={data.presentationSpace.defaultView.rotationDegrees}
                    onChange={(event) =>
                      commit(
                        {
                          ...data,
                          presentationSpace: {
                            ...data.presentationSpace,
                            defaultView: {
                              ...data.presentationSpace.defaultView,
                              rotationDegrees: numberValue(
                                event.currentTarget.value,
                                data.presentationSpace.defaultView.rotationDegrees,
                              ),
                            },
                          },
                        },
                        'Update default Camera View rotation',
                      )
                    }
                  />
                </div>
              </div>
            </section>

            <CollectionMasterDetail
              title="Named Camera Views"
              description="Reusable logical framing targets for presentation operations."
              items={data.presentationSpace.views}
              getKey={(_, index) => String(index)}
              selectedKey={activeCameraViewIndex >= 0 ? String(activeCameraViewIndex) : null}
              onSelectedKeyChange={(_, __, index) => setSelectedCameraViewIndex(index)}
              listAriaLabel="Named Camera Views"
              emptyState="No named Camera Views."
              listAction={{
                label: 'Add View',
                icon: <Plus className="size-3.5" aria-hidden="true" />,
                onClick: () => {
                  setSelectedCameraViewIndex(data.presentationSpace.views.length);
                  commit(
                    {
                      ...data,
                      presentationSpace: {
                        ...data.presentationSpace,
                        views: [
                          ...data.presentationSpace.views,
                          {
                            id: nextId(
                              data.presentationSpace.views.map((view) => view.id),
                              'view',
                            ),
                            view: {
                              center: { ...data.presentationSpace.defaultView.center },
                              zoom: data.presentationSpace.defaultView.zoom,
                              rotationDegrees: data.presentationSpace.defaultView.rotationDegrees,
                            },
                          },
                        ],
                      },
                    },
                    'Add Camera View',
                  );
                },
              }}
              getDeleteLabel={(entry) => `Delete Camera View ${entry.id}`}
              onDeleteItem={(_, index) => {
                const nextViews = data.presentationSpace.views.filter(
                  (_, viewIndex) => viewIndex !== index,
                );
                setSelectedCameraViewIndex(Math.max(0, Math.min(index, nextViews.length - 1)));
                commit(
                  {
                    ...data,
                    presentationSpace: {
                      ...data.presentationSpace,
                      views: nextViews,
                    },
                  },
                  'Delete Camera View',
                );
              }}
              getItemPresentation={(entry) => ({
                label: entry.id,
                trailing: `${entry.view.zoom}×`,
              })}
              renderDetail={renderCameraViewDetail}
            />

            <CollectionMasterDetail
              anchor="room.anchors"
              title="Anchors"
              description="Stable authored regions that Focus captures without live tracking."
              items={data.anchors}
              getKey={(_, index) => String(index)}
              selectedKey={activeAnchorIndex >= 0 ? String(activeAnchorIndex) : null}
              onSelectedKeyChange={(_, __, index) => setSelectedAnchorIndex(index)}
              listAriaLabel="Anchors"
              emptyState="No anchors."
              listAction={{
                label: 'Add Anchor',
                icon: <Plus className="size-3.5" aria-hidden="true" />,
                onClick: () => {
                  setSelectedAnchorIndex(data.anchors.length);
                  commit(
                    {
                      ...data,
                      anchors: [
                        ...data.anchors,
                        {
                          id: nextId(
                            data.anchors.map((anchor) => anchor.id),
                            'anchor',
                          ),
                          bounds: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
                        },
                      ],
                    },
                    'Add Room Anchor',
                  );
                },
              }}
              getDeleteLabel={(anchor) => `Delete Room Anchor ${anchor.id}`}
              onDeleteItem={(_, index) => {
                const nextAnchors = data.anchors.filter((_, anchorIndex) => anchorIndex !== index);
                setSelectedAnchorIndex(Math.max(0, Math.min(index, nextAnchors.length - 1)));
                commit({ ...data, anchors: nextAnchors }, 'Delete Room Anchor');
              }}
              getItemPresentation={(anchor) => ({
                label: anchor.id,
                trailing: `${anchor.bounds.width}×${anchor.bounds.height}`,
              })}
              renderDetail={renderAnchorDetail}
            />
          </div>
        ) : null}

        {activeCategory === 'behavior' ? (
          <section
            className="space-y-4 rounded-xl border bg-card/20 p-4"
            data-workbench-anchor="room.lifecycle"
          >
            <h3 className="text-sm font-semibold">Lifecycle</h3>
            {(['canEnter', 'canLeave'] as const).map((hook) => (
              <div key={hook} className="space-y-1.5">
                <Label>{hook === 'canEnter' ? 'Can enter' : 'Can leave'}</Label>
                <RecursiveConditionEditor
                  value={data.lifecycle[hook]}
                  project={project}
                  scope={{ currentRoom: true }}
                  onChange={(next) =>
                    commit(
                      { ...data, lifecycle: { ...data.lifecycle, [hook]: next } },
                      `Update room ${hook}`,
                    )
                  }
                />
              </div>
            ))}
            {(
              [
                ['beforeEnter', 'Before enter'],
                ['afterEnter', 'After enter'],
                ['beforeLeave', 'Before leave'],
                ['afterLeave', 'After leave'],
                ['onEnterRejected', 'On enter rejected'],
                ['onLeaveRejected', 'On leave rejected'],
              ] as const
            ).map(([hook, label]) => (
              <div key={hook} className="space-y-1.5">
                <Label>{label}</Label>
                <GameplayCommandListEditor
                  value={data.lifecycle[hook]}
                  project={project}
                  policy={{
                    currentRoom: true,
                    playerInventory: true,
                    admittedKinds:
                      hook === 'beforeEnter' || hook === 'beforeLeave'
                        ? roomPrecommitGameplayCommandKinds
                        : undefined,
                  }}
                  onChange={(next) =>
                    commit(
                      { ...data, lifecycle: { ...data.lifecycle, [hook]: next } },
                      `Update room ${hook}`,
                    )
                  }
                />
              </div>
            ))}
          </section>
        ) : null}
        {activeCategory === 'composition' ? (
          <div
            className={
              presentationMode === 'preview'
                ? 'pointer-events-none select-none opacity-50'
                : undefined
            }
            aria-disabled={presentationMode === 'preview'}
            inert={presentationMode === 'preview' || undefined}
          >
            <section
              className="space-y-3 rounded-xl border bg-card/20 p-4"
              data-workbench-anchor="room.composition"
            >
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 p-2">
                <Label className="text-xs">
                  {t('roomEditor.compositionPane.editor.fallbackInteractablePlacement')}
                </Label>
                <Select
                  items={data.placements.map((placement) => ({
                    value: placement.id,
                    label: placement.id,
                  }))}
                  placeholderItem={t(
                    'roomEditor.compositionPane.editor.noFallbackInteractablePlacement',
                  )}
                  value={data.fallbackInteractablePlacementId}
                  onValueChange={(placementId) =>
                    useCommandStore.getState().executeCommand({
                      type: 'room.setFallbackInteractablePlacement',
                      label: t(
                        'roomEditor.compositionPane.editor.setFallbackInteractablePlacement',
                      ),
                      payload: { roomId, placementId },
                      originSaveUnitId: recordSaveUnitId('rooms', roomId),
                      persistencePolicy: 'manual-save',
                    })
                  }
                >
                  <SelectTrigger className="h-8 w-56">
                    <SelectValue
                      placeholder={t(
                        'roomEditor.compositionPane.editor.noFallbackInteractablePlacement',
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {data.placements.map((placement) => (
                      <SelectItem key={placement.id} value={placement.id}>
                        {placement.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <RoomCompositionPane
                project={project}
                room={data}
                selection={roomSelection}
                disabled={presentationMode === 'preview'}
                expandedSelectionKeys={expandedRoomSelectionKeys}
                onExpandedSelectionKeysChange={(keys) =>
                  setExpandedRoomSelectionKeys(new Set(keys))
                }
                onSelectionChange={(nextSelection) => setRoomSelection([...nextSelection])}
                renderInspector={renderRoomSelectionInspector}
                addActions={roomAddActions}
                onBeginAdd={(actionId) => beginRoomAdd(actionId, { kind: 'drop' })}
                onAddToPlacement={(actionId, placementId) =>
                  beginRoomAdd(actionId, { kind: 'placement', placementId })
                }
                onDeleteSelection={deleteCurrentRoomSelection}
                bulkStackingActions={
                  bulkPresentationTargets
                    ? [
                        {
                          action: 'backward',
                          label: t('roomEditor.compositionPane.sendBackward'),
                        },
                        {
                          action: 'forward',
                          label: t('roomEditor.compositionPane.bringForward'),
                        },
                        { action: 'back', label: t('roomEditor.compositionPane.sendToBack') },
                        { action: 'front', label: t('roomEditor.compositionPane.bringToFront') },
                      ]
                    : undefined
                }
                onBulkStackingAction={reorderBulkPresentation}
                onEditHotspots={() => beginRoomHotspotFocus(null)}
              />
            </section>
          </div>
        ) : null}
        {activeCategory === 'contents' ? (
          <>
            <CollectionMasterDetail
              anchor="room.overlays"
              title="Overlays"
              description="Layout mounts rendered over the Room presentation. Use these for Room-local UI and other RmlUi presentation layers."
              items={data.overlays}
              getKey={(_, index) => String(index)}
              selectedKey={
                data.overlays.length > 0
                  ? String(Math.min(selectedOverlayIndex, data.overlays.length - 1))
                  : null
              }
              onSelectedKeyChange={(_, __, index) => setSelectedOverlayIndex(index)}
              listAriaLabel="Room overlays"
              emptyState="No overlays."
              listAction={{
                label: 'Add overlay',
                icon: <Plus className="size-3.5" aria-hidden="true" />,
                disabled: layouts.length === 0,
                onClick: () =>
                  setContentEntitySelector({ kind: 'new-overlay-layout', id: 'new-overlay' }),
              }}
              getDeleteLabel={(overlay) => `Delete overlay ${overlay.id}`}
              onDeleteItem={(_, index) => {
                const nextOverlays = data.overlays.filter(
                  (_, overlayIndex) => overlayIndex !== index,
                );
                setSelectedOverlayIndex(Math.max(0, Math.min(index, nextOverlays.length - 1)));
                commit({ ...data, overlays: nextOverlays }, 'Delete room overlay');
              }}
              getItemPresentation={(overlay) => ({
                label: overlay.id,
                trailing: overlay.visible ? 'Visible' : 'Hidden',
              })}
              renderDetail={(overlay) => (
                <div className="grid gap-3 rounded-lg border bg-background/60 p-3 @3xl:grid-cols-3">
                  <div className="space-y-1">
                    <Label>ID</Label>
                    <Input
                      value={overlay.id}
                      onChange={(event) =>
                        replaceOverlay(overlay.id, { id: event.currentTarget.value })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Layout</Label>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-start font-normal"
                      onClick={() =>
                        setContentEntitySelector({ kind: 'overlay-layout', id: overlay.id })
                      }
                    >
                      {layouts.find((layout) => layout.id === overlay.layout.$ref.id)?.label ??
                        overlay.layout.$ref.id}
                    </Button>
                  </div>
                  <label className="flex items-end gap-2 pb-2">
                    <input
                      type="checkbox"
                      checked={overlay.visible}
                      onChange={(event) =>
                        replaceOverlay(overlay.id, { visible: event.currentTarget.checked })
                      }
                    />
                    Visible
                  </label>
                </div>
              )}
            />
            <CollectionMasterDetail
              anchor="room.cast"
              title="Room cast"
              description="Decorative Room-local Character occurrences. They affect presentation only and do not move or mutate persistent Character world state."
              items={data.cast}
              getKey={(_, index) => String(index)}
              selectedKey={
                data.cast.length > 0
                  ? String(Math.min(selectedCastIndex, data.cast.length - 1))
                  : null
              }
              onSelectedKeyChange={(_, __, index) => setSelectedCastIndex(index)}
              listAriaLabel="Room cast"
              emptyState="No cast entries."
              listAction={{
                label: 'Add cast',
                icon: <Plus className="size-3.5" aria-hidden="true" />,
                disabled: characterSelectorItems.length === 0,
                onClick: () => {
                  setSelectedCastIndex(data.cast.length);
                  beginRoomAdd('cast', { kind: 'point', point: { x: 0.5, y: 0.5 } });
                },
              }}
              getDeleteLabel={(entry) => `Delete cast entry ${entry.id}`}
              onDeleteItem={(_, index) => {
                const nextCast = data.cast.filter((_, castIndex) => castIndex !== index);
                setSelectedCastIndex(Math.max(0, Math.min(index, nextCast.length - 1)));
                commit({ ...data, cast: nextCast }, 'Delete room cast entry');
              }}
              getItemPresentation={(entry) => ({
                label: entry.id,
                secondary:
                  characters.find((character) => character.id === entry.character.$ref.id)?.label ??
                  entry.character.$ref.id,
                trailing: entry.visible ? 'Visible' : 'Hidden',
              })}
              renderDetail={(entry) => (
                <div className="grid gap-3 rounded-lg border bg-background/60 p-3 @3xl:grid-cols-4">
                  <div className="space-y-1">
                    <Label>ID</Label>
                    <Input
                      value={entry.id}
                      onChange={(event) => replaceCast(entry.id, { id: event.currentTarget.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Character</Label>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-start font-normal"
                      onClick={() =>
                        setContentEntitySelector({ kind: 'cast-character', id: entry.id })
                      }
                    >
                      {characters.find((item) => item.id === entry.character.$ref.id)?.label ??
                        entry.character.$ref.id}
                    </Button>
                  </div>
                  <div className="space-y-1">
                    <Label>Placement</Label>
                    <Select
                      items={data.placements.map((item) => ({ value: item.id, label: item.id }))}
                      value={entry.placementId}
                      onValueChange={(value) =>
                        replaceCast(entry.id, { placementId: String(value) })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {data.placements.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="flex items-end gap-2 pb-2">
                    <input
                      type="checkbox"
                      checked={entry.visible}
                      onChange={(event) =>
                        replaceCast(entry.id, { visible: event.currentTarget.checked })
                      }
                    />
                    Visible
                  </label>
                  <div className="space-y-1">
                    <Label>Pose ID</Label>
                    <Input
                      value={entry.poseId ?? ''}
                      onChange={(event) =>
                        replaceCast(entry.id, { poseId: event.currentTarget.value || null })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Expression ID</Label>
                    <Input
                      value={entry.expressionId ?? ''}
                      onChange={(event) =>
                        replaceCast(entry.id, { expressionId: event.currentTarget.value || null })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Idle ID</Label>
                    <Input
                      value={entry.idleId ?? ''}
                      onChange={(event) =>
                        replaceCast(entry.id, { idleId: event.currentTarget.value || null })
                      }
                    />
                  </div>
                  <div className="@3xl:col-span-4">
                    <RecursiveConditionEditor
                      value={entry.condition}
                      project={project}
                      scope={{ currentRoom: true }}
                      onChange={(condition) => replaceCast(entry.id, { condition })}
                    />
                  </div>
                </div>
              )}
            />
            <CollectionMasterDetail
              anchor="room.props"
              title="Props"
              description="Decorative, non-interactive Room visuals placed at authored placements. Use an Interactable instead when the object needs gameplay identity or interactions."
              items={data.props}
              getKey={(_, index) => String(index)}
              selectedKey={
                data.props.length > 0
                  ? String(Math.min(selectedPropIndex, data.props.length - 1))
                  : null
              }
              onSelectedKeyChange={(_, __, index) => setSelectedPropIndex(index)}
              listAriaLabel="Room props"
              emptyState="No props."
              listAction={{
                label: 'Add prop',
                icon: <Plus className="size-3.5" aria-hidden="true" />,
                disabled: imageAssetItems.length === 0 && materialSelectorItems.length === 0,
                onClick: () => {
                  setSelectedPropIndex(data.props.length);
                  beginRoomAdd('prop', { kind: 'point', point: { x: 0.5, y: 0.5 } });
                },
              }}
              getDeleteLabel={(entry) => `Delete prop ${entry.id}`}
              onDeleteItem={(_, index) => {
                const nextProps = data.props.filter((_, propIndex) => propIndex !== index);
                setSelectedPropIndex(Math.max(0, Math.min(index, nextProps.length - 1)));
                commit({ ...data, props: nextProps }, 'Delete room prop');
              }}
              getItemPresentation={(entry) => ({
                label: entry.id,
                secondary: entry.placementId,
              })}
              renderDetail={(entry) => (
                <div className="grid gap-3 rounded-lg border bg-background/60 p-3 @3xl:grid-cols-4">
                  <div className="space-y-1">
                    <Label>ID</Label>
                    <Input
                      value={entry.id}
                      onChange={(event) => replaceProp(entry.id, { id: event.currentTarget.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Placement</Label>
                    <Select
                      items={data.placements.map((item) => ({ value: item.id, label: item.id }))}
                      value={entry.placementId}
                      onValueChange={(value) =>
                        replaceProp(entry.id, { placementId: String(value) })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {data.placements.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Asset</Label>
                    <div className="flex overflow-hidden rounded-md border bg-background">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-7 min-w-0 flex-1 justify-start rounded-none px-2 text-left font-normal"
                        onClick={() =>
                          setContentEntitySelector({ kind: 'prop-asset', id: entry.id })
                        }
                      >
                        {assets.find((item) => item.id === entry.asset?.$ref.id)?.label ??
                          'Choose asset'}
                      </Button>
                      {entry.asset ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-7 rounded-none border-l px-2"
                          onClick={() => replaceProp(entry.id, { asset: null })}
                        >
                          Clear
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="space-y-1 @3xl:col-span-4">
                    <Label>Material</Label>
                    <MaterialApplicationEditor
                      project={project}
                      value={entry.materialApplication}
                      expectedRole="engine-2d"
                      properties={roomMaterialProperties}
                      ariaLabel={t('roomEditor.compositionPane.editor.propMaterialAriaLabel', {
                        id: entry.id,
                      })}
                      overrideLabel={t('roomEditor.compositionPane.editor.propOverride')}
                      onChange={(materialApplication) =>
                        replaceProp(entry.id, { materialApplication })
                      }
                    />
                  </div>
                  <div className="@3xl:col-span-4">
                    <RecursiveConditionEditor
                      value={entry.condition}
                      project={project}
                      scope={{ currentRoom: true }}
                      onChange={(condition) => replaceProp(entry.id, { condition })}
                    />
                  </div>
                </div>
              )}
            />
            <CollectionMasterDetail
              anchor="room.environments"
              title="Environment Layers"
              description="Independent Room visual layers with their own bounds, material, opacity, presentation plane, clock, and UV scrolling. Use them for persistent effects such as fog, rain, water, or moving backgrounds."
              items={data.environments}
              getKey={(_, index) => String(index)}
              selectedKey={
                data.environments.length > 0
                  ? String(Math.min(selectedEnvironmentIndex, data.environments.length - 1))
                  : null
              }
              onSelectedKeyChange={(_, __, index) => setSelectedEnvironmentIndex(index)}
              listAriaLabel="Environment layers"
              emptyState="No environment layers."
              listAction={{
                label: 'Add environment',
                icon: <Plus className="size-3.5" aria-hidden="true" />,
                disabled: materialSelectorItems.length === 0,
                onClick: () => {
                  setSelectedEnvironmentIndex(data.environments.length);
                  beginRoomAdd('environment', {
                    kind: 'point',
                    point: { x: 0.5, y: 0.5 },
                  });
                },
              }}
              getDeleteLabel={(entry) => `Delete environment ${entry.id}`}
              onDeleteItem={(_, index) => {
                const nextEnvironments = data.environments.filter(
                  (_, environmentIndex) => environmentIndex !== index,
                );
                setSelectedEnvironmentIndex(
                  Math.max(0, Math.min(index, nextEnvironments.length - 1)),
                );
                commit({ ...data, environments: nextEnvironments }, 'Delete room environment');
              }}
              getItemPresentation={(entry) => ({
                label: entry.id,
                secondary: entry.plane,
                trailing: `${Math.round(entry.opacity * 100)}%`,
              })}
              renderDetail={(entry) => (
                <div className="grid gap-3 rounded-lg border bg-background/60 p-3 @3xl:grid-cols-4">
                  <div className="space-y-1">
                    <Label>ID</Label>
                    <Input
                      value={entry.id}
                      onChange={(event) =>
                        replaceEnvironment(entry.id, { id: event.currentTarget.value })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Asset</Label>
                    <div className="flex overflow-hidden rounded-md border bg-background">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-7 min-w-0 flex-1 justify-start rounded-none px-2 text-left font-normal"
                        onClick={() =>
                          setContentEntitySelector({ kind: 'environment-asset', id: entry.id })
                        }
                      >
                        {assets.find((item) => item.id === entry.asset?.$ref.id)?.label ??
                          'Choose asset'}
                      </Button>
                      {entry.asset ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-7 rounded-none border-l px-2"
                          onClick={() => replaceEnvironment(entry.id, { asset: null })}
                        >
                          Clear
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="space-y-1 @3xl:col-span-4">
                    <Label>Material</Label>
                    <MaterialApplicationEditor
                      project={project}
                      value={entry.materialApplication}
                      expectedRole="engine-2d"
                      properties={roomMaterialProperties}
                      ariaLabel={t(
                        'roomEditor.compositionPane.editor.environmentMaterialAriaLabel',
                        { id: entry.id },
                      )}
                      overrideLabel={t('roomEditor.compositionPane.editor.environmentOverride')}
                      allowClear={false}
                      onChange={(materialApplication) => {
                        if (materialApplication)
                          replaceEnvironment(entry.id, { materialApplication });
                      }}
                    />
                  </div>
                  <label className="flex items-end gap-2 pb-2">
                    <input
                      type="checkbox"
                      checked={entry.visible}
                      onChange={(event) =>
                        replaceEnvironment(entry.id, { visible: event.currentTarget.checked })
                      }
                    />
                    Visible
                  </label>
                  <div className="space-y-1">
                    <Label>Plane</Label>
                    <Select
                      items={roomEnvironmentPlaneValues.map((plane) => ({
                        value: plane,
                        label: plane,
                      }))}
                      value={entry.plane}
                      onValueChange={(value) => {
                        const plane = value as RoomEnvironmentData['plane'];
                        if (plane === entry.plane) return;
                        const allocated = allocateRoomPresentationOrder(data, plane);
                        commit(
                          {
                            ...allocated.room,
                            environments: allocated.room.environments.map((environment) =>
                              environment.id === entry.id
                                ? { ...environment, plane, order: allocated.order }
                                : environment,
                            ),
                          },
                          'Update room environment plane',
                        );
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {roomEnvironmentPlaneValues.map((plane) => (
                          <SelectItem key={plane} value={plane}>
                            {plane}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Clock</Label>
                    <Select
                      items={roomEnvironmentClockValues.map((clock) => ({
                        value: clock,
                        label: clock,
                      }))}
                      value={entry.clock}
                      onValueChange={(value) =>
                        replaceEnvironment(entry.id, {
                          clock: value as RoomEnvironmentData['clock'],
                        })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {roomEnvironmentClockValues.map((clock) => (
                          <SelectItem key={clock} value={clock}>
                            {clock}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Order</Label>
                    <Input
                      value={String(entry.order)}
                      onChange={(event) => {
                        const order = Math.round(
                          numberValue(event.currentTarget.value, entry.order),
                        );
                        if (order === entry.order) return;
                        executeRoomEditCommand(
                          'room.setPresentationOrder',
                          t('roomEditor.compositionPane.setOrder'),
                          { target: { kind: 'environment', id: entry.id }, order },
                        );
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Opacity</Label>
                    <Input
                      value={String(entry.opacity)}
                      onChange={(event) =>
                        replaceEnvironment(entry.id, {
                          opacity: Math.min(
                            1,
                            Math.max(0, numberValue(event.currentTarget.value, entry.opacity)),
                          ),
                        })
                      }
                    />
                  </div>
                  {(['x', 'y', 'width', 'height'] as const).map((field) => (
                    <div key={field} className="space-y-1">
                      <Label>Bounds {field}</Label>
                      <Input
                        value={String(entry.bounds[field])}
                        onChange={(event) =>
                          replaceEnvironment(entry.id, {
                            bounds: {
                              ...entry.bounds,
                              [field]: numberValue(event.currentTarget.value, entry.bounds[field]),
                            },
                          })
                        }
                      />
                    </div>
                  ))}
                  <div className="space-y-1">
                    <Label>Scroll X / sec</Label>
                    <Input
                      value={String(entry.scrollPerSecond.x)}
                      onChange={(event) =>
                        replaceEnvironment(entry.id, {
                          scrollPerSecond: {
                            ...entry.scrollPerSecond,
                            x: numberValue(event.currentTarget.value, entry.scrollPerSecond.x),
                          },
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Scroll Y / sec</Label>
                    <Input
                      value={String(entry.scrollPerSecond.y)}
                      onChange={(event) =>
                        replaceEnvironment(entry.id, {
                          scrollPerSecond: {
                            ...entry.scrollPerSecond,
                            y: numberValue(event.currentTarget.value, entry.scrollPerSecond.y),
                          },
                        })
                      }
                    />
                  </div>
                  <div className="@3xl:col-span-4">
                    <RecursiveConditionEditor
                      value={entry.condition}
                      project={project}
                      scope={{ currentRoom: true }}
                      onChange={(condition) => replaceEnvironment(entry.id, { condition })}
                    />
                  </div>
                </div>
              )}
            />
          </>
        ) : null}
        {activeCategory === 'behavior' ? (
          <section
            className="space-y-4 rounded-xl border bg-card/20 p-4"
            data-workbench-anchor="room.script-hooks"
          >
            <div>
              <h3 className="text-sm font-semibold">Script hook mappings</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Optional exact Room mappings compiled into the frozen Hook Registry. Bootstrap may
                add qualified-prefix and catchall mappings.
              </p>
            </div>
            <div className="space-y-3">
              {roomScriptHookKindValues.map((hook) => {
                const mapping = data.scriptHooks.find((item) => item.hook === hook);
                return (
                  <div key={hook} className="grid gap-2 rounded-lg border p-3 @3xl:grid-cols-3">
                    <div>
                      <Label>Hook</Label>
                      <div className="mt-2 font-mono text-xs">{hook}</div>
                    </div>
                    <div>
                      <Label>Script Module</Label>
                      <Select
                        value={mapping?.handler.module.$ref.id ?? '__none__'}
                        onValueChange={(value) => {
                          const remaining = data.scriptHooks.filter((item) => item.hook !== hook);
                          commit(
                            {
                              ...data,
                              scriptHooks:
                                value === '__none__'
                                  ? remaining
                                  : [
                                      ...remaining,
                                      {
                                        hook,
                                        handler: {
                                          module: {
                                            $ref: { collection: 'scripts', id: String(value) },
                                          },
                                          export:
                                            mapping?.handler.export || hook.replaceAll('-', '_'),
                                        },
                                      },
                                    ],
                            },
                            'Update room script hook mapping',
                          );
                        }}
                      >
                        <SelectItem value="__none__">No direct mapping</SelectItem>
                        {scripts.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label>Named export</Label>
                      <Input
                        value={mapping?.handler.export ?? ''}
                        disabled={!mapping}
                        placeholder={hook.replaceAll('-', '_')}
                        onChange={(event) => {
                          if (!mapping) return;
                          const exportName = event.currentTarget.value;
                          commit(
                            {
                              ...data,
                              scriptHooks: data.scriptHooks.map((item) =>
                                item.hook === hook
                                  ? {
                                      ...item,
                                      handler: { ...item.handler, export: exportName },
                                    }
                                  : item,
                              ),
                            },
                            'Update room script hook export',
                          );
                        }}
                      />
                    </div>
                    {hookRegistryAnalysis && roomId ? (
                      <HookRegistryResolutionInspector
                        analysis={hookRegistryAnalysis}
                        hook={hook}
                        target={roomId}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <SearchSelectorDialog
          open={roomAddRequest !== null}
          title={roomAddSelectorTitle}
          placeholder={t('roomEditor.compositionPane.editor.searchCompatibleContent')}
          emptyMessage={t('roomEditor.compositionPane.editor.noCompatibleContent')}
          items={roomAddSelectorItems}
          onOpenChange={(open) => {
            if (open) return;
            if (continueRoomAddSelectionRef.current) {
              continueRoomAddSelectionRef.current = false;
              return;
            }
            setRoomAddRequest(null);
          }}
          onSelect={selectRoomAddContent}
        />
        <SearchSelectorDialog
          open={contentEntitySelector !== null}
          title={contentEntitySelectorTitle}
          placeholder="Search project entities..."
          emptyMessage="No matching project entities."
          items={contentEntitySelectorItems}
          selectedId={contentEntitySelectorSelectedId}
          onOpenChange={(open) => {
            if (!open) setContentEntitySelector(null);
          }}
          onSelect={(item) => {
            if (!contentEntitySelector || !item.entityId) return;
            switch (contentEntitySelector.kind) {
              case 'overlay-layout':
                replaceOverlay(contentEntitySelector.id, { layout: roomLayoutRef(item.entityId) });
                break;
              case 'placement-layout': {
                const layoutId = item.entityId;
                const placement = data.placements.find(
                  (candidate) => candidate.id === contentEntitySelector.id,
                );
                if (!placement || !project.layouts[layoutId]) return;
                if (placement.presentation.layout) {
                  replacePlacement(
                    placement.id,
                    {
                      presentation: {
                        ...placement.presentation,
                        layout: roomLayoutRef(layoutId),
                      },
                    },
                    t('roomEditor.compositionPane.editor.updatePlacementLayout'),
                  );
                  break;
                }
                const allocated = allocateRoomPresentationOrder(data, 'world-overlay');
                commit(
                  {
                    ...allocated.room,
                    placements: allocated.room.placements.map((candidate) =>
                      candidate.id === placement.id
                        ? {
                            ...candidate,
                            presentation: {
                              label: candidate.presentation.label,
                              layout: roomLayoutRef(layoutId),
                              layoutOrder: allocated.order,
                            },
                          }
                        : candidate,
                    ),
                  },
                  t('roomEditor.compositionPane.editor.attachPlacementLayout'),
                );
                break;
              }
              case 'new-overlay-layout': {
                if (!project.layouts[item.entityId]) return;
                const allocated = allocateRoomPresentationOrder(data, 'world-overlay');
                const id = nextId(
                  allocated.room.overlays.map((overlay) => overlay.id),
                  'overlay',
                );
                setSelectedOverlayIndex(allocated.room.overlays.length);
                commit(
                  {
                    ...allocated.room,
                    overlays: [
                      ...allocated.room.overlays,
                      {
                        id,
                        layout: roomLayoutRef(item.entityId),
                        condition: { kind: 'always' },
                        visible: true,
                        order: allocated.order,
                      },
                    ],
                  },
                  'Add room overlay',
                );
                break;
              }
              case 'cast-character':
                replaceCast(contentEntitySelector.id, {
                  character: { $ref: { collection: 'characters', id: item.entityId } },
                });
                break;
              case 'prop-asset':
                replaceProp(contentEntitySelector.id, { asset: roomAssetRef(item.entityId) });
                break;
              case 'environment-asset':
                replaceEnvironment(contentEntitySelector.id, {
                  asset: roomAssetRef(item.entityId),
                });
                break;
            }
            setContentEntitySelector(null);
          }}
        />
        <SearchSelectorDialog
          open={backgroundSelectorOpen}
          title={t('selectors.backgroundImage.title')}
          placeholder={t('selectors.backgroundImage.placeholder')}
          emptyMessage={t('selectors.backgroundImage.empty')}
          items={imageAssetItems}
          selectedId={selectedBackgroundItem?.id ?? null}
          leadingMediaSize={{ width: 80, height: 48 }}
          onOpenChange={setBackgroundSelectorOpen}
          onSelect={(item) => {
            if (!item.entityId) return;
            commit(
              {
                ...data,
                background: { ...data.background, asset: roomAssetRef(item.entityId) },
              },
              'Update room background',
            );
          }}
        />
        <SearchSelectorDialog
          open={destinationSelectorExitId !== null}
          title={t('selectors.roomDestination.title')}
          placeholder={t('selectors.roomDestination.placeholder')}
          emptyMessage={t('selectors.roomDestination.empty')}
          items={roomItems}
          selectedId={selectedDestinationItem?.id ?? null}
          onOpenChange={(open) => {
            if (!open) setDestinationSelectorExitId(null);
          }}
          onSelect={(item) => {
            if (!destinationSelectorExitId || !item.entityId) return;
            replaceExit(destinationSelectorExitId, { target: roomRoomRef(item.entityId) });
          }}
        />
        <Dialog
          open={pendingPlacementDeletion !== null}
          onOpenChange={(open) => {
            if (!open) setPendingPlacementDeletion(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('roomEditor.compositionPane.deletePlacementTitle')}</DialogTitle>
              <DialogDescription>
                {t('roomEditor.compositionPane.deletePlacementConfirmation')}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-64 space-y-3 overflow-auto rounded-md border bg-muted/20 p-2">
              {pendingPlacementDeletion?.placements.map(({ placementId, occupants }) => (
                <div key={placementId} className="space-y-1">
                  <div className="font-medium">
                    {t('roomEditor.compositionPane.deletePlacementHeading', { id: placementId })}
                  </div>
                  <ul className="space-y-0.5 pl-4 text-muted-foreground">
                    {occupants.map((occupant) => (
                      <li key={roomEditSelectionKey(occupant)} className="list-disc">
                        {describeRoomEditSelection(project, data, occupant, t)}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingPlacementDeletion(null)}>
                {t('roomEditor.compositionPane.deletePlacementCancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const pending = pendingPlacementDeletion;
                  if (!pending) return;
                  setPendingPlacementDeletion(null);
                  executeRoomSelectionDelete(pending.selection);
                }}
              >
                {t('roomEditor.compositionPane.deleteSelection')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CategorizedEditorLayout>
    </EditorPreviewSplit>
  );
}
