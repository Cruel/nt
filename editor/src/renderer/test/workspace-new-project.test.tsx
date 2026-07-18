import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePage } from '@/routes/workspace';
import { useCommandStore } from '@/commands/command-store';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { useProjectStore } from '@/project/project-store';
import { defaultComfyUiConfig } from '../../shared/comfyui';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
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

function dispatchOpenProject(projectPath: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent(WORKSPACE_TOOLBAR_COMMAND_EVENT, {
      detail: { command: 'open-project', projectPath },
    }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.getState().clearProject();
  useWorkbenchStore.getState().resetWorkbench();
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
  useComfyUiStore.setState({
    config: {
      enabled: false,
      serverUrl: 'http://127.0.0.1:8000',
      defaultWorkflowId: 'flux2-klein-text-to-image',
      defaultWorkflows: {
        'image.generate': 'flux2-klein-text-to-image',
        'image.edit': 'flux2-klein-image-edit',
      },
      requestTimeoutMs: 15000,
      connectionCheckIntervalMs: 10000,
    },
    status: {
      state: 'disabled',
      serverUrl: 'http://127.0.0.1:8000',
      checkedAt: null,
      message: 'ComfyUI disabled',
      queueRemaining: null,
    },
    progress: {
      promptId: null,
      workflowId: null,
      state: 'idle',
      queueRemaining: null,
      currentNode: null,
      progressValue: null,
      progressMax: null,
      message: null,
    },
  });
  usePreferencesStore.setState({
    theme: 'system',
    language: 'system',
    codeEditorTheme: 'noveltea',
    restoreLastProjectOnStart: false,
    showPreviewFpsCounter: false,
    lastProjectPath: null,
    defaultProjectDirectory: null,
    comfyUiConfig: defaultComfyUiConfig(),
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
    projectPath: '/home/test/Documents/NovelTea/my-story',
    projectFilePath: '/home/test/Documents/NovelTea/my-story/project.json',
    project: createAuthoringProject({ id: 'my-story', name: 'My Story' }),
    diagnostics: [],
  });
  vi.mocked(window.noveltea.saveProject).mockResolvedValue({ ok: true, success: true, projectPath: '/mock/project', projectFilePath: '/mock/project/project.json' });
  vi.mocked(window.noveltea.purgeProjectTrash).mockResolvedValue({ ok: true, success: true, diagnostics: [] });
  vi.mocked(window.noveltea.stopProjectAssetWatcher).mockResolvedValue({ ok: true, success: true, diagnostics: [] });
});

describe('WorkspacePage new project modal', () => {
  it('does not restore project tabs from an unsupported legacy project', async () => {
    useWorkbenchStore.getState().openTab({
      id: 'tab:legacy-room',
      title: 'Bedroom',
      editorType: 'room',
      resource: { kind: 'record', stableId: 'room:bedroom', collection: 'room', entityId: 'bedroom' },
    });
    vi.mocked(window.noveltea.openProject).mockResolvedValue({
      ok: true,
      success: true,
      projectPath: '/home/test/legacy-project',
      projectFilePath: '/home/test/legacy-project/project.json',
      project: { schema: 'noveltea.project', schemaVersion: 0, room: { bedroom: {} } },
      diagnostics: [],
    });

    render(<WorkspacePage />);
    dispatchOpenProject('/home/test/legacy-project/project.json');

    await waitFor(() => expect(useWorkspaceStore.getState().statusMessage).toBe('Unsupported project schema'));
    expect(useProjectStore.getState().document).toBeNull();
    expect(useWorkspaceStore.getState().project).toBeNull();
    expect(useWorkbenchStore.getState().tabsById).toEqual({});
    expect(await screen.findByRole('heading', { name: 'Project format is not supported' })).toBeInTheDocument();
    expect(screen.getByText('This project was created with an older or unsupported NovelTea format and cannot be opened by this version of the editor.')).toBeInTheDocument();
  });

  it('handles an editor shortcut forwarded from a focused preview iframe', async () => {
    render(<WorkspacePage />);
    const shortcutHandler = vi.mocked(window.noveltea.onEditorShortcut).mock.calls.at(-1)?.[0];

    act(() => shortcutHandler?.('new'));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create NovelTea Project' })).toBeInTheDocument();
  });

  it('saves through the normal workspace command when a preview forwards the shortcut', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });
    useWorkspaceStore.setState({
      project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });
    render(<WorkspacePage />);
    const shortcutHandler = vi.mocked(window.noveltea.onEditorShortcut).mock.calls.at(-1)?.[0];

    act(() => shortcutHandler?.('save'));

    await waitFor(() => expect(window.noveltea.saveProject).toHaveBeenCalled());
  });

  it('checks editor-wide ComfyUI connection even when no project is loaded', async () => {
    usePreferencesStore.getState().setComfyUiConfig({ enabled: true });

    render(<WorkspacePage />);

    await waitFor(() => expect(window.noveltea.checkComfyUiConnection).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      serverUrl: 'http://127.0.0.1:8000',
    })));
    await waitFor(() => expect(useComfyUiStore.getState().status).toMatchObject({
      state: 'ready',
      message: 'ComfyUI ready',
    }));
  });

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

  it('does not reset editor-wide ComfyUI status when closing a project', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: createAuthoringProject({ id: 'my-story', name: 'My Story' }),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });
    useWorkspaceStore.setState({
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      project: createAuthoringProject({ id: 'my-story', name: 'My Story' }),
    });
    useComfyUiStore.setState((state) => ({
      config: { ...state.config, enabled: true },
      status: {
        state: 'ready',
        serverUrl: 'http://127.0.0.1:8000',
        checkedAt: 'now',
        message: 'ComfyUI ready',
        queueRemaining: 0,
      },
    }));

    render(<WorkspacePage />);
    act(() => {
      window.dispatchEvent(new CustomEvent(WORKSPACE_TOOLBAR_COMMAND_EVENT, { detail: 'close-project' }));
    });

    await waitFor(() => expect(useProjectStore.getState().document).toBeNull());
    expect(useComfyUiStore.getState().status).toMatchObject({
      state: 'ready',
      message: 'ComfyUI ready',
    });
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
