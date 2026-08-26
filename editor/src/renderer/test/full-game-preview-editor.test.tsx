import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FullGamePreviewEditor } from '@/editors/preview/FullGamePreviewEditor';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultHotspotBehavior } from '../../shared/project-schema/authoring-hotspots';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';
import type { PreviewClickableTarget } from '../../shared/preview-protocol';

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}));

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  sent: unknown[] = [];
  peer: FakePort | null = null;
  postMessage(message: unknown) {
    this.sent.push(message);
    this.peer?.onmessage?.({ data: message } as MessageEvent);
  }
  start() {}
  close() {
    this.closed = true;
  }
}

const ports: FakePort[] = [];

beforeEach(() => {
  ports.length = 0;
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = new FakePort();
      port2 = new FakePort();
      constructor() {
        this.port1.peer = this.port2;
        this.port2.peer = this.port1;
        ports.push(this.port1, this.port2);
      }
    },
  );
  usePreviewManagerStore.getState().resetPreviewManager();
  useWorkbenchStore.getState().resetWorkbench();
  useWorkspaceStore.setState({
    previewConnectionState: 'disconnected',
    selectedRuntimeObjectId: null,
    lastPreviewEvent: null,
    statusMessage: 'Preview disconnected',
  });
  usePreferencesStore.setState({ showPreviewFpsCounter: false });
  useProjectStore.getState().clearProject();
  useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
  usePendingInputStore.getState().resetPendingInputs();
  vi.mocked(window.noveltea.getEnginePreviewSession).mockResolvedValue({
    url: 'http://127.0.0.1:5000/?sessionToken=test-token',
    origin: 'http://127.0.0.1:5000',
    sessionToken: 'test-token',
  });
  vi.mocked(window.noveltea.reloadEnginePreview).mockResolvedValue({
    url: 'http://127.0.0.1:5001/?sessionToken=test-token-2',
    origin: 'http://127.0.0.1:5001',
    sessionToken: 'test-token-2',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderConnectedPreview() {
  useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
  render(<FullGamePreviewEditor />);
  const iframe = (await screen.findByTitle('NovelTea engine preview')) as HTMLIFrameElement;
  await waitFor(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow,
        origin: 'http://127.0.0.1:5000',
        data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
      }),
    );
    expect(ports.length).toBeGreaterThanOrEqual(2);
  });
  const editorPort = ports.at(-2)!;
  const previewPort = ports.at(-1)!;
  await act(async () => {
    previewPort.postMessage({
      version: 1,
      type: 'ready',
      capabilities: [],
      hostGeneration: 1,
      transportGeneration: 1,
      activeShaderVariant: 'glsl-120',
    });
  });
  await waitFor(() => expect(useWorkspaceStore.getState().previewConnectionState).toBe('ready'));
  return { iframe, editorPort, previewPort };
}

async function renderConnectedPreviewInPane(hidden = false) {
  useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
  const view = render(
    <div
      data-workbench-editor-pane="tab:full-game-preview"
      data-hidden={hidden ? true : undefined}
      aria-hidden={hidden ? true : undefined}
    >
      <FullGamePreviewEditor />
    </div>,
  );
  const iframe = (await screen.findByTitle('NovelTea engine preview')) as HTMLIFrameElement;
  await waitFor(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow,
        origin: 'http://127.0.0.1:5000',
        data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
      }),
    );
    expect(ports.length).toBeGreaterThanOrEqual(2);
  });
  const editorPort = ports.at(-2)!;
  const previewPort = ports.at(-1)!;
  await act(async () => {
    previewPort.postMessage({
      version: 1,
      type: 'ready',
      capabilities: [],
      hostGeneration: 1,
      transportGeneration: 1,
      activeShaderVariant: 'glsl-120',
    });
  });
  await waitFor(() => expect(useWorkspaceStore.getState().previewConnectionState).toBe('ready'));
  return { ...view, iframe, editorPort, previewPort };
}

function latestRequest(editorPort: FakePort, type: string) {
  return [...editorPort.sent]
    .reverse()
    .find((message) => (message as { type?: string }).type === type) as
    | { requestId: string }
    | undefined;
}

function requests(editorPort: FakePort, type: string) {
  return editorPort.sent.filter((message) => (message as { type?: string }).type === type);
}

async function resolveLatest(editorPort: FakePort, previewPort: FakePort, type: string) {
  const request = latestRequest(editorPort, type);
  expect(request).toBeDefined();
  await act(async () => {
    previewPort.postMessage({
      version: 1,
      type: 'command-result',
      requestId: request!.requestId,
      ok: true,
    });
  });
}

function projectWithEntrypoint() {
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  project.entrypoint = { kind: 'room', id: 'foyer' };
  return project;
}

