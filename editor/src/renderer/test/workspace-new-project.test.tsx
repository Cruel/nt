import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { WorkspacePage } from '@/routes/workspace';
import { useCommandStore } from '@/commands/command-store';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { useProjectStore } from '@/project/project-store';
import { defaultComfyUiConfig } from '../../shared/comfyui';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import {
  emptyEditorProjectState,
  stripEditorProjectState,
} from '../../shared/project-schema/editor-project-state';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { setLoadedEditorProjectState } from '@/workbench/project-editor-state';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { buildProjectSettingsTab } from '@/workbench/editor-registry';
import { WORKSPACE_TOOLBAR_COMMAND_EVENT } from '@/workspace/workspace-toolbar-events';

const bottomPanelRef = vi.hoisted(() => ({
  current: {
    collapse: vi.fn(),
    expand: vi.fn(),
    getSize: vi.fn(() => ({ asPercentage: 30, inPixels: 300 })),
    isCollapsed: vi.fn(() => false),
    resize: vi.fn(),
  },
}));

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
  usePanelRef: () => bottomPanelRef,
}));

function dispatchNewProject() {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_TOOLBAR_COMMAND_EVENT, { detail: 'new-project' }),
    );
  });
}

function dispatchOpenProject(projectPath: string) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_TOOLBAR_COMMAND_EVENT, {
        detail: { command: 'open-project', projectPath },
      }),
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.getState().clearProject();
  useWorkbenchStore.getState().resetWorkbench();
  useDraftDirtyStore.getState().resetDraftDirty();
  useBottomPanelStore.getState().hydrate({
    visible: true,
    activePanelId: 'problems',
    sizePercent: 30,
  });
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
  setLoadedEditorProjectState(emptyEditorProjectState());
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
  vi.mocked(window.noveltea.getDefaultProjectDirectory).mockResolvedValue(
    '/home/test/Documents/NovelTea',
  );
  vi.mocked(window.noveltea.selectDirectory).mockResolvedValue(
    '/home/test/Documents/NovelTea/custom-project',
  );
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
    contentProject: stripEditorProjectState(
      createAuthoringProject({ id: 'my-story', name: 'My Story' }),
    ),
    savedContentProject: stripEditorProjectState(
      createAuthoringProject({ id: 'my-story', name: 'My Story' }),
    ),
    editorState: emptyEditorProjectState(),
    contentFingerprint: '0'.repeat(64),
    repairs: [],
    diagnostics: [],
  });
  vi.mocked(window.noveltea.purgeProjectTrash).mockResolvedValue({
    ok: true,
    success: true,
    diagnostics: [],
  });
  vi.mocked(window.noveltea.stopProjectAssetWatcher).mockResolvedValue({
    ok: true,
    success: true,
    diagnostics: [],
  });
});

