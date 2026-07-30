import { describe, expect, it, beforeEach } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RoomEditor } from '@/editors/rooms/RoomEditor';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
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
beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useWorkbenchStore.getState().resetWorkbench();
  clearWorkbenchTabStates();
});
describe('RoomEditor', () => {
  it('renders the V2 room editor with lifecycle, exits, and placements', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor();
    expect(screen.getByText('Lifecycle')).toBeInTheDocument();
    expect(screen.getByText('Exits')).toBeInTheDocument();
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
    expect(document.querySelector('[data-room-editor-scroll]')).toHaveClass('overflow-auto');
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
      schemaVersion: 2,
      payload: { previewCollapsed: true },
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
    fireEvent.click(screen.getByText('Add placement'));
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: {
          foyer: { data: { placements: [expect.objectContaining({ id: 'placement', order: 0 })] } },
        },
      }),
    );
  });
});
