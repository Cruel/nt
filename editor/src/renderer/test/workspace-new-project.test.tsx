import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { WorkspacePage } from '@/routes/workspace';
import { useCommandStore } from '@/commands/command-store';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { useComfyUiQueueStore } from '@/comfyui/comfyui-queue-store';
import { useProjectStore } from '@/project/project-store';
import { defaultComfyUiConfig } from '../../shared/comfyui';
import {
  authoringProjectSchema,
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
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
import { useRecentProjectsStore } from '@/workspace/recent-projects-store';
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
  useComfyUiQueueStore.setState({ jobsByPromptId: {}, localJobsByPromptId: {}, order: [] });
  useRecentProjectsStore.setState({ recentProjects: [] });
  setLoadedEditorProjectState(emptyEditorProjectState());
  useComfyUiStore.setState({
    config: {
      enabled: false,
      serverUrl: 'http://127.0.0.1:8000',
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
    projectSessionId: 'created-project-session',
  });
  vi.mocked(window.noveltea.openProject).mockResolvedValue({
    ok: true,
    success: true,
    projectPath: '/home/test/Documents/NovelTea/my-story',
    projectFilePath: '/home/test/Documents/NovelTea/my-story/project.json',
    projectSessionId: 'opened-project-session',
    contentProject: stripEditorProjectState(
      createAuthoringProject({ id: 'my-story', name: 'My Story' }),
    ),
    savedContentProject: stripEditorProjectState(
      createAuthoringProject({ id: 'my-story', name: 'My Story' }),
    ),
    editorState: emptyEditorProjectState(),
    repairs: [],
    diagnostics: [],
  });
  vi.mocked(window.noveltea.purgeProjectTrash).mockResolvedValue({
    ok: true,
    success: true,
    diagnostics: [],
  });
  vi.mocked(window.noveltea.stopProjectWorkspaceWatcher).mockResolvedValue({
    ok: true,
    success: true,
    diagnostics: [],
  });
});