describe('WorkspacePage new project modal', () => {
  it('keeps the workbench mounted when the bottom panel is toggled', async () => {
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
    const mountedWorkbench = screen.getByTestId('workbench');

    await act(async () => useBottomPanelStore.getState().setVisible(false));
    expect(screen.getByTestId('workbench')).toBe(mountedWorkbench);

    await act(async () => useBottomPanelStore.getState().setVisible(true));
    expect(screen.getByTestId('workbench')).toBe(mountedWorkbench);
  });

  it('does not restore project tabs from an unsupported legacy project', async () => {
    useWorkbenchStore.getState().openTab({
      id: 'tab:legacy-room',
      title: 'Bedroom',
      editorType: 'room',
      resource: {
        kind: 'record',
        stableId: 'room:bedroom',
        collection: 'room',
        entityId: 'bedroom',
      },
    });
    vi.mocked(window.noveltea.openProject).mockResolvedValue({
      ok: true,
      success: false,
      projectPath: '/home/test/legacy-project',
      projectFilePath: '/home/test/legacy-project/project.json',
      diagnostics: [
        {
          severity: 'error',
          path: '/schema',
          message: 'Unsupported project schema.',
          category: 'Project schema',
        },
      ],
    });

    render(<WorkspacePage />);
    dispatchOpenProject('/home/test/legacy-project/project.json');

    await waitFor(() =>
      expect(useWorkspaceStore.getState().statusMessage).toBe('Unsupported project schema'),
    );
    expect(useProjectStore.getState().document).toBeNull();
    expect(useWorkspaceStore.getState().project).toBeNull();
    expect(useWorkbenchStore.getState().tabsById).toEqual({});
    expect(
      await screen.findByRole('heading', { name: 'Project format is not supported' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'This project was created with an older or unsupported NovelTea format and cannot be opened by this version of the editor.',
      ),
    ).toBeInTheDocument();
  });

  it('handles an editor shortcut forwarded from a focused preview iframe', async () => {
    render(<WorkspacePage />);
    const shortcutHandler = vi.mocked(window.noveltea.onEditorShortcut).mock.calls.at(-1)?.[0];

    act(() => shortcutHandler?.('new'));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create NovelTea Project' })).toBeInTheDocument();
  });

  it('does not save project content when a preview forwards Ctrl+S without a savable active tab', async () => {
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

    await waitFor(() => expect(useWorkspaceStore.getState().statusMessage).toBe('Nothing to save'));
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
  });

  it('applies an active serializable draft before saving the project snapshot', async () => {
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
    const settingsTab = buildProjectSettingsTab();
    useWorkbenchStore.getState().openTab(settingsTab);
    const apply = vi.fn(() => {
      useCommandStore.getState().executeCommand({
        type: 'project.replaceAtPath',
        label: 'Apply settings draft',
        payload: { path: '/project/name', value: 'Saved Draft Title' },
        originSaveUnitId: 'project:settings',
        persistencePolicy: 'manual-save',
      });
      return true;
    });
    useDraftDirtyStore.getState().setDraftDirty('tab:settings:draft', {
      tabId: settingsTab.id,
      dirty: true,
      schema: 'noveltea.editor.draft.test',
      schemaVersion: 1,
      payload: { name: 'Saved Draft Title' },
      apply,
    });

    render(<WorkspacePage />);
    const shortcutHandler = vi.mocked(window.noveltea.onEditorShortcut).mock.calls.at(-1)?.[0];
    act(() => shortcutHandler?.('save'));

    await waitFor(() => expect(window.noveltea.saveProjectContent).toHaveBeenCalled());
    expect(apply).toHaveBeenCalledOnce();
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[0]?.[0]).toBe(
      '/mock/project/project.json',
    );
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[0]?.[2]).toMatchObject({
      project: { name: 'Saved Draft Title' },
    });
    expect(useDraftDirtyStore.getState().entriesByKey).not.toHaveProperty('tab:settings:draft');
  });

  it('checks editor-wide ComfyUI connection even when no project is loaded', async () => {
    usePreferencesStore.getState().setComfyUiConfig({ enabled: true });

    render(<WorkspacePage />);

    await waitFor(() =>
      expect(window.noveltea.checkComfyUiConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          serverUrl: 'http://127.0.0.1:8000',
        }),
      ),
    );
    await waitFor(() =>
      expect(useComfyUiStore.getState().status).toMatchObject({
        state: 'ready',
        message: 'ComfyUI ready',
      }),
    );
  });

  it('opens a modal instead of creating an unsaved project immediately', async () => {
    render(<WorkspacePage />);

    dispatchNewProject();

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create NovelTea Project' })).toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toHaveValue('New Project');
    await waitFor(() =>
      expect(screen.getByLabelText('Project directory')).toHaveValue(
        '/home/test/Documents/NovelTea/new-project',
      ),
    );
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
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_TOOLBAR_COMMAND_EVENT, { detail: 'close-project' }),
      );
    });

    await waitFor(() => expect(useProjectStore.getState().document).toBeNull());
    expect(useComfyUiStore.getState().status).toMatchObject({
      state: 'ready',
      message: 'ComfyUI ready',
    });
  });

  it('persists dirty recovery metadata on close without saving dirty content', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });
    useWorkspaceStore.setState({
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      project,
    });
    useCommandStore.getState().executeCommand({
      type: 'project.applyPatch',
      label: 'Rename project',
      payload: [{ op: 'replace', path: '/project/name', value: 'Dirty Name' }],
      originSaveUnitId: 'project:settings',
      persistencePolicy: 'manual-save',
    });

    render(<WorkspacePage />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_TOOLBAR_COMMAND_EVENT, { detail: 'close-project' }),
      );
    });

    await waitFor(() => expect(useProjectStore.getState().document).toBeNull());
    expect(window.noveltea.saveProjectEditorMetadata).toHaveBeenCalledWith(
      '/mock/project/project.json',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.objectContaining({
        recovery: expect.objectContaining({
          saveUnitsById: expect.objectContaining({
            'project:settings': expect.objectContaining({
              patches: expect.arrayContaining([
                { op: 'replace', path: '/project/name', value: 'Dirty Name' },
              ]),
            }),
          }),
        }),
      }),
    );
  });

  it('blocks project close when recovery metadata cannot be flushed', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });
    useWorkspaceStore.setState({
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      project,
    });
    vi.mocked(window.noveltea.saveProjectEditorMetadata).mockResolvedValue({
      ok: false,
      success: false,
      diagnostics: [
        {
          severity: 'error',
          category: 'Project recovery',
          path: '/editor',
          message: 'External project content changed.',
        },
      ],
      error: 'External project content changed.',
    });

    render(<WorkspacePage />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_TOOLBAR_COMMAND_EVENT, { detail: 'close-project' }),
      );
    });

    await waitFor(() => expect(window.noveltea.saveProjectEditorMetadata).toHaveBeenCalled());
    expect(useProjectStore.getState().document).not.toBeNull();
    expect(window.noveltea.stopProjectAssetWatcher).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().statusMessage).toBe('External project content changed.');
    expect(useBottomPanelStore.getState()).toMatchObject({
      visible: true,
      activePanelId: 'problems',
    });
  });

  it('does not complete window exit when recovery metadata flush fails', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });
    useWorkspaceStore.setState({
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      project,
    });
    let beforeClose: (() => void) | null = null;
    vi.mocked(window.noveltea.onAppWindowBeforeClose).mockImplementation((callback) => {
      beforeClose = callback;
      return () => undefined;
    });
    vi.mocked(window.noveltea.saveProjectEditorMetadata).mockResolvedValue({
      ok: false,
      success: false,
      diagnostics: [],
      error: 'Metadata conflict.',
    });

    render(<WorkspacePage />);
    act(() => beforeClose?.());

    await waitFor(() => expect(window.noveltea.saveProjectEditorMetadata).toHaveBeenCalled());
    expect(window.noveltea.completeAppWindowExit).not.toHaveBeenCalled();
    expect(useProjectStore.getState().document).not.toBeNull();
  });

  it('debounces automatic recovery metadata writes after content becomes dirty', async () => {
    vi.useFakeTimers();
    try {
      const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
      useProjectStore.getState().loadProjectDocument({
        document: project,
        projectPath: '/mock/project',
        projectFilePath: '/mock/project/project.json',
      });
      useWorkspaceStore.setState({
        projectPath: '/mock/project',
        projectFilePath: '/mock/project/project.json',
        project,
      });
      render(<WorkspacePage />);

      act(() => {
        useCommandStore.getState().executeCommand({
          type: 'project.applyPatch',
          label: 'Rename project',
          payload: [{ op: 'replace', path: '/project/name', value: 'Changed' }],
          originSaveUnitId: 'project:settings',
          persistencePolicy: 'manual-save',
        });
      });
      await act(async () => {
        vi.advanceTimersByTime(499);
        await Promise.resolve();
      });
      expect(window.noveltea.saveProjectEditorMetadata).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(window.noveltea.saveProjectEditorMetadata).toHaveBeenCalledTimes(1);
      expect(isAuthoringProject(useProjectStore.getState().document)).toBe(true);
      expect(window.noveltea.saveProjectEditorMetadata).toHaveBeenCalledWith(
        '/mock/project/project.json',
        expect.stringMatching(/^[0-9a-f]{64}$/),
        expect.objectContaining({
          recovery: expect.objectContaining({
            saveUnitsById: expect.objectContaining({
              'project:settings': expect.objectContaining({
                affectedPaths: ['/project/name'],
              }),
            }),
          }),
        }),
      );
      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
      });
      expect(window.noveltea.saveProjectEditorMetadata).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

    fireEvent.change(await screen.findByLabelText('Project name'), {
      target: { value: 'My Story' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() =>
      expect(window.noveltea.createProject).toHaveBeenCalledWith({
        projectName: 'My Story',
        projectDirectory: '/home/test/Documents/NovelTea/my-story',
      }),
    );
    await waitFor(() =>
      expect(useProjectStore.getState().projectFilePath).toBe(
        '/home/test/Documents/NovelTea/my-story/project.json',
      ),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('blocks custom project directories containing spaces', async () => {
    render(<WorkspacePage />);
    dispatchNewProject();

    fireEvent.change(await screen.findByLabelText('Project directory'), {
      target: { value: '/tmp/my project' },
    });

    expect(screen.getByText('Project paths must not contain spaces.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Project' })).toBeDisabled();
  });
});
