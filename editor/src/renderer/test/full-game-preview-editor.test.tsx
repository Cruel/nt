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
    previewRunning: true,
    previewConnectionState: 'disconnected',
    selectedRuntimeObjectId: null,
    lastPreviewEvent: null,
    statusMessage: 'Preview disconnected',
  });
  usePreferencesStore.setState({ showPreviewFpsCounter: false });
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
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      origin: 'http://127.0.0.1:5000',
      data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
    }));
    ports[1]?.postMessage({ version: 1, type: 'ready', capabilities: [] });
  });
  await waitFor(() => expect(useWorkspaceStore.getState().previewConnectionState).toBe('ready'));
  return { iframe, editorPort: ports[0]!, previewPort: ports[1]! };
}

function latestRequest(editorPort: FakePort, type: string) {
  return [...editorPort.sent].reverse().find((message) => (message as { type?: string }).type === type) as { requestId: string } | undefined;
}

async function resolveLatest(editorPort: FakePort, previewPort: FakePort, type: string) {
  const request = latestRequest(editorPort, type);
  expect(request).toBeDefined();
  await act(async () => {
    previewPort.postMessage({ version: 1, type: 'command-result', requestId: request!.requestId, ok: true });
  });
}

describe('FullGamePreviewEditor', () => {
  it('owns the runtime transport controls and sends runtime commands', async () => {
    const user = userEvent.setup();
    const { editorPort } = await renderConnectedPreview();
    await user.click(screen.getByLabelText('Start runtime'));
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'runtime-start',
      requestId: expect.any(String),
    });
    expect(useWorkspaceStore.getState().previewRunning).toBe(true);

    await user.click(screen.getByLabelText('Stop runtime'));
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'runtime-stop',
      requestId: expect.any(String),
    });
    expect(useWorkspaceStore.getState().previewRunning).toBe(false);

    await user.click(screen.getByLabelText('Step runtime'));
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'runtime-step',
      requestId: expect.any(String),
    });
    await user.click(screen.getByText('Continue'));
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'runtime-continue',
      requestId: expect.any(String),
    });

    await user.click(screen.getByText('Fast-forward'));
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'runtime-fast-forward-to-input',
      requestId: expect.any(String),
    });
  });

  it('keeps existing gameplay/debug input probes in the full-game preview tab', async () => {
    const user = userEvent.setup();
    const { editorPort } = await renderConnectedPreview();
    await user.click(screen.getByText('Nav 0'));
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'runtime-navigate',
      requestId: expect.any(String),
      direction: 0,
    });
    await user.click(screen.getByText('Choice 0'));
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'runtime-dialogue-option',
      requestId: expect.any(String),
      optionIndex: 0,
    });
    await user.click(screen.getByText('Action'));
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'runtime-run-action',
      requestId: expect.any(String),
      verbId: 'look',
      objectIds: [],
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
    await user.click(screen.getByText('Continue'));
    const continueRequest = editorPort.sent.find((message) => (message as { type?: string }).type === 'runtime-continue') as { requestId: string };
    await act(async () => {
      previewPort.postMessage({ version: 1, type: 'command-result', requestId: continueRequest.requestId, ok: true });
    });

    await waitFor(() => {
      const snapshotRequests = editorPort.sent.filter((message) => (message as { type?: string }).type === 'runtime-request-debug-snapshot');
      expect(snapshotRequests.length).toBeGreaterThan(initialSnapshotRequests);
    });
  });

  it('logs fast-forward stop diagnostics and uses the final snapshot', async () => {
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
            availableInputs: { continue: true, dialogueOptions: [], navigation: [], actions: [], selectedObjects: [], clickableTargets: [] },
            variables: [],
            inventory: [],
            selectedObjects: [],
            diagnostics: [],
            saveSnapshot: {},
          },
        },
      });
    });

    await waitFor(() => expect(screen.getByText('Fast-forward stopped')).toBeInTheDocument());
    expect(screen.getByText(/budget-exhausted/)).toBeInTheDocument();
    expect(screen.getByText('continue')).toBeInTheDocument();
  });

  it('renders runtime debug snapshots with authoring metadata labels', async () => {
    const project = createAuthoringProject();
    project.variables.flag = { id: 'flag', label: 'Has Key', data: { kind: 'variable', type: 'boolean', defaultValue: false, scope: 'global' }, tags: [] };
    project.rooms.foyer = { id: 'foyer', label: 'Grand Foyer', data: {}, tags: [] };
    project.objects.key = { id: 'key', label: 'Brass Key', data: {}, tags: [] };
    project.verbs.look = { id: 'look', label: 'Inspect', data: {}, tags: [] };
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
            selectedObjects: ['key'],
            clickableTargets: [],
        },
          variables: [{ id: 'flag', label: 'flag', type: 'boolean', value: true, defaultValue: false, dirty: true }],
          inventory: [{ id: 'key', label: 'key', selected: true }],
        selectedObjects: ['key'],
          diagnostics: [],
          saveSnapshot: { variables: { flag: true }, inventory: ['key'] },
        },
      });
    });

    await waitFor(() => expect(screen.getAllByText('Grand Foyer').length).toBeGreaterThan(0));
    expect(screen.getByText('Has Key')).toBeInTheDocument();
    expect(screen.getAllByText('Brass Key').length).toBeGreaterThan(0);
    expect(screen.getByText('Inspect (1/1)')).toBeInTheDocument();
    expect(screen.getByText('Runtime snapshot refreshed')).toBeInTheDocument();
  });

  it('records semantic runtime inputs and keeps trace events separate', async () => {
    const user = userEvent.setup();
    const { editorPort, previewPort } = await renderConnectedPreview();

    await user.click(screen.getByText('Recording'));
    await user.click(screen.getByText('Start Recording'));
    await user.click(screen.getByText('Continue'));

    await waitFor(() => expect(screen.getByText('1. Continue')).toBeInTheDocument());
    expect(screen.getAllByText(/"type": "continue"/).length).toBeGreaterThan(0);
    expect(screen.getByText('Recorded Continue')).toBeInTheDocument();

    await act(async () => {
      previewPort.postMessage({ version: 1, type: 'command-result', requestId: latestRequest(editorPort, 'runtime-continue')!.requestId, ok: true });
      previewPort.postMessage({ version: 1, type: 'preview-diagnostic', diagnostic: { severity: 'warning', message: 'trace-only warning' } });
    });

    await waitFor(() => expect(screen.getAllByText('trace-only warning').length).toBeGreaterThan(0));
    expect(screen.queryByText(/ui-click/i)).toBeInTheDocument();
  });

  it('undoes the last recorded action by reset and replaying the remaining actions', async () => {
    const user = userEvent.setup();
    const { editorPort, previewPort } = await renderConnectedPreview();

    await user.click(screen.getByText('Recording'));
    await user.click(screen.getByText('Start Recording'));
    await user.click(screen.getByText('Continue'));
    await user.click(screen.getByText('Nav 0'));
    await waitFor(() => expect(screen.getByText('2. Navigate 0')).toBeInTheDocument());

    await user.click(screen.getByText('Undo Last'));
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-reset')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-reset');
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-continue')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-continue');
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-request-debug-snapshot')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-request-debug-snapshot');

    await waitFor(() => expect(screen.queryByText('2. Navigate 0')).not.toBeInTheDocument());
    expect(screen.getByText('1. Continue')).toBeInTheDocument();
    expect(screen.getByText('Undo last recorded action')).toBeInTheDocument();
    const resetCount = editorPort.sent.filter((message) => (message as { type?: string }).type === 'runtime-reset').length;
    expect(resetCount).toBeGreaterThan(0);
  });

  it('replays the current draft without persisting authoring tests', async () => {
    const user = userEvent.setup();
    const { editorPort, previewPort } = await renderConnectedPreview();

    await user.click(screen.getByText('Recording'));
    await user.click(screen.getByText('Start Recording'));
    await user.click(screen.getByText('Choice 0'));
    await waitFor(() => expect(screen.getByText('1. Choice 0')).toBeInTheDocument());
    await user.click(screen.getByText('Stop'));

    expect(screen.getByText('Save as New Test')).toBeDisabled();
    expect(screen.getByText('Apply to Existing Test')).toBeDisabled();

    await user.click(screen.getByText('Replay'));
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-reset')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-reset');
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-dialogue-option')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-dialogue-option');
    await waitFor(() => expect(latestRequest(editorPort, 'runtime-request-debug-snapshot')).toBeDefined());
    await resolveLatest(editorPort, previewPort, 'runtime-request-debug-snapshot');

    expect(screen.getByText('Replaying 1 recorded action')).toBeInTheDocument();
  });
});