describe('WorkspacePage new project modal', () => {
  it('routes asset-only watcher events to asset audit without republishing authoring state', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    const initialRevision = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
    const assetRevision = `sha256:${'b'.repeat(64)}` as `sha256:${string}`;
    useProjectStore.getState().loadProjectDocument({
      document: project,
      savedDocument: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: 'opened-project-session',
      workspaceRevision: initialRevision,
    });
    useWorkspaceStore.setState({
      project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });

    render(<WorkspacePage />);
    await waitFor(() =>
      expect(window.noveltea.startProjectWorkspaceWatcher).toHaveBeenCalledWith(
        'opened-project-session',
      ),
    );
    vi.mocked(window.noveltea.auditProjectAssets).mockClear();
    const beforeDocument = useProjectStore.getState().document;
    const beforeSavedDocument = useProjectStore.getState().savedDocument;
    const callback = vi.mocked(window.noveltea.onProjectWorkspaceChanged).mock.calls.at(-1)?.[0];
    expect(callback).toBeDefined();

    act(() => {
      callback?.({
        projectSessionId: 'opened-project-session',
        changedPaths: ['assets/images/logo.png'],
        authoringChangedPaths: [],
        assetChangedPaths: ['assets/images/logo.png'],
        candidate: {
          success: true,
          diagnostics: [],
          contentProject: stripEditorProjectState(project),
          savedContentProject: stripEditorProjectState(project),
          editorState: emptyEditorProjectState(),
          workspaceRevision: assetRevision,
          fileRevisions: { 'assets/images/logo.png': assetRevision },
          scriptSourcePaths: {},
        },
      });
    });

    await waitFor(() => expect(window.noveltea.auditProjectAssets).toHaveBeenCalledTimes(1));
    expect(useProjectStore.getState().document).toBe(beforeDocument);
    expect(useProjectStore.getState().savedDocument).toBe(beforeSavedDocument);
    expect(useProjectStore.getState().workspaceRevision).toBe(assetRevision);
    expect(useWorkspaceStore.getState().statusMessage).not.toBe(
      'Reloaded external project changes',
    );
  });

  it('surfaces a missing tracked asset without republishing or clearing the authoring project', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    const revision = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
    useProjectStore.getState().loadProjectDocument({
      document: project,
      savedDocument: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: 'opened-project-session',
      workspaceRevision: revision,
    });
    useWorkspaceStore.setState({
      project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });

    render(<WorkspacePage />);
    await waitFor(() =>
      expect(window.noveltea.startProjectWorkspaceWatcher).toHaveBeenCalledWith(
        'opened-project-session',
      ),
    );
    const beforeDocument = useProjectStore.getState().document;
    const callback = vi.mocked(window.noveltea.onProjectWorkspaceChanged).mock.calls.at(-1)?.[0];
    expect(callback).toBeDefined();

    act(() => {
      callback?.({
        projectSessionId: 'opened-project-session',
        changedPaths: ['assets/images/missing.png'],
        authoringChangedPaths: [],
        assetChangedPaths: ['assets/images/missing.png'],
        candidate: {
          success: false,
          diagnostics: [
            {
              code: 'workspace.source.missing',
              severity: 'error',
              category: 'Project workspace',
              path: '/assets/images/missing.png',
              message: "Authoritative source file 'assets/images/missing.png' is missing.",
              boundaries: ['authoring'],
              ownerPaths: ['/assets/images/missing.png'],
            },
          ],
        },
      });
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().statusMessage).toBe(
        'Asset source changes require attention',
      ),
    );
    expect(useProjectStore.getState().document).toBe(beforeDocument);
    expect(isAuthoringProject(useProjectStore.getState().document)).toBe(true);
    expect(useBottomPanelStore.getState()).toMatchObject({
      visible: true,
      activePanelId: 'problems',
    });
    expect(useWorkspaceStore.getState().diagnostics).toContainEqual(
      expect.objectContaining({ category: 'Asset source', severity: 'error' }),
    );
  });

  it('clears a latched external-source error when the repaired source returns to the current revision', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    const revision = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
    useProjectStore.getState().loadProjectDocument({
      document: project,
      savedDocument: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: 'opened-project-session',
      workspaceRevision: revision,
      fileRevisions: { 'records/rooms/hall.json': revision },
    });
    useWorkspaceStore.setState({
      project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });

    render(<WorkspacePage />);
    await waitFor(() =>
      expect(window.noveltea.startProjectWorkspaceWatcher).toHaveBeenCalledWith(
        'opened-project-session',
      ),
    );
    const callback = vi.mocked(window.noveltea.onProjectWorkspaceChanged).mock.calls.at(-1)?.[0];
    expect(callback).toBeDefined();

    act(() => {
      callback?.({
        projectSessionId: 'opened-project-session',
        changedPaths: ['records/rooms/hall.json'],
        authoringChangedPaths: ['records/rooms/hall.json'],
        assetChangedPaths: [],
        candidate: {
          success: false,
          diagnostics: [
            {
              code: 'authoring.workspace.invalid',
              severity: 'error',
              category: 'Project workspace',
              path: '/rooms/hall/data',
              message: 'Required Room field is missing.',
              boundaries: ['authoring'],
              ownerPaths: ['/rooms/hall/data'],
            },
          ],
        },
      });
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().statusMessage).toBe(
        'External project changes contain unreadable source files',
      ),
    );
    expect(useWorkspaceStore.getState().diagnostics).toContainEqual(
      expect.objectContaining({ category: 'External project source', severity: 'error' }),
    );

    act(() => {
      callback?.({
        projectSessionId: 'opened-project-session',
        changedPaths: ['records/rooms/hall.json'],
        authoringChangedPaths: ['records/rooms/hall.json'],
        assetChangedPaths: [],
        candidate: {
          success: true,
          diagnostics: [],
          contentProject: stripEditorProjectState(project),
          savedContentProject: stripEditorProjectState(project),
          editorState: emptyEditorProjectState(),
          workspaceRevision: revision,
          fileRevisions: { 'records/rooms/hall.json': revision },
          scriptSourcePaths: {},
        },
      });
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().statusMessage).toBe(
        'External project source is valid again',
      ),
    );
    expect(useWorkspaceStore.getState().diagnostics).not.toContainEqual(
      expect.objectContaining({ category: 'External project source' }),
    );
    expect(useProjectStore.getState().workspaceRevision).toBe(revision);
    expect(isAuthoringProject(useProjectStore.getState().document)).toBe(true);
  });

  it('publishes an external Room source edit without invalidating the live authoring project', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    const externalProject = structuredClone(project);
    externalProject.rooms.hall!.description = 'Changed outside NovelTea';
    const initialRevision = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
    const externalRevision = `sha256:${'b'.repeat(64)}` as `sha256:${string}`;
    const roomRevision = `sha256:${'c'.repeat(64)}` as `sha256:${string}`;
    useProjectStore.getState().loadProjectDocument({
      document: project,
      savedDocument: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: 'opened-project-session',
      workspaceRevision: initialRevision,
      fileRevisions: { 'records/rooms/hall.json': initialRevision },
    });
    useWorkspaceStore.setState({
      project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });

    render(<WorkspacePage />);
    await waitFor(() =>
      expect(window.noveltea.startProjectWorkspaceWatcher).toHaveBeenCalledWith(
        'opened-project-session',
      ),
    );
    const callback = vi.mocked(window.noveltea.onProjectWorkspaceChanged).mock.calls.at(-1)?.[0];
    expect(callback).toBeDefined();

    act(() => {
      callback?.({
        projectSessionId: 'opened-project-session',
        changedPaths: ['records/rooms/hall.json'],
        authoringChangedPaths: ['records/rooms/hall.json'],
        assetChangedPaths: [],
        candidate: {
          success: true,
          diagnostics: [],
          contentProject: stripEditorProjectState(externalProject),
          savedContentProject: stripEditorProjectState(externalProject),
          editorState: emptyEditorProjectState(),
          workspaceRevision: externalRevision,
          fileRevisions: { 'records/rooms/hall.json': roomRevision },
          scriptSourcePaths: {},
        },
      });
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().statusMessage).toBe('Reloaded external project changes'),
    );
    const live = useProjectStore.getState().document;
    expect(authoringProjectSchema.safeParse(live).success).toBe(true);
    expect(isAuthoringProject(live)).toBe(true);
    if (isAuthoringProject(live)) {
      expect(live.rooms.hall?.description).toBe('Changed outside NovelTea');
    }
    expect(isAuthoringProject(useWorkspaceStore.getState().project)).toBe(true);
  });

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
    expect(window.noveltea.closeActiveProject).toHaveBeenCalledOnce();
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

  it('notifies the user when a missing recent project is removed', async () => {
    useRecentProjectsStore.setState({
      recentProjects: [
        {
          projectPath: '/home/test/missing-project',
          label: 'Missing Project',
          openedAt: 1,
        },
      ],
    });
    vi.mocked(window.noveltea.openProject).mockRejectedValueOnce(
      new Error(
        "ENOENT: no such file or directory, open '/home/test/missing-project/project.json'",
      ),
    );

    render(<WorkspacePage />);
    dispatchOpenProject('/home/test/missing-project');

    expect(
      await screen.findByRole('heading', { name: 'Unable to open project' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /The recent project could not be opened and was removed from Recent Projects\./,
      ),
    ).toBeInTheDocument();
    expect(useRecentProjectsStore.getState().recentProjects).toEqual([]);
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

  it('cancels a scheduled recovery debounce before an immediate content save', async () => {
    vi.useFakeTimers();
    try {
      const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
      useProjectStore.getState().loadProjectDocument({
        document: project,
        savedDocument: project,
        projectPath: '/mock/project',
        projectFilePath: '/mock/project/project.json',
        projectSessionId: 'opened-project-session',
      });
      useWorkspaceStore.setState({
        project,
        projectPath: '/mock/project',
        projectFilePath: '/mock/project/project.json',
      });
      const settingsTab = buildProjectSettingsTab();
      useWorkbenchStore.getState().openTab(settingsTab);
      render(<WorkspacePage />);

      act(() => {
        useCommandStore.getState().executeCommand({
          type: 'project.replaceAtPath',
          label: 'Rename project',
          payload: { path: '/project/name', value: 'Saved immediately' },
          originSaveUnitId: 'project:settings',
          persistencePolicy: 'manual-save',
        });
      });
      const shortcutHandler = vi.mocked(window.noveltea.onEditorShortcut).mock.calls.at(-1)?.[0];
      act(() => shortcutHandler?.('save'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.noveltea.saveProjectContent).toHaveBeenCalledTimes(1);
      expect(window.noveltea.saveProjectEditorMetadata).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(window.noveltea.saveProjectEditorMetadata).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies an active serializable draft before saving the project snapshot', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: 'opened-project-session',
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
      payload: { name: 'Saved Draft Title' },
      apply,
    });

    render(<WorkspacePage />);
    const shortcutHandler = vi.mocked(window.noveltea.onEditorShortcut).mock.calls.at(-1)?.[0];
    act(() => shortcutHandler?.('save'));

    await waitFor(() => expect(window.noveltea.saveProjectContent).toHaveBeenCalled());
    expect(apply).toHaveBeenCalledOnce();
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[0]?.[0]).toBe(
      'opened-project-session',
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
    expect(window.noveltea.closeActiveProject).toHaveBeenCalledOnce();
    expect(useComfyUiStore.getState().status).toMatchObject({
      state: 'ready',
      message: 'ComfyUI ready',
    });
  });

  it('cancels running ComfyUI work before revoking the Project session on close', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: 'opened-project-session',
    });
    useWorkspaceStore.setState({
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      project,
    });
    render(<WorkspacePage />);
    act(() =>
      useComfyUiQueueStore.getState().updateProgress({
        promptId: 'running-job',
        workflowId: 'workflow',
        state: 'running',
        queueRemaining: 0,
        currentNode: null,
        progressValue: null,
        progressMax: null,
        message: 'Running',
        projectFilePath: '/mock/project/project.json',
      }),
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_TOOLBAR_COMMAND_EVENT, { detail: 'close-project' }),
      );
    });

    await waitFor(() => expect(window.noveltea.closeActiveProject).toHaveBeenCalledOnce());
    expect(window.noveltea.cancelComfyUiJob).toHaveBeenCalledWith(
      'opened-project-session',
      expect.any(Object),
    );
    expect(vi.mocked(window.noveltea.cancelComfyUiJob).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(window.noveltea.closeActiveProject).mock.invocationCallOrder[0]!,
    );
  });

  it('cancels running ComfyUI work before revoking the Project session on switch', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: 'opened-project-session',
    });
    useWorkspaceStore.setState({
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      project,
    });
    render(<WorkspacePage />);
    act(() =>
      useComfyUiQueueStore.getState().updateProgress({
        promptId: 'running-job',
        workflowId: 'workflow',
        state: 'running',
        queueRemaining: 0,
        currentNode: null,
        progressValue: null,
        progressMax: null,
        message: 'Running',
        projectFilePath: '/mock/project/project.json',
      }),
    );
    dispatchOpenProject('/mock/next-project');

    await waitFor(() =>
      expect(window.noveltea.openProject).toHaveBeenCalledWith('/mock/next-project'),
    );
    expect(window.noveltea.cancelComfyUiJob).toHaveBeenCalledWith(
      'opened-project-session',
      expect.any(Object),
    );
    expect(vi.mocked(window.noveltea.cancelComfyUiJob).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(window.noveltea.closeActiveProject).mock.invocationCallOrder[0]!,
    );
  });

  it('persists dirty recovery metadata on close without saving dirty content', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: 'opened-project-session',
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
      'opened-project-session',
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
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
      {},
    );
  });

  it('refreshes the recent project label from the current name when closing', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'Old Name' });
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
    useRecentProjectsStore.setState({
      recentProjects: [
        {
          projectPath: '/mock/project',
          projectFilePath: '/mock/project/project.json',
          label: 'Old Name',
          openedAt: 1,
        },
      ],
    });

    render(<WorkspacePage />);
    act(() => {
      useCommandStore.getState().executeCommand({
        type: 'project.applyPatch',
        label: 'Rename project',
        payload: [{ op: 'replace', path: '/project/name', value: 'New Name' }],
        originSaveUnitId: 'project:settings',
        persistencePolicy: 'manual-save',
      });
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_TOOLBAR_COMMAND_EVENT, { detail: 'close-project' }),
      );
    });

    await waitFor(() => expect(useProjectStore.getState().document).toBeNull());
    expect(useRecentProjectsStore.getState().recentProjects).toEqual([
      expect.objectContaining({
        projectPath: '/mock/project',
        label: 'New Name',
      }),
    ]);
  });

  it('blocks project close when recovery metadata cannot be flushed', async () => {
    const project = createAuthoringProject({ id: 'my-story', name: 'My Story' });
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: 'opened-project-session',
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
    expect(window.noveltea.closeActiveProject).not.toHaveBeenCalled();
    expect(window.noveltea.stopProjectWorkspaceWatcher).not.toHaveBeenCalled();
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
      projectSessionId: 'opened-project-session',
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
        projectSessionId: 'opened-project-session',
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
      const afterMetadataFlush = useProjectStore.getState();
      expect(isAuthoringProject(afterMetadataFlush.document)).toBe(true);
      expect(isAuthoringProject(afterMetadataFlush.savedDocument)).toBe(true);
      if (
        isAuthoringProject(afterMetadataFlush.document) &&
        isAuthoringProject(afterMetadataFlush.savedDocument)
      ) {
        expect(afterMetadataFlush.document.project.name).toBe('Changed');
        expect(afterMetadataFlush.savedDocument.project.name).toBe('My Story');
      }
      expect(window.noveltea.saveProjectEditorMetadata).toHaveBeenCalledWith(
        'opened-project-session',
        expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        expect.objectContaining({
          recovery: expect.objectContaining({
            saveUnitsById: expect.objectContaining({
              'project:settings': expect.objectContaining({
                affectedPaths: ['/project/name'],
              }),
            }),
          }),
        }),
        {},
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

  it('uses the selected directory as the parent of a new project folder', async () => {
    render(<WorkspacePage />);
    dispatchNewProject();

    fireEvent.change(await screen.findByLabelText('Project name'), {
      target: { value: 'My Story' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Project directory')).toHaveValue(
        '/home/test/Documents/NovelTea/custom-project/my-story',
      ),
    );
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
    expect(useProjectStore.getState().projectSessionId).toBe('opened-project-session');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('allows custom project directories containing spaces', async () => {
    render(<WorkspacePage />);
    dispatchNewProject();

    fireEvent.change(await screen.findByLabelText('Project directory'), {
      target: { value: '/tmp/my project' },
    });

    expect(screen.getByRole('button', { name: 'Create Project' })).toBeEnabled();
  });
});
