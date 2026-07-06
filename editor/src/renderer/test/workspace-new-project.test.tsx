import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePage } from '@/routes/workspace';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { WORKSPACE_TOOLBAR_COMMAND_EVENT } from '@/workspace/workspace-toolbar-events';

vi.mock('@/workbench/Workbench', () => ({
  Workbench: () => <div data-testid="workbench" />,
}));

vi.mock('@/workbench/BottomPanel', () => ({
  BottomPanel: () => <div data-testid="bottom-panel" />,
}));

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function dispatchNewProject() {
  act(() => {
    window.dispatchEvent(new CustomEvent(WORKSPACE_TOOLBAR_COMMAND_EVENT, { detail: 'new-project' }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.getState().clearProject();
  useWorkspaceStore.setState({
    projectPath: null,
    projectFilePath: null,
    project: null,
    diagnostics: [],
    playbackTests: [],
    timeline: [],
    statusMessage: 'Preview disconnected',
  });
  useCommandStore.getState().resetCommandHistory();
  usePreferencesStore.setState({
    theme: 'system',
    language: 'system',
    codeEditorTheme: 'noveltea',
    restoreLastProjectOnStart: false,
    showPreviewFpsCounter: false,
    lastProjectPath: null,
    defaultProjectDirectory: null,
  });
  vi.mocked(window.noveltea.getDefaultProjectDirectory).mockResolvedValue('/home/test/Documents/NovelTea');
  vi.mocked(window.noveltea.selectDirectory).mockResolvedValue('/home/test/Documents/NovelTea/custom-project');
  vi.mocked(window.noveltea.createProject).mockResolvedValue({
    ok: true,
    success: true,
    projectPath: '/home/test/Documents/NovelTea/my-story',
    projectFilePath: '/home/test/Documents/NovelTea/my-story/project.json',
  });
  vi.mocked(window.noveltea.openProject).mockResolvedValue({
    ok: true,
    success: true,
    importedLegacy: false,
    projectPath: '/home/test/Documents/NovelTea/my-story',
    projectFilePath: '/home/test/Documents/NovelTea/my-story/project.json',
    project: createAuthoringProject({ id: 'my-story', name: 'My Story' }),
    diagnostics: [],
  });
});

describe('WorkspacePage new project modal', () => {
  it('opens a modal instead of creating an unsaved project immediately', async () => {
    render(<WorkspacePage />);

    dispatchNewProject();

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create NovelTea Project' })).toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toHaveValue('New Project');
    await waitFor(() => expect(screen.getByLabelText('Project directory')).toHaveValue('/home/test/Documents/NovelTea/new-project'));
    expect(useProjectStore.getState().document).toBeNull();
    expect(window.noveltea.createProject).not.toHaveBeenCalled();
  });

  it('updates the proposed directory from the project name until manually edited', async () => {
    render(<WorkspacePage />);
    dispatchNewProject();
    const name = await screen.findByLabelText('Project name');
    const directory = screen.getByLabelText('Project directory');

    fireEvent.change(name, { target: { value: 'My Story' } });
    await waitFor(() => expect(directory).toHaveValue('/home/test/Documents/NovelTea/my-story'));

    fireEvent.change(directory, { target: { value: '/tmp/custom-project' } });
    fireEvent.change(name, { target: { value: 'Other Story' } });
    expect(directory).toHaveValue('/tmp/custom-project');
  });

  it('creates and loads a saved project', async () => {
    render(<WorkspacePage />);
    dispatchNewProject();

    fireEvent.change(await screen.findByLabelText('Project name'), { target: { value: 'My Story' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() => expect(window.noveltea.createProject).toHaveBeenCalledWith({
      projectName: 'My Story',
      projectDirectory: '/home/test/Documents/NovelTea/my-story',
    }));
    await waitFor(() => expect(useProjectStore.getState().projectFilePath).toBe('/home/test/Documents/NovelTea/my-story/project.json'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('blocks custom project directories containing spaces', async () => {
    render(<WorkspacePage />);
    dispatchNewProject();

    fireEvent.change(await screen.findByLabelText('Project directory'), { target: { value: '/tmp/my project' } });

    expect(screen.getByText('Project paths must not contain spaces.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Project' })).toBeDisabled();
  });
});
