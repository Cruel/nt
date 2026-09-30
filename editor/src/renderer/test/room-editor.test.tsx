import { describe, expect, it, beforeEach, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { defaultRoomData, parseRoomData } from '../../shared/project-schema/authoring-rooms';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
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
function renderEditor() {
  return render(
    <MaterialPreviewProjectProvider>
      <AuthoringWebGlGroupProvider>
        <div style={{ width: 800, height: 600 }}>
          <RoomEditor tab={tab} />
        </div>
      </AuthoringWebGlGroupProvider>
    </MaterialPreviewProjectProvider>,
  );
}
function selectRoomCategory(
  name: 'General' | 'Camera' | 'Composition' | 'Hotspots' | 'Navigation' | 'Contents' | 'Behavior',
) {
  const navigation = screen.getByRole('navigation', { name: 'Room editor categories' });
  fireEvent.click(within(navigation).getByRole('button', { name }));
}
beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useWorkbenchStore.getState().resetWorkbench();
  clearWorkbenchTabStates();
  vi.mocked(window.noveltea.requestImageThumbnail).mockClear();
  vi.mocked(window.noveltea.resolveProjectOriginalAssetUrl).mockReset();
  vi.mocked(window.noveltea.resolveProjectOriginalAssetUrl).mockResolvedValue({
    ok: true,
    url: 'noveltea-asset://source/session/logo',
  });
});
describe('RoomEditor', () => {
  it('splits Room editing into the shared categorical layout', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    expect(screen.getByRole('navigation', { name: 'Room editor categories' })).toBeInTheDocument();
    expect(screen.getByText('Display name')).toBeInTheDocument();
    expect(screen.queryByText('Lifecycle')).toBeNull();

    selectRoomCategory('Behavior');
    expect(screen.getByText('Lifecycle')).toBeInTheDocument();

    selectRoomCategory('Navigation');
    expect(screen.getByText('Exits')).toBeInTheDocument();

    selectRoomCategory('Composition');
    expect(screen.getByRole('heading', { name: 'Room Contents' })).toBeInTheDocument();
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
  it('uses one temporary add action instead of persistent hotspot interaction modes', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
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
    renderEditor();

    selectRoomCategory('Hotspots');
    expect(screen.getByRole('button', { name: 'Add hotspot' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Draw' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pan' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add hotspot' }));
    expect(screen.getByRole('button', { name: 'Cancel add' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.getByText(
        'Drag on the image to create a rectangular hotspot. Press Escape to cancel.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel add' }));
    expect(screen.getByRole('button', { name: 'Add hotspot' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
  it('creates Room hotspot geometry inert until the author assigns a target', () => {
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
    renderEditor();

    selectRoomCategory('Hotspots');
    fireEvent.click(screen.getByRole('button', { name: 'Add hotspot' }));
    const stage = document.querySelector<HTMLElement>('[data-hotspot-image-stage] > div[tabindex]');
    expect(stage).not.toBeNull();
    if (!stage) return;
    fireEvent.mouseDown(stage, { button: 0, clientX: 40, clientY: 40 });
    fireEvent.mouseMove(window, { clientX: 120, clientY: 120 });
    fireEvent.mouseUp(window, { clientX: 120, clientY: 120 });

    const updated = useProjectStore.getState().document;
    expect(isAuthoringProject(updated)).toBe(true);
    if (!isAuthoringProject(updated)) return;
    const updatedRoom = parseRoomData(updated.rooms.foyer?.data);
    expect(updatedRoom?.hotspots).toHaveLength(1);
    expect(updatedRoom?.hotspots[0]?.target).toEqual({ kind: 'none' });
    expect(screen.getByText('No target')).toBeInTheDocument();
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
  it('updates the display name through the command bus', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
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
    await waitFor(() =>
      expect(window.noveltea.resolveProjectOriginalAssetUrl).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        'foyer-background',
      ),
    );
    selectRoomCategory('Composition');
    expect(screen.getByTestId('room-composition-background')).toHaveAttribute(
      'src',
      expect.stringContaining('noveltea-asset://'),
    );
  });
  it('does not re-resolve the same Room background for local editor metadata changes', async () => {
    const project = createAuthoringProject();
    project.assets['foyer-background'] = {
      id: 'foyer-background',
      label: 'Foyer Background',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/foyer.png' },
        aliases: [],
        byteSize: 3,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.background.asset = { $ref: { collection: 'assets', id: 'foyer-background' } };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: '11111111-1111-4111-8111-111111111111',
    });
    renderEditor();

    await waitFor(() =>
      expect(window.noveltea.resolveProjectOriginalAssetUrl).toHaveBeenCalledTimes(1),
    );
    act(() => {
      useProjectStore.getState().markEditorMetadataPersisted({
        ...project.editor,
        bottomPanel: { ...project.editor.bottomPanel, visible: false },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.noveltea.resolveProjectOriginalAssetUrl).toHaveBeenCalledTimes(1);
  });

  it('falls back safely when the bounded Room background source is unavailable', async () => {
    const project = createAuthoringProject();
    project.assets['foyer-background'] = {
      id: 'foyer-background',
      label: 'Foyer Background',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/foyer.png' },
        aliases: [],
        byteSize: 3,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.background.asset = { $ref: { collection: 'assets', id: 'foyer-background' } };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    vi.mocked(window.noveltea.resolveProjectOriginalAssetUrl).mockResolvedValue({
      ok: false,
      code: 'revision-mismatch',
      boundaryCode: 'source-revision-mismatch',
    });
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: '11111111-1111-4111-8111-111111111111',
    });

    renderEditor();
    selectRoomCategory('Composition');
    await waitFor(() =>
      expect(window.noveltea.resolveProjectOriginalAssetUrl).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        'foyer-background',
      ),
    );
    expect(screen.queryByTestId('room-composition-background')).toBeNull();
  });
  it('shows visual background-fit options and updates the selected fit', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

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
    expect(within(modes).getByRole('button', { name: 'Preview' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(modes).getByRole('button', { name: 'Edit' }));
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

    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
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
      fireEvent.wheel(surface, { clientX: 750, clientY: 250, deltaY: -300 });
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
      fireEvent.pointerDown(surface, {
        button: 1,
        pointerId: 1,
        clientX: 500,
        clientY: 250,
      });
      fireEvent.pointerMove(surface, { pointerId: 1, clientX: 550, clientY: 275 });
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 550, clientY: 275 });
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
      fireEvent.pointerDown(surface, {
        button: 0,
        pointerId: 2,
        clientX: 550,
        clientY: 275,
      });
      fireEvent.pointerMove(surface, { pointerId: 2, clientX: 525, clientY: 250 });
      fireEvent.pointerUp(surface, { pointerId: 2, clientX: 525, clientY: 250 });
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

      fireEvent.pointerDown(surface, {
        button: 1,
        pointerId: 7,
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
        activeCategory: 'general',
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
});
