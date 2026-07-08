import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SourceEditor } from '@/components/source/SourceEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { DerivedPreviewPane } from '@/preview/DerivedPreviewPane';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import { buildCommandPaletteItems, filterSelectorItems } from '@/workspace/command-palette-search';
import {
  defaultRoomData,
  parseRoomData,
  roomAssetRef,
  roomBackgroundFitValues,
  roomMaterialRef,
  roomObjectRef,
  roomPathDirectionValues,
  roomPreviewBackgroundValues,
  roomRoomRef,
  validateRoomData,
  type RoomData,
  type RoomHotspotData,
  type RoomPathData,
} from '../../../shared/project-schema/authoring-rooms';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { buildRoomPreviewDocumentData, roomPreviewRevision } from '../../../shared/project-schema/room-project';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  captureScrollViewState,
  captureSourceEditorViewStates,
  isScrollViewState,
  parseSourceEditorViewStates,
  restoreScrollViewState,
  restoreSourceEditorViewStates,
  useSourceEditorViewStateRefs,
  useWorkbenchEditorTabState,
  type ScrollViewState,
  type SourceEditorViewStates,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

const ROOM_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.room';

interface RoomEditorTabStatePayload {
  scroll?: ScrollViewState;
  sourceViewStates?: SourceEditorViewStates;
  backgroundSelectorOpen?: boolean;
}

type RoomEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof ROOM_EDITOR_TAB_STATE_SCHEMA;
  payload?: RoomEditorTabStatePayload;
};

function parseRoomEditorTabState(value: WorkbenchTabStatePayload): RoomEditorTabStatePayload | null {
  if (value.schema !== ROOM_EDITOR_TAB_STATE_SCHEMA || typeof value.payload !== 'object' || value.payload === null || Array.isArray(value.payload)) return null;
  const payload = value.payload as Record<string, unknown>;
  return {
    scroll: isScrollViewState(payload.scroll) ? payload.scroll : undefined,
    sourceViewStates: parseSourceEditorViewStates(payload.sourceViewStates),
    backgroundSelectorOpen: typeof payload.backgroundSelectorOpen === 'boolean' ? payload.backgroundSelectorOpen : undefined,
  };
}

function commitRoom(roomId: string, next: RoomData, label: string) {
  return useCommandStore.getState().executeCommand({
    type: 'room.replaceData',
    label,
    payload: { roomId, data: next },
  });
}

