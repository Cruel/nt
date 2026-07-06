import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject, type AuthoringProject } from '../../shared/project-schema/authoring-project';
import { ProjectExplorer } from '@/workspace/ProjectExplorer';
import { useRecentProjectsStore } from '@/workspace/recent-projects-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { dispatchWorkspaceToolbarCommand, WORKSPACE_TOOLBAR_COMMAND_EVENT, type WorkspaceToolbarCommandDetail } from '@/workspace/workspace-toolbar-events';

function loadProject(project: AuthoringProject = createAuthoringProject()) {
  useProjectStore.getState().loadUnsavedProjectDocument(project);
}

describe('ProjectExplorer', () => {
  beforeEach(() => {
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
    useWorkbenchStore.getState().resetWorkbench();
    useRecentProjectsStore.setState({ recentProjects: [] });
  });

  it('shows recent projects in the sidebar when no project is open', () => {
    useRecentProjectsStore.setState({
      recentProjects: [
        {
          projectPath: '/projects/demo',
          projectFilePath: '/projects/demo/game.json',
          label: 'Demo Project',
          openedAt: 1,
        },
      ],
    });
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, listener);

    render(<ProjectExplorer nodes={[]} />);

    expect(screen.queryByRole('button', { name: /^new$/i })).not.toBeInTheDocument();
    expect(screen.getByText('Open Project')).toBeInTheDocument();
    expect(screen.getByText('Recent Projects')).toBeInTheDocument();
    expect(screen.getByText('Demo Project')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Demo Project'));

    expect((listener.mock.calls[0]?.[0] as CustomEvent<WorkspaceToolbarCommandDetail>).detail).toEqual({
      command: 'open-project',
      projectPath: '/projects/demo/game.json',
    });
    window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, listener);
  });

  it('opens the generic wizard and auto-generates IDs until manually edited', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<ProjectExplorer nodes={[]} />);

    await user.click(screen.getByRole('button', { name: /^new$/i }));

    const labelInput = screen.getByLabelText('Entity label');
    const idInput = screen.getByLabelText('Entity ID');
    await user.clear(labelInput);
    await user.type(labelInput, 'Entry Hall');
    expect(idInput).toHaveValue('entry-hall');

    await user.clear(idInput);
    await user.type(idInput, 'custom-id');
    await user.clear(labelInput);
    await user.type(labelInput, 'Changed Label');
    expect(idInput).toHaveValue('custom-id');
  });

  it('opens a collection-specific wizard from the explorer context menu', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<ProjectExplorer nodes={[]} />);

    fireEvent.contextMenu(screen.getByRole('button', { name: /characters/i }));
    await user.click(screen.getByRole('button', { name: /create character/i }));

    expect(screen.getByText('Character setup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create character/i })).toBeInTheDocument();
  });

  it('renders create command diagnostics for duplicate IDs', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: {} };
    loadProject(project);
    render(<ProjectExplorer nodes={[]} />);

    await user.click(screen.getByRole('button', { name: /^new$/i }));
    const labelInput = screen.getByLabelText('Entity label');
    await user.clear(labelInput);
    await user.type(labelInput, 'Foyer');
    await user.click(screen.getByRole('button', { name: /create room/i }));

    expect(await screen.findByText('A record with this ID already exists.')).toBeInTheDocument();
  });

  it('creates metadata-only objects and opens the placeholder editor tab', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<ProjectExplorer nodes={[]} />);

    await user.click(screen.getByRole('button', { name: /^new$/i }));
    await user.click(screen.getByRole('button', { name: /^object/i }));
    const labelInput = screen.getByLabelText('Entity label');
    await user.clear(labelInput);
    await user.type(labelInput, 'Silver Key');
    await user.click(screen.getByRole('button', { name: /create object/i }));

    const document = useProjectStore.getState().document as AuthoringProject;
    expect(document.objects['silver-key']).toMatchObject({ id: 'silver-key', label: 'Silver Key', data: {} });
    expect(useWorkbenchStore.getState().tabsById['tab:placeholder:objects:silver-key']).toMatchObject({
      editorType: 'placeholder-entity',
      resource: { collection: 'objects', entityId: 'silver-key' },
    });
  });

  it('creates a room and can set it as the project entrypoint', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<ProjectExplorer nodes={[]} />);

    await user.click(screen.getByRole('button', { name: /^new$/i }));
    const labelInput = screen.getByLabelText('Entity label');
    await user.clear(labelInput);
    await user.type(labelInput, 'Entry Room');
    await user.click(screen.getByLabelText(/set as project entrypoint/i));
    await user.click(screen.getByRole('button', { name: /create room/i }));

    const document = useProjectStore.getState().document as AuthoringProject;
    expect(document.entrypoint).toEqual({ collection: 'rooms', id: 'entry-room' });
  });

  it('opens the wizard from the new-entity toolbar command used by Ctrl+N', async () => {
    loadProject();
    render(<ProjectExplorer nodes={[]} />);

    act(() => dispatchWorkspaceToolbarCommand('new-entity'));

    expect(await screen.findByText('New Entity Wizard')).toBeInTheDocument();
  });
});
