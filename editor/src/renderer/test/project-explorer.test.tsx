import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '@/project/project-store';
import { ProjectExplorer } from '@/workspace/ProjectExplorer';
import { useRecentProjectsStore } from '@/workspace/recent-projects-store';
import { WORKSPACE_TOOLBAR_COMMAND_EVENT, type WorkspaceToolbarCommandDetail } from '@/workspace/workspace-toolbar-events';

describe('ProjectExplorer', () => {
  beforeEach(() => {
    useProjectStore.getState().clearProject();
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

    expect(screen.getByText('New Project')).toBeInTheDocument();
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
});
