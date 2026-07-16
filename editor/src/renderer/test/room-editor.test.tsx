import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoomEditor } from '@/editors/rooms/RoomEditor';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';

const tab: WorkbenchTab = { id: 'tab:room-detail:rooms:foyer', title: 'Foyer', editorType: 'room-detail', resource: { kind: 'record', stableId: 'record:rooms:foyer', collection: 'rooms', entityId: 'foyer' } };
function renderEditor() { return render(<div style={{ width: 800, height: 600 }}><RoomEditor tab={tab} /></div>); }
beforeEach(() => { useProjectStore.getState().clearProject(); useCommandStore.getState().resetCommandHistory(); });
describe('RoomEditor', () => {
  it('renders the V2 room editor with lifecycle, exits, and placements', () => {
    const project = createAuthoringProject(); project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') }; useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor(); expect(screen.getByText('Lifecycle')).toBeInTheDocument(); expect(screen.getByText('Exits')).toBeInTheDocument(); expect(screen.getByText('Placements')).toBeInTheDocument();
  });
  it('updates the display name through the command bus', async () => {
    const project = createAuthoringProject(); project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') }; useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor(); fireEvent.change(screen.getByDisplayValue('Foyer'), { target: { value: 'Foyer East' } }); await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({ rooms: { foyer: { data: { displayName: 'Foyer East' } } } }));
  });
  it('creates a generic typed placement anchor', async () => {
    const project = createAuthoringProject(); project.interactables.lamp = { id: 'lamp', label: 'Lamp', extends: null, properties: {}, data: defaultInteractableData('Lamp') }; project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') }; useProjectStore.getState().loadUnsavedProjectDocument(project);
    renderEditor(); fireEvent.click(screen.getByText('Add placement')); await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({ rooms: { foyer: { data: { placements: [expect.objectContaining({ id: 'placement', order: 0 })] } } } }));
  });
});