function cloneProject<T>(project: T): T {
  return JSON.parse(JSON.stringify(project)) as T;
}

async function postInputSnapshot(
  previewPort: FakePort,
  options: {
    continue?: boolean;
    navigation?: Array<{
      exitId: string;
      direction: number;
      label: string;
      enabled: boolean;
    }>;
    choices?: Array<{
      kind: 'dialogue' | 'scene';
      id: string;
      label: string;
      enabled: boolean;
    }>;
    clickableTargets?: PreviewClickableTarget[];
  } = {},
) {
  const waitingKind = options.choices?.length
    ? 'choice'
    : options.navigation?.length
      ? 'navigation'
      : options.continue
        ? 'continue'
        : 'none';
  await act(async () => {
    previewPort.postMessage({
      version: 1,
      type: 'runtime-debug-snapshot',
      snapshot: {
        loaded: true,
        running: true,
        shellMode: 'gameplay',
        runtimeMode: 'room',
        waiting: {
          kind: waitingKind,
          canContinue: options.continue ?? false,
          reason: 'test input available',
        },
        availableInputs: {
          continue: options.continue ?? false,
          choices: options.choices ?? [],
          navigation: options.navigation ?? [],
          actions: [],
          verbOffers: [],
          verbMenuOpen: false,
          selectedSubjects: [],
          clickableTargets: options.clickableTargets ?? [],
        },
        variables: [],
        inventory: [],
        selectedSubjects: [],
        diagnostics: [],
        saveSnapshot: {},
        publication: {
          revision: 1,
          presentationRevision: 1,
          observationCount: 0,
          actorCount: 0,
          interactableCount: 0,
          propCount: 0,
          environmentCount: 0,
          layoutCount: 0,
          desiredAudioCount: 0,
          gameplayInstances: [],
        },
      },
    });
  });
}

