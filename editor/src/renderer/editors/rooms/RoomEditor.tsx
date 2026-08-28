import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GameplayArchetypeControls } from '@/components/GameplayArchetypeControls';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import { DerivedPreviewPane } from '@/preview/DerivedPreviewPane';
import { EditorPreviewSplit } from '@/components/editor-preview-split';
import { FeatureAuthoringPanel } from '@/components/features/FeatureAuthoringPanel';
import { HotspotAuthoringPanel } from '@/components/hotspots/HotspotAuthoringPanel';
import { RoomCompositionStage } from '@/components/room-composition-stage';
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
import { usePreferencesStore } from '@/stores/preferences-store';
import { AssetImageThumbnail } from '@/workspace/AssetImageThumbnail';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import {
  buildCommandPaletteItems,
  filterSelectorItems,
  type SelectorItem,
} from '@/workspace/command-palette-search';
import {
  defaultRoomData,
  parseRoomData,
  roomAssetRef,
  roomBackgroundFitValues,
  roomEnvironmentClockValues,
  roomEnvironmentPlaneValues,
  roomExitDirectionValues,
  roomLayoutRef,
  roomMaterialRef,
  roomRoomRef,
  roomScriptHookKindValues,
  type RoomCastData,
  type RoomData,
  type RoomEnvironmentData,
  type RoomExitData,
  type RoomNormalizedRect,
  type RoomOverlayData,
  type RoomPlacementData,
  type RoomPropData,
} from '../../../shared/project-schema/authoring-rooms';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../../../shared/project-schema/authoring-project-settings';
import {
  inlineTextContent,
  type Condition,
  type TextContent,
} from '../../../shared/project-schema/authoring-flow';
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
import { registerWorkbenchTargetHandler } from '@/workbench/workbench-navigation';
import { RoomExitDirectionSelector } from './RoomExitDirectionSelector';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { resolveGameplayInstanceRecord } from '../../../shared/project-schema/authoring-archetypes';
import { parseInteractableData } from '../../../shared/project-schema/authoring-interactables';

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
  | 'behavior';

const roomEditorCategories: readonly CategorizedEditorCategory<RoomEditorCategory>[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Room identity, description, and background presentation.',
    icon: Settings2,
  },
  {
    id: 'camera',
    label: 'Camera',
    description: 'Define the world presentation space, Camera Views, and reusable Anchors.',
    icon: Camera,
  },
  {
    id: 'composition',
    label: 'Composition',
    description: 'Place and arrange Interactable instances and reusable anchors.',
    icon: Boxes,
  },
  {
    id: 'hotspots',
    label: 'Hotspots',
    description: 'Define clickable regions on the Room background.',
    icon: MousePointerClick,
  },
  {
    id: 'navigation',
    label: 'Navigation',
    description: 'Connect this Room to other Rooms through exits.',
    icon: Waypoints,
  },
  {
    id: 'contents',
    label: 'Contents',
    description: 'Configure overlays, cast, props, and environmental layers.',
    icon: Layers3,
  },
  {
    id: 'behavior',
    label: 'Behavior',
    description: 'Configure Room guards and frozen Hook Registry mappings.',
    icon: Workflow,
  },
];

function isRoomEditorCategory(value: unknown): value is RoomEditorCategory {
  return roomEditorCategories.some((category) => category.id === value);
}

function roomEditorCategoryForTarget(targetId: string): RoomEditorCategory {
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
type RoomEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof ROOM_EDITOR_TAB_STATE_SCHEMA;
  payload: {
    scroll?: ScrollViewState;
    activeCategory: RoomEditorCategory;
    previewCollapsed: boolean;
    hotspotView: HotspotEditorViewState;
  };
};

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
  if (
    !isRoomEditorCategory(payload.activeCategory) ||
    typeof payload.previewCollapsed !== 'boolean' ||
    !hotspotView
  )
    return null;
  return {
    scroll: isScrollViewState(payload.scroll) ? payload.scroll : undefined,
    activeCategory: payload.activeCategory,
    previewCollapsed: payload.previewCollapsed,
    hotspotView,
  };
}
const refValue = (ref: { $ref: { id: string } } | null | undefined) => ref?.$ref.id ?? '__none__';
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

