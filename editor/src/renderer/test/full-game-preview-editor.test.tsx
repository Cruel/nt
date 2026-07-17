import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FullGamePreviewEditor } from '@/editors/preview/FullGamePreviewEditor';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
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
  vi.stubGlobal('MessageChannel', class {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
      ports.push(this.port1, this.port2);
    }
  });
  usePreviewManagerStore.getState().resetPreviewManager();
  useWorkbenchStore.getState().resetWorkbench();
  useWorkspaceStore.setState({
    previewPosition: { x: 0.5, y: 0.5 },
    previewConnectionState: 'disconnected',
    selectedRuntimeObjectId: null,
    lastPreviewEvent: null,
    statusMessage: 'Preview disconnected',
  });
  usePreferencesStore.setState({ showPreviewFpsCounter: false });
  useProjectStore.getState().clearProject();
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
  render(<FullGamePreviewEditor />);
  const iframe = await screen.findByTitle('NovelTea engine preview') as HTMLIFrameElement;
  await waitFor(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      origin: 'http://127.0.0.1:5000',
      data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
    }));
    expect(ports.length).toBeGreaterThanOrEqual(2);
  });
  const editorPort = ports.at(-2)!;
  const previewPort = ports.at(-1)!;
  await act(async () => {
    previewPort.postMessage({ version: 1, type: 'ready', capabilities: [] });
  });
  await waitFor(() => expect(useWorkspaceStore.getState().previewConnectionState).toBe('ready'));
  return { iframe, editorPort, previewPort };
}

async function renderConnectedPreviewInPane(hidden = false) {
  const view = render(
    <div data-workbench-editor-pane="tab:full-game-preview" data-hidden={hidden ? true : undefined} aria-hidden={hidden ? true : undefined}>
      <FullGamePreviewEditor />
    </div>,
  );
  const iframe = await screen.findByTitle('NovelTea engine preview') as HTMLIFrameElement;
  await waitFor(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      origin: 'http://127.0.0.1:5000',
      data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
    }));
    expect(ports.length).toBeGreaterThanOrEqual(2);
  });
  const editorPort = ports.at(-2)!;
  const previewPort = ports.at(-1)!;
  await act(async () => {
    previewPort.postMessage({ version: 1, type: 'ready', capabilities: [] });
  });
  await waitFor(() => expect(useWorkspaceStore.getState().previewConnectionState).toBe('ready'));
  return { ...view, iframe, editorPort, previewPort };
}

function latestRequest(editorPort: FakePort, type: string) {
  return [...editorPort.sent].reverse().find((message) => (message as { type?: string }).type === type) as { requestId: string } | undefined;
}

function requests(editorPort: FakePort, type: string) {
  return editorPort.sent.filter((message) => (message as { type?: string }).type === type);
}