describe('FullGamePreviewEditor', () => {
  it('visually and semantically marks the selected inspector mode', async () => {
    const view = render(<FullGamePreviewEditor />);
    const user = userEvent.setup();

    const debug = await screen.findByRole('button', { name: 'Debug' });
    const recording = screen.getByRole('button', { name: 'Recording' });
    expect(debug).toHaveAttribute('aria-pressed', 'true');
    expect(recording).toHaveAttribute('aria-pressed', 'false');

    await user.click(recording);

    expect(debug).toHaveAttribute('aria-pressed', 'false');
    expect(recording).toHaveAttribute('aria-pressed', 'true');
    view.unmount();
  });

  it('presentation-pauses hidden Play without semantically stopping or resetting the runtime', async () => {
    const view = await renderConnectedPreviewInPane(false);
    await waitFor(() =>
      expect(latestRequest(view.editorPort, 'set-preview-activity')).toBeDefined(),
    );
    const initialRuntimeStopCount = requests(view.editorPort, 'runtime-stop').length;
    const initialRuntimeResetCount = requests(view.editorPort, 'runtime-reset').length;
    const initialStopCount = requests(view.editorPort, 'stop').length;
    const initialLoadCount = requests(view.editorPort, 'runtime-load-compiled-project').length;

    view.rerender(
      <div data-workbench-editor-pane="tab:full-game-preview" data-hidden="true" aria-hidden="true">
        <FullGamePreviewEditor />
      </div>,
    );

    await waitFor(() =>
      expect(view.editorPort.sent).toContainEqual({
        version: 1,
        type: 'set-preview-activity',
        requestId: expect.any(String),
        active: false,
        visible: false,
      }),
    );
    expect(requests(view.editorPort, 'runtime-stop')).toHaveLength(initialRuntimeStopCount);
    expect(requests(view.editorPort, 'runtime-reset')).toHaveLength(initialRuntimeResetCount);
    expect(requests(view.editorPort, 'stop')).toHaveLength(initialStopCount);
    expect(requests(view.editorPort, 'runtime-load-compiled-project')).toHaveLength(
      initialLoadCount,
    );
  });

  it('reactivates visible Play and requests a runtime debug snapshot refresh', async () => {
    useProjectStore.getState().loadUnsavedProjectDocument(projectWithEntrypoint());
    const view = await renderConnectedPreviewInPane(true);
    await waitFor(() =>
      expect(latestRequest(view.editorPort, 'runtime-load-compiled-project')).toBeDefined(),
    );
    await resolveLatest(view.editorPort, view.previewPort, 'runtime-load-compiled-project');
    await waitFor(() =>
      expect(latestRequest(view.editorPort, 'runtime-request-debug-snapshot')).toBeDefined(),
    );
    const initialSnapshotRequestCount = requests(
      view.editorPort,
      'runtime-request-debug-snapshot',
    ).length;
    await waitFor(() =>
      expect(view.editorPort.sent).toContainEqual({
        version: 1,
        type: 'set-preview-activity',
        requestId: expect.any(String),
        active: false,
        visible: false,
      }),
    );

    view.rerender(
      <div data-workbench-editor-pane="tab:full-game-preview">
        <FullGamePreviewEditor />
      </div>,
    );

    await waitFor(() =>
      expect(view.editorPort.sent).toContainEqual({
        version: 1,
        type: 'set-preview-activity',
        requestId: expect.any(String),
        active: true,
        visible: true,
      }),
    );
    await resolveLatest(view.editorPort, view.previewPort, 'set-preview-activity');
    await waitFor(() => {
      expect(requests(view.editorPort, 'runtime-request-debug-snapshot').length).toBeGreaterThan(
        initialSnapshotRequestCount,
      );
    });
  });

  it('loads the active authoring project into the runtime preview before debugging', async () => {
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined(),
    );
    const request = latestRequest(editorPort, 'runtime-load-compiled-project') as
      | { compiledProject?: unknown }
      | undefined;
    expect(request?.compiledProject).toMatchObject({
      schema: 'noveltea.compiled.project',
      definitions: { rooms: [expect.objectContaining({ id: 'foyer' })] },
      entrypoint: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
    });
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-request-debug-snapshot')).toBeDefined(),
    );
  });

  it('marks the Play session stale on runtime project edits without automatically reloading', async () => {
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined(),
    );
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');
    const initialLoadCount = requests(editorPort, 'runtime-load-compiled-project').length;

    const edited = cloneProject(project);
    edited.project = { ...edited.project, name: 'Changed Project' };
    await act(async () => {
      useProjectStore.getState().loadUnsavedProjectDocument(edited);
    });

    expect(
      await screen.findByText('Project changed since this Play session was loaded.'),
    ).toBeInTheDocument();
    expect(requests(editorPort, 'runtime-load-compiled-project')).toHaveLength(initialLoadCount);
  });

  it('does not mark stale for authoring edits that do not change the runtime export', async () => {
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined(),
    );
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');
    const initialLoadCount = requests(editorPort, 'runtime-load-compiled-project').length;

    const edited = cloneProject(project);
    edited.editor = {
      ...edited.editor,
      explorer: { ...edited.editor.explorer, searchQuery: 'editor-only' },
    };
    await act(async () => {
      useProjectStore.getState().loadUnsavedProjectDocument(edited);
    });

    await waitFor(() =>
      expect(requests(editorPort, 'runtime-load-compiled-project')).toHaveLength(initialLoadCount),
    );
    expect(
      screen.queryByText('Project changed since this Play session was loaded.'),
    ).not.toBeInTheDocument();
  });

  it('explicitly reloads the latest runtime project and clears stale state', async () => {
    const user = userEvent.setup();
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined(),
    );
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');
    const initialLoadCount = requests(editorPort, 'runtime-load-compiled-project').length;

    const edited = cloneProject(project);
    edited.project = { ...edited.project, name: 'Changed Project' };
    await act(async () => {
      useProjectStore.getState().loadUnsavedProjectDocument(edited);
      useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
    });
    expect(
      await screen.findByText('Project changed since this Play session was loaded.'),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText('Restart with latest project'));
    await waitFor(() =>
      expect(requests(editorPort, 'runtime-load-compiled-project')).toHaveLength(
        initialLoadCount + 1,
      ),
    );
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');

    await waitFor(() =>
      expect(
        screen.queryByText('Project changed since this Play session was loaded.'),
      ).not.toBeInTheDocument(),
    );
    expect(latestRequest(editorPort, 'runtime-request-debug-snapshot')).toBeDefined();
  });

  it('retains the last runtime while blocked and reloads after correction without reopening', async () => {
    const user = userEvent.setup();
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined(),
    );
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');
    const initialLoadCount = requests(editorPort, 'runtime-load-compiled-project').length;

    const blocked = cloneProject(project);
    blocked.entrypoint = null;
    await act(async () => {
      useProjectStore.getState().loadUnsavedProjectDocument(blocked);
      useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
    });

    expect(await screen.findByLabelText('Play blockers')).toBeInTheDocument();
    const blocker = screen.getByRole('button', {
      name: /Play blocker \d+: Choose a gameplay entrypoint before running or packaging the project\./,
    });
    await user.hover(blocker);
    expect(
      await screen.findByText(
        'Choose a gameplay entrypoint before running or packaging the project.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Reload engine preview')).toBeDisabled();
    expect(screen.getByLabelText('Reset game runtime')).toBeDisabled();
    expect(screen.queryByLabelText('Restart with latest project')).not.toBeInTheDocument();
    expect(requests(editorPort, 'runtime-load-compiled-project')).toHaveLength(initialLoadCount);

    const corrected = cloneProject(project);
    corrected.project = { ...corrected.project, name: 'Corrected Project' };
    await act(async () => {
      useProjectStore.getState().loadUnsavedProjectDocument(corrected);
      useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: /Play blocker \d+: Choose a gameplay entrypoint before running or packaging the project\./,
        }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByLabelText('Restart with latest project')).toBeEnabled();

    await user.click(screen.getByLabelText('Restart with latest project'));
    await waitFor(() =>
      expect(requests(editorPort, 'runtime-load-compiled-project')).toHaveLength(
        initialLoadCount + 1,
      ),
    );
  });

  it('automatically loads after initial blockers are fixed without showing a ready-to-load state', async () => {
    const blocked = projectWithEntrypoint();
    blocked.entrypoint = null;
    useProjectStore.getState().loadUnsavedProjectDocument(blocked);

    const view = await renderConnectedPreviewInPane(false);
    expect(await screen.findByLabelText('Play blockers')).toBeInTheDocument();
    expect(requests(view.editorPort, 'runtime-load-compiled-project')).toHaveLength(0);
    expect(screen.queryByLabelText('Load latest project')).not.toBeInTheDocument();

    view.rerender(
      <div data-workbench-editor-pane="tab:full-game-preview" data-hidden="true" aria-hidden="true">
        <FullGamePreviewEditor />
      </div>,
    );
    await waitFor(() =>
      expect(view.editorPort.sent).toContainEqual({
        version: 1,
        type: 'set-preview-activity',
        requestId: expect.any(String),
        active: false,
        visible: false,
      }),
    );
    await resolveLatest(view.editorPort, view.previewPort, 'set-preview-activity');

    await act(async () => {
      useProjectStore.getState().loadUnsavedProjectDocument(projectWithEntrypoint());
      useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
    });
    await waitFor(() =>
      expect(requests(view.editorPort, 'runtime-load-compiled-project')).toHaveLength(1),
    );
    expect(screen.queryByText('Project is ready to load for Play.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Load latest project')).not.toBeInTheDocument();
    await resolveLatest(view.editorPort, view.previewPort, 'runtime-load-compiled-project');
    await waitFor(() =>
      expect(requests(view.editorPort, 'runtime-request-debug-snapshot').length).toBeGreaterThan(0),
    );
    const snapshotCountBeforeReturn = requests(
      view.editorPort,
      'runtime-request-debug-snapshot',
    ).length;

    view.rerender(
      <div data-workbench-editor-pane="tab:full-game-preview">
        <FullGamePreviewEditor />
      </div>,
    );
    await waitFor(() =>
      expect(view.editorPort.sent).toContainEqual({
        version: 1,
        type: 'set-preview-activity',
        requestId: expect.any(String),
        active: true,
        visible: true,
      }),
    );
    await resolveLatest(view.editorPort, view.previewPort, 'set-preview-activity');
    expect(
      requests(view.editorPort, 'runtime-request-debug-snapshot').length,
    ).toBeGreaterThanOrEqual(snapshotCountBeforeReturn);
    expect(screen.queryByText('Project is ready to load for Play.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Load latest project')).not.toBeInTheDocument();
  });

  it('collapses duplicate Alpha hotspot blockers into one compact actionable icon', async () => {
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined(),
    );
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');

    const blocked = cloneProject(project);
    const interactable = defaultInteractableData('New Interactable');
    interactable.presentation.hotspots = {
      kind: 'sprite-alpha',
      hotspot: defaultHotspotBehavior('New Interactable'),
    };
    blocked.interactables['new-interactable'] = {
      id: 'new-interactable',
      label: 'New Interactable',
      data: interactable,
    };
    await act(async () => {
      useProjectStore.getState().loadUnsavedProjectDocument(blocked);
    });

    expect(await screen.findByLabelText('Play blockers')).toBeInTheDocument();
    const alphaBlockers = screen.getAllByRole('button', {
      name: /Play blocker \d+: Alpha hotspot mode requires a sprite image\./,
    });
    expect(alphaBlockers).toHaveLength(1);
    expect(alphaBlockers[0]).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Add a sprite or switch hotspot mode.'),
    );
  });

  it('uses recovery input changes in the Play freshness fingerprint', async () => {
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined(),
    );
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');

    await act(async () => {
      usePendingInputStore
        .getState()
        .setPendingInput('project:settings', '/settings/accessibility/uiScale/minimum', {
          value: '-',
          diagnosticCode: 'editor.pending-input.number',
        });
    });
    expect(
      await screen.findByText('Project changed since this Play session was loaded.'),
    ).toBeInTheDocument();

    await act(async () => {
      usePendingInputStore
        .getState()
        .clearPendingInput('project:settings', '/settings/accessibility/uiScale/minimum');
    });
    await waitFor(() =>
      expect(
        screen.queryByText('Project changed since this Play session was loaded.'),
      ).not.toBeInTheDocument(),
    );
  });

  it('warns when recording against a stale runtime snapshot', async () => {
    const user = userEvent.setup();
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined(),
    );
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');

    const edited = cloneProject(project);
    edited.project = { ...edited.project, name: 'Changed Project' };
    await act(async () => {
      useProjectStore.getState().loadUnsavedProjectDocument(edited);
    });
    expect(
      await screen.findByText('Project changed since this Play session was loaded.'),
    ).toBeInTheDocument();

    await user.click(screen.getByText('Recording'));
    await user.click(screen.getByText('Start Recording'));

    expect(
      await screen.findByText(/Recording is using an older runtime snapshot/),
    ).toBeInTheDocument();
    expect(requests(editorPort, 'runtime-load-compiled-project')).toHaveLength(1);
  });

  it('keeps only the supported runtime transport controls in the toolbar', async () => {
    const user = userEvent.setup();
    const { editorPort } = await renderConnectedPreview();

    expect(screen.getByLabelText('Reload engine preview')).toBeInTheDocument();
    expect(screen.getByLabelText('Reload engine preview')).toHaveAttribute(
      'title',
      'Reload engine preview',
    );
    expect(screen.queryByLabelText('Restart with latest project')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Load latest project')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Reset game runtime')).toBeInTheDocument();
    expect(screen.getByLabelText('Reset game runtime')).toHaveAttribute(
      'title',
      'Reset game runtime',
    );
    expect(screen.queryByLabelText('Start runtime')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Stop runtime')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Step runtime')).not.toBeInTheDocument();
    expect(screen.queryByText('Nav 0')).not.toBeInTheDocument();
    expect(screen.queryByText('Choice 0')).not.toBeInTheDocument();
    expect(screen.queryByText('Action')).not.toBeInTheDocument();

    await user.click(screen.getByText('Fast-forward'));
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'runtime-fast-forward-to-input',
      requestId: expect.any(String),
    });
  });

  it('sends engine FPS settings from the full-game preview cap input', async () => {
    const user = userEvent.setup();
    usePreferencesStore.setState({
      showPreviewFpsCounter: true,
      previewRmlUiRasterSnap: 'geometry',
    });
    const { editorPort } = await renderConnectedPreview();
    const capInput = screen.getByLabelText('Cap') as HTMLInputElement;
    await user.clear(capInput);
    await user.type(capInput, '30');
    await waitFor(() =>
      expect(editorPort.sent).toContainEqual({
        version: 1,
        type: 'set-engine-settings',
        requestId: expect.any(String),
        settings: { showFpsCounter: true, fpsCap: 30, rmluiRasterSnap: 'geometry' },
      }),
    );
  });

  it('reload cleanup closes the previous MessagePort', async () => {
    const user = userEvent.setup();
    const { editorPort } = await renderConnectedPreview();
    await user.click(screen.getByLabelText('Reload engine preview'));
    expect(editorPort.closed).toBe(true);
  });

  it('requests a runtime debug snapshot after ready and completed runtime commands', async () => {
    const user = userEvent.setup();
    useProjectStore.getState().loadUnsavedProjectDocument(projectWithEntrypoint());
    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined(),
    );
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');
    await waitFor(() =>
      expect(editorPort.sent).toContainEqual({
        version: 1,
        type: 'runtime-request-debug-snapshot',
        requestId: expect.any(String),
      }),
    );

    const initialSnapshotRequests = editorPort.sent.filter(
      (message) => (message as { type?: string }).type === 'runtime-request-debug-snapshot',
    ).length;
    await postInputSnapshot(previewPort, {
      choices: [{ kind: 'dialogue', id: 'continue-test', label: 'Continue test', enabled: true }],
    });
    await user.click(screen.getByText('Dialogue choice continue-test: Continue test'));
    const continueRequest = editorPort.sent.find(
      (message) => (message as { type?: string }).type === 'runtime-dialogue-choice',
    ) as { requestId: string };
    await act(async () => {
      previewPort.postMessage({
        version: 1,
        type: 'command-result',
        requestId: continueRequest.requestId,
        ok: true,
      });
    });

    await waitFor(() => {
      const snapshotRequests = editorPort.sent.filter(
        (message) => (message as { type?: string }).type === 'runtime-request-debug-snapshot',
      );
      expect(snapshotRequests.length).toBeGreaterThan(initialSnapshotRequests);
    });
  });

  it('logs fast-forward stop diagnostics and uses the final snapshot', async () => {
    const user = userEvent.setup();
    useProjectStore.getState().loadUnsavedProjectDocument(projectWithEntrypoint());
    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined(),
    );
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-request-debug-snapshot')).toBeDefined(),
    );
    const request = editorPort.sent.find(
      (message) => (message as { type?: string }).type === 'runtime-request-debug-snapshot',
    ) as { requestId: string } | undefined;
    expect(request).toBeDefined();

    await act(async () => {
      previewPort.postMessage({
        version: 1,
        type: 'runtime-fast-forward-result',
        requestId: 'ff-1',
        result: {
          reason: 'budget-exhausted',
          stepsApplied: 500,
          ticksApplied: 300,
          lastInput: 'tick',
          semanticInputBudget: 500,
          simulatedTickBudget: 300,
          stabilizationTickBudget: 20,
          diagnostic:
            'Fast-forward stopped after reaching the semantic input or simulated tick budget.',
          finalSnapshot: {
            loaded: true,
            running: true,
            shellMode: 'game',
            runtimeMode: 'dialogue',
            waiting: {
              kind: 'continue',
              canContinue: true,
              reason: 'runtime is waiting for continue',
            },
            availableInputs: {
              continue: true,
              choices: [],
              navigation: [],
              actions: [],
              verbOffers: [],
              verbMenuOpen: false,
              selectedSubjects: [],
              clickableTargets: [],
            },
            variables: [],
            inventory: [],
            selectedSubjects: [],
            diagnostics: [],
            saveSnapshot: {},
            publication: {
              revision: 2,
              presentationRevision: 2,
              observationCount: 0,
              actorCount: 0,
              interactableCount: 0,
              propCount: 0,
              environmentCount: 0,
              layoutCount: 0,
              desiredAudioCount: 0,
              gameplayInstances: [],
            },
          },
        },
      });
    });

    await user.click(screen.getByText('Events & diagnostics'));
    await waitFor(() => expect(screen.getByText('Fast-forward stopped')).toBeInTheDocument());
    expect(screen.getByText(/budget-exhausted/)).toBeInTheDocument();
    expect(screen.getByText('continue')).toBeInTheDocument();
  });

  it('renders runtime debug snapshots with authoring metadata labels', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.variables.flag = {
      id: 'flag',
      label: 'Has Key',
      data: { kind: 'variable', type: 'boolean', defaultValue: false, scope: 'global' },
    };
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Grand Foyer',
      data: defaultRoomData('Grand Foyer'),
    };
    project.interactables.key = {
      id: 'key',
      label: 'Brass Key',
      traits: [],
      properties: {},
      data: defaultInteractableData('Brass Key'),
    };
    project.verbs.look = {
      id: 'look',
      label: 'Inspect',
      data: defaultVerbData('Inspect'),
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { previewPort } = await renderConnectedPreview();
    await act(async () => {
      previewPort.postMessage({
        version: 1,
        type: 'runtime-debug-snapshot',
        snapshot: {
          loaded: true,
          running: true,
          shellMode: 'gameplay',
          runtimeMode: 'room',
          currentRoomId: 'foyer',
          waiting: { kind: 'action', canContinue: false, reason: 'object action available' },
          availableInputs: {
            continue: false,
            choices: [],
            navigation: [],
            actions: [
              {
                verbId: 'look',
                label: 'look',
                bindingOrder: ['target'],
                selectedCount: 1,
                rank: 0,
                primary: true,
                enabled: true,
              },
            ],
            verbOffers: [
              {
                verbId: 'look',
                slotId: 'target',
                label: 'look',
                bindingOrder: ['target'],
                rank: 0,
                primary: true,
              },
            ],
            verbMenuOpen: true,
            selectedSubjects: [{ kind: 'interactable', id: 'key' }],
            clickableTargets: [],
          },
          variables: [
            {
              id: 'flag',
              label: 'flag',
              type: 'boolean',
              value: true,
              defaultValue: false,
              dirty: true,
            },
          ],
          inventory: [{ id: 'key', label: 'key', selected: true }],
          selectedSubjects: [{ kind: 'interactable', id: 'key' }],
          diagnostics: [],
          saveSnapshot: { variables: { flag: true }, inventory: ['key'] },
          publication: {
            revision: 3,
            presentationRevision: 3,
            observationCount: 1,
            actorCount: 0,
            interactableCount: 1,
            propCount: 0,
            environmentCount: 0,
            layoutCount: 0,
            desiredAudioCount: 0,
            gameplayInstances: [],
          },
        },
      });
    });

    await waitFor(() => expect(screen.getAllByText('Grand Foyer').length).toBeGreaterThan(0));
    await user.click(screen.getByText('Variables'));
    await user.click(screen.getByText('Inventory'));
    expect(screen.getByText('Has Key')).toBeInTheDocument();
    expect(screen.getAllByText('Brass Key').length).toBeGreaterThan(0);
    expect(screen.getByText('Inspect (1/1)')).toBeInTheDocument();
    await user.click(screen.getByText('Events & diagnostics'));
    expect(screen.getByText('Runtime snapshot refreshed')).toBeInTheDocument();
  });

  it('shows and filters the variable search when more than three variables exist', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.variables.alpha = {
      id: 'alpha',
      label: 'Alpha Flag',
      data: { kind: 'variable', type: 'boolean', defaultValue: false, scope: 'global' },
    };
    project.variables.beta = {
      id: 'beta',
      label: 'Beta Count',
      data: { kind: 'variable', type: 'integer', defaultValue: 0, scope: 'global' },
    };
    project.variables.gamma = {
      id: 'gamma',
      label: 'Gamma Name',
      data: { kind: 'variable', type: 'string', defaultValue: '', scope: 'global' },
    };
    project.variables.delta = {
      id: 'delta',
      label: 'Delta Value',
      data: { kind: 'variable', type: 'number', defaultValue: 0, scope: 'global' },
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { previewPort } = await renderConnectedPreview();
    await act(async () => {
      previewPort.postMessage({
        version: 1,
        type: 'runtime-debug-snapshot',
        snapshot: {
          loaded: true,
          running: true,
          shellMode: 'gameplay',
          runtimeMode: 'room',
          waiting: { kind: 'none', canContinue: false },
          availableInputs: {
            continue: false,
            choices: [],
            navigation: [],
            actions: [],
            verbOffers: [],
            verbMenuOpen: false,
            selectedSubjects: [],
            clickableTargets: [],
          },
          variables: [
            { id: 'alpha', label: 'alpha', type: 'boolean', value: false, defaultValue: false },
            { id: 'beta', label: 'beta', type: 'integer', value: 2, defaultValue: 0 },
            { id: 'gamma', label: 'gamma', type: 'string', value: 'hello', defaultValue: '' },
            { id: 'delta', label: 'delta', type: 'number', value: 3.5, defaultValue: 0 },
          ],
          inventory: [],
          selectedSubjects: [],
          diagnostics: [],
          saveSnapshot: {},
          publication: {
            revision: 4,
            presentationRevision: 4,
            observationCount: 0,
            actorCount: 0,
            interactableCount: 0,
            propCount: 0,
            environmentCount: 0,
            layoutCount: 0,
            desiredAudioCount: 0,
            gameplayInstances: [],
          },
        },
      });
    });

    await user.click(screen.getByText('Variables'));
    const search = screen.getByRole('textbox', { name: 'Search variables' });
    expect(search).toBeInTheDocument();

    await user.type(search, 'gamma');
    expect(screen.getByText('Gamma Name')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Flag')).not.toBeInTheDocument();
    expect(screen.queryByText('Beta Count')).not.toBeInTheDocument();
    expect(screen.queryByText('Delta Value')).not.toBeInTheDocument();
  });

  it('uses runtime-eligible semantic targets and records only accepted subject selections', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.interactables.hidden = {
      id: 'hidden',
      label: 'Hidden object',
      data: defaultInteractableData('Hidden object'),
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const { editorPort, previewPort } = await renderConnectedPreview();

    await postInputSnapshot(previewPort);
    expect(screen.queryByText('Activate Hidden object')).not.toBeInTheDocument();

    await postInputSnapshot(previewPort, {
      clickableTargets: [
        {
          kind: 'subject',
          subject: { kind: 'feature', ownerKind: 'room', ownerId: 'foyer', featureId: 'door' },
          label: 'Door',
        },
      ],
    });
    const selection = screen.getByText('Activate Door');
    await user.click(screen.getByText('Recording'));
    await user.click(screen.getByText('Start Recording'));
    await user.click(selection);
    expect(
      screen.queryByText('1. Primary Activate feature:room:foyer:door'),
    ).not.toBeInTheDocument();

    const rejected = latestRequest(editorPort, 'runtime-primary-activate');
    expect(rejected).toBeDefined();
    await act(async () => {
      previewPort.postMessage({
        version: 1,
        type: 'command-result',
        requestId: rejected!.requestId,
        ok: false,
        error: 'Subject is not currently eligible.',
      });
    });
    expect(
      screen.queryByText('1. Primary Activate feature:room:foyer:door'),
    ).not.toBeInTheDocument();

    await user.click(selection);
    await resolveLatest(editorPort, previewPort, 'runtime-primary-activate');
    await waitFor(() =>
      expect(screen.getByText('1. Primary Activate feature:room:foyer:door')).toBeInTheDocument(),
    );
  });

  it('records semantic runtime inputs and keeps trace events separate', async () => {
    const user = userEvent.setup();
    const { editorPort, previewPort } = await renderConnectedPreview();

    await postInputSnapshot(previewPort, {
      choices: [{ kind: 'dialogue', id: 'accept-edge', label: 'Accept', enabled: true }],
    });

    await user.click(screen.getByText('Recording'));
    await user.click(screen.getByText('Start Recording'));
    await user.click(screen.getByText('Dialogue choice accept-edge: Accept'));
    expect(screen.queryByText('1. Dialogue choice accept-edge')).not.toBeInTheDocument();

    await act(async () => {
      previewPort.postMessage({
        version: 1,
        type: 'command-result',
        requestId: latestRequest(editorPort, 'runtime-dialogue-choice')!.requestId,
        ok: true,
      });
    });

    await waitFor(() =>
      expect(screen.getByText('1. Dialogue choice accept-edge')).toBeInTheDocument(),
    );
    expect(screen.getAllByText(/"type": "dialogue-choice"/).length).toBeGreaterThan(0);
    expect(screen.getByText('Recorded Dialogue choice accept-edge')).toBeInTheDocument();

    await act(async () => {
      previewPort.postMessage({
        version: 1,
        type: 'preview-diagnostic',
        diagnostic: { severity: 'warning', message: 'trace-only warning' },
      });
    });

    await waitFor(() =>
      expect(screen.getAllByText('trace-only warning').length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/ui-click/i)).not.toBeInTheDocument();
  });

  it('undoes the last recorded action by reset and replaying the remaining actions', async () => {
    const user = userEvent.setup();
    const { editorPort, previewPort } = await renderConnectedPreview();

    await postInputSnapshot(previewPort, {
      navigation: [
        { exitId: 'north-exit', direction: 0, label: 'North', enabled: true },
        { exitId: 'south-exit', direction: 1, label: 'South', enabled: true },
      ],
    });

    await user.click(screen.getByText('Recording'));
    await user.click(screen.getByText('Start Recording'));
    await user.click(screen.getByText('Navigate North'));
    expect(latestRequest(editorPort, 'runtime-navigate')).toMatchObject({
      exitId: 'north-exit',
    });
    await resolveLatest(editorPort, previewPort, 'runtime-navigate');
    await user.click(screen.getByText('Navigate South'));
    expect(latestRequest(editorPort, 'runtime-navigate')).toMatchObject({
      exitId: 'south-exit',
    });
    await resolveLatest(editorPort, previewPort, 'runtime-navigate');
    await waitFor(() => expect(screen.getByText('2. Navigate south-exit')).toBeInTheDocument());

    await user.click(screen.getByText('Undo Last'));
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-reset')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-reset');
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-navigate')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-navigate');
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-request-debug-snapshot')).toBeDefined(),
    );
    await resolveLatest(editorPort, previewPort, 'runtime-request-debug-snapshot');

    await waitFor(() =>
      expect(screen.queryByText('2. Navigate south-exit')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('1. Navigate north-exit')).toBeInTheDocument();
    expect(screen.getByText('Undo last recorded action')).toBeInTheDocument();
    const resetCount = editorPort.sent.filter(
      (message) => (message as { type?: string }).type === 'runtime-reset',
    ).length;
    expect(resetCount).toBeGreaterThan(0);
  });

  it('replays the current draft without persisting authoring tests', async () => {
    const user = userEvent.setup();
    const { editorPort, previewPort } = await renderConnectedPreview();

    await postInputSnapshot(previewPort, {
      choices: [{ kind: 'dialogue', id: 'accept-edge', label: 'Accept', enabled: true }],
    });

    await user.click(screen.getByText('Recording'));
    await user.click(screen.getByText('Start Recording'));
    await user.click(screen.getByText('Dialogue choice accept-edge: Accept'));
    await resolveLatest(editorPort, previewPort, 'runtime-dialogue-choice');
    await waitFor(() =>
      expect(screen.getByText('1. Dialogue choice accept-edge')).toBeInTheDocument(),
    );
    await user.click(screen.getByText('Stop'));

    expect(screen.getByText('Save as New Test')).toBeEnabled();
    expect(screen.getByText('Apply to Existing Test')).toBeDisabled();

    await user.click(screen.getByText('Replay'));
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-reset')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-reset');
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-dialogue-choice')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-dialogue-choice');
    await waitFor(() =>
      expect(latestRequest(editorPort, 'runtime-request-debug-snapshot')).toBeDefined(),
    );
    await resolveLatest(editorPort, previewPort, 'runtime-request-debug-snapshot');

    await user.click(screen.getByText('Events & diagnostics'));
    expect(screen.getByText('Replaying 1 recorded action')).toBeInTheDocument();
  });
});