function ConditionEditor({
  condition,
  variables,
  onChange,
}: {
  condition: Condition;
  variables: string[];
  onChange: (next: Condition) => void;
}) {
  if (condition.kind === 'lua-predicate')
    return (
      <div className="space-y-2">
        <div className="flex gap-2">
          <Select value="lua-predicate" onValueChange={() => {}}>
            <SelectItem value="lua-predicate">Lua predicate</SelectItem>
            <SelectItem value="always">Always</SelectItem>
          </Select>
          <Input
            value={condition.source}
            onChange={(event) => onChange({ ...condition, source: event.currentTarget.value })}
          />
        </div>
        <LuaExplicitFallbackEditor
          value={condition.additionalDependencies}
          onChange={(additionalDependencies) => onChange({ ...condition, additionalDependencies })}
        />
      </div>
    );
  if (condition.kind === 'variable-comparison')
    return (
      <div className="grid gap-2 md:grid-cols-4">
        <Select
          value="variable-comparison"
          onValueChange={(value) => value === 'always' && onChange({ kind: 'always' })}
        >
          <SelectItem value="variable-comparison">Variable comparison</SelectItem>
          <SelectItem value="always">Always</SelectItem>
        </Select>
        <Select
          value={condition.variable.$ref.id}
          onValueChange={(value) =>
            onChange({
              ...condition,
              variable: { $ref: { collection: 'variables', id: String(value) } },
            })
          }
        >
          {variables.map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
        <Select
          value={condition.operator}
          onValueChange={(value) =>
            onChange({ ...condition, operator: value as typeof condition.operator })
          }
        >
          {[
            'equal',
            'not-equal',
            'less',
            'less-equal',
            'greater',
            'greater-equal',
            'truthy',
            'falsy',
          ].map((operator) => (
            <SelectItem key={operator} value={operator}>
              {operator}
            </SelectItem>
          ))}
        </Select>
        <Input
          value={condition.value === undefined ? '' : String(condition.value)}
          onChange={(event) => onChange({ ...condition, value: event.currentTarget.value })}
        />
      </div>
    );
  return (
    <Select
      value="always"
      onValueChange={(value) => {
        if (value === 'lua-predicate')
          onChange({
            kind: 'lua-predicate',
            source: 'return true',
            additionalDependencies: { targets: [] },
          });
        else if (value === 'variable-comparison' && variables[0])
          onChange({
            kind: 'variable-comparison',
            variable: { $ref: { collection: 'variables', id: variables[0] } },
            operator: 'truthy',
          });
      }}
    >
      <SelectItem value="always">Always</SelectItem>
      <SelectItem value="lua-predicate">Lua predicate</SelectItem>
      <SelectItem value="variable-comparison">Variable comparison</SelectItem>
    </Select>
  );
}

function CompactExitConditionEditor({
  condition,
  variables,
  onChange,
}: {
  condition: Condition;
  variables: string[];
  onChange: (next: Condition) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      <Select
        value={condition.kind}
        onValueChange={(kind) => {
          if (kind === condition.kind) return;
          if (kind === 'lua-predicate')
            onChange({
              kind: 'lua-predicate',
              source: 'return true',
              additionalDependencies: { targets: [] },
            });
          else if (kind === 'variable-comparison' && variables[0])
            onChange({
              kind: 'variable-comparison',
              variable: { $ref: { collection: 'variables', id: variables[0] } },
              operator: 'truthy',
            });
          else if (kind === 'always') onChange({ kind: 'always' });
        }}
      >
        <SelectTrigger size="sm" aria-label="Available when">
          <SelectValue>
            {condition.kind === 'always'
              ? 'Always'
              : condition.kind === 'lua-predicate'
                ? 'Lua predicate'
                : 'Variable comparison'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="always">Always</SelectItem>
          <SelectItem value="lua-predicate">Lua predicate</SelectItem>
          <SelectItem value="variable-comparison" disabled={!variables[0]}>
            Variable comparison
          </SelectItem>
        </SelectContent>
      </Select>
      {condition.kind === 'lua-predicate' ? (
        <>
          <Input
            className="min-w-48 flex-1 font-mono"
            aria-label="Lua predicate"
            value={condition.source}
            onChange={(event) => onChange({ ...condition, source: event.currentTarget.value })}
          />
          <details className="basis-full rounded border bg-background/60">
            <summary className="cursor-pointer px-2 py-1 text-[11px] text-muted-foreground">
              Additional dependencies
            </summary>
            <div className="border-t p-2">
              <LuaExplicitFallbackEditor
                value={condition.additionalDependencies}
                onChange={(additionalDependencies) =>
                  onChange({ ...condition, additionalDependencies })
                }
              />
            </div>
          </details>
        </>
      ) : null}
      {condition.kind === 'variable-comparison' ? (
        <>
          <Select
            value={condition.variable.$ref.id}
            onValueChange={(value) =>
              onChange({
                ...condition,
                variable: { $ref: { collection: 'variables', id: String(value) } },
              })
            }
          >
            <SelectTrigger size="sm" aria-label="Variable">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {variables.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={condition.operator}
            onValueChange={(value) =>
              onChange({ ...condition, operator: value as typeof condition.operator })
            }
          >
            <SelectTrigger size="sm" aria-label="Comparison operator">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                'equal',
                'not-equal',
                'less',
                'less-equal',
                'greater',
                'greater-equal',
                'truthy',
                'falsy',
              ].map((operator) => (
                <SelectItem key={operator} value={operator}>
                  {operator}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="min-w-32 flex-1"
            aria-label="Comparison value"
            value={condition.value === undefined ? '' : String(condition.value)}
            onChange={(event) => onChange({ ...condition, value: event.currentTarget.value })}
          />
        </>
      ) : null}
    </div>
  );
}

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
      <div className="grid gap-2 md:grid-cols-[160px_140px_1fr]">
        <Select
          value={value.source.kind}
          onValueChange={(kind) => {
            const source =
              kind === 'localized'
                ? { kind: 'localized' as const, key: 'text-key' }
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
          <SelectItem value="inline">Inline</SelectItem>
          <SelectItem value="localized">Localized key</SelectItem>
          <SelectItem value="lua-expression">Lua expression</SelectItem>
        </Select>
        <Select
          value={value.markup}
          onValueChange={(markup) =>
            onChange({ ...value, markup: markup as TextContent['markup'] })
          }
        >
          <SelectItem value="active-text">ActiveText</SelectItem>
          <SelectItem value="plain">Plain</SelectItem>
        </Select>
        <Input
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
  const { t } = useTranslation('workspace');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [backgroundSelectorOpen, setBackgroundSelectorOpen] = useState(false);
  const [destinationSelectorExitId, setDestinationSelectorExitId] = useState<string | null>(null);
  const [compositionBackgroundUrl, setCompositionBackgroundUrl] = useState<string | null>(null);
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null);
  const [interactableSelectorOpen, setInteractableSelectorOpen] = useState(false);
  const [placingInteractable, setPlacingInteractable] = useState<
    | { kind: 'definition'; definitionId: string }
    | { kind: 'instance'; instanceId: string; definitionId: string }
    | null
  >(null);
  const [activeCategory, setActiveCategory] = useState<RoomEditorCategory>(() => {
    const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    return savedState
      ? (parseRoomEditorTabState(savedState)?.activeCategory ?? 'general')
      : 'general';
  });
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
  const editorPreviewLayout = usePreferencesStore((state) => state.editorPreviewLayout);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const document = useProjectStore((state) => state.document);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const roomId = tab.resource?.entityId;
  const project = isAuthoringProject(document) ? document : null;
  const record = roomId && project ? project.rooms[roomId] : null;
  const effectiveRecord =
    project && record ? resolveGameplayInstanceRecord(project, 'room', record) : record;
  const data =
    parseRoomData(effectiveRecord?.data) ?? defaultRoomData(record?.label ?? roomId ?? 'Room');
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
  const interactableItems = useMemo(() => {
    const definitionItems = filterSelectorItems(selectorItems, {
      collections: ['interactables'],
      includeActions: false,
    }).map((item) => ({
      ...item,
      id: `definition:${item.entityId ?? item.id}`,
      subtitle: item.subtitle ? `New instance · ${item.subtitle}` : 'New instance',
    }));
    if (!project) return definitionItems;
    const instanceItems: SelectorItem[] = Object.entries(project.interactableInstances)
      .filter(([, instance]) => instance.location.kind !== 'room')
      .map(([instanceId, instance]) => {
        const definition = project.interactables[instance.definition.$ref.id];
        return {
          id: `instance:${instanceId}`,
          kind: 'record',
          title: instance.editorLabel ?? instanceId,
          subtitle: `Existing instance · ${definition?.label ?? instance.definition.$ref.id}`,
          entityId: instanceId,
          tags: [instanceId, instance.definition.$ref.id],
          collectionTerms: ['interactable', 'instance'],
          actionTerms: [],
        };
      });
    return [...instanceItems, ...definitionItems];
  }, [project, selectorItems]);
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
            previewCollapsed,
            hotspotView,
          },
        }),
        restoreTabState: (state) => {
          const parsed = parseRoomEditorTabState(state);
          if (!parsed) return;
          setActiveCategory(parsed.activeCategory);
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
      [activeCategory, data.hotspots, hotspotView, previewCollapsed],
    ),
  );
  useEffect(
    () =>
      registerWorkbenchTargetHandler(tab.id, 'room', (target) => {
        setActiveCategory(roomEditorCategoryForTarget(target.id));
        if (target.id.startsWith('room.hotspot.')) {
          const id = target.id.slice('room.hotspot.'.length);
          if (data.hotspots.some((hotspot) => hotspot.id === id))
            setHotspotView((current) => ({ ...current, selectedHotspotId: id }));
        }
        return false;
      }),
    [data.hotspots, tab.id],
  );
  const backgroundAssetData =
    project && data.background.asset
      ? parseAssetData(project.assets[data.background.asset.$ref.id]?.data)
      : null;
  const compositionBackgroundSize =
    backgroundAssetData?.kind === 'image' && backgroundAssetData.imageMetadata
      ? {
          width: backgroundAssetData.imageMetadata.width,
          height: backgroundAssetData.imageMetadata.height,
        }
      : null;
  useEffect(() => {
    let cancelled = false;
    if (!projectSessionId || !data.background.asset || backgroundAssetData?.kind !== 'image') {
      setCompositionBackgroundUrl(null);
      return;
    }
    window.noveltea
      .resolveProjectOriginalAssetUrl(projectSessionId, data.background.asset.$ref.id)
      .then((result) => !cancelled && setCompositionBackgroundUrl(result.ok ? result.url : null))
      .catch(() => !cancelled && setCompositionBackgroundUrl(null));
    return () => {
      cancelled = true;
    };
  }, [backgroundAssetData, data.background.asset, projectSessionId]);
  if (!project || !record || !roomId)
    return <div className="p-4 text-sm text-muted-foreground">Room record not found.</div>;
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
  const executeHotspot = (type: string, label: string, payload: Record<string, unknown>) =>
    useCommandStore.getState().executeCommand({
      type,
      label,
      payload: { roomId, ...payload },
      originSaveUnitId: recordSaveUnitId('rooms', roomId),
      persistencePolicy: 'manual-save',
    });
  const nextHotspotId = () => {
    const ids = new Set(data.hotspots.map((item) => item.id));
    let index = 1;
    while (ids.has(index === 1 ? 'hotspot' : `hotspot-${index}`)) index += 1;
    return index === 1 ? 'hotspot' : `hotspot-${index}`;
  };
  const nextHotspotInputOrder = data.hotspots.reduce(
    (maximum, item) => Math.max(maximum, item.inputOrder),
    -1,
  );
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
  const materials = Object.entries(project.materials).map(([id, value]) => ({
    id,
    label: value.label,
  }));
  const layouts = Object.entries(project.layouts).map(([id, value]) => ({
    id,
    label: value.label,
  }));
  const characters = Object.entries(project.characters).map(([id, value]) => ({
    id,
    label: value.label,
  }));
  const scripts = Object.entries(project.scripts).map(([id, value]) => ({
    id,
    label: value.label,
  }));
  const variables = Object.keys(project.variables);
  const replaceExit = (id: string, patch: Partial<RoomExitData>) =>
    commit(
      { ...data, exits: data.exits.map((exit) => (exit.id === id ? { ...exit, ...patch } : exit)) },
      'Update room exit',
    );
  const replacePlacement = (id: string, patch: Partial<RoomPlacementData>) =>
    commit(
      {
        ...data,
        placements: data.placements.map((placement) =>
          placement.id === id ? { ...placement, ...patch } : placement,
        ),
      },
      'Update room placement',
    );
  const placementOccupants = (placementId: string) => [
    ...data.cast
      .filter((entry) => entry.placementId === placementId)
      .map((entry) => project.characters[entry.character.$ref.id]?.label ?? entry.id),
    ...data.props.filter((entry) => entry.placementId === placementId).map((entry) => entry.id),
    ...data.interactables
      .filter((entry) => entry.placementId === placementId)
      .map((entry) => project.interactables[entry.interactable.$ref.id]?.label ?? entry.id),
  ];
  const placeInteractable = (
    target: NonNullable<typeof placingInteractable>,
    bounds: RoomNormalizedRect,
  ) => {
    const interactableId = target.definitionId;
    const interactableRecord = project.interactables[interactableId];
    const interactable = parseInteractableData(interactableRecord?.data);
    if (!interactable) return;
    const instanceId =
      target.kind === 'instance'
        ? target.instanceId
        : nextId(Object.keys(project.interactableInstances), interactableId);
    const placementId = nextId(
      data.placements.map((placement) => placement.id),
      `${instanceId}-placement`,
    );
    useCommandStore.getState().executeCommand({
      type: 'room.placeInteractable',
      label: 'Place Interactable instance in Room',
      payload: { roomId, interactableId, instanceId, placementId, bounds },
      originSaveUnitId: recordSaveUnitId('rooms', roomId),
      persistencePolicy: 'manual-save',
    });
    setSelectedPlacementId(placementId);
    setPlacingInteractable(null);
  };
  const detachInteractable = (interactableId: string, sourcePlacementId: string) => {
    const placementId = nextId(
      data.placements.map((placement) => placement.id),
      `${interactableId}-placement`,
    );
    useCommandStore.getState().executeCommand({
      type: 'room.detachInteractablePlacement',
      label: 'Create dedicated Interactable placement',
      payload: { roomId, interactableId, sourcePlacementId, placementId },
      originSaveUnitId: recordSaveUnitId('rooms', roomId),
      persistencePolicy: 'manual-save',
    });
    setSelectedPlacementId(placementId);
  };
  const moveInteractableToPlacement = (interactableId: string, placementId: string) => {
    useCommandStore.getState().executeCommand({
      type: 'room.moveInteractableToPlacement',
      label: 'Move Interactable to placement',
      payload: { roomId, interactableId, placementId },
      originSaveUnitId: recordSaveUnitId('rooms', roomId),
      persistencePolicy: 'manual-save',
    });
    setSelectedPlacementId(placementId);
  };
  const selectedPlacementInteractables = selectedPlacementId
    ? data.interactables
        .filter((entry) => entry.placementId === selectedPlacementId)
        .map((entry) => ({
          id: entry.id,
          label: project.interactables[entry.interactable.$ref.id]?.label ?? entry.id,
        }))
    : [];
  const referenceResolution = projectSettingsFromProject(project).display.referenceResolution;
  const placingInteractableData = placingInteractable
    ? parseInteractableData(project.interactables[placingInteractable.definitionId]?.data)
    : null;
  const placingSprite = placingInteractableData?.presentation.sprite
    ? parseAssetData(project.assets[placingInteractableData.presentation.sprite.$ref.id]?.data)
    : null;
  const placingImageMetadata = placingSprite?.kind === 'image' ? placingSprite.imageMetadata : null;
  const placementDraftSize = placingImageMetadata
    ? (() => {
        const roomAspect = referenceResolution.width / referenceResolution.height;
        const assetAspect = placingImageMetadata.width / placingImageMetadata.height;
        const heightAtDefaultWidth = (0.2 * roomAspect) / assetAspect;
        return heightAtDefaultWidth <= 0.2
          ? { width: 0.2, height: heightAtDefaultWidth }
          : { width: (0.2 * assetAspect) / roomAspect, height: 0.2 };
      })()
    : undefined;
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
      'Update room cast',
    );
  const replaceProp = (id: string, patch: Partial<RoomPropData>) =>
    commit(
      {
        ...data,
        props: data.props.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
      },
      'Update room prop',
    );
  const replaceEnvironment = (id: string, patch: Partial<RoomEnvironmentData>) =>
    commit(
      {
        ...data,
        environments: data.environments.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry,
        ),
      },
      'Update room environment',
    );
  const categorizedRoomEditorCategories = roomEditorCategories.map((category) => {
    switch (category.id) {
      case 'camera':
        return { ...category, trailing: data.presentationSpace.views.length + data.anchors.length };
      case 'composition':
        return { ...category, trailing: data.placements.length };
      case 'hotspots':
        return { ...category, trailing: data.hotspots.length };
      case 'navigation':
        return { ...category, trailing: data.exits.length };
      case 'contents':
        return {
          ...category,
          trailing:
            data.overlays.length + data.cast.length + data.props.length + data.environments.length,
        };
      default:
        return category;
    }
  });
  const activeRoomCategory =
    categorizedRoomEditorCategories.find((category) => category.id === activeCategory) ??
    categorizedRoomEditorCategories[0]!;
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
        <DerivedPreviewPane
          ownerTabId={tab.id}
          previewMode="room"
          enabled={!previewCollapsed}
          root={{ kind: 'room-preview', recordId: roomId }}
          inputs={{ displayPreference: { mode: 'project' } }}
        />
      }
    >
      <CategorizedEditorLayout
        categories={categorizedRoomEditorCategories}
        activeCategory={activeCategory}
        onCategoryChange={setActiveCategory}
        navigationLabel="Room editor categories"
        contentRef={scrollRef}
        contentContainerClassName="max-w-6xl pb-8"
        header={
          <header className="flex min-w-0 flex-wrap items-center gap-2.5">
            <h2 className="truncate text-lg font-semibold">{activeRoomCategory.label}</h2>
            <span className="truncate text-xs text-muted-foreground">{record.label}</span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {roomId}
            </Badge>
          </header>
        }
      >
        {activeCategory === 'general' ? (
          <section
            className="overflow-hidden rounded-lg border bg-card/30"
            data-workbench-anchor="room.summary"
          >
            <div className="border-b px-3 py-2.5">
              <h3 className="text-sm font-semibold">Room details</h3>
            </div>
            <div className="p-3 pb-0">
              <GameplayArchetypeControls
                project={project}
                collection="rooms"
                entityId={roomId}
                record={record}
                kind="room"
              />
            </div>
            <div className="grid gap-3 p-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Display name</Label>
                <Input
                  value={data.displayName}
                  onChange={(event) =>
                    commit({ ...data, displayName: event.currentTarget.value }, 'Update room name')
                  }
                />
              </div>
              <div data-workbench-anchor="room.description" className="space-y-1.5 md:col-span-2">
                <Label>Description</Label>
                <TextContentEditor
                  value={data.description}
                  onChange={(description) =>
                    commit({ ...data, description }, 'Update room description')
                  }
                />
              </div>
            </div>
            <div
              data-workbench-anchor="room.background"
              className="grid gap-3 border-t bg-muted/10 p-3 md:grid-cols-3"
            >
              <div className="space-y-1.5 md:col-span-3">
                <Label>Background image</Label>
                <div className="flex min-h-16 items-stretch overflow-hidden rounded-lg border bg-background">
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
                        className="h-12 w-20"
                      />
                    ) : (
                      <span className="flex h-12 w-20 shrink-0 items-center justify-center rounded border border-dashed bg-muted/20">
                        <Image className="size-5 text-muted-foreground" aria-hidden="true" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {selectedBackgroundItem?.title ?? 'Choose an image'}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {selectedBackgroundItem?.entityId ??
                          `${imageAssetItems.length} image${imageAssetItems.length === 1 ? '' : 's'} available`}
                      </span>
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
              <div className="space-y-1.5">
                <Label>Material</Label>
                <Select
                  value={refValue(data.background.material)}
                  onValueChange={(value) =>
                    commit(
                      {
                        ...data,
                        background: {
                          ...data.background,
                          material: value === '__none__' ? null : roomMaterialRef(String(value)),
                        },
                      },
                      'Update room material',
                    )
                  }
                >
                  <SelectItem value="__none__">No material</SelectItem>
                  {materials.map((material) => (
                    <SelectItem key={material.id} value={material.id}>
                      {material.label}
                    </SelectItem>
                  ))}
                </Select>
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
          </section>
        ) : null}

        {activeCategory === 'hotspots' ? (
          <div className="space-y-4">
            <FeatureAuthoringPanel
              project={project}
              features={data.features}
              anchorPrefix="room"
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
              localFeatures={data.features}
              roomVisibleGuide={{
                referenceSize: projectSettingsFromProject(project).display.referenceResolution,
                fit: data.background.fit,
              }}
              exits={data.exits.map((exit) => ({ id: exit.id, label: exit.id }))}
              onViewChange={setHotspotView}
              onAdd={(bounds, target) => {
                const id = nextHotspotId();
                executeHotspot('room.addHotspot', 'Add room hotspot', {
                  hotspot: {
                    id,
                    label: t('hotspots.defaultLabel'),
                    condition: { kind: 'always' },
                    inputOrder: Math.min(2147483647, nextHotspotInputOrder + 1),
                    highlight: { kind: 'default' },
                    target,
                    shape: { kind: 'rect', bounds },
                  },
                });
                setHotspotView((view) => ({ ...view, selectedHotspotId: id, tool: 'select' }));
              }}
              onDelete={(hotspotId) =>
                executeHotspot('room.deleteHotspot', 'Delete room hotspot', { hotspotId })
              }
              onRename={(hotspotId, nextId) =>
                executeHotspot('room.renameHotspot', 'Rename room hotspot', { hotspotId, nextId })
              }
              onUpdate={(hotspotId, hotspot) =>
                executeHotspot('room.updateHotspot', 'Update room hotspot', { hotspotId, hotspot })
              }
              onBounds={(hotspotId, bounds) =>
                executeHotspot('room.setHotspotBounds', 'Set room hotspot bounds', {
                  hotspotId,
                  bounds,
                })
              }
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
                        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
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
                          <CompactExitConditionEditor
                            condition={exit.condition}
                            variables={variables}
                            onChange={(condition) => replaceExit(exit.id, { condition })}
                          />
                        </div>
                        <details className="group rounded-md border bg-muted/10">
                          <summary className="cursor-pointer select-none px-2 py-1.5 text-[11px] font-medium marker:text-muted-foreground">
                            Transition{' '}
                            {exit.transition ? `· ${exit.transition.kind}` : '· Project default'}
                          </summary>
                          <div className="grid gap-2 border-t p-2 md:grid-cols-3">
                            {exit.transition ? (
                              <>
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <Label className="shrink-0 text-[11px]">Style</Label>
                                  <Select
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
                                      <SelectValue>
                                        {exit.transition.kind.charAt(0).toUpperCase() +
                                          exit.transition.kind.slice(1)}
                                      </SelectValue>
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
                              <p className="self-center text-xs text-muted-foreground md:col-span-2">
                                This exit uses the project transition settings.
                              </p>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              className="justify-self-start md:col-start-3 md:justify-self-end"
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
          <div className="space-y-4" data-workbench-anchor="room.camera">
            <section className="space-y-3 rounded-xl border bg-card/20 p-4">
              <div>
                <h3 className="text-sm font-semibold">World Presentation Space</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Logical world framing is independent of display resolution. Contain clamps the
                  Camera View to authored bounds; Overscan allows framing outside them.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-1.5">
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
                    value={data.presentationSpace.edgePolicy}
                    onValueChange={(edgePolicy) => {
                      if (!edgePolicy) return;
                      commit(
                        {
                          ...data,
                          presentationSpace: { ...data.presentationSpace, edgePolicy },
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
              <div className="flex items-center justify-between gap-3 border-t pt-3">
                <div>
                  <Label>Camera bounds</Label>
                  <p className="text-xs text-muted-foreground">
                    Optional world-space rectangle used by the Contain policy.
                  </p>
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
                <div className="grid gap-3 md:grid-cols-4">
                  {(['x', 'y', 'width', 'height'] as const).map((field) => (
                    <div key={field} className="space-y-1.5">
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

            <section className="space-y-3 rounded-xl border bg-card/20 p-4">
              <div>
                <h3 className="text-sm font-semibold">Default Camera View</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Reconstructible framing used when no higher-precedence View is active.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-4">
                {(['x', 'y'] as const).map((axis) => (
                  <div key={axis} className="space-y-1.5">
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

            <section className="space-y-3 rounded-xl border bg-card/20 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Named Camera Views</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Reusable logical framing targets for presentation operations.
                  </p>
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
                    )
                  }
                >
                  <Plus data-icon="inline-start" /> Add View
                </Button>
              </div>
              {data.presentationSpace.views.map((entry, index) => (
                <div
                  key={`${entry.id}-${index}`}
                  className="grid gap-3 rounded-lg border bg-background/60 p-3 md:grid-cols-6"
                >
                  <div className="space-y-1.5 md:col-span-2">
                    <Label>View ID</Label>
                    <Input
                      value={entry.id}
                      onChange={(event) => {
                        const views = data.presentationSpace.views.map((candidate, viewIndex) =>
                          viewIndex === index
                            ? { ...candidate, id: event.currentTarget.value }
                            : candidate,
                        );
                        commit(
                          { ...data, presentationSpace: { ...data.presentationSpace, views } },
                          'Rename Camera View',
                        );
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Center X</Label>
                    <Input
                      type="number"
                      value={entry.view.center.x}
                      onChange={(event) => {
                        const views = data.presentationSpace.views.map((candidate, viewIndex) =>
                          viewIndex === index
                            ? {
                                ...candidate,
                                view: {
                                  ...candidate.view,
                                  center: {
                                    ...candidate.view.center,
                                    x: numberValue(
                                      event.currentTarget.value,
                                      candidate.view.center.x,
                                    ),
                                  },
                                },
                              }
                            : candidate,
                        );
                        commit(
                          { ...data, presentationSpace: { ...data.presentationSpace, views } },
                          'Update Camera View',
                        );
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Center Y</Label>
                    <Input
                      type="number"
                      value={entry.view.center.y}
                      onChange={(event) => {
                        const views = data.presentationSpace.views.map((candidate, viewIndex) =>
                          viewIndex === index
                            ? {
                                ...candidate,
                                view: {
                                  ...candidate.view,
                                  center: {
                                    ...candidate.view.center,
                                    y: numberValue(
                                      event.currentTarget.value,
                                      candidate.view.center.y,
                                    ),
                                  },
                                },
                              }
                            : candidate,
                        );
                        commit(
                          { ...data, presentationSpace: { ...data.presentationSpace, views } },
                          'Update Camera View',
                        );
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Zoom</Label>
                    <Input
                      type="number"
                      min={0.001}
                      step={0.05}
                      value={entry.view.zoom}
                      onChange={(event) => {
                        const views = data.presentationSpace.views.map((candidate, viewIndex) =>
                          viewIndex === index
                            ? {
                                ...candidate,
                                view: {
                                  ...candidate.view,
                                  zoom: Math.max(
                                    0.001,
                                    numberValue(event.currentTarget.value, candidate.view.zoom),
                                  ),
                                },
                              }
                            : candidate,
                        );
                        commit(
                          { ...data, presentationSpace: { ...data.presentationSpace, views } },
                          'Update Camera View zoom',
                        );
                      }}
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <Label>Rotation</Label>
                      <Input
                        type="number"
                        value={entry.view.rotationDegrees}
                        onChange={(event) => {
                          const views = data.presentationSpace.views.map((candidate, viewIndex) =>
                            viewIndex === index
                              ? {
                                  ...candidate,
                                  view: {
                                    ...candidate.view,
                                    rotationDegrees: numberValue(
                                      event.currentTarget.value,
                                      candidate.view.rotationDegrees,
                                    ),
                                  },
                                }
                              : candidate,
                          );
                          commit(
                            { ...data, presentationSpace: { ...data.presentationSpace, views } },
                            'Update Camera View rotation',
                          );
                        }}
                      />
                    </div>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete Camera View ${entry.id}`}
                      onClick={() =>
                        commit(
                          {
                            ...data,
                            presentationSpace: {
                              ...data.presentationSpace,
                              views: data.presentationSpace.views.filter(
                                (_, viewIndex) => viewIndex !== index,
                              ),
                            },
                          },
                          'Delete Camera View',
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))}
            </section>

            <section
              className="space-y-3 rounded-xl border bg-card/20 p-4"
              data-workbench-anchor="room.anchors"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Anchors</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Stable authored regions that Focus captures without live tracking.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
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
                    )
                  }
                >
                  <Plus data-icon="inline-start" /> Add Anchor
                </Button>
              </div>
              {data.anchors.map((anchor, index) => (
                <div
                  key={`${anchor.id}-${index}`}
                  className="grid gap-3 rounded-lg border bg-background/60 p-3 md:grid-cols-6"
                >
                  <div className="space-y-1.5 md:col-span-2">
                    <Label>Anchor ID</Label>
                    <Input
                      value={anchor.id}
                      onChange={(event) =>
                        commit(
                          {
                            ...data,
                            anchors: data.anchors.map((candidate, anchorIndex) =>
                              anchorIndex === index
                                ? { ...candidate, id: event.currentTarget.value }
                                : candidate,
                            ),
                          },
                          'Rename Room Anchor',
                        )
                      }
                    />
                  </div>
                  {(['x', 'y', 'width', 'height'] as const).map((field) => (
                    <div key={field} className="space-y-1.5">
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
                          commit(
                            {
                              ...data,
                              anchors: data.anchors.map((candidate, anchorIndex) =>
                                anchorIndex === index
                                  ? {
                                      ...candidate,
                                      bounds: { ...candidate.bounds, [field]: value },
                                    }
                                  : candidate,
                              ),
                            },
                            'Update Room Anchor bounds',
                          );
                        }}
                      />
                    </div>
                  ))}
                  <div className="flex items-end">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete Room Anchor ${anchor.id}`}
                      onClick={() =>
                        commit(
                          {
                            ...data,
                            anchors: data.anchors.filter((_, anchorIndex) => anchorIndex !== index),
                          },
                          'Delete Room Anchor',
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))}
            </section>
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
                <ConditionEditor
                  condition={data.lifecycle[hook]}
                  variables={variables}
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
          <>
            <section
              className="space-y-3 rounded-xl border bg-card/20 p-4"
              data-workbench-anchor="room.composition"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">{t('roomComposition.title')}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('roomComposition.description')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={placingInteractable ? 'secondary' : 'outline'}
                  onClick={() => {
                    if (placingInteractable) setPlacingInteractable(null);
                    else setInteractableSelectorOpen(true);
                  }}
                >
                  <Plus data-icon="inline-start" />
                  {placingInteractable
                    ? t('roomComposition.cancelPlacement')
                    : t('roomComposition.placeInteractable')}
                </Button>
              </div>
              <RoomCompositionStage
                backgroundUrl={compositionBackgroundUrl}
                backgroundImageSize={compositionBackgroundSize}
                backgroundFit={data.background.fit}
                fallbackColor={data.background.color}
                referenceResolution={referenceResolution}
                placementDraftSize={placementDraftSize}
                items={data.placements.map((placement) => ({
                  id: placement.id,
                  label: placement.id,
                  bounds: placement.bounds,
                  occupants: placementOccupants(placement.id),
                }))}
                selectedId={selectedPlacementId}
                placementDraftLabel={
                  placingInteractable
                    ? placingInteractable.kind === 'instance'
                      ? (project.interactableInstances[placingInteractable.instanceId]
                          ?.editorLabel ?? placingInteractable.instanceId)
                      : (project.interactables[placingInteractable.definitionId]?.label ??
                        placingInteractable.definitionId)
                    : null
                }
                onSelectionChange={setSelectedPlacementId}
                onCommitBounds={(placementId, bounds) =>
                  useCommandStore.getState().executeCommand({
                    type: 'room.setPlacementBounds',
                    label: 'Update room placement bounds',
                    payload: { roomId, placementId, bounds },
                    originSaveUnitId: recordSaveUnitId('rooms', roomId),
                    persistencePolicy: 'manual-save',
                  })
                }
                onCommitPlacement={(bounds) => {
                  if (placingInteractable) placeInteractable(placingInteractable, bounds);
                }}
                onCancelPlacement={() => setPlacingInteractable(null)}
              />
              {placingInteractable ? (
                <p className="text-xs text-muted-foreground">
                  {t('roomComposition.dragPlacement')}
                </p>
              ) : null}
              {selectedPlacementId && placementOccupants(selectedPlacementId).length > 1 ? (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <div>
                    <div className="font-medium">{t('roomComposition.sharedTitle')}</div>
                    <p className="text-muted-foreground">
                      {t('roomComposition.sharedDescription')}
                    </p>
                    {selectedPlacementInteractables.map((interactable) => (
                      <div key={interactable.id} className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="font-medium">{interactable.label}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => detachInteractable(interactable.id, selectedPlacementId!)}
                        >
                          {t('roomComposition.detach')}
                        </Button>
                        <Select
                          value={selectedPlacementId ?? undefined}
                          onValueChange={(placementId) => {
                            if (placementId)
                              moveInteractableToPlacement(interactable.id, placementId);
                          }}
                        >
                          <SelectTrigger className="h-8 w-48">
                            <SelectValue placeholder={t('roomComposition.moveToPlacement')} />
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
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
            <section
              className="space-y-4 rounded-xl border bg-card/20 p-4"
              data-workbench-anchor="room.placements"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Placements</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Named regions used by cast, props, and interactions.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    commit(
                      {
                        ...data,
                        placements: [
                          ...data.placements,
                          {
                            id: nextId(
                              data.placements.map((placement) => placement.id),
                              'placement',
                            ),
                            bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
                            order: data.placements.length,
                            presentation: { label: null, layout: null },
                          },
                        ],
                      },
                      'Add room placement',
                    )
                  }
                >
                  <Plus data-icon="inline-start" />
                  Add placement
                </Button>
              </div>
              {data.placements.map((placement) => (
                <div
                  key={placement.id}
                  data-workbench-anchor={`room.placement.${placement.id}`}
                  className="space-y-4 rounded-lg border bg-background/60 p-4"
                >
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div className="min-w-56 flex-1 space-y-1.5">
                      <Label htmlFor={`placement-${placement.id}-id`}>Placement ID</Label>
                      <Input
                        id={`placement-${placement.id}-id`}
                        value={placement.id}
                        onChange={(event) =>
                          replacePlacement(placement.id, { id: event.currentTarget.value })
                        }
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">
                        {placementOccupants(placement.id).length} occupant
                        {placementOccupants(placement.id).length === 1 ? '' : 's'}
                      </Badge>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete placement ${placement.id}`}
                        onClick={() =>
                          commit(
                            {
                              ...data,
                              placements: data.placements.filter(
                                (item) => item.id !== placement.id,
                              ),
                            },
                            'Delete room placement',
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div>
                      <div className="text-sm font-medium">Position and size</div>
                      <p className="text-xs text-muted-foreground">
                        Percentage of the Room presentation surface.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {(
                        [
                          ['x', 'Left'],
                          ['y', 'Top'],
                          ['width', 'Width'],
                          ['height', 'Height'],
                        ] as const
                      ).map(([field, label]) => (
                        <div key={field} className="space-y-1.5">
                          <Label htmlFor={`placement-${placement.id}-${field}`}>{label}</Label>
                          <div className="relative">
                            <Input
                              id={`placement-${placement.id}-${field}`}
                              type="number"
                              min={0}
                              max={100}
                              step={0.1}
                              className="pr-7 tabular-nums"
                              value={Number((placement.bounds[field] * 100).toFixed(3))}
                              onChange={(event) =>
                                replacePlacement(placement.id, {
                                  bounds: {
                                    ...placement.bounds,
                                    [field]:
                                      numberValue(
                                        event.currentTarget.value,
                                        placement.bounds[field] * 100,
                                      ) / 100,
                                  },
                                })
                              }
                            />
                            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
                              %
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-4 border-t pt-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium">Label</div>
                          <p className="text-xs text-muted-foreground">
                            Optional text exposed by this placement.
                          </p>
                        </div>
                        {placement.presentation.label ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              replacePlacement(placement.id, {
                                presentation: { ...placement.presentation, label: null },
                              })
                            }
                          >
                            Remove label
                          </Button>
                        ) : null}
                      </div>
                      {placement.presentation.label ? (
                        <TextContentEditor
                          value={placement.presentation.label}
                          onChange={(label) =>
                            replacePlacement(placement.id, {
                              presentation: { ...placement.presentation, label },
                            })
                          }
                        />
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            replacePlacement(placement.id, {
                              presentation: {
                                ...placement.presentation,
                                label: inlineTextContent(''),
                              },
                            })
                          }
                        >
                          Add label
                        </Button>
                      )}
                    </div>
                    <div className="space-y-2">
                      <div>
                        <div className="text-sm font-medium">Layout</div>
                        <p className="text-xs text-muted-foreground">
                          Optional presentation attached to this placement.
                        </p>
                      </div>
                      <Select
                        value={refValue(placement.presentation.layout)}
                        onValueChange={(value) =>
                          replacePlacement(placement.id, {
                            presentation: {
                              ...placement.presentation,
                              layout: value === '__none__' ? null : roomLayoutRef(String(value)),
                            },
                          })
                        }
                      >
                        <SelectItem value="__none__">No layout</SelectItem>
                        {layouts.map((layout) => (
                          <SelectItem key={layout.id} value={layout.id}>
                            {layout.label}
                          </SelectItem>
                        ))}
                      </Select>
                    </div>
                  </div>
                </div>
              ))}
            </section>
          </>
        ) : null}
        {activeCategory === 'contents' ? (
          <>
            <section
              className="space-y-4 rounded-xl border bg-card/20 p-4"
              data-workbench-anchor="room.overlays"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Overlays</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Layouts rendered over the room presentation.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={layouts.length === 0}
                  onClick={() => {
                    const layout = layouts[0];
                    if (!layout) return;
                    commit(
                      {
                        ...data,
                        overlays: [
                          ...data.overlays,
                          {
                            id: nextId(
                              data.overlays.map((overlay) => overlay.id),
                              'overlay',
                            ),
                            layout: roomLayoutRef(layout.id),
                            condition: { kind: 'always' },
                            visible: true,
                            order: data.overlays.length,
                          },
                        ],
                      },
                      'Add room overlay',
                    );
                  }}
                >
                  <Plus data-icon="inline-start" />
                  Add overlay
                </Button>
              </div>
              {data.overlays.map((overlay) => (
                <div
                  key={overlay.id}
                  className="grid gap-3 rounded-lg border bg-background/60 p-3 md:grid-cols-4"
                >
                  <Input
                    value={overlay.id}
                    onChange={(event) =>
                      replaceOverlay(overlay.id, { id: event.currentTarget.value })
                    }
                  />
                  <Select
                    value={overlay.layout.$ref.id}
                    onValueChange={(value) =>
                      replaceOverlay(overlay.id, { layout: roomLayoutRef(String(value)) })
                    }
                  >
                    {layouts.map((layout) => (
                      <SelectItem key={layout.id} value={layout.id}>
                        {layout.label}
                      </SelectItem>
                    ))}
                  </Select>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={overlay.visible}
                      onChange={(event) =>
                        replaceOverlay(overlay.id, { visible: event.currentTarget.checked })
                      }
                    />
                    Enabled
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      commit(
                        {
                          ...data,
                          overlays: data.overlays.filter((item) => item.id !== overlay.id),
                        },
                        'Delete room overlay',
                      )
                    }
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </section>
            <section
              className="space-y-4 rounded-xl border bg-card/20 p-4"
              data-workbench-anchor="room.cast"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Room cast</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Characters visible when this room is presented.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!characters[0] || !data.placements[0]}
                  onClick={() => {
                    if (!characters[0] || !data.placements[0]) return;
                    commit(
                      {
                        ...data,
                        cast: [
                          ...data.cast,
                          {
                            id: nextId(
                              data.cast.map((entry) => entry.id),
                              'cast',
                            ),
                            character: { $ref: { collection: 'characters', id: characters[0].id } },
                            condition: { kind: 'always' },
                            placementId: data.placements[0].id,
                            poseId: null,
                            expressionId: null,
                            idleId: null,
                            visible: true,
                            order: data.cast.length,
                          },
                        ],
                      },
                      'Add room cast entry',
                    );
                  }}
                >
                  <Plus data-icon="inline-start" />
                  Add cast
                </Button>
              </div>
              {data.cast.map((entry) => (
                <div
                  key={entry.id}
                  className="grid gap-3 rounded-lg border bg-background/60 p-3 md:grid-cols-4"
                >
                  <Input
                    value={entry.id}
                    onChange={(event) => replaceCast(entry.id, { id: event.currentTarget.value })}
                  />
                  <Select
                    value={entry.character.$ref.id}
                    onValueChange={(value) =>
                      replaceCast(entry.id, {
                        character: { $ref: { collection: 'characters', id: String(value) } },
                      })
                    }
                  >
                    {characters.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                  <Select
                    value={entry.placementId}
                    onValueChange={(value) => replaceCast(entry.id, { placementId: String(value) })}
                  >
                    {data.placements.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.id}
                      </SelectItem>
                    ))}
                  </Select>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={entry.visible}
                      onChange={(event) =>
                        replaceCast(entry.id, { visible: event.currentTarget.checked })
                      }
                    />
                    Visible
                  </label>
                  <Input
                    placeholder="Pose ID"
                    value={entry.poseId ?? ''}
                    onChange={(event) =>
                      replaceCast(entry.id, { poseId: event.currentTarget.value || null })
                    }
                  />
                  <Input
                    placeholder="Expression ID"
                    value={entry.expressionId ?? ''}
                    onChange={(event) =>
                      replaceCast(entry.id, { expressionId: event.currentTarget.value || null })
                    }
                  />
                  <Input
                    placeholder="Idle ID"
                    value={entry.idleId ?? ''}
                    onChange={(event) =>
                      replaceCast(entry.id, { idleId: event.currentTarget.value || null })
                    }
                  />
                  <div className="md:col-span-3">
                    <ConditionEditor
                      condition={entry.condition}
                      variables={variables}
                      onChange={(condition) => replaceCast(entry.id, { condition })}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      commit(
                        { ...data, cast: data.cast.filter((item) => item.id !== entry.id) },
                        'Delete room cast entry',
                      )
                    }
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </section>
            <section
              className="space-y-4 rounded-xl border bg-card/20 p-4"
              data-workbench-anchor="room.props"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Props</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Static visual elements placed within the room.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!data.placements[0] || (!assets[0] && !materials[0])}
                  onClick={() => {
                    if (!data.placements[0]) return;
                    commit(
                      {
                        ...data,
                        props: [
                          ...data.props,
                          {
                            id: nextId(
                              data.props.map((entry) => entry.id),
                              'prop',
                            ),
                            condition: { kind: 'always' },
                            placementId: data.placements[0].id,
                            asset: assets[0] ? roomAssetRef(assets[0].id) : null,
                            material:
                              !assets[0] && materials[0] ? roomMaterialRef(materials[0].id) : null,
                            visible: true,
                            order: data.props.length,
                          },
                        ],
                      },
                      'Add room prop',
                    );
                  }}
                >
                  <Plus data-icon="inline-start" />
                  Add prop
                </Button>
              </div>
              {data.props.map((entry) => (
                <div
                  key={entry.id}
                  className="grid gap-3 rounded-lg border bg-background/60 p-3 md:grid-cols-4"
                >
                  <Input
                    value={entry.id}
                    onChange={(event) => replaceProp(entry.id, { id: event.currentTarget.value })}
                  />
                  <Select
                    value={entry.placementId}
                    onValueChange={(value) => replaceProp(entry.id, { placementId: String(value) })}
                  >
                    {data.placements.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.id}
                      </SelectItem>
                    ))}
                  </Select>
                  <Select
                    value={refValue(entry.asset)}
                    onValueChange={(value) =>
                      replaceProp(entry.id, {
                        asset: value === '__none__' ? null : roomAssetRef(String(value)),
                      })
                    }
                  >
                    <SelectItem value="__none__">No asset</SelectItem>
                    {assets.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                  <Select
                    value={refValue(entry.material)}
                    onValueChange={(value) =>
                      replaceProp(entry.id, {
                        material: value === '__none__' ? null : roomMaterialRef(String(value)),
                      })
                    }
                  >
                    <SelectItem value="__none__">No material</SelectItem>
                    {materials.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                  <div className="md:col-span-3">
                    <ConditionEditor
                      condition={entry.condition}
                      variables={variables}
                      onChange={(condition) => replaceProp(entry.id, { condition })}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      commit(
                        { ...data, props: data.props.filter((item) => item.id !== entry.id) },
                        'Delete room prop',
                      )
                    }
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </section>
            <section
              className="space-y-4 rounded-xl border bg-card/20 p-4"
              data-workbench-anchor="room.environments"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Environment loops</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Animated materials and shader layers that persist in this room.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!materials[0]}
                  onClick={() => {
                    const material = materials[0];
                    if (!material) return;
                    commit(
                      {
                        ...data,
                        environments: [
                          ...data.environments,
                          {
                            id: nextId(
                              data.environments.map((entry) => entry.id),
                              'environment',
                            ),
                            condition: { kind: 'always' },
                            asset: assets[0] ? roomAssetRef(assets[0].id) : null,
                            material: roomMaterialRef(material.id),
                            bounds: { x: 0, y: 0, width: 1, height: 1 },
                            plane: 'world-content',
                            order: data.environments.length,
                            clock: 'gameplay',
                            scrollPerSecond: { x: 0, y: 0 },
                            opacity: 1,
                            visible: true,
                          },
                        ],
                      },
                      'Add room environment',
                    );
                  }}
                >
                  <Plus data-icon="inline-start" />
                  Add environment
                </Button>
              </div>
              {data.environments.map((entry) => (
                <div
                  key={entry.id}
                  className="grid gap-3 rounded-lg border bg-background/60 p-3 md:grid-cols-4"
                >
                  <div>
                    <Label>ID</Label>
                    <Input
                      value={entry.id}
                      onChange={(event) =>
                        replaceEnvironment(entry.id, { id: event.currentTarget.value })
                      }
                    />
                  </div>
                  <div>
                    <Label>Asset</Label>
                    <Select
                      value={refValue(entry.asset)}
                      onValueChange={(value) =>
                        replaceEnvironment(entry.id, {
                          asset: value === '__none__' ? null : roomAssetRef(String(value)),
                        })
                      }
                    >
                      <SelectItem value="__none__">No asset</SelectItem>
                      {assets.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label>Material</Label>
                    <Select
                      value={entry.material.$ref.id}
                      onValueChange={(value) =>
                        replaceEnvironment(entry.id, { material: roomMaterialRef(String(value)) })
                      }
                    >
                      {materials.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </Select>
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
                  <div>
                    <Label>Plane</Label>
                    <Select
                      value={entry.plane}
                      onValueChange={(value) =>
                        replaceEnvironment(entry.id, {
                          plane: value as RoomEnvironmentData['plane'],
                        })
                      }
                    >
                      {roomEnvironmentPlaneValues.map((plane) => (
                        <SelectItem key={plane} value={plane}>
                          {plane}
                        </SelectItem>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label>Clock</Label>
                    <Select
                      value={entry.clock}
                      onValueChange={(value) =>
                        replaceEnvironment(entry.id, {
                          clock: value as RoomEnvironmentData['clock'],
                        })
                      }
                    >
                      {roomEnvironmentClockValues.map((clock) => (
                        <SelectItem key={clock} value={clock}>
                          {clock}
                        </SelectItem>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label>Order</Label>
                    <Input
                      value={String(entry.order)}
                      onChange={(event) =>
                        replaceEnvironment(entry.id, {
                          order: Math.round(numberValue(event.currentTarget.value, entry.order)),
                        })
                      }
                    />
                  </div>
                  <div>
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
                    <div key={field}>
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
                  <div>
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
                  <div>
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
                  <div className="md:col-span-3">
                    <ConditionEditor
                      condition={entry.condition}
                      variables={variables}
                      onChange={(condition) => replaceEnvironment(entry.id, { condition })}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      commit(
                        {
                          ...data,
                          environments: data.environments.filter((item) => item.id !== entry.id),
                        },
                        'Delete room environment',
                      )
                    }
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </section>
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
                  <div key={hook} className="grid gap-2 rounded-lg border p-3 md:grid-cols-3">
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
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <SearchSelectorDialog
          open={interactableSelectorOpen}
          title={t('roomComposition.placeInteractable')}
          placeholder={t('roomComposition.searchInteractables')}
          emptyMessage={t('roomComposition.noInteractables')}
          items={interactableItems}
          selectedId={null}
          onOpenChange={setInteractableSelectorOpen}
          onSelect={(item) => {
            if (!item.entityId) return;
            if (item.id.startsWith('instance:')) {
              const instance = project.interactableInstances[item.entityId];
              if (!instance) return;
              setPlacingInteractable({
                kind: 'instance',
                instanceId: item.entityId,
                definitionId: instance.definition.$ref.id,
              });
            } else {
              setPlacingInteractable({ kind: 'definition', definitionId: item.entityId });
            }
            setInteractableSelectorOpen(false);
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
      </CategorizedEditorLayout>
    </EditorPreviewSplit>
  );
}
