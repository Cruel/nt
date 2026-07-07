import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoomEditor } from '@/editors/rooms/RoomEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import {
  captureWorkbenchTabState,
  clearWorkbenchTabStates,
  setWorkbenchTabState,
  useWorkbenchTabStateStore,
} from '@/workbench/workbench-tab-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

vi.mock('@/components/engine-preview', () => ({
  EnginePreview: ({ previewDocument }: { previewDocument: { kind: string } }) => <div data-kind={previewDocument.kind} data-testid="room-engine-preview" />,
}));

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({ value, onChange, className }: { value: string; onChange?: (value: string) => void; className?: string }) => (
    <textarea className={className} value={value} onChange={(event) => onChange?.(event.currentTarget.value)} />
  ),
}));

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

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  clearWorkbenchTabStates();
});

describe('RoomEditor', () => {
  it('renders typed room defaults and room preview', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<RoomEditor tab={tab} />);

    expect(screen.getByText('Foyer')).toBeInTheDocument();
    expect(screen.getByText('Navigation paths')).toBeInTheDocument();
    expect(screen.getByText('Hotspots')).toBeInTheDocument();
    expect(screen.getByTestId('room-engine-preview')).toHaveAttribute('data-kind', 'room-preview');
  });

  it('dispatches command-backed display name and hotspot updates', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<RoomEditor tab={tab} />);

    fireEvent.change(screen.getByDisplayValue('Foyer'), { target: { value: 'Foyer East' } });
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: { foyer: { data: { displayName: 'Foyer East' } } },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('room.replaceData');

    fireEvent.click(screen.getByText('Add Hotspot'));
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: { foyer: { data: { hotspots: [expect.objectContaining({ id: 'hotspot' })] } } },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('room.replaceData');
  });

  it('chooses and clears a background image through the selector', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: defaultRoomData('Foyer') };
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      tags: [],
      data: { kind: 'image', source: { type: 'project-file', path: 'assets/images/logo.png' }, aliases: [], extension: '.png' },
    };
    project.assets.theme = {
      id: 'theme',
      label: 'Theme',
      tags: [],
      data: { kind: 'audio', source: { type: 'project-file', path: 'assets/audio/theme.ogg' }, aliases: [], extension: '.ogg' },
    };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<RoomEditor tab={tab} />);

    fireEvent.click(screen.getByText('No image'));
    expect(await screen.findByText('Choose a background image')).toBeInTheDocument();
    expect(screen.getByText('Logo')).toBeInTheDocument();
    expect(screen.queryByText('Theme')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Logo'));
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { data: { background: { asset: { $ref: { collection: 'assets', id: 'logo' } } } } } },
    }));
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('room.replaceData');

    fireEvent.click(screen.getByText('Clear'));
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { data: { background: { asset: null } } } },
    }));
  });

  it('captures and restores tab state for scroll and local selector state', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    const view = render(<RoomEditor tab={tab} />);
    const scrollContainer = view.container.querySelector<HTMLElement>('[data-room-editor-scroll]')!;
    scrollContainer.scrollTop = 96;

    fireEvent.click(screen.getByText('No image'));
    expect(await screen.findByText('Choose a background image')).toBeInTheDocument();

    captureWorkbenchTabState(tab.id);

    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toMatchObject({
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        scroll: { scrollTop: 96, scrollLeft: 0 },
        backgroundSelectorOpen: true,
      },
    });

    view.unmount();
    setWorkbenchTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      schemaVersion: 1,
      payload: {
        scroll: { scrollTop: 48, scrollLeft: 0 },
        backgroundSelectorOpen: true,
      },
    });

    const restoredView = render(<RoomEditor tab={tab} />);

    expect(await screen.findByText('Choose a background image')).toBeInTheDocument();
    await waitFor(() => expect(restoredView.container.querySelector<HTMLElement>('[data-room-editor-scroll]')?.scrollTop).toBe(48));
  });
});
