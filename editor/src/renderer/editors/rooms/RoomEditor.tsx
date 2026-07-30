import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Image, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ColorField } from '@/components/ui/color-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LuaExplicitFallbackEditor } from '@/components/lua-explicit-fallback-editor';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import { DerivedPreviewPane } from '@/preview/DerivedPreviewPane';
import { EditorPreviewSplit } from '@/components/editor-preview-split';
import { resolveEditorPreviewSplitOrientation } from '@/components/editor-preview-layout';
import { usePreferencesStore } from '@/stores/preferences-store';
import { AssetImageThumbnail } from '@/workspace/AssetImageThumbnail';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import { buildCommandPaletteItems, filterSelectorItems } from '@/workspace/command-palette-search';
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
  type RoomCastData,
  type RoomData,
  type RoomEnvironmentData,
  type RoomExitData,
  type RoomOverlayData,
  type RoomPlacementData,
  type RoomPropData,
} from '../../../shared/project-schema/authoring-rooms';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../../../shared/project-schema/authoring-project-settings';
import {
  inlineTextContent,
  type Condition,
  type Effect,
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

const ROOM_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.room';
type RoomEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof ROOM_EDITOR_TAB_STATE_SCHEMA;
  schemaVersion: 2;
  payload: { scroll?: ScrollViewState; previewCollapsed: boolean };
};

