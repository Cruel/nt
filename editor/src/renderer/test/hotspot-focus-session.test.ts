import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { useCommandStore } from '@/commands/command-store';
import {
  createHotspotFocusHistory,
  deleteHotspotGeometry,
  mergeHotspotFocusGeometry,
  redoHotspotGeometry,
  setHotspotGeometryBounds,
  undoHotspotGeometry,
} from '@/components/hotspots/hotspot-focus-session';
import {
  HOTSPOT_FOCUS_DRAFT_SCHEMA,
  useHotspotFocusStore,
} from '@/components/hotspots/hotspot-focus-store';
import type { EditableHotspot } from '@/components/hotspots/hotspot-types';
import { useProjectStore } from '@/project/project-store';
import { serializeDraftDirtyState, useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { tabCloseRequiresDirtyPrompt } from '@/workbench/close-guard-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultInteractableData,
  interactableAssetRef,
  parseInteractableData,
} from '../../shared/project-schema/authoring-interactables';
import {
  defaultRoomData,
  parseRoomData,
  type RoomHotspotData,
} from '../../shared/project-schema/authoring-rooms';
import { editorI18n } from '@/i18n';

const originalBounds = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
const movedBounds = { x: 0.2, y: 0.25, width: 0.3, height: 0.4 };

function hotspot(id = 'door'): EditableHotspot {
  return {
    id,
    label: 'Door',
    condition: { kind: 'always' },
    inputOrder: 0,
    highlight: { kind: 'default' },
    target: { kind: 'none' },
    shape: { kind: 'rect', bounds: originalBounds },
  };
}

function projectWithRoomHotspot() {
  const project = createAuthoringProject();
  const room = defaultRoomData('Foyer');
  room.hotspots = [hotspot() as RoomHotspotData];
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', traits: [], data: room };
  return project;
}

function projectWithRoomHotspotImage() {
  const project = projectWithRoomHotspot();
  project.assets.background = {
    id: 'background',
    label: 'Background',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/background.png' },
      aliases: [],
      byteSize: 64,
      contentHash: `sha256:${'a'.repeat(64)}`,
      imageMetadata: { width: 100, height: 100, hasAlpha: true, orientation: 1 },
    },
  };
  project.assets.replacement = {
    id: 'replacement',
    label: 'Replacement',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/replacement.png' },
      aliases: [],
      byteSize: 128,
      contentHash: `sha256:${'b'.repeat(64)}`,
      imageMetadata: { width: 200, height: 100, hasAlpha: true, orientation: 1 },
    },
  };
  const room = parseRoomData(project.rooms.foyer?.data);
  if (!room) throw new Error('Expected Room data.');
  room.background.asset = { $ref: { collection: 'assets', id: 'background' } };
  project.rooms.foyer = { ...project.rooms.foyer!, data: room };
  return project;
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useDraftDirtyStore.getState().resetDraftDirty();
  useWorkbenchStore.getState().resetWorkbench();
  useHotspotFocusStore.setState({ sessionsByTabId: {}, rememberedViewsByTarget: {} });
});