function nextUniqueId(existing: Iterable<string>, base: string) {
  const used = new Set(existing);
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function toNumber(value: string, fallback: number) {
  const next = Number.parseFloat(value);
  return Number.isFinite(next) ? next : fallback;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function refValue(ref: { $ref: { id: string } } | null | undefined) {
  return ref?.$ref.id ?? '__none__';
}

function sortPaths(paths: RoomPathData[]) {
  return [...paths].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

export function RoomEditor({ tab }: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const [backgroundSelectorOpen, setBackgroundSelectorOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sourceEditors = useSourceEditorViewStateRefs<'description' | 'beforeEnter' | 'afterEnter' | 'beforeLeave' | 'afterLeave'>();
  const projectDocument = useProjectStore((state) => state.document);
  const roomId = tab.resource?.entityId;
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const record = roomId && project ? project.rooms[roomId] : null;
  const parsedData = parseRoomData(record?.data);
  const data = parsedData ?? defaultRoomData(record?.label ?? roomId ?? 'Room');
  const diagnostics = useMemo(() => project && record && roomId ? validateRoomData(project, roomId, record) : [], [project, record, roomId]);
  const selectorItems = useMemo(() => buildCommandPaletteItems(project, t), [project, t]);
  const backgroundImageItems = useMemo(() => filterSelectorItems(selectorItems, { collections: ['assets'], assetKinds: ['image'], includeActions: false }), [selectorItems]);
  const materials = project ? Object.entries(project.materials).map(([id, material]) => ({ id, label: material.label })) : [];
  const targetRooms = project ? Object.entries(project.rooms).map(([id, room]) => ({ id, label: room.label })) : [];
  const objects = project ? Object.entries(project.objects).map(([id, object]) => ({ id, label: object.label })) : [];

  useWorkbenchEditorTabState<RoomEditorTabState>(tab.id, useMemo(() => ({
    captureTabState: () => ({
      schema: ROOM_EDITOR_TAB_STATE_SCHEMA,
      schemaVersion: 1,
      payload: {
        scroll: captureScrollViewState(scrollRef.current),
        sourceViewStates: captureSourceEditorViewStates(sourceEditors.refs.current),
        backgroundSelectorOpen,
      },
    }),
    restoreTabState: (state: RoomEditorTabState) => {
      const parsed = parseRoomEditorTabState(state);
      if (!parsed) return;
      if (parsed.backgroundSelectorOpen !== undefined) setBackgroundSelectorOpen(parsed.backgroundSelectorOpen);
      window.requestAnimationFrame(() => {
        restoreScrollViewState(scrollRef.current, parsed.scroll);
        restoreSourceEditorViewStates(sourceEditors.refs.current, parsed.sourceViewStates);
      });
    },
  }), [backgroundSelectorOpen, sourceEditors.refs]));

  if (!roomId || !record || !project) return <div className="p-4 text-sm text-muted-foreground">Room record not found.</div>;

  const activeRoomId = roomId;
  const activeRecord = record;
  const activeProject = project;
  const revision = roomPreviewRevision(activeProject, activeRoomId);
  const previewDocument = {
    kind: 'room-preview' as const,
    recordId: activeRoomId,
    revision,
    data: buildRoomPreviewDocumentData(activeProject, activeRoomId),
  };
  const selectedHotspot = data.preview.selectedHotspotId
    ? data.hotspots.find((hotspot) => hotspot.id === data.preview.selectedHotspotId) ?? null
    : data.hotspots[0] ?? null;
  const selectedBackgroundAssetId = data.background.asset?.$ref.id ?? null;
  const selectedBackgroundAsset = selectedBackgroundAssetId ? activeProject.assets[selectedBackgroundAssetId] : null;

  function commit(next: RoomData, label = 'Update room') {
    commitRoom(activeRoomId, next, label);
  }

  function patchBackground(patch: Partial<RoomData['background']>) {
    commit({ ...data, background: { ...data.background, ...patch } }, 'Update room background');
  }

  function patchScripts(patch: Partial<RoomData['scripts']>) {
    commit({ ...data, scripts: { ...data.scripts, ...patch } }, 'Update room script');
  }

  function patchPreview(patch: Partial<RoomData['preview']>) {
    commit({ ...data, preview: { ...data.preview, ...patch } }, 'Update room preview');
  }

  function replacePath(pathId: string, patch: Partial<RoomPathData>) {
    commit({ ...data, paths: data.paths.map((path) => path.id === pathId ? { ...path, ...patch } : path) }, 'Update room path');
  }

  function addPath() {
    const id = nextUniqueId(data.paths.map((path) => path.id), 'path');
    commit({
      ...data,
      paths: [...data.paths, { id, label: 'Path', direction: 'custom', target: null, enabled: true, condition: '', order: data.paths.length }],
    }, 'Add room path');
  }

  function deletePath(pathId: string) {
    commit({ ...data, paths: data.paths.filter((path) => path.id !== pathId) }, 'Delete room path');
  }

  function replaceHotspot(hotspotId: string, patch: Partial<RoomHotspotData>) {
    commit({ ...data, hotspots: data.hotspots.map((hotspot) => hotspot.id === hotspotId ? { ...hotspot, ...patch } : hotspot) }, 'Update room hotspot');
  }

  function addHotspot() {
    const id = nextUniqueId(data.hotspots.map((hotspot) => hotspot.id), 'hotspot');
    const hotspot: RoomHotspotData = {
      id,
      label: 'Hotspot',
      object: null,
      bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      placeInRoom: true,
      description: '',
      script: '',
    };
    commit({ ...data, hotspots: [...data.hotspots, hotspot], preview: { ...data.preview, selectedHotspotId: id } }, 'Add room hotspot');
  }

  function deleteHotspot(hotspotId: string) {
    const remaining = data.hotspots.filter((hotspot) => hotspot.id !== hotspotId);
    commit({
      ...data,
      hotspots: remaining,
      preview: { ...data.preview, selectedHotspotId: data.preview.selectedHotspotId === hotspotId ? (remaining[0]?.id ?? null) : data.preview.selectedHotspotId },
    }, 'Delete room hotspot');
  }

  return (
    <div ref={scrollRef} className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4" data-room-editor-scroll>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{activeRecord.label}</h2>
            <Badge variant="outline">{activeRoomId}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Room background, description text, enter/leave hooks, navigation paths, hotspots, and live preview.</p>
        </div>
      </div>

      {!parsedData ? <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">Room data was invalid; showing editable defaults until you apply a change.</div> : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <section className="grid gap-3 rounded border p-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Display name</Label>
              <Input value={data.displayName} onChange={(event) => commit({ ...data, displayName: event.currentTarget.value }, 'Update room display name')} />
            </div>
            <div className="space-y-1">
              <Label>Description format</Label>
              <Select value={data.description.format} onValueChange={(value) => commit({ ...data, description: { ...data.description, format: value as RoomData['description']['format'] } }, 'Update room description format')}>
                <SelectItem value="active-text">ActiveText</SelectItem>
                <SelectItem value="plain">Plain</SelectItem>
              </Select>
            </div>
          </section>

          <section className="grid gap-3 rounded border p-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1">
              <Label>Background image</Label>
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="h-8 min-w-0 flex-1 justify-start px-2 text-left text-xs font-normal" onClick={() => setBackgroundSelectorOpen(true)}>
                  <span className="truncate">{selectedBackgroundAsset ? `${selectedBackgroundAsset.label || selectedBackgroundAssetId} (${selectedBackgroundAssetId})` : t('selectors.none.backgroundImage')}</span>
                </Button>
                {selectedBackgroundAssetId ? <Button type="button" size="sm" variant="outline" onClick={() => patchBackground({ asset: null })}>{t('selectors.clear')}</Button> : null}
              </div>
            </div>
            <div className="space-y-1">
              <Label>Background material</Label>
              <Select value={refValue(data.background.material)} onValueChange={(value) => patchBackground({ material: value === '__none__' ? null : roomMaterialRef(String(value)) })}>
                <SelectItem value="__none__">No material</SelectItem>
                {materials.map((material) => <SelectItem key={material.id} value={material.id}>{material.label} ({material.id})</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Fit</Label>
              <Select value={data.background.fit} onValueChange={(value) => patchBackground({ fit: value as RoomData['background']['fit'] })}>
                {roomBackgroundFitValues.map((fit) => <SelectItem key={fit} value={fit}>{fit}</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Fallback color</Label>
              <Input value={data.background.color ?? ''} onChange={(event) => patchBackground({ color: event.currentTarget.value.trim() || null })} placeholder="#111827 or empty" />
            </div>
          </section>

          <section className="space-y-2 rounded border p-3">
            <Label>Description source</Label>
            <SourceEditor ref={sourceEditors.refFor('description')} className="h-56" language="text" value={data.description.source} onChange={(source) => commit({ ...data, description: { ...data.description, source } }, 'Update room description')} />
          </section>

          <section className="grid gap-3 rounded border p-3 lg:grid-cols-2">
            <div className="space-y-2">
              <Label>Before enter Lua</Label>
              <SourceEditor ref={sourceEditors.refFor('beforeEnter')} className="h-36" language="lua" value={data.scripts.beforeEnter} onChange={(beforeEnter) => patchScripts({ beforeEnter })} />
            </div>
            <div className="space-y-2">
              <Label>After enter Lua</Label>
              <SourceEditor ref={sourceEditors.refFor('afterEnter')} className="h-36" language="lua" value={data.scripts.afterEnter} onChange={(afterEnter) => patchScripts({ afterEnter })} />
            </div>
            <div className="space-y-2">
              <Label>Before leave Lua</Label>
              <SourceEditor ref={sourceEditors.refFor('beforeLeave')} className="h-36" language="lua" value={data.scripts.beforeLeave} onChange={(beforeLeave) => patchScripts({ beforeLeave })} />
            </div>
            <div className="space-y-2">
              <Label>After leave Lua</Label>
              <SourceEditor ref={sourceEditors.refFor('afterLeave')} className="h-36" language="lua" value={data.scripts.afterLeave} onChange={(afterLeave) => patchScripts({ afterLeave })} />
            </div>
          </section>

          <section className="space-y-3 rounded border p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Navigation paths</h3>
              <Button size="sm" variant="outline" onClick={addPath}>Add Path</Button>
            </div>
            {sortPaths(data.paths).map((path) => (
              <div key={path.id} className="grid gap-2 rounded border p-2 md:grid-cols-2 xl:grid-cols-6">
                <div className="space-y-1">
                  <Label>ID</Label>
                  <Input value={path.id} onChange={(event) => replacePath(path.id, { id: event.currentTarget.value })} />
                </div>
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input value={path.label} onChange={(event) => replacePath(path.id, { label: event.currentTarget.value })} />
                </div>
                <div className="space-y-1">
                  <Label>Direction</Label>
                  <Select value={path.direction} onValueChange={(value) => replacePath(path.id, { direction: value as RoomPathData['direction'] })}>
                    {roomPathDirectionValues.map((direction) => <SelectItem key={direction} value={direction}>{direction}</SelectItem>)}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Target room</Label>
                  <Select value={refValue(path.target)} onValueChange={(value) => replacePath(path.id, { target: value === '__none__' ? null : roomRoomRef(String(value)) })}>
                    <SelectItem value="__none__">No target</SelectItem>
                    {targetRooms.map((room) => <SelectItem key={room.id} value={room.id}>{room.label} ({room.id})</SelectItem>)}
                  </Select>
                </div>
                <div className="flex items-center gap-2 self-end">
                  <Switch checked={path.enabled} onCheckedChange={(checked) => replacePath(path.id, { enabled: Boolean(checked) })} />
                  <Label>Enabled</Label>
                </div>
                <div className="flex items-end">
                  <Button size="sm" variant="outline" onClick={() => deletePath(path.id)}>Delete</Button>
                </div>
                <div className="space-y-1 md:col-span-2 xl:col-span-6">
                  <Label>Condition Lua</Label>
                  <Input value={path.condition} onChange={(event) => replacePath(path.id, { condition: event.currentTarget.value })} placeholder="return true" />
                </div>
              </div>
            ))}
            {data.paths.length === 0 ? <div className="rounded border p-2 text-xs text-muted-foreground">No paths yet.</div> : null}
          </section>

          <section className="space-y-3 rounded border p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Hotspots</h3>
              <Button size="sm" variant="outline" onClick={addHotspot}>Add Hotspot</Button>
            </div>
            {data.hotspots.map((hotspot) => (
              <div key={hotspot.id} className="grid gap-2 rounded border p-2 md:grid-cols-2 xl:grid-cols-6">
                <div className="space-y-1">
                  <Label>ID</Label>
                  <Input value={hotspot.id} onFocus={() => patchPreview({ selectedHotspotId: hotspot.id })} onChange={(event) => replaceHotspot(hotspot.id, { id: event.currentTarget.value })} />
                </div>
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input value={hotspot.label} onFocus={() => patchPreview({ selectedHotspotId: hotspot.id })} onChange={(event) => replaceHotspot(hotspot.id, { label: event.currentTarget.value })} />
                </div>
                <div className="space-y-1 xl:col-span-2">
                  <Label>Object</Label>
                  <Select value={refValue(hotspot.object)} onValueChange={(value) => replaceHotspot(hotspot.id, { object: value === '__none__' ? null : roomObjectRef(String(value)) })}>
                    <SelectItem value="__none__">Free-standing hotspot</SelectItem>
                    {objects.map((object) => <SelectItem key={object.id} value={object.id}>{object.label} ({object.id})</SelectItem>)}
                  </Select>
                </div>
                <div className="flex items-center gap-2 self-end">
                  <Switch checked={hotspot.placeInRoom} onCheckedChange={(checked) => replaceHotspot(hotspot.id, { placeInRoom: Boolean(checked) })} />
                  <Label>Placed</Label>
                </div>
                <div className="flex items-end">
                  <Button size="sm" variant="outline" onClick={() => deleteHotspot(hotspot.id)}>Delete</Button>
                </div>
                {(['x', 'y', 'width', 'height'] as const).map((field) => (
                  <div key={field} className="space-y-1">
                    <Label>{field}</Label>
                    <Input
                      value={String(hotspot.bounds[field])}
                      onFocus={() => patchPreview({ selectedHotspotId: hotspot.id })}
                      onChange={(event) => replaceHotspot(hotspot.id, { bounds: { ...hotspot.bounds, [field]: clamp01(toNumber(event.currentTarget.value, hotspot.bounds[field])) } })}
                    />
                  </div>
                ))}
                <div className="space-y-1 md:col-span-2">
                  <Label>Description</Label>
                  <Input value={hotspot.description} onChange={(event) => replaceHotspot(hotspot.id, { description: event.currentTarget.value })} />
                </div>
                <div className="space-y-1 md:col-span-2 xl:col-span-6">
                  <Label>Hotspot script Lua</Label>
                  <Input value={hotspot.script} onChange={(event) => replaceHotspot(hotspot.id, { script: event.currentTarget.value })} placeholder="return true" />
                </div>
              </div>
            ))}
            {data.hotspots.length === 0 ? <div className="rounded border p-2 text-xs text-muted-foreground">No hotspots yet.</div> : null}
          </section>
        </div>

        <aside className="space-y-4 rounded border bg-muted/20 p-4">
          <div className="h-72 overflow-hidden rounded border bg-background">
            <DerivedPreviewPane
              ownerTabId={tab.id}
              previewMode="room"
              previewDocument={previewDocument}
            />
          </div>
          <div className="relative h-48 overflow-hidden rounded border bg-background">
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Placement canvas</div>
            {data.preview.showHotspots ? data.hotspots.map((hotspot) => (
              <button
                key={hotspot.id}
                type="button"
                className={`absolute rounded border bg-primary/10 px-1 text-[10px] ${selectedHotspot?.id === hotspot.id ? 'border-primary' : 'border-primary/40'}`}
                style={{
                  left: `${hotspot.bounds.x * 100}%`,
                  top: `${hotspot.bounds.y * 100}%`,
                  width: `${hotspot.bounds.width * 100}%`,
                  height: `${hotspot.bounds.height * 100}%`,
                }}
                onClick={() => patchPreview({ selectedHotspotId: hotspot.id })}
              >
                {hotspot.label}
              </button>
            )) : null}
          </div>
          <div className="grid gap-3 text-xs text-muted-foreground">
            <div><span className="font-medium text-foreground">Background:</span> {data.background.asset?.$ref.id ?? 'None'}</div>
            <div><span className="font-medium text-foreground">Material:</span> {data.background.material?.$ref.id ?? 'None'}</div>
            <div><span className="font-medium text-foreground">Selected hotspot:</span> {selectedHotspot?.label ?? 'None'}</div>
          </div>
          <div className="space-y-2">
            <Label>Preview background</Label>
            <Select value={data.preview.background} onValueChange={(value) => patchPreview({ background: value as RoomData['preview']['background'] })}>
              {roomPreviewBackgroundValues.map((background) => <SelectItem key={background} value={background}>{background}</SelectItem>)}
            </Select>
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={data.preview.showHotspots} onCheckedChange={(checked) => patchPreview({ showHotspots: Boolean(checked) })} />
              Show hotspots
            </label>
          </div>
          {diagnostics.length > 0 ? (
            <div className="rounded border p-2 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">Diagnostics</div>
              <div className="mt-1 space-y-1">
                {diagnostics.slice(0, 6).map((item) => <div key={`${item.path}:${item.message}`}>{item.severity}: {item.message}</div>)}
              </div>
            </div>
          ) : null}
          <div className="overflow-hidden font-mono text-[10px] text-muted-foreground">revision {revision.slice(0, 80)}</div>
        </aside>
      </div>
      <SearchSelectorDialog
        open={backgroundSelectorOpen}
        title={t('selectors.backgroundImage.title')}
        placeholder={t('selectors.backgroundImage.placeholder')}
        emptyMessage={t('selectors.backgroundImage.empty')}
        items={backgroundImageItems}
        selectedId={selectedBackgroundAssetId ? `record:assets:${selectedBackgroundAssetId}` : null}
        limit={12}
        leadingMediaSize={{ width: '6rem', height: '4.5rem' }}
        onSelect={(item) => {
          if (!item.entityId) return;
          patchBackground({ asset: roomAssetRef(item.entityId) });
        }}
        onOpenChange={setBackgroundSelectorOpen}
      />
    </div>
  );
}