function parseRoomEditorTabState(
  value: WorkbenchTabStatePayload,
): RoomEditorTabState['payload'] | null {
  if (
    value.schema !== ROOM_EDITOR_TAB_STATE_SCHEMA ||
    value.schemaVersion !== 2 ||
    typeof value.payload !== 'object' ||
    value.payload === null ||
    Array.isArray(value.payload)
  )
    return null;
  const payload = value.payload as Record<string, unknown>;
  if (typeof payload.previewCollapsed !== 'boolean') return null;
  return {
    scroll: isScrollViewState(payload.scroll) ? payload.scroll : undefined,
    previewCollapsed: payload.previewCollapsed,
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

function EffectsEditor({
  effects,
  variables,
  onChange,
}: {
  effects: Effect[];
  variables: string[];
  onChange: (next: Effect[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange([...effects, { kind: 'run-lua-effect', source: '-- Lua' }])}
        >
          Add Lua effect
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!variables[0]}
          onClick={() =>
            variables[0] &&
            onChange([
              ...effects,
              {
                kind: 'set-variable',
                variable: { $ref: { collection: 'variables', id: variables[0] } },
                value: '',
              },
            ])
          }
        >
          Set variable
        </Button>
      </div>
      {effects.map((effect, index) => (
        <div key={`${effect.kind}-${index}`} className="flex gap-2">
          {effect.kind === 'set-variable' ? (
            <Select
              value={effect.variable.$ref.id}
              onValueChange={(value) =>
                onChange(
                  effects.map((item, itemIndex) =>
                    itemIndex !== index || item.kind !== 'set-variable'
                      ? item
                      : {
                          ...item,
                          variable: { $ref: { collection: 'variables', id: String(value) } },
                        },
                  ),
                )
              }
            >
              {variables.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </Select>
          ) : null}
          <Input
            value={effect.kind === 'run-lua-effect' ? effect.source : String(effect.value)}
            onChange={(event) =>
              onChange(
                effects.map((item, itemIndex) =>
                  itemIndex !== index
                    ? item
                    : item.kind === 'run-lua-effect'
                      ? { kind: 'run-lua-effect', source: event.currentTarget.value }
                      : { ...item, value: event.currentTarget.value },
                ),
              )
            }
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => onChange(effects.filter((_, itemIndex) => itemIndex !== index))}
          >
            Delete
          </Button>
        </div>
      ))}
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
  const [previewCollapsed, setPreviewCollapsed] = useState(() => {
    const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    return savedState ? (parseRoomEditorTabState(savedState)?.previewCollapsed ?? false) : false;
  });
  const editorPreviewLayout = usePreferencesStore((state) => state.editorPreviewLayout);
  const document = useProjectStore((state) => state.document);
  const roomId = tab.resource?.entityId;
  const project = isAuthoringProject(document) ? document : null;
  const record = roomId && project ? project.rooms[roomId] : null;
  const data = parseRoomData(record?.data) ?? defaultRoomData(record?.label ?? roomId ?? 'Room');
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
  useWorkbenchEditorTabState<RoomEditorTabState>(
    tab.id,
    useMemo(
      () => ({
        schema: ROOM_EDITOR_TAB_STATE_SCHEMA,
        schemaVersion: 2,
        captureTabState: () => ({
          schema: ROOM_EDITOR_TAB_STATE_SCHEMA,
          schemaVersion: 2,
          payload: {
            scroll: captureScrollViewState(scrollRef.current),
            previewCollapsed,
          },
        }),
        restoreTabState: (state) => {
          const parsed = parseRoomEditorTabState(state);
          if (!parsed) return;
          setPreviewCollapsed(parsed.previewCollapsed);
          window.requestAnimationFrame(() =>
            restoreScrollViewState(scrollRef.current, parsed.scroll),
          );
        },
      }),
      [previewCollapsed],
    ),
  );
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
  const rooms = Object.entries(project.rooms).map(([id, value]) => ({ id, label: value.label }));
  const assets = Object.entries(project.assets).map(([id, value]) => ({ id, label: value.label }));
  const selectedBackgroundItem = imageAssetItems.find(
    (item) => item.entityId === data.background.asset?.$ref.id,
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
      <div ref={scrollRef} data-room-editor-scroll className="h-full min-h-0 overflow-auto">
        <div className="mx-auto w-full max-w-6xl space-y-3 p-3 pb-8">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <h2 className="truncate text-xl font-semibold tracking-tight">{record.label}</h2>
              <Badge variant="outline" className="font-mono text-[10px]">
                {roomId}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{data.exits.length} exits</span>
              <span aria-hidden="true">·</span>
              <span>{data.placements.length} placements</span>
            </div>
          </header>

          <section
            className="overflow-hidden rounded-lg border bg-card/30"
            data-workbench-anchor="room.summary"
          >
            <div className="border-b px-3 py-2.5">
              <h3 className="text-sm font-semibold">Room details</h3>
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
                        sourcePath={selectedBackgroundItem.preview.sourcePath}
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
                <Select
                  value={data.background.fit}
                  onValueChange={(value) =>
                    commit(
                      {
                        ...data,
                        background: {
                          ...data.background,
                          fit: value as RoomData['background']['fit'],
                        },
                      },
                      'Update room background fit',
                    )
                  }
                >
                  {roomBackgroundFitValues.map((fit) => (
                    <SelectItem key={fit} value={fit}>
                      {fit.charAt(0).toUpperCase() + fit.slice(1)}
                    </SelectItem>
                  ))}
                </Select>
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

          <section
            className="overflow-hidden rounded-lg border bg-card/30"
            data-workbench-anchor="room.exits"
          >
            <div className="flex items-center justify-between gap-3 border-b px-3 py-2.5">
              <div>
                <h3 className="text-sm font-semibold">Exits</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Define where the player can travel from this room.
                </p>
              </div>
              <Button
                size="sm"
                onClick={() =>
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
                          direction: 'custom',
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
            <div className="space-y-2 p-3">
              {data.exits.length === 0 ? (
                <div className="rounded-lg border border-dashed px-4 py-8 text-center">
                  <ArrowRight className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-2 text-sm font-medium">No exits yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add an exit to connect this room to another room.
                  </p>
                </div>
              ) : null}
              {data.exits.map((exit) => {
                const targetRoom = rooms.find((room) => room.id === exit.target.$ref.id);
                return (
                  <article
                    key={exit.id}
                    data-workbench-anchor={`room.exit.${exit.id}`}
                    className="overflow-hidden rounded-lg border bg-background/80"
                  >
                    <div className="flex items-center gap-3 border-b bg-muted/15 px-3 py-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
                        <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {exit.label || 'Untitled exit'}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          To {targetRoom?.label ?? exit.target.$ref.id}
                        </p>
                      </div>
                      <Badge variant="outline" className="capitalize">
                        {exit.direction.replace('-', ' ')}
                      </Badge>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${exit.label || exit.id}`}
                        title="Delete exit"
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
                    <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-4">
                      <div className="space-y-1.5">
                        <Label>Label</Label>
                        <Input
                          value={exit.label}
                          onChange={(event) =>
                            replaceExit(exit.id, { label: event.currentTarget.value })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Destination</Label>
                        <Select
                          value={exit.target.$ref.id}
                          onValueChange={(value) =>
                            replaceExit(exit.id, { target: roomRoomRef(String(value)) })
                          }
                        >
                          {rooms.map((room) => (
                            <SelectItem key={room.id} value={room.id}>
                              {room.label}
                            </SelectItem>
                          ))}
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Direction</Label>
                        <Select
                          value={exit.direction}
                          onValueChange={(value) =>
                            replaceExit(exit.id, { direction: value as RoomExitData['direction'] })
                          }
                        >
                          {roomExitDirectionValues.map((direction) => (
                            <SelectItem key={direction} value={direction}>
                              {direction.charAt(0).toUpperCase() +
                                direction.slice(1).replace('-', ' ')}
                            </SelectItem>
                          ))}
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Internal ID</Label>
                        <Input
                          className="font-mono"
                          value={exit.id}
                          onChange={(event) =>
                            replaceExit(exit.id, { id: event.currentTarget.value })
                          }
                        />
                      </div>
                      <div className="space-y-1.5 border-t pt-3 md:col-span-2 xl:col-span-4">
                        <Label>Available when</Label>
                        <ConditionEditor
                          condition={exit.condition}
                          variables={variables}
                          onChange={(condition) => replaceExit(exit.id, { condition })}
                        />
                      </div>
                      <details className="group rounded-md border bg-muted/10 md:col-span-2 xl:col-span-4">
                        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium marker:text-muted-foreground">
                          Transition{' '}
                          {exit.transition ? `· ${exit.transition.kind}` : '· Project default'}
                        </summary>
                        <div className="grid gap-3 border-t p-3 md:grid-cols-3">
                          {exit.transition ? (
                            <>
                              <div className="space-y-1.5">
                                <Label>Style</Label>
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
                                  <SelectItem value="cut">Cut</SelectItem>
                                  <SelectItem value="fade">Fade</SelectItem>
                                  <SelectItem value="dissolve">Dissolve</SelectItem>
                                </Select>
                              </div>
                              <div className="space-y-1.5">
                                <Label>Duration (ms)</Label>
                                <Input
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
                              <div className="space-y-1.5">
                                <Label>Fade color</Label>
                                <Input
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
                                  : { kind: 'fade', durationMs: 250, color: null, skippable: true },
                              })
                            }
                          >
                            {exit.transition ? 'Use project default' : 'Override transition'}
                          </Button>
                        </div>
                      </details>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <div className="space-y-3 border-t pt-3">
            <div>
              <h3 className="text-sm font-semibold">Advanced room configuration</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Lifecycle hooks, placements, visual layers, cast, props, and composition.
              </p>
            </div>
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
              {(['beforeEnter', 'afterEnter', 'beforeLeave', 'afterLeave'] as const).map((hook) => (
                <div key={hook} className="space-y-1.5 border-t pt-3">
                  <Label>
                    {hook === 'beforeEnter'
                      ? 'Before entering'
                      : hook === 'afterEnter'
                        ? 'After entering'
                        : hook === 'beforeLeave'
                          ? 'Before leaving'
                          : 'After leaving'}
                  </Label>
                  <EffectsEditor
                    effects={data.lifecycle[hook]}
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
                  className="grid gap-3 rounded-lg border bg-background/60 p-3 md:grid-cols-3"
                >
                  <Input
                    value={placement.id}
                    onChange={(event) =>
                      replacePlacement(placement.id, { id: event.currentTarget.value })
                    }
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      commit(
                        {
                          ...data,
                          placements: data.placements.filter((item) => item.id !== placement.id),
                        },
                        'Delete room placement',
                      )
                    }
                  >
                    Delete
                  </Button>
                  {(['x', 'y', 'width', 'height'] as const).map((field) => (
                    <div key={field}>
                      <Label>{field}</Label>
                      <Input
                        value={String(placement.bounds[field])}
                        onChange={(event) =>
                          replacePlacement(placement.id, {
                            bounds: {
                              ...placement.bounds,
                              [field]: numberValue(
                                event.currentTarget.value,
                                placement.bounds[field],
                              ),
                            },
                          })
                        }
                      />
                    </div>
                  ))}
                  <div className="md:col-span-2">
                    <Label>Presentation label</Label>
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
                  {placement.presentation.label ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        replacePlacement(placement.id, {
                          presentation: { ...placement.presentation, label: null },
                        })
                      }
                    >
                      Clear label
                    </Button>
                  ) : null}
                  <div>
                    <Label>Presentation layout</Label>
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
              ))}
            </section>
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
            <section
              className="space-y-4 rounded-xl border bg-card/20 p-4"
              data-workbench-anchor="room.compose"
            >
              <div>
                <h3 className="text-sm font-semibold">Composition hook</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Optional script used to customize the final room composition.
                </p>
              </div>
              <Select
                value={data.compose?.script.$ref.id ?? '__none__'}
                onValueChange={(value) =>
                  commit(
                    {
                      ...data,
                      compose:
                        value === '__none__'
                          ? null
                          : {
                              script: { $ref: { collection: 'scripts', id: String(value) } },
                              additionalDependencies: data.compose?.additionalDependencies ?? {
                                targets: [],
                              },
                            },
                    },
                    'Update room composition hook',
                  )
                }
              >
                <SelectItem value="__none__">No composition hook</SelectItem>
                {scripts.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </Select>
              {data.compose ? (
                <LuaExplicitFallbackEditor
                  value={data.compose.additionalDependencies}
                  onChange={(additionalDependencies) =>
                    commit(
                      { ...data, compose: { ...data.compose!, additionalDependencies } },
                      'Update room composition dependencies',
                    )
                  }
                />
              ) : null}
              <p className="text-xs text-muted-foreground">
                The compiled hook has one fixed compose entrypoint, invoked when room composition is
                evaluated at runtime.
              </p>
            </section>
          </div>

          <SearchSelectorDialog
            open={backgroundSelectorOpen}
            title={t('selectors.backgroundImage.title')}
            placeholder={t('selectors.backgroundImage.placeholder')}
            emptyMessage={t('selectors.backgroundImage.empty')}
            items={imageAssetItems}
            selectedId={selectedBackgroundItem?.id ?? null}
            leadingMediaSize={{ width: '5rem', height: '3rem' }}
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
        </div>
      </div>
    </EditorPreviewSplit>
  );
}
