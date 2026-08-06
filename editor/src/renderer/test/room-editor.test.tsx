import { describe, expect, it, beforeEach } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RoomEditor } from '@/editors/rooms/RoomEditor';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultRoomData, parseRoomData } from '../../shared/project-schema/authoring-rooms';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
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
    <div style={{ width: 800, height: 600 }}>
      <RoomEditor tab={tab} />
    </div>,
  );
}
function selectRoomCategory(
  name: 'General' | 'Composition' | 'Hotspots' | 'Navigation' | 'Contents' | 'Behavior',
) {
  const navigation = screen.getByRole('navigation', { name: 'Room editor categories' });
  fireEvent.click(within(navigation).getByRole('button', { name }));
}
beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useWorkbenchStore.getState().resetWorkbench();
  clearWorkbenchTabStates();
});
describe('RoomEditor', () => {
  it('splits Room editing into the shared categorical layout', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    expect(screen.getByRole('navigation', { name: 'Room editor categories' })).toBeInTheDocument();
    expect(screen.getByText('Room details')).toBeInTheDocument();
    expect(screen.queryByText('Lifecycle')).toBeNull();

    selectRoomCategory('Behavior');
    expect(screen.getByText('Lifecycle')).toBeInTheDocument();

    selectRoomCategory('Navigation');
    expect(screen.getByText('Exits')).toBeInTheDocument();

    selectRoomCategory('Composition');
    expect(screen.getByText('Placements')).toBeInTheDocument();
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
    expect(screen.getByText('Placements')).toBeInTheDocument();
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
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: /choose an image/i }));
    expect(screen.getByText('Choose a background image')).toBeInTheDocument();
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
  it('uses a compact dropdown for exit availability', () => {
    const project = createAuthoringProject();
    const foyer = defaultRoomData('Foyer');
    foyer.exits = [
      {
        id: 'hallway-exit',
        label: 'Hallway',
        direction: 'east',
        target: { $ref: { collection: 'rooms', id: 'foyer' } },
        condition: { kind: 'always' },
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
    expect(
      within(exitCard as HTMLElement).getByRole('combobox', { name: 'Available when' }),
    ).toHaveTextContent('Always');
    expect(
      within(exitCard as HTMLElement).queryByRole('option', { name: 'Lua predicate' }),
    ).toBeNull();
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
      schemaVersion: 4,
      payload: {
        activeCategory: 'general',
        previewCollapsed: true,
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          schemaVersion: 1,
        },
      },
    });

    view.unmount();
    renderEditor();

    expect(screen.queryByRole('separator', { name: 'Resize room preview' })).toBeNull();
  });
  it('creates a generic typed placement anchor', async () => {
    const project = createAuthoringProject();
    project.interactables.lamp = {
      id: 'lamp',
      label: 'Lamp',
      extends: null,
      properties: {},
      data: defaultInteractableData('Lamp'),
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    selectRoomCategory('Composition');
    fireEvent.click(screen.getByText('Add placement'));
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: {
          foyer: { data: { placements: [expect.objectContaining({ id: 'placement', order: 0 })] } },
        },
      }),
    );
  });
  it('places an existing Interactable through one dedicated Room placement transaction', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    project.interactables.key = {
      id: 'key',
      label: 'Brass Key',
      data: defaultInteractableData('Brass Key'),
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    selectRoomCategory('Composition');

    fireEvent.click(screen.getByRole('button', { name: 'Place Interactable' }));
    fireEvent.click(screen.getByRole('button', { name: /Brass Key/i }));
    const stage = screen.getByTestId('room-composition-stage');
    Object.defineProperty(stage, 'getBoundingClientRect', {
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
    fireEvent.mouseDown(stage, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 400, clientY: 250 });
    fireEvent.mouseUp(window, { clientX: 400, clientY: 250 });

    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: {
          foyer: {
            data: {
              placements: [
                expect.objectContaining({
                  id: 'key-placement',
                }),
              ],
              interactables: [
                expect.objectContaining({
                  id: 'key',
                  interactable: { $ref: { collection: 'interactables', id: 'key' } },
                  placementId: 'key-placement',
                }),
              ],
            },
          },
        },
      }),
    );
    const currentDocument = useProjectStore.getState().document;
    expect(isAuthoringProject(currentDocument)).toBe(true);
    if (!isAuthoringProject(currentDocument)) throw new Error('Expected an authoring project.');
    const placement = parseRoomData(currentDocument.rooms.foyer?.data)?.placements[0];
    expect(placement?.bounds.x).toBeCloseTo(0.1);
    expect(placement?.bounds.y).toBeCloseTo(0.2);
    expect(placement?.bounds.width).toBeCloseTo(0.3);
    expect(placement?.bounds.height).toBeCloseTo(0.3);
    expect(useCommandStore.getState().history.entries).toHaveLength(1);
  });

  it('moves and resizes an existing placement through window-level pointer gestures', async () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        order: 0,
        presentation: { label: null, layout: null },
      },
    ];
    const key = defaultInteractableData('Brass Key');
    room.interactables = [
      {
        id: 'key',
        interactable: { $ref: { collection: 'interactables', id: 'key' } },
        condition: { kind: 'always' },
        placementId: 'key-placement',
        enabled: true,
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.key = { id: 'key', label: 'Brass Key', data: key };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    selectRoomCategory('Composition');

    const stage = screen.getByTestId('room-composition-stage');
    Object.defineProperty(stage, 'getBoundingClientRect', {
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
    const placement = screen.getByTestId('room-placement-key-placement');
    fireEvent.mouseDown(placement, { button: 0, clientX: 100, clientY: 50 });
    fireEvent.mouseMove(window, { clientX: 300, clientY: 150 });
    fireEvent.mouseUp(window, { clientX: 300, clientY: 150 });
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: {
          foyer: {
            data: {
              placements: [
                expect.objectContaining({
                  bounds: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
                }),
              ],
            },
          },
        },
      }),
    );

    const resize = screen.getByRole('button', { name: 'Resize key-placement' });
    fireEvent.mouseDown(resize, { button: 0, clientX: 500, clientY: 250 });
    fireEvent.mouseMove(window, { clientX: 700, clientY: 350 });
    fireEvent.mouseUp(window, { clientX: 700, clientY: 350 });
    await waitFor(() => {
      const document = useProjectStore.getState().document;
      expect(isAuthoringProject(document)).toBe(true);
      if (!isAuthoringProject(document)) return;
      const bounds = parseRoomData(document.rooms.foyer?.data)?.placements[0]?.bounds;
      expect(bounds?.x).toBeCloseTo(0.3);
      expect(bounds?.y).toBeCloseTo(0.3);
      expect(bounds?.width).toBeCloseTo(0.4);
      expect(bounds?.height).toBeCloseTo(0.4);
    });
  });

  it('allows placing the same Interactable definition multiple times', async () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        order: 0,
        presentation: { label: null, layout: null },
      },
    ];
    const key = defaultInteractableData('Brass Key');
    room.interactables = [
      {
        id: 'key',
        interactable: { $ref: { collection: 'interactables', id: 'key' } },
        condition: { kind: 'always' },
        placementId: 'key-placement',
        enabled: true,
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.key = { id: 'key', label: 'Brass Key', data: key };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    selectRoomCategory('Composition');

    fireEvent.click(screen.getByRole('button', { name: 'Place Interactable' }));
    fireEvent.click(screen.getByRole('button', { name: /Brass Key/i }));
    const stage = screen.getByTestId('room-composition-stage');
    Object.defineProperty(stage, 'getBoundingClientRect', {
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
    fireEvent.mouseDown(stage, { button: 0, clientX: 600, clientY: 200 });
    fireEvent.mouseUp(window, { clientX: 600, clientY: 200 });

    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: {
          foyer: {
            data: {
              interactables: [
                expect.objectContaining({ id: 'key', placementId: 'key-placement' }),
                expect.objectContaining({ id: 'key-2', placementId: 'key-2-placement' }),
              ],
            },
          },
        },
      }),
    );
  });
});