async function resolveLatest(editorPort: FakePort, previewPort: FakePort, type: string) {
  const request = latestRequest(editorPort, type);
  expect(request).toBeDefined();
  await act(async () => {
    previewPort.postMessage({ version: 1, type: 'command-result', requestId: request!.requestId, ok: true });
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

async function postInputSnapshot(previewPort: FakePort, options: {
  continue?: boolean;
  navigation?: Array<{ index: number; label: string; enabled: boolean }>;
  dialogueOptions?: Array<{ index: number; label: string; enabled: boolean }>;
} = {}) {
  const waitingKind = options.dialogueOptions?.length
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
        waiting: { kind: waitingKind, canContinue: options.continue ?? false, reason: 'test input available' },
        availableInputs: {
          continue: options.continue ?? false,
          dialogueOptions: options.dialogueOptions ?? [],
          navigation: options.navigation ?? [],
          actions: [],
          selectedSubjects: [],
          clickableTargets: [],
        },
        variables: [],
        inventory: [],
        selectedSubjects: [],
        diagnostics: [],
        saveSnapshot: {},
        publication: { revision: 1, presentationRevision: 1, observationCount: 0, actorCount: 0, interactableCount: 0, propCount: 0, environmentCount: 0, layoutCount: 0, desiredAudioCount: 0 },
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
    await waitFor(() => expect(latestRequest(view.editorPort, 'set-preview-activity')).toBeDefined());
    const initialRuntimeStopCount = requests(view.editorPort, 'runtime-stop').length;
    const initialRuntimeResetCount = requests(view.editorPort, 'runtime-reset').length;
    const initialStopCount = requests(view.editorPort, 'stop').length;
    const initialLoadCount = requests(view.editorPort, 'runtime-load-compiled-project').length;

    view.rerender(
      <div data-workbench-editor-pane="tab:full-game-preview" data-hidden="true" aria-hidden="true">
        <FullGamePreviewEditor />
      </div>,
    );

    await waitFor(() => expect(view.editorPort.sent).toContainEqual({
      version: 1,
      type: 'set-preview-activity',
      requestId: expect.any(String),
      active: false,
      visible: false,
    }));
    expect(requests(view.editorPort, 'runtime-stop')).toHaveLength(initialRuntimeStopCount);
    expect(requests(view.editorPort, 'runtime-reset')).toHaveLength(initialRuntimeResetCount);
    expect(requests(view.editorPort, 'stop')).toHaveLength(initialStopCount);
    expect(requests(view.editorPort, 'runtime-load-compiled-project')).toHaveLength(initialLoadCount);
  });

  it('reactivates visible Play and requests a runtime debug snapshot refresh', async () => {
    const view = await renderConnectedPreviewInPane(true);
    await waitFor(() => expect(view.editorPort.sent).toContainEqual({
      version: 1,
      type: 'set-preview-activity',
      requestId: expect.any(String),
      active: false,
      visible: false,
    }));

    view.rerender(
      <div data-workbench-editor-pane="tab:full-game-preview">
        <FullGamePreviewEditor />
      </div>,
    );

    await waitFor(() => expect(view.editorPort.sent).toContainEqual({
      version: 1,
      type: 'set-preview-activity',
      requestId: expect.any(String),
      active: true,
      visible: true,
    }));
    await resolveLatest(view.editorPort, view.previewPort, 'set-preview-activity');
    await waitFor(() => expect(latestRequest(view.editorPort, 'runtime-request-debug-snapshot')).toBeDefined());
  });

  it('loads the active authoring project into the runtime preview before debugging', async () => {
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined());
    const request = latestRequest(editorPort, 'runtime-load-compiled-project') as { compiledProject?: unknown } | undefined;
    expect(request?.compiledProject).toMatchObject({
      schema: 'noveltea.compiled.project',
      definitions: { rooms: [expect.objectContaining({ id: 'foyer' })] },
      entrypoint: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
    });
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-request-debug-snapshot')).toBeDefined());
  });

  it('marks the Play session stale on runtime project edits without automatically reloading', async () => {
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');
    const initialLoadCount = requests(editorPort, 'runtime-load-compiled-project').length;

    const edited = cloneProject(project);
    edited.project = { ...edited.project, name: 'Changed Project' };
    await act(async () => {
      useProjectStore.getState().loadUnsavedProjectDocument(edited);
    });

    expect(await screen.findByText('Project changed since this Play session was loaded.')).toBeInTheDocument();
    expect(screen.getAllByText('The running game is using an older runtime snapshot.').length).toBeGreaterThan(0);
    expect(requests(editorPort, 'runtime-load-compiled-project')).toHaveLength(initialLoadCount);
  });

  it('does not mark stale for authoring edits that do not change the runtime export', async () => {
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');
    const initialLoadCount = requests(editorPort, 'runtime-load-compiled-project').length;

    const edited = cloneProject(project);
    edited.editor = { ...edited.editor, explorer: { ...edited.editor.explorer, searchQuery: 'editor-only' } };
    await act(async () => {
      useProjectStore.getState().loadUnsavedProjectDocument(edited);
    });

    await waitFor(() => expect(requests(editorPort, 'runtime-load-compiled-project')).toHaveLength(initialLoadCount));
    expect(screen.queryByText('Project changed since this Play session was loaded.')).not.toBeInTheDocument();
  });

  it('explicitly reloads the latest runtime project and clears stale state', async () => {
    const user = userEvent.setup();
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');
    const initialLoadCount = requests(editorPort, 'runtime-load-compiled-project').length;

    const edited = cloneProject(project);
    edited.project = { ...edited.project, name: 'Changed Project' };
    await act(async () => {
      useProjectStore.getState().loadUnsavedProjectDocument(edited);
    });
    expect(await screen.findByText('Project changed since this Play session was loaded.')).toBeInTheDocument();

    await user.click(screen.getByText('Restart with Latest Project'));
    await waitFor(() => expect(requests(editorPort, 'runtime-load-compiled-project')).toHaveLength(initialLoadCount + 1));
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');

    await waitFor(() => expect(screen.queryByText('Project changed since this Play session was loaded.')).not.toBeInTheDocument());
    expect(latestRequest(editorPort, 'runtime-request-debug-snapshot')).toBeDefined();
  });

  it('warns when recording against a stale runtime snapshot', async () => {
    const user = userEvent.setup();
    const project = projectWithEntrypoint();
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-load-compiled-project')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-load-compiled-project');

    const edited = cloneProject(project);
    edited.project = { ...edited.project, name: 'Changed Project' };
    await act(async () => {
      useProjectStore.getState().loadUnsavedProjectDocument(edited);
    });
    expect(await screen.findByText('Project changed since this Play session was loaded.')).toBeInTheDocument();

    await user.click(screen.getByText('Recording'));
    await user.click(screen.getByText('Start Recording'));

    expect(await screen.findByText(/Recording is using an older runtime snapshot/)).toBeInTheDocument();
    expect(requests(editorPort, 'runtime-load-compiled-project')).toHaveLength(1);
  });

  it('keeps only the supported runtime transport controls in the toolbar', async () => {
    const user = userEvent.setup();
    const { editorPort } = await renderConnectedPreview();

    expect(screen.getByLabelText('Reload engine preview')).toBeInTheDocument();
    expect(screen.getByLabelText('Restart with latest project')).toBeInTheDocument();
    expect(screen.getByLabelText('Reset runtime')).toBeInTheDocument();
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
    usePreferencesStore.setState({ showPreviewFpsCounter: true });
    const { editorPort } = await renderConnectedPreview();
    const capInput = screen.getByLabelText('Cap') as HTMLInputElement;
    await user.clear(capInput);
    await user.type(capInput, '30');
    await waitFor(() => expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'set-engine-settings',
      requestId: expect.any(String),
      settings: { showFpsCounter: true, fpsCap: 30 },
    }));
  });

  it('reload cleanup closes the previous MessagePort', async () => {
    const user = userEvent.setup();
    const { editorPort } = await renderConnectedPreview();
    await user.click(screen.getByLabelText('Reload engine preview'));
    expect(editorPort.closed).toBe(true);
  });

  it('requests a runtime debug snapshot after ready and completed runtime commands', async () => {
    const user = userEvent.setup();
    const { editorPort, previewPort } = await renderConnectedPreview();
    await waitFor(() => expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'runtime-request-debug-snapshot',
      requestId: expect.any(String),
    }));

    const initialSnapshotRequests = editorPort.sent.filter((message) => (message as { type?: string }).type === 'runtime-request-debug-snapshot').length;
    await postInputSnapshot(previewPort, {
      dialogueOptions: [{ index: 0, label: 'Continue test', enabled: true }],
    });
    await user.click(screen.getByText('Choice 0: Continue test'));
    const continueRequest = editorPort.sent.find((message) => (message as { type?: string }).type === 'runtime-dialogue-option') as { requestId: string };
    await act(async () => {
      previewPort.postMessage({ version: 1, type: 'command-result', requestId: continueRequest.requestId, ok: true });
    });

    await waitFor(() => {
      const snapshotRequests = editorPort.sent.filter((message) => (message as { type?: string }).type === 'runtime-request-debug-snapshot');
      expect(snapshotRequests.length).toBeGreaterThan(initialSnapshotRequests);
    });
  });

  it('logs fast-forward stop diagnostics and uses the final snapshot', async () => {
    const user = userEvent.setup();
    const { editorPort, previewPort } = await renderConnectedPreview();
    const request = editorPort.sent.find((message) => (message as { type?: string }).type === 'runtime-request-debug-snapshot') as { requestId: string } | undefined;
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
          diagnostic: 'Fast-forward stopped after reaching the semantic input or simulated tick budget.',
          finalSnapshot: {
            loaded: true,
            running: true,
            shellMode: 'game',
            runtimeMode: 'dialogue',
            waiting: { kind: 'continue', canContinue: true, reason: 'runtime is waiting for continue' },
            availableInputs: { continue: true, dialogueOptions: [], navigation: [], actions: [], selectedSubjects: [], clickableTargets: [] },
            variables: [],
            inventory: [],
            selectedSubjects: [],
            diagnostics: [],
            saveSnapshot: {},
            publication: { revision: 2, presentationRevision: 2, observationCount: 0, actorCount: 0, interactableCount: 0, propCount: 0, environmentCount: 0, layoutCount: 0, desiredAudioCount: 0 },
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
    project.variables.flag = { id: 'flag', label: 'Has Key', data: { kind: 'variable', type: 'boolean', defaultValue: false, scope: 'global' } };
    project.rooms.foyer = { id: 'foyer', label: 'Grand Foyer', data: defaultRoomData('Grand Foyer') };
    project.interactables.key = { id: 'key', label: 'Brass Key', extends: null, properties: {}, data: defaultInteractableData('Brass Key') };
    project.verbs.look = { id: 'look', label: 'Inspect', extends: null, properties: {}, data: defaultVerbData('Inspect') };
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
            dialogueOptions: [],
            navigation: [],
            actions: [{ verbId: 'look', label: 'look', objectCount: 1, selectedCount: 1, enabled: true }],
            selectedSubjects: [{ kind: 'interactable', id: 'key' }],
            clickableTargets: [],
        },
          variables: [{ id: 'flag', label: 'flag', type: 'boolean', value: true, defaultValue: false, dirty: true }],
          inventory: [{ id: 'key', label: 'key', selected: true }],
        selectedSubjects: [{ kind: 'interactable', id: 'key' }],
          diagnostics: [],
          saveSnapshot: { variables: { flag: true }, inventory: ['key'] },
          publication: { revision: 3, presentationRevision: 3, observationCount: 1, actorCount: 0, interactableCount: 1, propCount: 0, environmentCount: 0, layoutCount: 0, desiredAudioCount: 0 },
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
    project.variables.alpha = { id: 'alpha', label: 'Alpha Flag', data: { kind: 'variable', type: 'boolean', defaultValue: false, scope: 'global' } };
    project.variables.beta = { id: 'beta', label: 'Beta Count', data: { kind: 'variable', type: 'integer', defaultValue: 0, scope: 'global' } };
    project.variables.gamma = { id: 'gamma', label: 'Gamma Name', data: { kind: 'variable', type: 'string', defaultValue: '', scope: 'global' } };
    project.variables.delta = { id: 'delta', label: 'Delta Value', data: { kind: 'variable', type: 'number', defaultValue: 0, scope: 'global' } };
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
          availableInputs: { continue: false, dialogueOptions: [], navigation: [], actions: [], selectedSubjects: [], clickableTargets: [] },
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
          publication: { revision: 4, presentationRevision: 4, observationCount: 0, actorCount: 0, interactableCount: 0, propCount: 0, environmentCount: 0, layoutCount: 0, desiredAudioCount: 0 },
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

  it('records semantic runtime inputs and keeps trace events separate', async () => {
    const user = userEvent.setup();
    const { editorPort, previewPort } = await renderConnectedPreview();

    await postInputSnapshot(previewPort, {
      dialogueOptions: [{ index: 0, label: 'Accept', enabled: true }],
    });

    await user.click(screen.getByText('Recording'));
    await user.click(screen.getByText('Start Recording'));
    await user.click(screen.getByText('Choice 0: Accept'));

    await waitFor(() => expect(screen.getByText('1. Choice 0')).toBeInTheDocument());
    expect(screen.getAllByText(/"type": "dialogue-option"/).length).toBeGreaterThan(0);
    expect(screen.getByText('Recorded Choice 0')).toBeInTheDocument();

    await act(async () => {
      previewPort.postMessage({ version: 1, type: 'command-result', requestId: latestRequest(editorPort, 'runtime-dialogue-option')!.requestId, ok: true });
      previewPort.postMessage({ version: 1, type: 'preview-diagnostic', diagnostic: { severity: 'warning', message: 'trace-only warning' } });
    });

    await waitFor(() => expect(screen.getAllByText('trace-only warning').length).toBeGreaterThan(0));
    expect(screen.queryByText(/ui-click/i)).toBeInTheDocument();
  });

  it('undoes the last recorded action by reset and replaying the remaining actions', async () => {
    const user = userEvent.setup();
    const { editorPort, previewPort } = await renderConnectedPreview();

    await postInputSnapshot(previewPort, {
      navigation: [
        { index: 0, label: 'North', enabled: true },
        { index: 1, label: 'South', enabled: true },
      ],
    });

    await user.click(screen.getByText('Recording'));
    await user.click(screen.getByText('Start Recording'));
    await user.click(screen.getByText('Navigate 0: North'));
    await user.click(screen.getByText('Navigate 1: South'));
    await waitFor(() => expect(screen.getByText('2. Navigate 1')).toBeInTheDocument());

    await user.click(screen.getByText('Undo Last'));
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-reset')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-reset');
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-navigate')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-navigate');
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-request-debug-snapshot')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-request-debug-snapshot');

    await waitFor(() => expect(screen.queryByText('2. Navigate 1')).not.toBeInTheDocument());
    expect(screen.getByText('1. Navigate 0')).toBeInTheDocument();
    expect(screen.getByText('Undo last recorded action')).toBeInTheDocument();
    const resetCount = editorPort.sent.filter((message) => (message as { type?: string }).type === 'runtime-reset').length;
    expect(resetCount).toBeGreaterThan(0);
  });

  it('replays the current draft without persisting authoring tests', async () => {
    const user = userEvent.setup();
    const { editorPort, previewPort } = await renderConnectedPreview();

    await postInputSnapshot(previewPort, {
      dialogueOptions: [{ index: 0, label: 'Accept', enabled: true }],
    });

    await user.click(screen.getByText('Recording'));
    await user.click(screen.getByText('Start Recording'));
    await user.click(screen.getByText('Choice 0: Accept'));
    await waitFor(() => expect(screen.getByText('1. Choice 0')).toBeInTheDocument());
    await user.click(screen.getByText('Stop'));

    expect(screen.getByText('Save as New Test')).toBeEnabled();
    expect(screen.getByText('Apply to Existing Test')).toBeDisabled();

    await user.click(screen.getByText('Replay'));
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-reset')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-reset');
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-dialogue-option')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-dialogue-option');
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-request-debug-snapshot')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-request-debug-snapshot');

    await user.click(screen.getByText('Events & diagnostics'));
    expect(screen.getByText('Replaying 1 recorded action')).toBeInTheDocument();
  });
});
