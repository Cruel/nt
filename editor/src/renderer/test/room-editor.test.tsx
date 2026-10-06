import { describe, expect, it, beforeEach, vi } from 'vite-plus/test';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoomEditor } from '@/editors/rooms/RoomEditor';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultArchetypeData } from '../../shared/project-schema/authoring-archetypes';
import { defaultRoomData, parseRoomData } from '../../shared/project-schema/authoring-rooms';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { WorkbenchEditorLocationProvider } from '@/workbench/workbench-editor-location';
import { AuthoringWebGlGroupProvider } from '@/authoring-renderer/authoring-webgl-provider';
import { MaterialPreviewProjectProvider } from '@/material-preview/material-preview-provider';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { invokeWorkbenchTargetHandler } from '@/workbench/workbench-navigation';
import { setTabPreviewVisible } from '@/workbench/preview-visibility-command';
import {
  captureWorkbenchTabState,
  clearWorkbenchTabStates,
  useWorkbenchTabStateStore,
} from '@/workbench/workbench-tab-state';
import { useHotspotFocusStore } from '@/components/hotspots/hotspot-focus-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';

const tab: WorkbenchTab = {
  id: 'tab:room-detail:rooms:foyer',
  title: 'Foyer',
  editorType: 'room-detail',
  resource: {
    kind: 'record',
    stableId: 'record:rooms:foyer',
    collection: 'rooms',
    entityId: 'foyer',
  },
};
function renderEditor(strict = false) {
  const content = (
    <MaterialPreviewProjectProvider>
      <AuthoringWebGlGroupProvider>
        <div style={{ width: 800, height: 600 }}>
          <RoomEditor tab={tab} />
        </div>
      </AuthoringWebGlGroupProvider>
    </MaterialPreviewProjectProvider>
  );
  return render(strict ? <StrictMode>{content}</StrictMode> : content);
}
function selectRoomCategory(
  name: 'General' | 'Camera' | 'Composition' | 'Hotspots' | 'Navigation' | 'Contents' | 'Behavior',
) {
  const navigation = screen.getByRole('navigation', { name: 'Room editor categories' });
  fireEvent.click(within(navigation).getByRole('button', { name }));
}
function setRoomTabPresentationMode(
  presentationMode: 'edit' | 'preview',
  activeCategory?: 'general' | 'composition',
) {
  const resolvedActiveCategory =
    activeCategory ?? (presentationMode === 'edit' ? 'composition' : 'general');
  useWorkbenchTabStateStore.getState().setTabState(tab.id, {
    schema: 'noveltea.editor.tab-state.room',
    payload: {
      activeCategory: resolvedActiveCategory,
      presentationMode,
      editNavigation: { zoom: 1, pan: { x: 0, y: 0 } },
      selection: [],
      expandedSelectionKeys: [],
      previewCollapsed: false,
      hotspotView: {
        schema: 'noveltea.editor.hotspot-view',
        tool: 'select',
        selectedHotspotId: null,
        zoom: 1,
        panX: 0,
        panY: 0,
      },
    },
  });
}
async function waitForHotspotFocusTransition() {
  await waitFor(
    () =>
      expect(screen.getByTestId('hotspot-focus-overlay')).toHaveAttribute(
        'data-focus-transition-phase',
        'focused',
      ),
    { timeout: 3500 },
  );
}
beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useWorkbenchStore.getState().resetWorkbench();
  useHotspotFocusStore.setState({ sessionsByTabId: {}, rememberedViewsByTarget: {} });
  useDraftDirtyStore.getState().resetDraftDirty();
  clearWorkbenchTabStates();
  vi.mocked(window.noveltea.requestImageThumbnail).mockClear();
  vi.mocked(window.noveltea.resolveProjectOriginalAssetUrl).mockReset();
  vi.mocked(window.noveltea.resolveProjectOriginalAssetUrl).mockResolvedValue({
    ok: true,
    url: 'noveltea-asset://source/session/logo',
    contentHash: `sha256:${'0'.repeat(64)}`,
    byteSize: 1,
  });
});
describe('RoomEditor', () => {
  it('splits Room editing into the shared categorical layout', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    expect(screen.getByRole('navigation', { name: 'Room editor categories' })).toBeInTheDocument();
    selectRoomCategory('General');
    expect(screen.getByText('Display name')).toBeInTheDocument();
    expect(screen.queryByText('Lifecycle')).toBeNull();

    selectRoomCategory('Behavior');
    expect(screen.getByText('Lifecycle')).toBeInTheDocument();

    selectRoomCategory('Navigation');
    expect(screen.getByText('Exits')).toBeInTheDocument();

    selectRoomCategory('Composition');
    expect(screen.getByRole('heading', { name: 'Room Contents' })).toBeInTheDocument();
  });

  it('routes Contents Add through exact resource selection and dedicated-placement semantics', () => {
    const project = createAuthoringProject();
    project.assets.pixel = {
      id: 'pixel',
      label: 'Pixel',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/pixel.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    selectRoomCategory('Contents');
    fireEvent.click(screen.getByRole('button', { name: 'Add prop' }));

    expect(screen.getByText('Choose Prop source')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Image · Pixel/i }));

    const updated = useProjectStore.getState().document;
    expect(isAuthoringProject(updated)).toBe(true);
    if (!isAuthoringProject(updated)) return;
    const room = parseRoomData(updated.rooms.foyer?.data)!;
    expect(room.props).toHaveLength(1);
    expect(room.placements).toHaveLength(1);
    expect(room.props[0]?.placementId).toBe(room.placements[0]?.id);
    expect(room.placements[0]?.bounds).toEqual({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 });
  });
  it('counts effective Room Properties from Traits in the category sidebar', () => {
    const project = createAuthoringProject();
    project.traits.inspectable = {
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['room'],
      properties: [
        { id: 'clue', type: 'string', nullable: false },
        { id: 'examined', type: 'boolean', nullable: false, defaultValue: false },
      ],
    };
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      traits: ['inspectable'],
      localProperties: [{ id: 'clue', type: 'string', nullable: false, value: 'portrait' }],
      data: defaultRoomData('Foyer'),
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    const navigation = screen.getByRole('navigation', { name: 'Room editor categories' });
    expect(within(navigation).getByRole('button', { name: 'Properties' })).toHaveTextContent('2');
  });

  it('uses compact master-detail editors for Camera Views and Anchors', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.presentationSpace.views = [
      {
        id: 'wide',
        view: { center: { x: 10, y: 20 }, zoom: 1, rotationDegrees: 0 },
      },
      {
        id: 'close',
        view: { center: { x: 30, y: 40 }, zoom: 2, rotationDegrees: 15 },
      },
    ];
    room.anchors = [
      { id: 'door', bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
      { id: 'desk', bounds: { x: 0.5, y: 0.6, width: 0.2, height: 0.1 } },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    selectRoomCategory('Camera');
    expect(screen.getByDisplayValue('wide')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('close')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^close2×$/i }));
    expect(screen.getByDisplayValue('close')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('wide')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^desk0.2×0.1$/i }));
    expect(screen.getByDisplayValue('desk')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('door')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add View' }));
    expect(screen.getByDisplayValue('view')).toBeInTheDocument();
    const updated = useProjectStore.getState().document;
    expect(isAuthoringProject(updated)).toBe(true);
    if (!isAuthoringProject(updated)) return;
    expect(parseRoomData(updated.rooms.foyer?.data)?.presentationSpace.views).toHaveLength(3);
  });

  it('uses the Room Contents hierarchy to select Placements semantically', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'left-table',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
      {
        id: 'right-door',
        bounds: { x: 0.7, y: 0.2, width: 0.2, height: 0.4 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    selectRoomCategory('Composition');
    expect(screen.getByRole('heading', { name: 'Room Contents' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Placement · right-door/i }));
    expect(screen.getAllByText('Placement · right-door')).not.toHaveLength(0);
    expect(screen.queryByRole('heading', { name: 'Room Contents' })).toBeNull();
  });

  it('edits shared Gameplay Commands for every Room lifecycle command hook', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    selectRoomCategory('Behavior');

    for (const label of [
      'Before enter',
      'After enter',
      'Before leave',
      'After leave',
      'On enter rejected',
      'On leave rejected',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    const afterEnter = screen.getByText('After enter').parentElement;
    expect(afterEnter).not.toBeNull();
    const beforeEnter = screen.getByText('Before enter').parentElement;
    expect(beforeEnter).not.toBeNull();
    expect(within(beforeEnter!).queryByRole('button', { name: '+ Run Lua' })).toBeNull();
    fireEvent.click(within(afterEnter!).getByRole('button', { name: '+ Run Lua' }));

    const updated = useProjectStore.getState().document;
    expect(isAuthoringProject(updated)).toBe(true);
    if (!isAuthoringProject(updated)) return;
    const room = parseRoomData(updated.rooms.foyer?.data);
    expect(room?.lifecycle.afterEnter).toEqual([
      {
        id: 'run-lua',
        kind: 'run-lua',
        source: 'return true',
      },
    ]);
  });
  it('exposes canonical Hook Registry resolution from the Behavior surface', () => {
    const project = createAuthoringProject();
    project.scripts['room-hooks'] = {
      id: 'room-hooks',
      label: 'Room Hooks',
      data: {
        kind: 'script-module',
        source: { kind: 'inline-lua', source: 'return { before_enter = function() end }' },
      },
    };
    const room = defaultRoomData('Foyer');
    room.scriptHooks.push({
      hook: 'before-enter',
      handler: {
        module: { $ref: { collection: 'scripts', id: 'room-hooks' } },
        export: 'before_enter',
      },
    });
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    selectRoomCategory('Behavior');

    expect(screen.getByText('Resolved statically: room-hooks.before_enter')).toBeInTheDocument();
    expect(screen.getByText('Room definition')).toBeInTheDocument();
    expect(screen.getAllByText('gameplay-effect').length).toBeGreaterThanOrEqual(1);
  });
  it('moves geometry interaction into the temporary full-tab Hotspot Focus workspace', () => {
    const project = createAuthoringProject();
    project.assets.image = {
      id: 'image',
      label: 'Image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/room.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 64,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 100, height: 100, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.background.asset = { $ref: { collection: 'assets', id: 'image' } };
    room.hotspots = [
      {
        id: 'door',
        label: 'Door',
        condition: { kind: 'always' },
        inputOrder: 0,
        highlight: { kind: 'default' },
        target: { kind: 'none' },
        shape: { kind: 'rect', bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
      },
    ];
    room.features.push({
      id: 'surface',
      label: 'Surface',
      traits: [],
      localProperties: [],
      defaultProperties: [],
      inventories: [],
    });
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchStore.getState().openTab(tab);
    expect(
      useCommandStore.getState().executeCommand({
        type: 'project.applyPatch',
        label: 'Rename Room externally',
        payload: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Foyer renamed' }],
        originSaveUnitId: 'record:rooms:foyer',
        persistencePolicy: 'manual-save',
      }).ok,
    ).toBe(true);
    renderEditor();

    selectRoomCategory('Hotspots');
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rectangle' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pan' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit geometry' }));
    expect(document.querySelector('[data-hotspot-focus]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rectangle' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '100%' })).toBeInTheDocument();

    act(() => {
      useHotspotFocusStore
        .getState()
        .setBounds(tab.id, 'door', { x: 0.25, y: 0.3, width: 0.3, height: 0.4 });
    });
    const projectUndo = vi.fn(() => useCommandStore.getState().undo());
    const projectRedo = vi.fn(() => useCommandStore.getState().redo());
    const globalProjectShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) projectUndo();
      else if (key === 'y' || (key === 'z' && event.shiftKey)) projectRedo();
    };
    window.addEventListener('keydown', globalProjectShortcut);

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(
      useHotspotFocusStore.getState().sessionsByTabId[tab.id]?.history.present[0]?.shape?.bounds,
    ).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    expect(projectUndo).not.toHaveBeenCalled();
    expect(useCommandStore.getState().history.cursor).toBe(0);

    const selectButton = screen.getByRole('button', { name: 'Select' });
    selectButton.focus();
    fireEvent.keyDown(selectButton, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(
      useHotspotFocusStore.getState().sessionsByTabId[tab.id]?.history.present[0]?.shape?.bounds,
    ).toEqual({ x: 0.25, y: 0.3, width: 0.3, height: 0.4 });
    expect(projectRedo).not.toHaveBeenCalled();

    const focusRoot = document.querySelector<HTMLElement>('[data-hotspot-focus]');
    expect(focusRoot).not.toBeNull();
    if (focusRoot) {
      focusRoot.focus();
      fireEvent.keyDown(focusRoot, { key: 'z', ctrlKey: true });
    }
    expect(
      useHotspotFocusStore.getState().sessionsByTabId[tab.id]?.history.present[0]?.shape?.bounds,
    ).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    expect(projectUndo).not.toHaveBeenCalled();

    const stage = document.querySelector<HTMLElement>('[data-hotspot-image-stage] > div[tabindex]');
    expect(stage).not.toBeNull();
    if (stage) {
      stage.focus();
      fireEvent.keyDown(stage, { key: 'y', ctrlKey: true });
    }
    expect(
      useHotspotFocusStore.getState().sessionsByTabId[tab.id]?.history.present[0]?.shape?.bounds,
    ).toEqual({ x: 0.25, y: 0.3, width: 0.3, height: 0.4 });
    expect(projectRedo).not.toHaveBeenCalled();
    if (stage) {
      fireEvent.keyDown(stage, { key: 'z', ctrlKey: true });
    }
    expect(
      useHotspotFocusStore.getState().sessionsByTabId[tab.id]?.history.present[0]?.shape?.bounds,
    ).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    expect(projectUndo).not.toHaveBeenCalled();
    expect(useCommandStore.getState().history.cursor).toBe(0);

    useWorkbenchStore.getState().openTab({
      id: 'tab:other-tool',
      title: 'Other tool',
      editorType: 'settings',
      resource: { kind: 'tool', stableId: 'tool:other' },
    });
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(projectUndo).toHaveBeenCalledTimes(1);
    expect(useCommandStore.getState().history.cursor).toBe(-1);
    expect(
      useHotspotFocusStore.getState().sessionsByTabId[tab.id]?.history.present[0]?.shape?.bounds,
    ).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });

    window.removeEventListener('keydown', globalProjectShortcut);
  });

  it('selects Room Hotspots in direct Edit for semantic inspection and opens Focus from both entry points', () => {
    const project = createAuthoringProject();
    project.assets.image = {
      id: 'image',
      label: 'Image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/room.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 64,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 100, height: 100, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.background.asset = { $ref: { collection: 'assets', id: 'image' } };
    room.hotspots = [
      {
        id: 'door',
        label: 'Door',
        condition: { kind: 'always' },
        inputOrder: 3,
        highlight: { kind: 'default' },
        target: { kind: 'none' },
        shape: { kind: 'rect', bounds: { x: 0.2, y: 0.2, width: 0.25, height: 0.3 } },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchTabStateStore.getState().setTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'composition',
        presentationMode: 'edit',
        editNavigation: { zoom: 1, pan: { x: 0, y: 0 } },
        selection: [{ kind: 'hotspot', id: 'door' }],
        expandedSelectionKeys: [],
        previewCollapsed: false,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          tool: 'select',
          selectedHotspotId: 'door',
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });
    renderEditor();

    expect(screen.getByText('Target')).toBeInTheDocument();
    expect(screen.getByText('Condition')).toBeInTheDocument();
    expect(screen.getByText('Highlight')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit geometry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Hotspots' })).toBeInTheDocument();
    expect(document.querySelector('[data-testid="room-edit-hotspot-door"]')).not.toBeNull();
    expect(document.querySelector('[data-testid^="room-edit-resize-"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit geometry' }));
    expect(document.querySelector('[data-hotspot-focus]')).not.toBeNull();

    act(() => {
      useHotspotFocusStore.getState().discard(tab.id);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Room Contents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Hotspots' }));
    expect(document.querySelector('[data-hotspot-focus]')).not.toBeNull();
  });

  it('finishes Hotspot Focus entry and animated Cancel under StrictMode', async () => {
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 400 },
      clientHeight: { configurable: true, get: () => 400 },
    });
    const project = createAuthoringProject();
    project.assets.image = {
      id: 'image',
      label: 'Image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/room.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 64,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 100, height: 100, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.background.asset = { $ref: { collection: 'assets', id: 'image' } };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
    useWorkbenchTabStateStore.getState().setTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'composition',
        presentationMode: 'edit',
        editNavigation: { zoom: 1, pan: { x: 0, y: 0 } },
        selection: [],
        expandedSelectionKeys: [],
        previewCollapsed: false,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          tool: 'select',
          selectedHotspotId: null,
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });
    renderEditor(true);

    const surface = screen.getByTestId('room-edit-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 120,
        y: 80,
        left: 120,
        top: 80,
        right: 720,
        bottom: 380,
        width: 600,
        height: 300,
        toJSON: () => ({}),
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Hotspots' }));

    expect(document.querySelector('[data-testid="room-edit-viewport"]')).not.toBeNull();
    expect(screen.getByTestId('hotspot-focus-overlay')).toHaveAttribute(
      'data-focus-transition-phase',
      'entering',
    );
    expect(document.querySelector('[data-focus-transition-image]')).not.toBeNull();
    expect(document.querySelector('[data-focus-transition-destination]')).toHaveClass('opacity-0');

    await waitForHotspotFocusTransition();
    expect(document.querySelector('[data-focus-transition-destination]')).toHaveStyle({
      opacity: '1',
    });
    const hotspotFocusWorkspace = document.querySelector<HTMLElement>('[data-hotspot-focus]');
    expect(hotspotFocusWorkspace).not.toBeNull();
    expect(screen.getByTestId('hotspot-focus-toolbar')).toBeVisible();
    expect(within(hotspotFocusWorkspace!).getByLabelText('Hotspots')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Pan' }));
    fireEvent.click(screen.getByRole('button', { name: '100%' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('hotspot-focus-overlay')).toHaveAttribute(
      'data-focus-transition-phase',
      'exiting',
    );
    await waitFor(
      () => expect(useHotspotFocusStore.getState().sessionsByTabId[tab.id]).toBeUndefined(),
      { timeout: 8000 },
    );
    expect(document.querySelector('[data-hotspot-focus]')).toBeNull();
  }, 15000);

  it('captures a canonical Room presentation endpoint when Hotspot Focus starts from Preview', () => {
    setRoomTabPresentationMode('preview');
    const project = createAuthoringProject();
    project.assets.image = {
      id: 'image',
      label: 'Image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/room.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 64,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 100, height: 100, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.background.asset = { $ref: { collection: 'assets', id: 'image' } };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    const previewSurface = document.querySelector<HTMLElement>('[data-room-preview-surface]');
    expect(previewSurface).not.toBeNull();
    Object.defineProperty(previewSurface!, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 100,
        y: 50,
        left: 100,
        top: 50,
        right: 1300,
        bottom: 850,
        width: 1200,
        height: 800,
        toJSON: () => ({}),
      }),
    });

    selectRoomCategory('Hotspots');
    fireEvent.click(screen.getByRole('button', { name: 'Edit geometry' }));

    expect(
      useHotspotFocusStore.getState().sessionsByTabId[tab.id]?.returnViewportScreenRect,
    ).toEqual({ x: 100, y: 112.5, width: 1200, height: 675 });
  });

  it('retains the Hotspot Focus Room return endpoint across active-only remounts', () => {
    setRoomTabPresentationMode('preview');
    const project = createAuthoringProject();
    project.assets.image = {
      id: 'image',
      label: 'Image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/room.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 64,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 100, height: 100, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.background.asset = { $ref: { collection: 'assets', id: 'image' } };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const first = renderEditor();

    const previewSurface = document.querySelector<HTMLElement>('[data-room-preview-surface]');
    expect(previewSurface).not.toBeNull();
    Object.defineProperty(previewSurface!, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 100,
        y: 50,
        left: 100,
        top: 50,
        right: 1300,
        bottom: 850,
        width: 1200,
        height: 800,
        toJSON: () => ({}),
      }),
    });
    selectRoomCategory('Hotspots');
    fireEvent.click(screen.getByRole('button', { name: 'Edit geometry' }));
    const retainedEndpoint =
      useHotspotFocusStore.getState().sessionsByTabId[tab.id]?.returnViewportScreenRect;
    expect(retainedEndpoint).not.toBeNull();
    expect(useHotspotFocusStore.getState().sessionsByTabId[tab.id]?.entryTransitionPending).toBe(
      false,
    );

    first.unmount();
    renderEditor();

    expect(
      useHotspotFocusStore.getState().sessionsByTabId[tab.id]?.returnViewportScreenRect,
    ).toEqual(retainedEndpoint);
    expect(screen.getByTestId('hotspot-focus-overlay')).toHaveAttribute(
      'data-focus-transition-phase',
      'focused',
    );
  });

  it.each([45, 120])(
    'cancels Hotspot Focus exit work when unmounted after %dms and restores the retained session',
    async (elapsedMs) => {
      setRoomTabPresentationMode('preview');
      Object.defineProperties(HTMLElement.prototype, {
        clientWidth: { configurable: true, get: () => 400 },
        clientHeight: { configurable: true, get: () => 400 },
      });
      const project = createAuthoringProject();
      project.assets.image = {
        id: 'image',
        label: 'Image',
        data: {
          kind: 'image',
          source: { type: 'project-file', path: 'assets/images/room.png' },
          aliases: [],
          sampling: 'linear',
          byteSize: 64,
          contentHash: `sha256:${'a'.repeat(64)}`,
          imageMetadata: { width: 100, height: 100, hasAlpha: true, orientation: 1 },
        },
      };
      const room = defaultRoomData('Foyer');
      room.background.asset = { $ref: { collection: 'assets', id: 'image' } };
      room.hotspots = [
        {
          id: 'door',
          label: 'Door',
          condition: { kind: 'always' },
          inputOrder: 0,
          highlight: { kind: 'default' },
          target: { kind: 'none' },
          shape: { kind: 'rect', bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
        },
      ];
      project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
      useProjectStore.getState().loadUnsavedProjectDocument(project);
      useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
      const view = renderEditor();

      const previewSurface = document.querySelector<HTMLElement>('[data-room-preview-surface]');
      expect(previewSurface).not.toBeNull();
      Object.defineProperty(previewSurface!, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 100,
          y: 50,
          left: 100,
          top: 50,
          right: 700,
          bottom: 350,
          width: 600,
          height: 300,
          toJSON: () => ({}),
        }),
      });
      selectRoomCategory('Hotspots');
      fireEvent.click(screen.getByRole('button', { name: 'Edit geometry' }));
      await waitForHotspotFocusTransition();
      act(() => {
        useHotspotFocusStore.getState().setSelection(tab.id, 'door');
        useHotspotFocusStore.getState().setTool(tab.id, 'pan');
        useHotspotFocusStore.getState().setCamera(tab.id, { zoom: 1.5, pan: { x: 12, y: -8 } });
      });
      const retained = useHotspotFocusStore.getState().sessionsByTabId[tab.id];
      expect(retained).toBeDefined();

      vi.useFakeTimers();
      try {
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        await act(async () => vi.advanceTimersByTime(elapsedMs));
        view.unmount();
        await act(async () => vi.runAllTimers());
      } finally {
        vi.useRealTimers();
      }

      expect(useHotspotFocusStore.getState().sessionsByTabId[tab.id]).toMatchObject({
        selectedHotspotId: 'door',
        tool: 'pan',
        camera: { zoom: 1.5, pan: { x: 12, y: -8 } },
      });
      renderEditor();
      expect(document.querySelector('[data-hotspot-focus]')).not.toBeNull();
    },
  );

  it('suspends retained Room composition shortcuts while Hotspot Focus owns the tab', () => {
    const project = createAuthoringProject();
    project.assets.image = {
      id: 'image',
      label: 'Image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/room.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 64,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 100, height: 100, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.background.asset = { $ref: { collection: 'assets', id: 'image' } };
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchTabStateStore.getState().setTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'composition',
        presentationMode: 'edit',
        editNavigation: { zoom: 1, pan: { x: 0, y: 0 } },
        selection: [{ kind: 'placement', id: 'desk' }],
        expandedSelectionKeys: [],
        previewCollapsed: false,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          tool: 'select',
          selectedHotspotId: null,
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });
    renderEditor();
    selectRoomCategory('Hotspots');
    fireEvent.click(screen.getByRole('button', { name: 'Edit geometry' }));

    fireEvent.keyDown(window, { key: 'Delete' });

    const current = useProjectStore.getState().document;
    expect(isAuthoringProject(current)).toBe(true);
    if (!isAuthoringProject(current)) return;
    expect(parseRoomData(current.rooms.foyer?.data)?.placements.map((item) => item.id)).toEqual([
      'desk',
    ]);
  });
  it('uses the shared dialog for consequential multi-occupant Placement deletion', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = [
      {
        id: 'book',
        condition: { kind: 'always' },
        placementId: 'desk',
        asset: null,
        materialApplication: null,
        visible: true,
        order: 0,
      },
      {
        id: 'lamp',
        condition: { kind: 'always' },
        placementId: 'desk',
        asset: null,
        materialApplication: null,
        visible: true,
        order: 1024,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchTabStateStore.getState().setTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'composition',
        presentationMode: 'edit',
        editNavigation: { zoom: 1, pan: { x: 0, y: 0 } },
        selection: [{ kind: 'placement', id: 'desk' }],
        expandedSelectionKeys: [],
        previewCollapsed: false,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          tool: 'select',
          selectedHotspotId: null,
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });
    const confirm = vi.spyOn(window, 'confirm');
    try {
      renderEditor();
      fireEvent.keyDown(window, { key: 'Delete' });

      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('Delete occupied Placements?')).toBeInTheDocument();
      expect(within(dialog).getByText('Prop · book')).toBeInTheDocument();
      expect(within(dialog).getByText('Prop · lamp')).toBeInTheDocument();
      expect(confirm).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      let current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      expect(parseRoomData(current.rooms.foyer?.data)?.placements).toHaveLength(1);

      fireEvent.keyDown(window, { key: 'Delete' });
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
      current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      expect(parseRoomData(current.rooms.foyer?.data)?.placements).toHaveLength(0);
      expect(useCommandStore.getState().history.entries).toHaveLength(1);
    } finally {
      confirm.mockRestore();
    }
  });
  it('creates Room hotspot geometry inert until the author assigns a target', async () => {
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 400 },
      clientHeight: { configurable: true, get: () => 400 },
    });
    const project = createAuthoringProject();
    project.assets.image = {
      id: 'image',
      label: 'Image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/room.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 64,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 100, height: 100, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.background.asset = { $ref: { collection: 'assets', id: 'image' } };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
    renderEditor();

    selectRoomCategory('Hotspots');
    fireEvent.click(screen.getByRole('button', { name: 'Edit geometry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
    const stage = document.querySelector<HTMLElement>('[data-hotspot-image-stage] > div[tabindex]');
    expect(stage).not.toBeNull();
    if (!stage) return;
    fireEvent.mouseDown(stage, { button: 0, clientX: 160, clientY: 160 });
    fireEvent.mouseMove(window, { clientX: 220, clientY: 220 });
    fireEvent.mouseUp(window, { clientX: 220, clientY: 220 });

    let updated = useProjectStore.getState().document;
    expect(isAuthoringProject(updated)).toBe(true);
    if (!isAuthoringProject(updated)) return;
    expect(parseRoomData(updated.rooms.foyer?.data)?.hotspots).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Rectangle' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.mouseDown(stage, { button: 0, clientX: 240, clientY: 240 });
    fireEvent.mouseMove(window, { clientX: 300, clientY: 300 });
    fireEvent.mouseUp(window, { clientX: 300, clientY: 300 });

    await waitForHotspotFocusTransition();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(document.querySelector('[data-hotspot-focus]')).toBeNull());

    updated = useProjectStore.getState().document;
    expect(isAuthoringProject(updated)).toBe(true);
    if (!isAuthoringProject(updated)) return;
    const updatedRoom = parseRoomData(updated.rooms.foyer?.data);
    expect(updatedRoom?.hotspots).toHaveLength(2);
    expect(updatedRoom?.hotspots.map((item) => item.id)).toEqual(['hotspot', 'hotspot-2']);
    expect(updatedRoom?.hotspots.map((item) => item.inputOrder)).toEqual([0, 1]);
    expect(updatedRoom?.hotspots[0]?.target).toEqual({ kind: 'none' });
    expect(updatedRoom?.hotspots[1]?.target).toEqual({ kind: 'none' });
    expect(screen.getByDisplayValue('hotspot-2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('selects the owning Room category for workbench targets', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    act(() => {
      invokeWorkbenchTargetHandler(tab.id, {
        id: 'room.placements',
        requestId: 1,
      });
    });

    const navigation = screen.getByRole('navigation', { name: 'Room editor categories' });
    expect(within(navigation).getByRole('button', { name: 'Composition' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('heading', { name: 'Room Contents' })).toBeInTheDocument();
  });

  it('selects the Properties category for Room Property targets', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    act(() => {
      invokeWorkbenchTargetHandler(tab.id, {
        id: 'room.properties',
        requestId: 2,
      });
    });

    const navigation = screen.getByRole('navigation', { name: 'Room editor categories' });
    expect(within(navigation).getByRole('button', { name: 'Properties' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('reveals a hidden Instance Property target by selecting its placement first', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.interactables = [
      {
        id: 'key-entry',
        interactable: { $ref: { registry: 'interactableInstances', id: 'key-instance' } },
        condition: { kind: 'always' },
        placementId: 'key-placement',
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.key = {
      id: 'key',
      label: 'Brass Key',
      defaultProperties: [{ id: 'quality', type: 'string', nullable: false }],
      data: defaultInteractableData('Brass Key'),
    };
    project.interactableInstances['key-instance'] = defaultInteractableInstanceData(
      'key-instance',
      'key',
      { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
    );
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    expect(
      document.querySelector('[data-workbench-anchor="instance.property.key-instance.quality"]'),
    ).toBeNull();
    act(() => {
      invokeWorkbenchTargetHandler(tab.id, {
        id: 'instance.property.key-instance.quality',
        requestId: 2,
        payload: {
          kind: 'interactable-instance-property',
          instanceId: 'key-instance',
          propertyId: 'quality',
          placementId: 'key-placement',
        },
      });
    });

    const navigation = screen.getByRole('navigation', { name: 'Room editor categories' });
    expect(within(navigation).getByRole('button', { name: 'Composition' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('Interactable · Brass Key · key-entry')).toBeInTheDocument();
    expect(screen.getByText('Interactable occurrence')).toBeInTheDocument();
  });

  it('authors Placement bounds, label, and attached Layout from the Composition inspector with undo', async () => {
    const project = createAuthoringProject();
    project.assets.pixel = {
      id: 'pixel',
      label: 'Pixel',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/pixel.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = [
      {
        id: 'lamp',
        condition: { kind: 'always' },
        placementId: 'desk',
        asset: { $ref: { collection: 'assets', id: 'pixel' } },
        materialApplication: null,
        visible: true,
        order: 0,
      },
    ];
    project.layouts['desk-ui'] = {
      id: 'desk-ui',
      label: 'Desk UI',
      data: defaultLayoutData('Desk UI'),
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: /Placement · desk/i }));

    fireEvent.change(screen.getByLabelText('Bounds x'), { target: { value: '0.25' } });
    await waitFor(() => {
      const current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      expect(parseRoomData(current.rooms.foyer?.data)?.placements[0]?.bounds.x).toBe(0.25);
    });
    await act(() => useCommandStore.getState().undo());
    await waitFor(() => {
      const current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      expect(parseRoomData(current.rooms.foyer?.data)?.placements[0]?.bounds.x).toBe(0.1);
    });

    const placementIdEditor = screen.getByRole('textbox', { name: 'Placement ID' });
    fireEvent.change(placementIdEditor, { target: { value: 'writing-desk' } });
    fireEvent.blur(placementIdEditor);
    await waitFor(() => {
      const current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      const nextRoom = parseRoomData(current.rooms.foyer?.data);
      expect(nextRoom?.placements[0]?.id).toBe('writing-desk');
      expect(nextRoom?.props[0]?.placementId).toBe('writing-desk');
      expect(screen.getByRole('textbox', { name: 'Placement ID' })).toHaveValue('writing-desk');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add label' }));
    const labelEditor = document.querySelector('textarea');
    expect(labelEditor).not.toBeNull();
    if (!labelEditor) return;
    fireEvent.change(labelEditor, { target: { value: 'Writing desk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose Layout' }));
    fireEvent.click(screen.getByRole('button', { name: /Desk UI/i }));

    await waitFor(() => {
      const current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      const placement = parseRoomData(current.rooms.foyer?.data)?.placements[0];
      expect(placement?.presentation.label).toMatchObject({
        source: { kind: 'inline', text: 'Writing desk' },
      });
      expect(placement?.presentation.layout).toEqual({
        $ref: { collection: 'layouts', id: 'desk-ui' },
      });
    });
  });

  it('edits the exact Interactable Instance through the shared Property Manager in Composition', async () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.interactables = [
      {
        id: 'key-entry',
        interactable: { $ref: { registry: 'interactableInstances', id: 'key-instance' } },
        condition: { kind: 'always' },
        placementId: 'key-placement',
        visible: true,
        order: 0,
      },
    ];
    project.interactables.key = {
      id: 'key',
      label: 'Brass Key',
      data: defaultInteractableData('Brass Key'),
    };
    const instance = defaultInteractableInstanceData('key-instance', 'key', {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'foyer' } },
    });
    instance.localProperties = [
      {
        id: 'condition',
        label: 'Condition',
        type: 'string',
        nullable: false,
        value: 'ready',
      },
    ];
    project.interactableInstances['key-instance'] = instance;
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: /Interactable · Brass Key · key-entry/i }));
    expect(screen.getByText('Instance Properties')).toBeInTheDocument();
    expect(screen.getByText('Condition')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Condition' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Property' }));

    await waitFor(() => {
      const current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      expect(current.interactableInstances['key-instance']?.localProperties).toEqual([]);
    });
  });

  it('edits the fallback Interactable placement from the Composition pane', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const label = screen.getByText('Fallback Interactable placement');
    const control = label.parentElement;
    expect(control).not.toBeNull();
    fireEvent.click(within(control as HTMLElement).getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'desk' }));

    await waitFor(() => {
      const current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      expect(parseRoomData(current.rooms.foyer?.data)?.fallbackInteractablePlacementId).toBe(
        'desk',
      );
    });
  });

  it('retains Hotspot selection and expanded multi-selection inspector state across an ID rename', async () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.hotspots = [
      {
        id: 'door',
        label: 'Door',
        condition: { kind: 'always' },
        inputOrder: 0,
        highlight: { kind: 'default' },
        target: { kind: 'none' },
        shape: { kind: 'rect', bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchTabStateStore.getState().setTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'composition',
        presentationMode: 'edit',
        editNavigation: { zoom: 1, pan: { x: 0, y: 0 } },
        selection: [
          { kind: 'hotspot', id: 'door' },
          { kind: 'placement', id: 'desk' },
        ],
        expandedSelectionKeys: ['hotspot:door'],
        previewCollapsed: false,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          tool: 'select',
          selectedHotspotId: 'door',
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });
    renderEditor();

    expect(screen.getByText('2 selected')).toBeInTheDocument();
    const idInput = screen.getByDisplayValue('door');
    fireEvent.change(idInput, { target: { value: 'doorway' } });
    fireEvent.blur(idInput);

    await waitFor(() => {
      const current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      expect(parseRoomData(current.rooms.foyer?.data)?.hotspots[0]?.id).toBe('doorway');
      expect(screen.getByDisplayValue('doorway')).toBeInTheDocument();
    });
    captureWorkbenchTabState(tab.id);
    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toMatchObject({
      payload: {
        selection: [
          { kind: 'hotspot', id: 'doorway' },
          { kind: 'placement', id: 'desk' },
        ],
        expandedSelectionKeys: ['hotspot:doorway'],
      },
    });
  });
  it('updates the display name through the command bus', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    selectRoomCategory('General');
    fireEvent.change(screen.getByDisplayValue('Foyer'), { target: { value: 'Foyer East' } });
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: { foyer: { data: { displayName: 'Foyer East' } } },
      }),
    );
  });
  it('selects the background from the searchable image asset selector', async () => {
    const project = createAuthoringProject();
    project.assets['foyer-background'] = {
      id: 'foyer-background',
      label: 'Foyer Background',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/foyer.png' },
        aliases: [],
        extension: '.png',
        imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
      },
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: '11111111-1111-4111-8111-111111111111',
    });
    renderEditor();
    selectRoomCategory('General');

    fireEvent.click(screen.getByRole('button', { name: /choose an image/i }));
    expect(screen.getByText('Choose a background image')).toBeInTheDocument();
    await waitFor(() =>
      expect(window.noveltea.requestImageThumbnail).toHaveBeenCalledWith({
        source: {
          projectSessionId: '11111111-1111-4111-8111-111111111111',
          assetId: 'foyer-background',
          projectRelativePath: 'assets/images/foyer.png',
          width: 1920,
          height: 1080,
          orientation: 1,
        },
        variant: { kind: 'profile', profile: 'wide' },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /foyer background/i }));

    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: {
          foyer: {
            data: {
              background: {
                asset: { $ref: { collection: 'assets', id: 'foyer-background' } },
              },
            },
          },
        },
      }),
    );
    expect(await screen.findByAltText('Foyer Background')).toHaveAttribute(
      'src',
      expect.stringContaining('noveltea-thumbnail:'),
    );
  });
  it('shows visual background-fit options and updates the selected fit', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    selectRoomCategory('General');

    const fitGroup = screen.getByRole('group', { name: 'Image fit' });
    const coverButton = within(fitGroup).getByRole('button', { name: 'Cover' });
    const containButton = within(fitGroup).getByRole('button', { name: 'Contain' });
    const stretchButton = within(fitGroup).getByRole('button', { name: 'Stretch' });
    const centerButton = within(fitGroup).getByRole('button', { name: 'Center' });

    expect(coverButton).toHaveAttribute('aria-pressed', 'true');
    expect(coverButton.querySelector('[data-background-fit-icon="cover"]')).not.toBeNull();
    expect(containButton.querySelector('[data-background-fit-icon="contain"]')).not.toBeNull();
    expect(stretchButton.querySelector('[data-background-fit-icon="stretch"]')).not.toBeNull();
    expect(centerButton.querySelector('[data-background-fit-icon="center"]')).not.toBeNull();

    const icons = [coverButton, containButton, stretchButton, centerButton].map((button) =>
      button.querySelector<SVGSVGElement>('[data-background-fit-icon]'),
    );
    expect(icons.every((icon) => icon?.classList.contains('size-10'))).toBe(true);

    const frames = icons.map((icon) => icon?.querySelector('[data-background-fit-frame]'));
    const frameGeometry = frames.map((frame) => [
      frame?.getAttribute('x'),
      frame?.getAttribute('y'),
      frame?.getAttribute('width'),
      frame?.getAttribute('height'),
      frame?.getAttribute('class'),
      frame?.getAttribute('rx'),
      frame?.getAttribute('shape-rendering'),
    ]);
    expect(frameGeometry).toEqual(Array(4).fill(frameGeometry[0]));
    expect(frameGeometry[0]).toEqual([
      '2',
      '4',
      '20',
      '16',
      'fill-none stroke-muted-foreground',
      null,
      'crispEdges',
    ]);

    const images = icons.map((icon) => icon?.querySelector('[data-background-fit-image]'));
    expect(
      images.map((image) => [
        image?.getAttribute('x'),
        image?.getAttribute('y'),
        image?.getAttribute('width'),
        image?.getAttribute('height'),
      ]),
    ).toEqual([
      ['-2.22', '4', '28.44', '16'],
      ['2', '6.38', '20', '11.25'],
      ['2', '4', '20', '16'],
      ['7', '9.19', '10', '5.62'],
    ]);
    expect(images[0]?.parentElement).not.toHaveAttribute('clip-path');
    expect(images.slice(1).every((image) => image?.parentElement?.hasAttribute('clip-path'))).toBe(
      true,
    );
    expect(
      images.every((image) => image?.querySelector('rect')?.classList.contains('fill-chart-2')),
    ).toBe(true);

    fireEvent.click(containButton);

    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: { foyer: { data: { background: { fit: 'contain' } } } },
      }),
    );
    expect(containButton).toHaveAttribute('aria-pressed', 'true');
  });
  it('selects an exit destination from the searchable room selector', async () => {
    const project = createAuthoringProject();
    const foyer = defaultRoomData('Foyer');
    foyer.exits = [
      {
        id: 'hallway-exit',
        label: 'Hallway',
        direction: 'east',
        target: { $ref: { collection: 'rooms', id: 'foyer' } },
        condition: { kind: 'always' },
        onRejected: [],
        transition: null,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: foyer };
    project.rooms.hallway = {
      id: 'hallway',
      label: 'Long Hallway',
      data: defaultRoomData('Long Hallway'),
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    selectRoomCategory('Navigation');

    fireEvent.click(screen.getByRole('button', { name: /choose destination/i }));
    expect(screen.getByText('Choose an exit destination')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Type a room name, ID, or tag'), {
      target: { value: 'long hall' },
    });
    fireEvent.click(screen.getByRole('button', { name: /long hallway/i }));

    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: {
          foyer: {
            data: {
              exits: [
                expect.objectContaining({
                  target: { $ref: { collection: 'rooms', id: 'hallway' } },
                }),
              ],
            },
          },
        },
      }),
    );
  });
  it('selects exit directions with the visual compass control', async () => {
    const project = createAuthoringProject();
    const foyer = defaultRoomData('Foyer');
    foyer.exits = [
      {
        id: 'hallway-exit',
        label: 'Hallway',
        direction: 'custom',
        target: { $ref: { collection: 'rooms', id: 'foyer' } },
        condition: { kind: 'always' },
        onRejected: [],
        transition: null,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: foyer };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    selectRoomCategory('Navigation');

    expect(screen.getByRole('button', { name: 'Custom direction' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Northwest' }));

    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: {
          foyer: {
            data: {
              exits: [expect.objectContaining({ direction: 'northwest' })],
            },
          },
        },
      }),
    );
  });
  it('uses the shared recursive Condition editor for exit availability', () => {
    const project = createAuthoringProject();
    const foyer = defaultRoomData('Foyer');
    foyer.exits = [
      {
        id: 'hallway-exit',
        label: 'Hallway',
        direction: 'east',
        target: { $ref: { collection: 'rooms', id: 'foyer' } },
        condition: { kind: 'always' },
        onRejected: [],
        transition: null,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: foyer };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    selectRoomCategory('Navigation');

    expect(screen.queryByText('Define where the player can travel from this room.')).toBeNull();
    const exitCard = document.querySelector('[data-workbench-anchor="room.exit.hallway-exit"]');
    expect(exitCard).not.toBeNull();
    expect(within(exitCard as HTMLElement).queryByText('Direction')).toBeNull();
    const deleteButton = within(exitCard as HTMLElement).getByRole('button', {
      name: 'Delete Hallway',
    });
    const directionSelector = within(exitCard as HTMLElement).getByRole('group', {
      name: 'Exit direction',
    });
    expect(
      directionSelector.compareDocumentPosition(deleteButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    fireEvent.click(within(exitCard as HTMLElement).getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'Always' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'All' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Any' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Not' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Lua predicate' })).toBeTruthy();
  });
  it('opens destination Rooms from the Exits heading', () => {
    const project = createAuthoringProject();
    const foyer = defaultRoomData('Foyer');
    foyer.exits = [
      {
        id: 'hallway-exit',
        label: 'Hallway',
        direction: 'east',
        target: { $ref: { collection: 'rooms', id: 'hallway' } },
        condition: { kind: 'always' },
        onRejected: [],
        transition: null,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: foyer };
    project.rooms.hallway = {
      id: 'hallway',
      label: 'Long Hallway',
      data: defaultRoomData('Long Hallway'),
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    selectRoomCategory('Navigation');

    fireEvent.click(screen.getByRole('button', { name: 'Long Hallway' }));

    expect(useWorkbenchStore.getState().tabsById['tab:room-detail:rooms:hallway']).toMatchObject({
      editorType: 'room-detail',
      resource: { entityId: 'hallway' },
    });
  });
  it('warns about and creates a missing reciprocal exit', async () => {
    const project = createAuthoringProject();
    const foyer = defaultRoomData('Foyer');
    foyer.exits = [
      {
        id: 'hallway-exit',
        label: 'Hallway',
        direction: 'north',
        target: { $ref: { collection: 'rooms', id: 'hallway' } },
        condition: { kind: 'always' },
        onRejected: [],
        transition: null,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: foyer };
    project.rooms.hallway = {
      id: 'hallway',
      label: 'Long Hallway',
      data: defaultRoomData('Long Hallway'),
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    selectRoomCategory('Navigation');

    expect(screen.getByText('Long Hallway has no south exit back to Foyer.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add return exit' }));

    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: {
          hallway: {
            data: {
              exits: [
                expect.objectContaining({
                  id: 'return-exit',
                  label: 'To Foyer',
                  direction: 'south',
                  target: { $ref: { collection: 'rooms', id: 'foyer' } },
                  condition: { kind: 'always' },
                  onRejected: [],
                  transition: null,
                }),
              ],
            },
          },
        },
      }),
    );
    expect(
      screen.queryByText('Long Hallway has no south exit back to Foyer.'),
    ).not.toBeInTheDocument();
    expect(useCommandStore.getState().history.entries.at(-1)).toMatchObject({
      originSaveUnitId: 'record:rooms:hallway',
      persistencePolicy: 'manual-save',
    });

    act(() => {
      useCommandStore.getState().undo();
    });
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: { hallway: { data: { exits: [] } } },
      }),
    );
    expect(screen.getByText('Long Hallway has no south exit back to Foyer.')).toBeInTheDocument();
  });
  it('warns about and corrects a reciprocal exit in the wrong direction', async () => {
    const project = createAuthoringProject();
    const foyer = defaultRoomData('Foyer');
    foyer.exits = [
      {
        id: 'hallway-exit',
        label: 'Hallway',
        direction: 'north',
        target: { $ref: { collection: 'rooms', id: 'hallway' } },
        condition: { kind: 'always' },
        onRejected: [],
        transition: null,
      },
    ];
    const hallway = defaultRoomData('Long Hallway');
    hallway.exits = [
      {
        id: 'foyer-exit',
        label: 'Foyer',
        direction: 'west',
        target: { $ref: { collection: 'rooms', id: 'foyer' } },
        condition: { kind: 'always' },
        onRejected: [],
        transition: null,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: foyer };
    project.rooms.hallway = { id: 'hallway', label: 'Long Hallway', data: hallway };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    selectRoomCategory('Navigation');

    expect(
      screen.getByText('Long Hallway returns to Foyer via west, but south is expected.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add return exit' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change to south' }));

    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: {
          hallway: {
            data: {
              exits: [
                expect.objectContaining({
                  id: 'foyer-exit',
                  direction: 'south',
                  target: { $ref: { collection: 'rooms', id: 'foyer' } },
                }),
              ],
            },
          },
        },
      }),
    );
    expect(
      screen.queryByText('Long Hallway returns to Foyer via west, but south is expected.'),
    ).not.toBeInTheDocument();
  });
  it('uses the shared resizable preview split', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    expect(screen.getByRole('separator', { name: 'Resize room preview' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveClass('overflow-y-auto');
  });
  it('persists the Room Edit and Preview mode independently from preview collapse', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const view = renderEditor();

    const modes = screen.getByRole('group', { name: 'Room presentation mode' });
    expect(within(modes).getByRole('button', { name: 'Edit' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(document.querySelector('[data-preview-pane-mode="room"]')).toHaveAttribute(
      'data-preview-pane-enabled',
      'true',
    );

    captureWorkbenchTabState(tab.id);
    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toMatchObject({
      schema: 'noveltea.editor.tab-state.room',
      payload: { presentationMode: 'edit', previewCollapsed: false },
    });

    view.unmount();
    renderEditor();
    const restoredModes = screen.getByRole('group', { name: 'Room presentation mode' });
    expect(within(restoredModes).getByRole('button', { name: 'Edit' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
  it('discards replaced Room tab-state shapes instead of migrating missing fields', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchTabStateStore.getState().setTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'camera',
        presentationMode: 'edit',
        previewCollapsed: false,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          tool: 'select',
          selectedHotspotId: null,
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });

    renderEditor();

    expect(screen.getByRole('heading', { name: 'Composition' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('keeps precision Edit navigation tab-scoped across reduced-motion Preview round trips', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.25, y: 0.25, width: 0.25, height: 0.25 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const authoredBefore = structuredClone(useProjectStore.getState().document);
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      renderEditor();
      const modes = screen.getByRole('group', { name: 'Room presentation mode' });
      fireEvent.click(within(modes).getByRole('button', { name: 'Edit' }));

      const surface = screen.getByTestId('room-edit-surface');
      Object.defineProperty(surface, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 500,
          width: 1000,
          height: 500,
          toJSON: () => ({}),
        }),
      });
      expect(fireEvent.wheel(surface, { clientX: 750, clientY: 250, deltaY: -300 })).toBe(false);
      const zoomLabel = screen.getByLabelText('Edit zoom');
      expect(zoomLabel).not.toHaveTextContent('100%');
      const rememberedZoomText = zoomLabel.textContent;

      fireEvent.click(surface, { clientX: 300, clientY: 150 });
      expect(screen.getByTestId('room-edit-selected-placement:desk')).toBeInTheDocument();

      captureWorkbenchTabState(tab.id);
      const afterWheel = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
      expect(afterWheel).toBeDefined();
      const afterWheelPan = (
        afterWheel!.payload as { editNavigation?: { pan?: { x?: number; y?: number } } }
      ).editNavigation?.pan;
      fireEvent.mouseDown(surface, {
        button: 1,
        clientX: 500,
        clientY: 250,
      });
      fireEvent.mouseMove(window, { clientX: 550, clientY: 275 });
      fireEvent.mouseUp(window, { button: 1, clientX: 550, clientY: 275 });
      captureWorkbenchTabState(tab.id);
      const afterMiddlePan = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
      expect(afterMiddlePan).toBeDefined();
      const middlePan = (
        afterMiddlePan!.payload as { editNavigation?: { pan?: { x?: number; y?: number } } }
      ).editNavigation?.pan;
      expect(middlePan?.x).not.toBe(afterWheelPan?.x);
      expect(middlePan?.y).not.toBe(afterWheelPan?.y);
      fireEvent.click(surface, { clientX: 900, clientY: 450 });
      expect(screen.getByRole('heading', { name: 'Room Contents' })).toBeInTheDocument();

      fireEvent.keyDown(window, { code: 'Space' });
      fireEvent.mouseDown(surface, {
        button: 0,
        clientX: 550,
        clientY: 275,
      });
      fireEvent.mouseMove(window, { clientX: 525, clientY: 250 });
      fireEvent.mouseUp(window, { button: 0, clientX: 525, clientY: 250 });
      fireEvent.keyUp(window, { code: 'Space' });
      captureWorkbenchTabState(tab.id);
      const afterSpacePan = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
      expect(afterSpacePan).toBeDefined();
      const spacePan = (
        afterSpacePan!.payload as { editNavigation?: { pan?: { x?: number; y?: number } } }
      ).editNavigation?.pan;
      expect(spacePan?.x).not.toBe(middlePan?.x);
      expect(spacePan?.y).not.toBe(middlePan?.y);

      captureWorkbenchTabState(tab.id);
      const captured = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
      expect(captured).toMatchObject({
        schema: 'noveltea.editor.tab-state.room',
        payload: {
          presentationMode: 'edit',
          editNavigation: {
            zoom: expect.any(Number),
            pan: { x: expect.any(Number), y: expect.any(Number) },
          },
        },
      });
      expect(captured).toBeDefined();
      expect(
        (captured!.payload as { editNavigation?: { zoom?: number } }).editNavigation?.zoom,
      ).toBeGreaterThan(1);
      expect(useProjectStore.getState().document).toEqual(authoredBefore);

      fireEvent.click(within(modes).getByRole('button', { name: 'Preview' }));
      expect(within(modes).getByRole('button', { name: 'Preview' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      fireEvent.click(within(modes).getByRole('button', { name: 'Edit' }));
      expect(screen.getByLabelText('Edit zoom')).toHaveTextContent(rememberedZoomText ?? '');
      fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
      expect(screen.getByLabelText('Edit zoom')).toHaveTextContent('100%');
      expect(useProjectStore.getState().document).toEqual(authoredBefore);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
  it('cancels an active middle-mouse pan on Escape before any lower-priority action', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchTabStateStore.getState().setTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'composition',
        presentationMode: 'edit',
        editNavigation: { zoom: 1, pan: { x: 0, y: 0 } },
        selection: [],
        expandedSelectionKeys: [],
        previewCollapsed: false,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          tool: 'select',
          selectedHotspotId: null,
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });
    renderEditor();
    const surface = screen.getByTestId('room-edit-surface');

    fireEvent.mouseDown(surface, {
      button: 1,
      clientX: 400,
      clientY: 250,
    });
    expect(surface).toHaveAttribute('data-panning', 'true');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(surface).toHaveAttribute('data-panning', 'false');
    fireEvent.mouseUp(window, { button: 1, clientX: 420, clientY: 250 });
    expect(screen.queryByTestId(/^room-edit-selected-/)).toBeNull();
  });

  it('emphasizes only an unselected hovered Placement from ordinary hit geometry', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchTabStateStore.getState().setTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'composition',
        presentationMode: 'edit',
        editNavigation: { zoom: 1, pan: { x: 0, y: 0 } },
        selection: [],
        expandedSelectionKeys: [],
        previewCollapsed: false,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          tool: 'select',
          selectedHotspotId: null,
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });
    renderEditor();
    const surface = screen.getByTestId('room-edit-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 500,
        width: 1000,
        height: 500,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    fireEvent.mouseMove(surface, { clientX: 150, clientY: 75 });
    expect(screen.getByTestId('room-edit-placement-desk')).toHaveAttribute('data-hovered', 'true');
    fireEvent.click(surface, { clientX: 150, clientY: 75 });
    fireEvent.mouseMove(surface, { clientX: 150, clientY: 75 });
    expect(screen.getByTestId('room-edit-placement-desk')).toHaveAttribute('data-hovered', 'false');
  });

  it('does not expose placement-rectangle resize handles for Character occurrences', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.assets.hero = {
      id: 'hero',
      label: 'Hero sprite',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/hero.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'b'.repeat(64)}`,
        imageMetadata: { width: 100, height: 200, hasAlpha: true, orientation: 1 },
      },
    };
    const character = defaultCharacterData('Hero');
    character.initialWorldState = {
      location: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
      enabled: true,
      visible: true,
    };
    character.profiles[0]!.poses[0]!.layers[0] = {
      ...character.profiles[0]!.poses[0]!.layers[0]!,
      visual: { kind: 'image', image: { $ref: { collection: 'assets', id: 'hero' } } },
    };
    character.profiles.push({
      ...structuredClone(character.profiles[0]!),
      id: 'closeup',
      label: 'Closeup',
    });
    character.appearances.push({ id: 'formal', label: 'Formal', profiles: [] });
    project.characters.hero = { id: 'hero', label: 'Hero', data: character };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'hero-placement',
        bounds: { x: 0.4, y: 0.2, width: 0.2, height: 0.4 },
        presentation: { label: null, layout: null },
      },
    ];
    room.cast = [
      {
        id: 'hero-cast',
        character: { $ref: { collection: 'characters', id: 'hero' } },
        condition: { kind: 'always' },
        placementId: 'hero-placement',
        profileId: null,
        poseId: null,
        expressionId: null,
        appearanceId: null,
        idleId: null,
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchTabStateStore.getState().setTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'composition',
        presentationMode: 'edit',
        editNavigation: { zoom: 1, pan: { x: 0, y: 0 } },
        selection: [{ kind: 'cast', id: 'hero-cast' }],
        expandedSelectionKeys: [],
        previewCollapsed: false,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          tool: 'select',
          selectedHotspotId: null,
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });
    renderEditor();
    expect(screen.getByTestId('room-edit-selected-cast:hero-cast')).toBeInTheDocument();
    expect(screen.queryByTestId(/^room-edit-resize-/)).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Appearance' })).toHaveTextContent(
      'Character default',
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Appearance' }));
    expect(screen.getByRole('option', { name: 'Character default' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Appearance' }), { key: 'Escape' });
    fireEvent.click(screen.getByRole('combobox', { name: 'Profile' }));
    await user.click(screen.getByRole('option', { name: 'Closeup' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Appearance' }));
    await user.click(screen.getByRole('option', { name: 'Formal' }));
    await waitFor(() => {
      const updated = useProjectStore.getState().document;
      expect(isAuthoringProject(updated)).toBe(true);
      if (!isAuthoringProject(updated)) return;
      expect(parseRoomData(updated.rooms.foyer?.data)?.cast[0]).toMatchObject({
        profileId: 'closeup',
        appearanceId: 'formal',
      });
    });
  });

  it('offers inherited Character profiles and appearances in the cast inspector', async () => {
    const project = createAuthoringProject();
    const character = defaultCharacterData('Hero');
    character.initialWorldState = {
      location: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
      enabled: true,
      visible: true,
    };
    const inheritedProfile = {
      ...structuredClone(character.profiles[0]!),
      id: 'closeup',
      label: 'Inherited Closeup',
    };
    const inheritedAppearance = { id: 'formal', label: 'Inherited Formal', profiles: [] };
    project.archetypes['hero-base'] = {
      id: 'hero-base',
      label: 'Hero Base',
      data: {
        ...defaultArchetypeData('character'),
        overrides: {
          '/data/profiles': [...character.profiles, inheritedProfile],
          '/data/appearances': [inheritedAppearance],
        },
      },
    };
    project.characters.hero = {
      id: 'hero',
      label: 'Hero',
      data: character,
      archetype: { $ref: { collection: 'archetypes', id: 'hero-base' } },
      archetypeOverrides: {},
      traits: [],
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'hero-placement',
        bounds: { x: 0.4, y: 0.2, width: 0.2, height: 0.4 },
        presentation: { label: null, layout: null },
      },
    ];
    room.cast = [
      {
        id: 'hero-cast',
        character: { $ref: { collection: 'characters', id: 'hero' } },
        condition: { kind: 'always' },
        placementId: 'hero-placement',
        profileId: null,
        poseId: null,
        expressionId: null,
        appearanceId: null,
        idleId: null,
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchTabStateStore.getState().setTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'composition',
        presentationMode: 'edit',
        editNavigation: { zoom: 1, pan: { x: 0, y: 0 } },
        selection: [{ kind: 'cast', id: 'hero-cast' }],
        expandedSelectionKeys: [],
        previewCollapsed: false,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          tool: 'select',
          selectedHotspotId: null,
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });

    renderEditor();
    fireEvent.click(screen.getByRole('combobox', { name: 'Profile' }));
    expect(screen.getByRole('option', { name: 'Inherited Closeup' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: 'Appearance' }));
    expect(screen.getByRole('option', { name: 'Inherited Formal' })).toBeInTheDocument();
  });

  it('keeps the Edit viewport mounted beneath the Hotspot Focus overlay', async () => {
    const observe = vi.spyOn(ResizeObserver.prototype, 'observe');
    try {
      const project = createAuthoringProject();
      project.assets.image = {
        id: 'image',
        label: 'Image',
        data: {
          kind: 'image',
          source: { type: 'project-file', path: 'assets/images/room.png' },
          aliases: [],
          sampling: 'linear',
          byteSize: 64,
          contentHash: `sha256:${'c'.repeat(64)}`,
          imageMetadata: { width: 100, height: 100, hasAlpha: true, orientation: 1 },
        },
      };
      const room = defaultRoomData('Foyer');
      room.background.asset = { $ref: { collection: 'assets', id: 'image' } };
      room.hotspots = [
        {
          id: 'door',
          label: 'Door',
          condition: { kind: 'always' },
          inputOrder: 0,
          highlight: { kind: 'default' },
          target: { kind: 'none' },
          shape: { kind: 'rect', bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
        },
      ];
      project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
      useProjectStore.getState().loadUnsavedProjectDocument(project);
      useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
      renderEditor();

      const modes = screen.getByRole('group', { name: 'Room presentation mode' });
      fireEvent.click(within(modes).getByRole('button', { name: 'Edit' }));
      const firstViewport = await screen.findByTestId('room-edit-viewport');
      expect(observe.mock.calls.some(([element]) => element === firstViewport)).toBe(true);
      observe.mockClear();

      selectRoomCategory('Hotspots');
      fireEvent.click(screen.getByRole('button', { name: 'Edit geometry' }));
      expect(screen.getByTestId('hotspot-focus-overlay')).toBeInTheDocument();
      expect(screen.getByTestId('room-edit-viewport')).toBe(firstViewport);
      await waitForHotspotFocusTransition();
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));

      await waitFor(() => expect(screen.queryByTestId('hotspot-focus-overlay')).toBeNull(), {
        timeout: 3500,
      });
      expect(screen.getByTestId('room-edit-viewport')).toBe(firstViewport);
      expect(observe.mock.calls.some(([element]) => element === firstViewport)).toBe(false);
    } finally {
      observe.mockRestore();
    }
  });

  it('uses the full Edit pane as a workspace around the fitted Room frame', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === 'room-edit-viewport')
          return {
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 1200,
            bottom: 800,
            width: 1200,
            height: 800,
            toJSON: () => ({}),
          } as DOMRect;
        if (this.dataset.testid === 'room-edit-surface')
          return {
            x: 0,
            y: 62.5,
            left: 0,
            top: 62.5,
            right: 1200,
            bottom: 737.5,
            width: 1200,
            height: 675,
            toJSON: () => ({}),
          } as DOMRect;
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
    try {
      renderEditor();
      const modes = screen.getByRole('group', { name: 'Room presentation mode' });
      fireEvent.click(within(modes).getByRole('button', { name: 'Edit' }));
      const viewport = await screen.findByTestId('room-edit-viewport');
      const frame = screen.getByTestId('room-edit-fit-frame');
      expect(viewport).not.toHaveClass('p-2');
      expect(viewport).toHaveClass('relative', 'overflow-hidden');
      expect(frame).toHaveStyle({
        width: '1200px',
        height: '675px',
        transform: 'translate(-50%, -50%) translate(0px, 0px) scale(1)',
      });

      const surface = screen.getByTestId('room-edit-surface');
      expect(fireEvent.wheel(surface, { clientX: 600, clientY: 400, deltaY: -300 })).toBe(false);
      expect(frame.style.transform).toContain('scale(1.568');
      expect(frame).toHaveStyle({ width: '1200px', height: '675px' });
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('cancels an active Edit pan before the animated Preview transition owns the surface', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const originalMatchMedia = window.matchMedia;
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    let reducedMotion = true;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      renderEditor();
      const modes = screen.getByRole('group', { name: 'Room presentation mode' });
      fireEvent.click(within(modes).getByRole('button', { name: 'Edit' }));
      const surface = screen.getByTestId('room-edit-surface');

      fireEvent.mouseDown(surface, {
        button: 1,
        clientX: 400,
        clientY: 250,
      });
      expect(surface).toHaveAttribute('data-panning', 'true');

      reducedMotion = false;
      window.requestAnimationFrame = vi.fn(() => 91);
      window.cancelAnimationFrame = vi.fn();
      fireEvent.click(within(modes).getByRole('button', { name: 'Preview' }));

      await waitFor(() => expect(surface).toHaveAttribute('data-panning', 'false'));
      expect(surface).toHaveAttribute('data-interaction-enabled', 'false');
      expect(within(modes).getByRole('button', { name: 'Edit' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(within(modes).getByRole('button', { name: 'Preview' })).toBeDisabled();
    } finally {
      window.matchMedia = originalMatchMedia;
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
    }
  });
  it('captures and restores its tab-scoped preview collapse state', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const view = renderEditor();

    act(() => {
      setTabPreviewVisible(tab, false);
    });
    await waitFor(() =>
      expect(screen.queryByRole('separator', { name: 'Resize room preview' })).toBeNull(),
    );
    captureWorkbenchTabState(tab.id);

    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toMatchObject({
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'composition',
        previewCollapsed: true,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
        },
      },
    });

    view.unmount();
    renderEditor();

    expect(screen.queryByRole('separator', { name: 'Resize room preview' })).toBeNull();
  });
  it('activates Composition for Edit and retains its inspector as inert state in Preview', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const project = createAuthoringProject();
    project.assets.pixel = {
      id: 'pixel',
      label: 'Pixel',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/pixel.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    try {
      renderEditor();

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(screen.getByRole('heading', { name: 'Composition' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Placement · desk/i }));
      expect(screen.getAllByText('Placement · desk')).not.toHaveLength(0);
      expect(screen.getByTestId('room-composition-pane')).toHaveAttribute('data-disabled', 'false');

      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
      await waitFor(() =>
        expect(screen.getByTestId('room-composition-pane')).toHaveAttribute(
          'data-disabled',
          'true',
        ),
      );
      expect(screen.getAllByText('Placement · desk')).not.toHaveLength(0);
      const navigation = screen.getByRole('navigation', { name: 'Room editor categories' });
      for (const category of [
        'General',
        'Camera',
        'Hotspots',
        'Navigation',
        'Contents',
        'Properties',
        'Behavior',
      ]) {
        fireEvent.click(within(navigation).getByRole('button', { name: category }));
        expect(screen.getByRole('heading', { name: category })).toBeInTheDocument();
      }
      fireEvent.click(within(navigation).getByRole('button', { name: 'Composition' }));
      expect(screen.getByTestId('room-composition-pane')).toHaveAttribute('data-disabled', 'true');
      expect(screen.getAllByText('Placement · desk')).not.toHaveLength(0);

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await waitFor(() =>
        expect(screen.getByTestId('room-composition-pane')).toHaveAttribute(
          'data-disabled',
          'false',
        ),
      );
      expect(screen.getAllByText('Placement · desk')).not.toHaveLength(0);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('persists semantic multi-selection and expandable inspector state per Room tab', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = [
      {
        id: 'lamp',
        condition: { kind: 'always' },
        placementId: 'desk',
        asset: null,
        materialApplication: null,
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchTabStateStore.getState().setTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'composition',
        presentationMode: 'edit',
        editNavigation: { zoom: 1, pan: { x: 0, y: 0 } },
        selection: [
          { kind: 'placement', id: 'desk' },
          { kind: 'prop', id: 'lamp' },
        ],
        expandedSelectionKeys: ['placement:desk'],
        previewCollapsed: false,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          tool: 'select',
          selectedHotspotId: null,
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });

    renderEditor();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByTestId('room-multi-selection-inspectors')).toBeInTheDocument();
    expect(screen.queryByTestId('room-bulk-presentation-order-controls')).toBeNull();
    captureWorkbenchTabState(tab.id);
    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toMatchObject({
      payload: {
        selection: [
          { kind: 'placement', id: 'desk' },
          { kind: 'prop', id: 'lamp' },
        ],
        expandedSelectionKeys: ['placement:desk'],
      },
    });
  });

  it('shows bulk stacking controls only for a multi-selection in one Presentation Plane', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = ['lamp', 'book'].map((id, index) => ({
      id,
      condition: { kind: 'always' as const },
      placementId: 'desk',
      asset: null,
      materialApplication: null,
      visible: true,
      order: index * 1024,
    }));
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchTabStateStore.getState().setTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        activeCategory: 'composition',
        presentationMode: 'edit',
        editNavigation: { zoom: 1, pan: { x: 0, y: 0 } },
        selection: [
          { kind: 'prop', id: 'lamp' },
          { kind: 'prop', id: 'book' },
        ],
        expandedSelectionKeys: [],
        previewCollapsed: false,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          tool: 'select',
          selectedHotspotId: null,
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });

    renderEditor();

    const controls = screen.getByTestId('room-bulk-presentation-order-controls');
    expect(within(controls).getByRole('button', { name: 'Send Backward' })).toBeInTheDocument();
    expect(within(controls).getByRole('button', { name: 'Bring Forward' })).toBeInTheDocument();
    expect(within(controls).getByRole('button', { name: 'Send to Back' })).toBeInTheDocument();
    expect(within(controls).getByRole('button', { name: 'Bring to Front' })).toBeInTheDocument();
  });

  it('uses placement-first click, exact drill-in, overlap candidates, and explicit deselection', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.35, height: 0.35 },
        presentation: {
          label: null,
          layout: { $ref: { collection: 'layouts', id: 'desk-ui' } },
          layoutOrder: 4,
        },
      },
    ];
    project.layouts['desk-ui'] = {
      id: 'desk-ui',
      label: 'Desk UI',
      data: defaultLayoutData('Desk UI'),
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    try {
      renderEditor();
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

      const surface = screen.getByTestId('room-edit-surface');
      Object.defineProperty(surface, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 500,
          width: 1000,
          height: 500,
          toJSON: () => ({}),
        }),
      });

      fireEvent.click(surface, { clientX: 200, clientY: 100 });
      expect(screen.getByTestId('room-edit-selected-placement:desk')).toBeInTheDocument();
      expect(screen.getAllByText('Placement · desk')).not.toHaveLength(0);

      fireEvent.doubleClick(surface, { clientX: 200, clientY: 100 });
      expect(screen.getByTestId('room-edit-selected-placement-layout:desk')).toBeInTheDocument();
      expect(screen.getAllByText('Layout · Desk UI')).not.toHaveLength(0);

      fireEvent.click(surface, { clientX: 900, clientY: 450 });
      expect(screen.getByRole('heading', { name: 'Room Contents' })).toBeInTheDocument();
      fireEvent.doubleClick(surface, { clientX: 200, clientY: 100 });
      expect(screen.getByTestId('room-edit-selected-placement-layout:desk')).toBeInTheDocument();

      fireEvent.contextMenu(surface, { clientX: 200, clientY: 100 });
      const selectMenu = await screen.findByRole('menuitem', { name: 'Select' });
      expect(screen.queryByRole('menuitem', { name: /Layout · Desk UI/i })).not.toBeInTheDocument();
      fireEvent.focus(selectMenu);
      fireEvent.keyDown(selectMenu, { key: 'ArrowRight' });
      expect(
        await screen.findByRole('menuitem', { name: /Layout · Desk UI/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /Placement · desk/i })).toBeInTheDocument();
      expect(screen.getByTestId('room-edit-selected-placement-layout:desk')).toBeInTheDocument();
      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /Placement · desk/i }));
      expect(screen.getByTestId('room-edit-context-preview-placement:desk')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('menuitem', { name: /Deselect All/i }));
      expect(screen.getByRole('heading', { name: 'Room Contents' })).toBeInTheDocument();
      expect(screen.queryByTestId('room-edit-selected-placement-layout:desk')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /Layout · Desk UI/i }));
      expect(screen.getByTestId('room-edit-selected-placement-layout:desk')).toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
      expect(screen.getByRole('heading', { name: 'Room Contents' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Layout · Desk UI/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Room Contents' }));
      expect(screen.getByRole('heading', { name: 'Room Contents' })).toBeInTheDocument();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('marquee-selects placements and moves a mixed explicit-occurrence selection atomically', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const project = createAuthoringProject();
    project.assets.pixel = {
      id: 'pixel',
      label: 'Pixel',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/pixel.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 100, height: 100, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
      {
        id: 'chair',
        bounds: { x: 0.5, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = [
      {
        id: 'book',
        condition: { kind: 'always' },
        placementId: 'desk',
        asset: { $ref: { collection: 'assets', id: 'pixel' } },
        materialApplication: null,
        visible: true,
        order: 0,
      },
      {
        id: 'lamp',
        condition: { kind: 'always' },
        placementId: 'desk',
        asset: { $ref: { collection: 'assets', id: 'pixel' } },
        materialApplication: null,
        visible: true,
        order: 1024,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    try {
      renderEditor();
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

      const surface = screen.getByTestId('room-edit-surface');
      Object.defineProperty(surface, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 500,
          width: 1000,
          height: 500,
          toJSON: () => ({}),
        }),
      });

      fireEvent.mouseDown(surface, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(window, { clientX: 750, clientY: 200 });
      expect(screen.getByTestId('room-edit-marquee')).toBeInTheDocument();
      expect(screen.getByTestId('room-edit-selected-placement:desk')).toBeInTheDocument();
      expect(screen.getByTestId('room-edit-selected-placement:chair')).toBeInTheDocument();
      expect(screen.queryByText('2 selected')).toBeNull();
      fireEvent.mouseUp(window, { button: 0, clientX: 750, clientY: 200 });
      expect(screen.getByText('2 selected')).toBeInTheDocument();

      fireEvent.doubleClick(surface, { clientX: 200, clientY: 100 });
      expect(screen.getByTestId('room-edit-selected-prop:lamp')).toBeInTheDocument();
      fireEvent.mouseDown(surface, {
        button: 0,
        clientX: 600,
        clientY: 100,
        ctrlKey: true,
      });
      fireEvent.mouseUp(window, {
        button: 0,
        clientX: 600,
        clientY: 100,
        ctrlKey: true,
      });
      expect(screen.getByText('2 selected')).toBeInTheDocument();

      fireEvent.mouseDown(surface, { button: 0, clientX: 200, clientY: 100 });
      fireEvent.mouseMove(window, { clientX: 300, clientY: 150 });
      fireEvent.mouseUp(window, { button: 0, clientX: 300, clientY: 150 });

      const updated = useProjectStore.getState().document;
      expect(isAuthoringProject(updated)).toBe(true);
      if (!isAuthoringProject(updated)) return;
      const updatedRoom = parseRoomData(updated.rooms.foyer?.data)!;
      expect(updatedRoom.placements).toHaveLength(3);
      expect(updatedRoom.placements.find((item) => item.id === 'desk')?.bounds).toEqual({
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.2,
      });
      expect(updatedRoom.props.find((item) => item.id === 'book')?.placementId).toBe('desk');
      const lamp = updatedRoom.props.find((item) => item.id === 'lamp')!;
      expect(lamp.placementId).not.toBe('desk');
      expect(
        updatedRoom.placements.find((item) => item.id === lamp.placementId)?.bounds.x,
      ).toBeCloseTo(0.2);
      expect(updatedRoom.placements.find((item) => item.id === 'chair')?.bounds.x).toBeCloseTo(0.6);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('commits direct-drag semantic selection when a move gesture starts', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
      {
        id: 'chair',
        bounds: { x: 0.5, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    try {
      renderEditor();
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const surface = screen.getByTestId('room-edit-surface');
      Object.defineProperty(surface, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 500,
          width: 1000,
          height: 500,
          toJSON: () => ({}),
        }),
      });

      fireEvent.click(surface, { clientX: 200, clientY: 100 });
      expect(screen.getByTestId('room-edit-selected-placement:desk')).toBeInTheDocument();

      fireEvent.mouseDown(surface, {
        button: 0,
        clientX: 600,
        clientY: 100,
      });
      fireEvent.mouseMove(window, { clientX: 650, clientY: 125 });
      expect(screen.getByTestId('room-edit-selected-placement:chair')).toBeInTheDocument();
      expect(screen.queryByTestId('room-edit-selected-placement:desk')).toBeNull();
      fireEvent.mouseUp(window, { button: 0, clientX: 650, clientY: 125 });

      fireEvent.mouseDown(surface, {
        button: 0,
        clientX: 200,
        clientY: 100,
        ctrlKey: true,
      });
      fireEvent.mouseMove(window, {
        clientX: 250,
        clientY: 125,
        ctrlKey: true,
      });
      expect(screen.getByText('2 selected')).toBeInTheDocument();
      fireEvent.mouseUp(window, {
        button: 0,
        clientX: 250,
        clientY: 125,
        ctrlKey: true,
      });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('uses the clamped draft projection during a move before committing it', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'edge',
        bounds: { x: 0.7, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    try {
      renderEditor();
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.click(screen.getByRole('button', { name: /Placement · edge/i }));

      const surface = screen.getByTestId('room-edit-surface');
      Object.defineProperty(surface, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 500,
          width: 1000,
          height: 500,
          toJSON: () => ({}),
        }),
      });
      const selected = screen.getByTestId('room-edit-selected-placement:edge');
      expect(selected).toHaveClass('pointer-events-auto');
      const initialLeft = Number.parseFloat(selected.style.left);

      fireEvent.mouseDown(selected, { button: 0, clientX: 800, clientY: 100 });
      fireEvent.mouseMove(window, { clientX: 1000, clientY: 100 });

      const draftLeft = Number.parseFloat(
        screen.getByTestId('room-edit-selected-placement:edge').style.left,
      );
      expect(draftLeft).toBeGreaterThan(initialLeft);
      expect(draftLeft).toBeLessThan(90);
      const duringDrag = useProjectStore.getState().document;
      expect(isAuthoringProject(duringDrag)).toBe(true);
      if (!isAuthoringProject(duringDrag)) return;
      expect(parseRoomData(duringDrag.rooms.foyer?.data)?.placements[0]?.bounds.x).toBe(0.7);

      fireEvent.mouseUp(window, { button: 0, clientX: 1000, clientY: 100 });
      const committed = useProjectStore.getState().document;
      expect(isAuthoringProject(committed)).toBe(true);
      if (!isAuthoringProject(committed)) return;
      expect(parseRoomData(committed.rooms.foyer?.data)?.placements[0]?.bounds.x).toBeCloseTo(0.8);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('updates the resize draft projection before committing the Project change', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Placement · desk/i }));

    const surface = screen.getByTestId('room-edit-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 1000,
        bottom: 500,
        width: 1000,
        height: 500,
        toJSON: () => ({}),
      }),
    });
    const selected = screen.getByTestId('room-edit-selected-placement:desk');
    const initialWidth = Number.parseFloat(selected.style.width);
    const handle = screen.getByTestId('room-edit-resize-se');

    expect(handle).toHaveClass('pointer-events-auto');
    fireEvent.mouseDown(handle, { button: 0, clientX: 300, clientY: 150 });
    fireEvent.mouseMove(window, { clientX: 400, clientY: 200 });

    const draftWidth = Number.parseFloat(
      screen.getByTestId('room-edit-selected-placement:desk').style.width,
    );
    expect(draftWidth).toBeGreaterThan(initialWidth);
    const duringResize = useProjectStore.getState().document;
    expect(isAuthoringProject(duringResize)).toBe(true);
    if (!isAuthoringProject(duringResize)) return;
    expect(parseRoomData(duringResize.rooms.foyer?.data)?.placements[0]?.bounds.width).toBe(0.2);

    fireEvent.mouseUp(window, { button: 0, clientX: 400, clientY: 200 });
    const committed = useProjectStore.getState().document;
    expect(isAuthoringProject(committed)).toBe(true);
    if (!isAuthoringProject(committed)) return;
    expect(parseRoomData(committed.rooms.foyer?.data)?.placements[0]?.bounds.width).toBeGreaterThan(
      0.2,
    );
  });

  it('does not split a shared placement when a resize handle is clicked without moving', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'shared',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = ['book', 'lamp'].map((id, index) => ({
      id,
      condition: { kind: 'always' as const },
      placementId: 'shared',
      asset: { $ref: { collection: 'assets' as const, id: 'pixel' } },
      materialApplication: null,
      visible: true,
      order: index * 1024,
    }));
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    try {
      renderEditor();
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const surface = screen.getByTestId('room-edit-surface');
      Object.defineProperty(surface, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 500,
          width: 1000,
          height: 500,
          toJSON: () => ({}),
        }),
      });

      fireEvent.doubleClick(surface, { clientX: 200, clientY: 100 });
      expect(screen.getByTestId('room-edit-selected-prop:lamp')).toBeInTheDocument();
      const handle = screen.getByTestId('room-edit-resize-se');
      const beforePan = structuredClone(useProjectStore.getState().document);
      fireEvent.keyDown(window, { code: 'Space' });
      fireEvent.mouseDown(handle, { button: 0, clientX: 300, clientY: 150 });
      expect(surface).toHaveAttribute('data-panning', 'true');
      fireEvent.mouseMove(window, { clientX: 340, clientY: 180 });
      fireEvent.mouseUp(window, { button: 0, clientX: 340, clientY: 180 });
      fireEvent.keyUp(window, { code: 'Space' });
      expect(surface).toHaveAttribute('data-panning', 'false');
      expect(useProjectStore.getState().document).toEqual(beforePan);

      fireEvent.mouseDown(handle, { button: 0, clientX: 300, clientY: 150 });
      fireEvent.mouseUp(window, { button: 0, clientX: 300, clientY: 150 });

      const updated = useProjectStore.getState().document;
      expect(isAuthoringProject(updated)).toBe(true);
      if (!isAuthoringProject(updated)) return;
      const updatedRoom = parseRoomData(updated.rooms.foyer?.data)!;
      expect(updatedRoom.placements).toHaveLength(1);
      expect(updatedRoom.props.every((item) => item.placementId === 'shared')).toBe(true);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('chooses an exact non-first image for Prop Add, filters non-images, and reuses the same positioned Add command', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const project = createAuthoringProject();
    project.assets.first = {
      id: 'first',
      label: 'First Image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/first.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 32, height: 32, hasAlpha: true, orientation: 1 },
      },
    };
    project.assets.second = {
      id: 'second',
      label: 'Second Image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/second.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'b'.repeat(64)}`,
        imageMetadata: { width: 32, height: 32, hasAlpha: true, orientation: 1 },
      },
    };
    project.assets.sound = {
      id: 'sound',
      label: 'Sound Effect',
      data: {
        kind: 'audio',
        source: { type: 'project-file', path: 'assets/sound.mp3' },
        aliases: [],
        extension: '.mp3',
        imageMetadata: null,
      },
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    try {
      renderEditor();
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const surface = screen.getByTestId('room-edit-surface');
      Object.defineProperty(surface, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 500,
          width: 1000,
          height: 500,
          toJSON: () => ({}),
        }),
      });

      fireEvent.click(
        within(screen.getByTestId('room-composition-add-actions')).getByRole('button', {
          name: 'Prop',
        }),
      );
      expect(screen.getByText('Choose Prop source')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Image · First Image/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Image · Second Image/i })).toBeInTheDocument();
      expect(screen.queryByText('Sound Effect')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Image · Second Image/i }));

      let current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      expect(parseRoomData(current.rooms.foyer?.data)?.props).toHaveLength(0);
      fireEvent.mouseMove(surface, { clientX: 300, clientY: 200 });
      expect(screen.getByTestId('room-edit-add-ghost')).toBeInTheDocument();
      fireEvent.mouseDown(surface, { button: 0, clientX: 300, clientY: 200 });

      current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      expect(parseRoomData(current.rooms.foyer?.data)?.props[0]?.asset?.$ref.id).toBe('second');

      fireEvent.contextMenu(surface, { clientX: 700, clientY: 300 });
      const addMenu = await screen.findByRole('menuitem', { name: 'Add' });
      fireEvent.focus(addMenu);
      fireEvent.keyDown(addMenu, { key: 'ArrowRight' });
      const propItems = await screen.findAllByRole('menuitem', { name: 'Prop' });
      fireEvent.click(propItems.at(-1)!);
      fireEvent.click(await screen.findByRole('button', { name: /Image · First Image/i }));

      current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      const updatedRoom = parseRoomData(current.rooms.foyer?.data)!;
      expect(updatedRoom.props.map((item) => item.asset?.$ref.id)).toEqual(['second', 'first']);
      expect(updatedRoom.placements).toHaveLength(2);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('filters Environment Add image choices after an explicit Material choice', () => {
    const project = createAuthoringProject();
    project.materials.mist = {
      id: 'mist',
      label: 'Mist',
      data: defaultMaterialData('Mist'),
    };
    project.assets.image = {
      id: 'image',
      label: 'Backdrop',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/backdrop.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 32, height: 32, hasAlpha: true, orientation: 1 },
      },
    };
    project.assets.sound = {
      id: 'sound',
      label: 'Sound Effect',
      data: {
        kind: 'audio',
        source: { type: 'project-file', path: 'assets/sound.mp3' },
        aliases: [],
        extension: '.mp3',
        imageMetadata: null,
      },
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(
      within(screen.getByTestId('room-composition-add-actions')).getByRole('button', {
        name: 'Environment',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Material · Mist/i }));

    expect(screen.getByText('Choose Environment Image')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Image · Backdrop/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No image Asset' })).toBeInTheDocument();
    expect(screen.queryByText('Sound Effect')).toBeNull();
  });

  it('lets Interactable Add choose an existing exact Instance or create a new exact Instance', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Brass Key',
      data: defaultInteractableData('Brass Key'),
    };
    project.interactableInstances['key-instance'] = defaultInteractableInstanceData(
      'key-instance',
      'key',
    );
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    try {
      renderEditor();
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const surface = screen.getByTestId('room-edit-surface');
      Object.defineProperty(surface, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 500,
          width: 1000,
          height: 500,
          toJSON: () => ({}),
        }),
      });
      const addInteractable = () =>
        fireEvent.click(
          within(screen.getByTestId('room-composition-add-actions')).getByRole('button', {
            name: 'Interactable',
          }),
        );

      addInteractable();
      expect(screen.getByRole('button', { name: /New Instance · Brass Key/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Existing Instance · key-instance/i }));
      fireEvent.mouseMove(surface, { clientX: 250, clientY: 180 });
      fireEvent.mouseDown(surface, { button: 0, clientX: 250, clientY: 180 });

      let current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      expect(Object.keys(current.interactableInstances)).toEqual(['key-instance']);
      expect(parseRoomData(current.rooms.foyer?.data)?.interactables[0]?.interactable.$ref.id).toBe(
        'key-instance',
      );

      addInteractable();
      fireEvent.click(screen.getByRole('button', { name: /New Instance · Brass Key/i }));
      fireEvent.mouseMove(surface, { clientX: 650, clientY: 320 });
      fireEvent.mouseDown(surface, { button: 0, clientX: 650, clientY: 320 });

      current = useProjectStore.getState().document;
      expect(isAuthoringProject(current)).toBe(true);
      if (!isAuthoringProject(current)) return;
      expect(Object.keys(current.interactableInstances)).toHaveLength(2);
      expect(current.interactableInstances['key-instance']).toBeDefined();
      expect(parseRoomData(current.rooms.foyer?.data)?.interactables).toHaveLength(2);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('shares pane ghost/drop and positioned context Add while Preview cancels the transient Add tool', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    try {
      renderEditor();
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      let surface = screen.getByTestId('room-edit-surface');
      const rect = {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 1000,
        bottom: 500,
        width: 1000,
        height: 500,
        toJSON: () => ({}),
      };
      Object.defineProperty(surface, 'getBoundingClientRect', {
        configurable: true,
        value: () => rect,
      });

      const addActions = screen.getByTestId('room-composition-add-actions');
      fireEvent.click(within(addActions).getByRole('button', { name: 'Placement' }));
      fireEvent.mouseMove(surface, { clientX: 300, clientY: 200 });
      expect(screen.getByTestId('room-edit-add-ghost')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
      expect(screen.queryByTestId('room-edit-add-ghost')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      surface = screen.getByTestId('room-edit-surface');
      Object.defineProperty(surface, 'getBoundingClientRect', {
        configurable: true,
        value: () => rect,
      });
      fireEvent.mouseMove(surface, { clientX: 300, clientY: 200 });
      expect(screen.queryByTestId('room-edit-add-ghost')).toBeNull();

      fireEvent.click(
        within(screen.getByTestId('room-composition-add-actions')).getByRole('button', {
          name: 'Placement',
        }),
      );
      fireEvent.mouseMove(surface, { clientX: 300, clientY: 200 });
      fireEvent.mouseDown(surface, { button: 0, clientX: 300, clientY: 200 });
      let updated = useProjectStore.getState().document;
      expect(isAuthoringProject(updated)).toBe(true);
      if (!isAuthoringProject(updated)) return;
      expect(parseRoomData(updated.rooms.foyer?.data)?.placements).toHaveLength(1);

      fireEvent.contextMenu(surface, { clientX: 700, clientY: 300 });
      const addMenu = await screen.findByRole('menuitem', { name: 'Add' });
      fireEvent.focus(addMenu);
      fireEvent.keyDown(addMenu, { key: 'ArrowRight' });
      const placementItems = await screen.findAllByRole('menuitem', { name: 'Placement' });
      fireEvent.click(placementItems.at(-1)!);
      updated = useProjectStore.getState().document;
      expect(isAuthoringProject(updated)).toBe(true);
      if (!isAuthoringProject(updated)) return;
      expect(parseRoomData(updated.rooms.foyer?.data)?.placements).toHaveLength(2);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('scopes Ctrl+D deselection to the active Room editor in split groups', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.35, height: 0.35 },
        presentation: {
          label: null,
          layout: { $ref: { collection: 'layouts', id: 'desk-ui' } },
          layoutOrder: 4,
        },
      },
    ];
    project.layouts['desk-ui'] = {
      id: 'desk-ui',
      label: 'Desk UI',
      data: defaultLayoutData('Desk UI'),
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkbenchStore.setState({ activeGroupId: 'group:left' });
    const rightTab = { ...tab, id: `${tab.id}:right` };

    render(
      <MaterialPreviewProjectProvider>
        <AuthoringWebGlGroupProvider>
          <div data-testid="left-room-editor">
            <WorkbenchEditorLocationProvider
              location={{
                tabId: tab.id,
                groupId: 'group:left',
                isActiveInGroup: true,
                isVisible: true,
              }}
            >
              <RoomEditor tab={tab} />
            </WorkbenchEditorLocationProvider>
          </div>
          <div data-testid="right-room-editor">
            <WorkbenchEditorLocationProvider
              location={{
                tabId: rightTab.id,
                groupId: 'group:right',
                isActiveInGroup: true,
                isVisible: true,
              }}
            >
              <RoomEditor tab={rightTab} />
            </WorkbenchEditorLocationProvider>
          </div>
        </AuthoringWebGlGroupProvider>
      </MaterialPreviewProjectProvider>,
    );

    const left = within(screen.getByTestId('left-room-editor'));
    const right = within(screen.getByTestId('right-room-editor'));
    fireEvent.click(left.getByRole('button', { name: 'Edit' }));
    fireEvent.click(right.getByRole('button', { name: 'Edit' }));
    fireEvent.click(left.getByRole('button', { name: /Layout · Desk UI/i }));
    fireEvent.click(right.getByRole('button', { name: /Layout · Desk UI/i }));

    expect(left.getByTestId('room-edit-selected-placement-layout:desk')).toBeInTheDocument();
    expect(right.getByTestId('room-edit-selected-placement-layout:desk')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });

    expect(left.queryByTestId('room-edit-selected-placement-layout:desk')).toBeNull();
    expect(left.getByRole('heading', { name: 'Room Contents' })).toBeInTheDocument();
    expect(right.getByTestId('room-edit-selected-placement-layout:desk')).toBeInTheDocument();
  });
});
