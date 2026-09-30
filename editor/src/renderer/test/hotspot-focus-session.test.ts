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
import { useHotspotFocusStore } from '@/components/hotspots/hotspot-focus-store';
import type { EditableHotspot } from '@/components/hotspots/hotspot-types';
import { useProjectStore } from '@/project/project-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultRoomData,
  parseRoomData,
  type RoomHotspotData,
} from '../../shared/project-schema/authoring-rooms';

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