describe('Hotspot Focus session', () => {
  it('undoes and redoes geometry locally and deletes the complete hotspot entity', () => {
    const initial = [hotspot()];
    const moved = setHotspotGeometryBounds(createHotspotFocusHistory(initial), 'door', movedBounds);
    expect(moved.present[0]?.shape?.bounds).toEqual(movedBounds);

    const undone = undoHotspotGeometry(moved);
    expect(undone.present[0]?.shape?.bounds).toEqual(originalBounds);
    expect(redoHotspotGeometry(undone).present[0]?.shape?.bounds).toEqual(movedBounds);

    expect(deleteHotspotGeometry(moved, 'door').present).toEqual([]);
  });

  it('merges geometry onto the latest semantic records without discarding concurrent semantic edits', () => {
    const initial = [hotspot()];
    const current = [
      {
        ...hotspot(),
        shape: { kind: 'rect' as const, bounds: movedBounds },
      },
      { ...hotspot('window'), label: 'Window', inputOrder: 1 },
    ];
    const latest = [
      { ...hotspot(), label: 'Renamed Door', inputOrder: 7 },
      { ...hotspot('external'), label: 'External', inputOrder: 8 },
    ];

    const merged = mergeHotspotFocusGeometry(initial, current, latest);

    expect(merged).toEqual([
      {
        ...latest[0],
        shape: { kind: 'rect', bounds: movedBounds },
      },
      latest[1],
      current[1],
    ]);
  });

  it('rejects an edit when another Focus session deleted the same hotspot', () => {
    const initial = [hotspot()];
    const current = [
      {
        ...hotspot(),
        shape: { kind: 'rect' as const, bounds: movedBounds },
      },
    ];

    expect(mergeHotspotFocusGeometry(initial, current, [])).toBeNull();
  });

  it('preserves untouched concurrent geometry and rejects conflicting edits to the same shape', () => {
    const initial = [hotspot('door'), { ...hotspot('window'), inputOrder: 1 }];
    const draft = [
      { ...initial[0], shape: { kind: 'rect' as const, bounds: movedBounds } },
      initial[1],
    ];
    const externalWindowBounds = { x: 0.6, y: 0.1, width: 0.2, height: 0.2 };
    const latest = [
      initial[0],
      { ...initial[1], shape: { kind: 'rect' as const, bounds: externalWindowBounds } },
    ];

    expect(
      mergeHotspotFocusGeometry(initial, draft, latest)?.map((item) => item.shape?.bounds),
    ).toEqual([movedBounds, externalWindowBounds]);

    const conflictingDoorBounds = { x: 0.7, y: 0.2, width: 0.2, height: 0.2 };
    expect(
      mergeHotspotFocusGeometry(initial, draft, [
        { ...initial[0], shape: { kind: 'rect' as const, bounds: conflictingDoorBounds } },
        initial[1],
      ]),
    ).toBeNull();
  });

  it('keeps Rectangle active after creation and exposes the edited draft to close resolution', () => {
    useProjectStore.getState().loadUnsavedProjectDocument(projectWithRoomHotspot());
    const store = useHotspotFocusStore.getState();
    store.start({
      tabId: 'room-tab',
      ownerKind: 'room',
      ownerId: 'foyer',
      assetId: null,
      mode: 'rectangles',
      items: [hotspot()],
    });
    store.setTool('room-tab', 'draw-rect');
    store.add('room-tab', { ...hotspot('window'), label: 'Window' });

    const session = useHotspotFocusStore.getState().sessionsByTabId['room-tab'];
    expect(session?.tool).toBe('draw-rect');
    expect(session?.selectedHotspotId).toBe('window');
    const draft = useDraftDirtyStore.getState().entriesByKey['hotspot-focus:room-tab'];
    expect(draft?.dirty).toBe(true);
    expect(draft?.apply).toBeTypeOf('function');
    expect(draft?.discard).toBeTypeOf('function');
    expect(draft?.schema).toBe(HOTSPOT_FOCUS_DRAFT_SCHEMA);
    expect(draft?.payload).toMatchObject({ schemaVersion: 1 });
  });

  it('serializes and restores a dirty Focus draft with live apply/discard callbacks', () => {
    useProjectStore.getState().loadUnsavedProjectDocument(projectWithRoomHotspot());
    const store = useHotspotFocusStore.getState();
    store.start({
      tabId: 'room-tab',
      ownerKind: 'room',
      ownerId: 'foyer',
      assetId: null,
      mode: 'rectangles',
      items: [hotspot()],
    });
    store.setBounds('room-tab', 'door', movedBounds);
    const serialized = serializeDraftDirtyState(useDraftDirtyStore.getState());

    useHotspotFocusStore.setState({ sessionsByTabId: {}, rememberedViewsByTarget: {} });
    useDraftDirtyStore.getState().resetDraftDirty();
    useDraftDirtyStore.getState().restoreSerializedDrafts(serialized);

    expect(
      useHotspotFocusStore.getState().restore({
        tabId: 'room-tab',
        ownerKind: 'room',
        ownerId: 'foyer',
        assetId: null,
        mode: 'rectangles',
        items: [hotspot()],
      }),
    ).toBe(true);
    expect(
      useHotspotFocusStore.getState().sessionsByTabId['room-tab']?.history.present[0]?.shape
        ?.bounds,
    ).toEqual(movedBounds);
    const restored = useDraftDirtyStore.getState().entriesByKey['hotspot-focus:room-tab'];
    expect(restored?.apply).toBeTypeOf('function');
    expect(restored?.discard).toBeTypeOf('function');
  });

  it('requires close resolution for a tab-local Focus draft even when a duplicate record view remains', () => {
    useProjectStore.getState().loadUnsavedProjectDocument(projectWithRoomHotspot());
    const workbench = useWorkbenchStore.getState();
    const resource = {
      kind: 'record' as const,
      stableId: 'record:rooms:foyer',
      collection: 'rooms',
      entityId: 'foyer',
    };
    workbench.openTab({ id: 'room-a', title: 'Foyer A', editorType: 'room-detail', resource });
    workbench.openTab(
      { id: 'room-b', title: 'Foyer B', editorType: 'room-detail', resource },
      { duplicate: true },
    );
    const store = useHotspotFocusStore.getState();
    store.start({
      tabId: 'room-a',
      ownerKind: 'room',
      ownerId: 'foyer',
      assetId: null,
      mode: 'rectangles',
      items: [hotspot()],
    });
    store.setBounds('room-a', 'door', movedBounds);

    expect(tabCloseRequiresDirtyPrompt('room-a', new Set(['room-a']))).toBe(true);
  });

  it('rejects malformed recovered hotspot records instead of restoring them', () => {
    useProjectStore.getState().loadUnsavedProjectDocument(projectWithRoomHotspot());
    useDraftDirtyStore.getState().restoreSerializedDrafts({
      'hotspot-focus:room-tab': {
        schema: HOTSPOT_FOCUS_DRAFT_SCHEMA,
        tabId: 'room-tab',
        label: 'Hotspot geometry',
        payload: {
          schemaVersion: 1,
          ownerKind: 'room',
          ownerId: 'foyer',
          assetId: null,
          mode: 'rectangles',
          initialItems: [null],
          currentItems: [null],
          selectedHotspotId: null,
          tool: 'select',
          camera: { zoom: 1, pan: { x: 0, y: 0 } },
          cameraInitialized: true,
        },
      },
    });

    expect(
      useHotspotFocusStore.getState().restore({
        tabId: 'room-tab',
        ownerKind: 'room',
        ownerId: 'foyer',
        assetId: null,
        mode: 'rectangles',
        items: [hotspot()],
      }),
    ).toBe(false);
    expect(useHotspotFocusStore.getState().sessionsByTabId['room-tab']).toBeUndefined();
    expect(useDraftDirtyStore.getState().entriesByKey['hotspot-focus:room-tab']).toBeUndefined();
  });

  it('commits all geometry edits as one project undo step', () => {
    const project = projectWithRoomHotspot();
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const store = useHotspotFocusStore.getState();
    store.start({
      tabId: 'room-tab',
      ownerKind: 'room',
      ownerId: 'foyer',
      assetId: null,
      mode: 'rectangles',
      items: [hotspot()],
    });
    store.setBounds('room-tab', 'door', movedBounds);
    store.add('room-tab', { ...hotspot('window'), label: 'Window' });

    expect(store.commit('room-tab')).toBe(true);
    expect(useCommandStore.getState().history.entries).toHaveLength(1);
    const committed = useProjectStore.getState().document;
    if (!committed || typeof committed !== 'object' || !('rooms' in committed))
      throw new Error('Expected project document.');
    const room = parseRoomData((committed as typeof project).rooms.foyer?.data);
    expect(room?.hotspots).toHaveLength(2);
    expect(room?.hotspots[0]?.shape.bounds).toEqual(movedBounds);

    expect(useCommandStore.getState().undo().ok).toBe(true);
    const undone = useProjectStore.getState().document as typeof project;
    const undoneRoom = parseRoomData(undone.rooms.foyer?.data);
    expect(undoneRoom?.hotspots).toHaveLength(1);
    expect(undoneRoom?.hotspots[0]?.shape.bounds).toEqual(originalBounds);
  });

  it('refuses stale geometry when another edit replaces the Room background source', () => {
    const project = projectWithRoomHotspotImage();
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const store = useHotspotFocusStore.getState();
    store.start({
      tabId: 'room-tab',
      ownerKind: 'room',
      ownerId: 'foyer',
      assetId: 'background',
      mode: 'rectangles',
      items: [hotspot()],
    });
    store.setBounds('room-tab', 'door', movedBounds);
    expect(
      useDraftDirtyStore.getState().entriesByKey['hotspot-focus:room-tab']?.payload,
    ).toMatchObject({
      sourceIdentity: {
        sourcePath: 'assets/images/background.png',
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteSize: 64,
        imageMetadata: { width: 100, height: 100, hasAlpha: true, orientation: 1 },
      },
    });

    const sourceChange = useCommandStore.getState().executeCommand({
      type: 'project.applyPatch',
      label: 'Replace Room background',
      payload: [
        {
          op: 'replace',
          path: '/rooms/foyer/data/background/asset',
          value: { $ref: { collection: 'assets', id: 'replacement' } },
        },
      ],
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    expect(sourceChange.ok).toBe(true);

    expect(store.commit('room-tab')).toBe(false);
    expect(useHotspotFocusStore.getState().sessionsByTabId['room-tab']).toBeDefined();
    expect(useDraftDirtyStore.getState().entriesByKey['hotspot-focus:room-tab']?.dirty).toBe(true);
    expect(useCommandStore.getState().history.entries).toHaveLength(1);

    const current = useProjectStore.getState().document as typeof project;
    expect(parseRoomData(current.rooms.foyer?.data)?.hotspots[0]?.shape.bounds).toEqual(
      originalBounds,
    );
  });

  it('refuses stale geometry when the source Asset is replaced in place', () => {
    const project = projectWithRoomHotspotImage();
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const store = useHotspotFocusStore.getState();
    store.start({
      tabId: 'room-tab',
      ownerKind: 'room',
      ownerId: 'foyer',
      assetId: 'background',
      mode: 'rectangles',
      items: [hotspot()],
    });
    store.setBounds('room-tab', 'door', movedBounds);

    const sourceChange = useCommandStore.getState().executeCommand({
      type: 'project.applyPatch',
      label: 'Reimport Room background',
      payload: [
        {
          op: 'replace',
          path: '/assets/background/data/contentHash',
          value: `sha256:${'c'.repeat(64)}`,
        },
      ],
      originSaveUnitId: 'record:assets:background',
      persistencePolicy: 'manual-save',
    });
    expect(sourceChange.ok).toBe(true);

    expect(store.commit('room-tab')).toBe(false);
    expect(useHotspotFocusStore.getState().sessionsByTabId['room-tab']).toBeDefined();
    expect(useCommandStore.getState().history.entries).toHaveLength(1);
  });

  it('refuses stale geometry when another edit replaces the Interactable sprite source', () => {
    const project = projectWithRoomHotspotImage();
    const data = defaultInteractableData('Door');
    const interactableHotspot = {
      id: 'door',
      label: 'Door',
      condition: { kind: 'always' as const },
      inputOrder: 0,
      highlight: { kind: 'default' as const },
      target: { kind: 'owner' as const },
      shape: { kind: 'rect' as const, bounds: originalBounds },
    };
    data.presentation.sprite = interactableAssetRef('background');
    data.presentation.hotspots = {
      kind: 'custom',
      hotspots: [interactableHotspot],
    };
    project.interactables.door = { id: 'door', label: 'Door', traits: [], data };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const store = useHotspotFocusStore.getState();
    store.start({
      tabId: 'interactable-tab',
      ownerKind: 'interactable',
      ownerId: 'door',
      assetId: 'background',
      mode: 'rectangles',
      items: [interactableHotspot],
    });
    store.setBounds('interactable-tab', 'door', movedBounds);

    const sourceChange = useCommandStore.getState().executeCommand({
      type: 'project.applyPatch',
      label: 'Replace Interactable sprite',
      payload: [
        {
          op: 'replace',
          path: '/interactables/door/data/presentation/sprite',
          value: interactableAssetRef('replacement'),
        },
      ],
      originSaveUnitId: 'record:interactables:door',
      persistencePolicy: 'manual-save',
    });
    expect(sourceChange.ok).toBe(true);

    expect(store.commit('interactable-tab')).toBe(false);
    expect(useHotspotFocusStore.getState().sessionsByTabId['interactable-tab']).toBeDefined();
    const current = useProjectStore.getState().document as typeof project;
    const currentInteractable = parseInteractableData(current.interactables.door?.data);
    expect(
      currentInteractable?.presentation.hotspots.kind === 'custom'
        ? currentInteractable.presentation.hotspots.hotspots[0]?.shape.bounds
        : null,
    ).toEqual(originalBounds);
  });

  it('localizes Focus draft and project-command labels', async () => {
    await editorI18n.changeLanguage('pseudo');
    const project = projectWithRoomHotspot();
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const store = useHotspotFocusStore.getState();
    store.start({
      tabId: 'room-tab',
      ownerKind: 'room',
      ownerId: 'foyer',
      assetId: null,
      mode: 'rectangles',
      items: [hotspot()],
    });
    store.setBounds('room-tab', 'door', movedBounds);
    expect(useDraftDirtyStore.getState().entriesByKey['hotspot-focus:room-tab']?.label).toBe(
      '⟦Hotspot geometry⟧',
    );

    expect(store.commit('room-tab')).toBe(true);
    expect(useCommandStore.getState().history.entries[0]?.label).toBe(
      '⟦Edit Room hotspot geometry⟧',
    );
  });

  it('cancels the Focus draft without project mutation or command history', () => {
    const project = projectWithRoomHotspot();
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const store = useHotspotFocusStore.getState();
    store.start({
      tabId: 'room-tab',
      ownerKind: 'room',
      ownerId: 'foyer',
      assetId: null,
      mode: 'rectangles',
      items: [hotspot()],
    });
    store.setBounds('room-tab', 'door', movedBounds);

    expect(store.discard('room-tab')).toBe(true);
    expect(useCommandStore.getState().history.entries).toHaveLength(0);
    const current = useProjectStore.getState().document as typeof project;
    expect(parseRoomData(current.rooms.foyer?.data)?.hotspots[0]?.shape.bounds).toEqual(
      originalBounds,
    );
  });

  it('drops Focus sessions and draft-close state when the active Project instance changes', () => {
    useProjectStore.getState().loadUnsavedProjectDocument(projectWithRoomHotspot());
    const store = useHotspotFocusStore.getState();
    store.start({
      tabId: 'room-tab',
      ownerKind: 'room',
      ownerId: 'foyer',
      assetId: null,
      mode: 'rectangles',
      items: [hotspot()],
    });
    store.setBounds('room-tab', 'door', movedBounds);
    expect(useDraftDirtyStore.getState().entriesByKey['hotspot-focus:room-tab']?.dirty).toBe(true);

    useProjectStore.getState().loadUnsavedProjectDocument(createAuthoringProject());

    expect(useHotspotFocusStore.getState().sessionsByTabId).toEqual({});
    expect(useHotspotFocusStore.getState().rememberedViewsByTarget).toEqual({});
    expect(useDraftDirtyStore.getState().entriesByKey['hotspot-focus:room-tab']).toBeUndefined();
  });

  it('ends a clean Focus session when its owning workbench tab closes', () => {
    useProjectStore.getState().loadUnsavedProjectDocument(projectWithRoomHotspot());
    const workbench = useWorkbenchStore.getState();
    workbench.openTab({
      id: 'room-tab',
      title: 'Foyer',
      editorType: 'room-detail',
      resource: {
        kind: 'record',
        stableId: 'record:rooms:foyer',
        collection: 'rooms',
        entityId: 'foyer',
      },
    });
    useHotspotFocusStore.getState().start({
      tabId: 'room-tab',
      ownerKind: 'room',
      ownerId: 'foyer',
      assetId: null,
      mode: 'rectangles',
      items: [hotspot()],
    });
    expect(useHotspotFocusStore.getState().sessionsByTabId['room-tab']).toBeDefined();

    useWorkbenchStore.getState().closeTab(useWorkbenchStore.getState().activeGroupId, 'room-tab');

    expect(useHotspotFocusStore.getState().sessionsByTabId['room-tab']).toBeUndefined();
  });
});
