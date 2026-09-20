import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { BottomPanel } from '@/workbench/BottomPanel';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { useTerminalAttentionStore } from '@/workbench/terminal-attention-store';
import { useProjectStore } from '@/project/project-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type {
  TerminalEvent,
  TerminalHostSnapshot,
  TerminalSessionSnapshot,
} from '../../shared/terminal';

const clipboardWriteText = vi.fn().mockResolvedValue(undefined);

const terminalMock = vi.hoisted(() => ({
  onData: null as ((data: string) => void) | null,
  keyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  writes: [] as string[],
  pastes: [] as string[],
  selectedText: '',
  options: {} as Record<string, unknown>,
  resetCount: 0,
  focusCount: 0,
  fitCount: 0,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terminalMock.options = this.options;
    }
    loadAddon() {}
    open() {}
    write(data: string) {
      terminalMock.writes.push(data);
    }
    focus() {
      terminalMock.focusCount += 1;
    }
    reset() {
      terminalMock.resetCount += 1;
    }
    dispose() {}
    attachCustomKeyEventHandler(callback: (event: KeyboardEvent) => boolean) {
      terminalMock.keyHandler = callback;
    }
    hasSelection() {
      return terminalMock.selectedText.length > 0;
    }
    getSelection() {
      return terminalMock.selectedText;
    }
    paste(data: string) {
      terminalMock.pastes.push(data);
    }
    onData(callback: (data: string) => void) {
      terminalMock.onData = callback;
      return { dispose() {} };
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      terminalMock.fitCount += 1;
    }
  },
}));

vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

function session(
  sequence: number,
  overrides: Partial<TerminalSessionSnapshot> = {},
): TerminalSessionSnapshot {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    label: `Terminal ${sequence}`,
    sequence,
    status: 'running',
    commandState: 'unknown',
    currentCommandStartedAt: null,
    latestCommand: null,
    latestAttention: null,
    initialCwd: '/mock/project',
    lastKnownCwd: '/mock/project',
    createdAt: `2026-09-19T12:00:0${sequence}.000Z`,
    originProject: { id: 'project', name: 'Project' },
    output: '',
    error: null,
    exitCode: null,
    ...overrides,
  };
}

const terminal1 = session(1);
const initialState: TerminalHostSnapshot = {
  sessions: [terminal1],
  selectedSessionId: terminal1.id,
};

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  terminalMock.onData = null;
  terminalMock.keyHandler = null;
  terminalMock.writes = [];
  terminalMock.pastes = [];
  terminalMock.selectedText = '';
  terminalMock.options = {};
  terminalMock.resetCount = 0;
  terminalMock.focusCount = 0;
  terminalMock.fitCount = 0;
  useProjectStore.getState().clearProject();
  usePreferencesStore.getState().resetToDefaults();
  useTerminalAttentionStore.getState().reset();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: clipboardWriteText,
      readText: vi.fn().mockResolvedValue('pasted'),
    },
  });
  useBottomPanelStore
    .getState()
    .hydrate({ visible: true, activePanelId: 'output', sizePercent: 30 });
  vi.mocked(window.noveltea.ensureTerminalState).mockResolvedValue(initialState);
  vi.mocked(window.noveltea.createTerminalSession).mockResolvedValue(initialState);
  vi.mocked(window.noveltea.selectTerminalSession).mockResolvedValue(initialState);
  vi.mocked(window.noveltea.closeTerminalSession).mockResolvedValue({
    state: initialState,
    requiresConfirmation: false,
  });
  vi.mocked(window.noveltea.relaunchTerminalSession).mockResolvedValue(initialState);
  vi.mocked(window.noveltea.onTerminalEvent).mockReturnValue(() => {});
  vi.mocked(window.noveltea.showTerminalNotification).mockResolvedValue(true);
  vi.mocked(window.noveltea.onTerminalNotificationClick).mockReturnValue(() => {});
});

describe('Terminal bottom panel', () => {
  it('is globally available but creates the first PTY lazily only when selected', async () => {
    render(<BottomPanel />);
    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument();
    expect(window.noveltea.ensureTerminalState).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    await waitFor(() => expect(window.noveltea.ensureTerminalState).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'New Terminal' })).toBeInTheDocument();
    expect(screen.getByText('Terminal 1')).toBeInTheDocument();
  });

  it('marks hidden terminal attention unread while ignoring attention on the visible selected terminal', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>();
    vi.mocked(window.noveltea.onTerminalEvent).mockImplementation((callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    });
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);
    await screen.findByText('Terminal 1');

    act(() => {
      for (const listener of listeners) {
        listener({
          kind: 'attention',
          sessionId: terminal1.id,
          attention: { kind: 'bell', occurredAt: '2026-09-19T12:00:10.000Z' },
        });
      }
    });
    expect(screen.queryByLabelText('Terminal needs attention')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Output' }));
    expect(listeners.size).toBeGreaterThan(0);
    act(() => {
      for (const listener of listeners) {
        listener({
          kind: 'attention',
          sessionId: terminal1.id,
          attention: { kind: 'command-completed', occurredAt: '2026-09-19T12:00:20.000Z' },
        });
      }
    });
    expect(screen.getByLabelText('Terminal needs attention')).toBeInTheDocument();
  });

  it('shows running activity separately and gives unread attention visual precedence', async () => {
    const terminal2 = session(2, { commandState: 'idle' });
    const twoSessions = { sessions: [terminal1, terminal2], selectedSessionId: terminal1.id };
    const listeners = new Set<(event: TerminalEvent) => void>();
    vi.mocked(window.noveltea.ensureTerminalState).mockResolvedValue(twoSessions);
    vi.mocked(window.noveltea.onTerminalEvent).mockImplementation((callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    });
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);
    await screen.findByText('Terminal 2');

    act(() => {
      for (const listener of listeners) {
        listener({
          kind: 'metadata',
          sessionId: terminal2.id,
          commandState: 'running',
          currentCommandStartedAt: '2026-09-19T12:00:10.000Z',
          latestCommand: null,
          lastKnownCwd: '/mock/project',
        });
      }
    });
    expect(screen.getByLabelText('Terminal 2 command running')).toBeInTheDocument();

    act(() => {
      for (const listener of listeners) {
        listener({
          kind: 'attention',
          sessionId: terminal2.id,
          attention: { kind: 'bell', occurredAt: '2026-09-19T12:00:11.000Z' },
        });
      }
    });
    expect(screen.getByLabelText('Terminal 2 needs attention')).toBeInTheDocument();
    expect(screen.queryByLabelText('Terminal 2 command running')).not.toBeInTheDocument();
  });

  it('delays passive acknowledgment, cancels it when hidden, then fades after sustained viewing', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>();
    vi.mocked(window.noveltea.onTerminalEvent).mockImplementation((callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    });
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);
    await screen.findByText('Terminal 1');
    fireEvent.click(screen.getByRole('button', { name: 'Output' }));
    act(() => {
      for (const listener of listeners) {
        listener({
          kind: 'attention',
          sessionId: terminal1.id,
          attention: { kind: 'bell', occurredAt: '2026-09-19T12:00:10.000Z' },
        });
      }
    });
    expect(screen.getByLabelText('Terminal needs attention')).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByText('Terminal'));
    await act(async () => Promise.resolve());
    expect(screen.getByLabelText('Terminal 1 needs attention')).toHaveAttribute(
      'data-terminal-unread-state',
      'unread',
    );
    act(() => {
      vi.advanceTimersByTime(2_999);
    });
    expect(screen.getByLabelText('Terminal 1 needs attention')).toHaveAttribute(
      'data-terminal-unread-state',
      'unread',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Output' }));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByLabelText('Terminal needs attention')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Terminal'));
    await act(async () => Promise.resolve());
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByLabelText('Terminal 1 needs attention')).toHaveAttribute(
      'data-terminal-unread-state',
      'fading',
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByLabelText('Terminal 1 needs attention')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Terminal needs attention')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('immediately fades unread attention for both the terminal being left and one selected directly', async () => {
    const terminal2 = session(2);
    const twoSessions = { sessions: [terminal1, terminal2], selectedSessionId: terminal1.id };
    const listeners = new Set<(event: TerminalEvent) => void>();
    vi.mocked(window.noveltea.ensureTerminalState).mockResolvedValue(twoSessions);
    vi.mocked(window.noveltea.selectTerminalSession).mockResolvedValue({
      sessions: [terminal1, terminal2],
      selectedSessionId: terminal2.id,
    });
    vi.mocked(window.noveltea.onTerminalEvent).mockImplementation((callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    });
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);
    await screen.findByText('Terminal 2');
    fireEvent.click(screen.getByRole('button', { name: 'Output' }));
    act(() => {
      for (const sessionId of [terminal1.id, terminal2.id]) {
        for (const listener of listeners) {
          listener({
            kind: 'attention',
            sessionId,
            attention: { kind: 'bell', occurredAt: '2026-09-19T12:00:10.000Z' },
          });
        }
      }
    });

    vi.useFakeTimers();
    fireEvent.click(screen.getByText('Terminal'));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByText('Terminal 2'));
    await act(async () => Promise.resolve());
    expect(screen.getByLabelText('Terminal 1 needs attention')).toHaveAttribute(
      'data-terminal-unread-state',
      'fading',
    );
    expect(screen.getByLabelText('Terminal 2 needs attention')).toHaveAttribute(
      'data-terminal-unread-state',
      'fading',
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByLabelText('Terminal 1 needs attention')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Terminal 2 needs attention')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('requests at most one native notification per unread period and honors the preference', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>();
    vi.mocked(window.noveltea.onTerminalEvent).mockImplementation((callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    });
    render(<BottomPanel />);

    const attention: TerminalEvent = {
      kind: 'attention',
      sessionId: terminal1.id,
      attention: { kind: 'bell', occurredAt: '2026-09-19T12:00:10.000Z' },
    };
    act(() => {
      for (const listener of listeners) listener(attention);
      for (const listener of listeners) listener(attention);
    });
    expect(window.noveltea.showTerminalNotification).toHaveBeenCalledOnce();
    expect(window.noveltea.showTerminalNotification).toHaveBeenCalledWith({
      sessionId: terminal1.id,
      kind: 'bell',
    });

    useTerminalAttentionStore.getState().reset();
    act(() => {
      usePreferencesStore.getState().setTerminalPreferences({ desktopNotifications: false });
      for (const listener of listeners) listener(attention);
    });
    expect(window.noveltea.showTerminalNotification).toHaveBeenCalledOnce();
  });

  it('opens, selects, and acknowledges a terminal when its native notification is clicked', async () => {
    let clickListener: ((event: { sessionId: string }) => void) | null = null;
    vi.mocked(window.noveltea.onTerminalNotificationClick).mockImplementation((callback) => {
      clickListener = callback;
      return () => {};
    });
    vi.mocked(window.noveltea.selectTerminalSession).mockResolvedValue(initialState);
    render(<BottomPanel />);
    act(() => {
      useTerminalAttentionStore.getState().receiveAttention(terminal1.id, {
        kind: 'bell',
        occurredAt: '2026-09-19T12:00:10.000Z',
      });
    });

    vi.useFakeTimers();
    act(() => {
      clickListener?.({ sessionId: terminal1.id });
    });
    expect(useBottomPanelStore.getState()).toMatchObject({
      visible: true,
      activePanelId: 'terminal',
    });
    expect(window.noveltea.selectTerminalSession).toHaveBeenCalledWith(terminal1.id);
    expect(useTerminalAttentionStore.getState().attentionBySession[terminal1.id]?.state).toBe(
      'fading',
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useTerminalAttentionStore.getState().attentionBySession[terminal1.id]).toBeUndefined();
    vi.useRealTimers();
  });

  it('routes selected xterm input/output and fitted dimensions through terminal IPC', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>();
    vi.mocked(window.noveltea.onTerminalEvent).mockImplementation((callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    });
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);
    await waitFor(() =>
      expect(window.noveltea.resizeTerminal).toHaveBeenCalledWith({
        sessionId: terminal1.id,
        columns: 100,
        rows: 30,
      }),
    );

    act(() => terminalMock.onData?.('echo hello\r'));
    expect(window.noveltea.writeTerminal).toHaveBeenCalledWith(terminal1.id, 'echo hello\r');
    act(() => {
      for (const listener of listeners) {
        listener({ kind: 'output', sessionId: terminal1.id, data: 'hello\r\n' });
      }
    });
    expect(terminalMock.writes).toContain('hello\r\n');
  });

  it('creates and selects multiple left-aligned terminal tabs without coupling selection to Project changes', async () => {
    const terminal2 = session(2, {
      initialCwd: '/mock/second-project',
      lastKnownCwd: '/mock/second-project',
      originProject: { id: 'second', name: 'Second' },
    });
    const twoSessions = { sessions: [terminal1, terminal2], selectedSessionId: terminal2.id };
    vi.mocked(window.noveltea.createTerminalSession).mockResolvedValue(twoSessions);
    vi.mocked(window.noveltea.selectTerminalSession).mockResolvedValue({
      sessions: [terminal1, terminal2],
      selectedSessionId: terminal1.id,
    });
    useBottomPanelStore.getState().setActivePanelId('terminal');
    const view = render(<BottomPanel />);
    await screen.findByText('Terminal 1');

    fireEvent.click(screen.getByRole('button', { name: 'New Terminal' }));
    expect(await screen.findByText('Terminal 2')).toBeInTheDocument();
    expect(window.noveltea.createTerminalSession).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByText('Terminal 1'));
    await waitFor(() =>
      expect(window.noveltea.selectTerminalSession).toHaveBeenCalledWith(terminal1.id),
    );

    act(() => {
      useProjectStore.getState().loadProjectDocument({
        document: createAuthoringProject(),
        projectPath: '/mock/other',
        projectFilePath: '/mock/other/project.json',
      });
    });
    view.rerender(<BottomPanel />);
    expect(window.noveltea.ensureTerminalState).toHaveBeenCalledOnce();
  });

  it('asks once before closing a running/unknown terminal and then forces the requested close', async () => {
    const terminal2 = session(2);
    const twoSessions = { sessions: [terminal1, terminal2], selectedSessionId: terminal1.id };
    vi.mocked(window.noveltea.ensureTerminalState).mockResolvedValue(twoSessions);
    vi.mocked(window.noveltea.closeTerminalSession)
      .mockResolvedValueOnce({ state: twoSessions, requiresConfirmation: true })
      .mockResolvedValueOnce({
        state: { sessions: [terminal2], selectedSessionId: terminal2.id },
        requiresConfirmation: false,
      });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);
    await screen.findByText('Terminal 1');

    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(window.noveltea.closeTerminalSession).toHaveBeenNthCalledWith(1, {
      sessionId: terminal1.id,
      force: false,
    });
    expect(window.noveltea.closeTerminalSession).toHaveBeenNthCalledWith(2, {
      sessionId: terminal1.id,
      force: true,
    });
    expect(await screen.findByText('Terminal 2')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('retains exited output and offers same-session Relaunch', async () => {
    const exited = session(1, {
      status: 'exited',
      commandState: 'idle',
      output: 'done\r\n',
      exitCode: 7,
    });
    vi.mocked(window.noveltea.ensureTerminalState).mockResolvedValue({
      sessions: [exited],
      selectedSessionId: exited.id,
    });
    vi.mocked(window.noveltea.relaunchTerminalSession).mockResolvedValue(initialState);
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);

    expect(await screen.findByText('Terminal exited (7)')).toBeInTheDocument();
    await waitFor(() => expect(terminalMock.writes).toContain('done\r\n'));
    fireEvent.click(screen.getByRole('button', { name: 'Relaunch' }));
    await waitFor(() =>
      expect(window.noveltea.relaunchTerminalSession).toHaveBeenCalledWith(exited.id),
    );
  });

  it('retries host creation when failure occurs before any session exists', async () => {
    vi.mocked(window.noveltea.ensureTerminalState)
      .mockRejectedValueOnce(new Error('cwd unavailable'))
      .mockResolvedValueOnce(initialState);
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);

    expect(await screen.findByText('cwd unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(window.noveltea.ensureTerminalState).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Terminal 1')).toBeInTheDocument();
  });

  it('reconstructs buffered output after panel remount from the window-owned host state', async () => {
    vi.mocked(window.noveltea.ensureTerminalState).mockResolvedValue({
      sessions: [session(1, { output: 'background output\r\n' })],
      selectedSessionId: terminal1.id,
    });
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);
    await waitFor(() => expect(terminalMock.writes).toContain('background output\r\n'));

    act(() => useBottomPanelStore.getState().setActivePanelId('output'));
    act(() => useBottomPanelStore.getState().setActivePanelId('terminal'));
    await waitFor(() => expect(window.noveltea.ensureTerminalState).toHaveBeenCalledTimes(2));
  });

  it('applies terminal presentation preferences live without restarting the PTY', async () => {
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);
    await screen.findByText('Terminal 1');
    const creationCount = vi.mocked(window.noveltea.ensureTerminalState).mock.calls.length;
    const fitCount = terminalMock.fitCount;

    act(() => {
      usePreferencesStore.getState().setTerminalPreferences({
        fontFamily: 'Fira Code, monospace',
        fontSize: 18,
        scrollback: 24000,
      });
    });

    await waitFor(() => expect(terminalMock.options.fontFamily).toBe('Fira Code, monospace'));
    expect(terminalMock.options.fontSize).toBe(18);
    expect(terminalMock.options.scrollback).toBe(24000);
    await waitFor(() => expect(terminalMock.fitCount).toBeGreaterThan(fitCount));
    expect(window.noveltea.ensureTerminalState).toHaveBeenCalledTimes(creationCount);
  });

  it('copies an xterm selection but leaves Ctrl+C unclaimed when there is no selection', async () => {
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);
    await screen.findByText('Terminal 1');
    await waitFor(() => expect(terminalMock.keyHandler).not.toBeNull());

    terminalMock.selectedText = '';
    expect(
      terminalMock.keyHandler?.(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })),
    ).toBe(true);

    terminalMock.selectedText = 'selected output';
    expect(
      terminalMock.keyHandler?.(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })),
    ).toBe(false);
    expect(clipboardWriteText).toHaveBeenCalledWith('selected output');
  });

  it('keeps macOS Command copy/paste separate from Ctrl+C interrupt', async () => {
    vi.mocked(window.noveltea.getAppInfo).mockResolvedValueOnce({
      version: 'test',
      electronVersion: '42.0.0',
      platform: 'darwin',
      arch: 'arm64',
      packaged: false,
      frameless: false,
      nativeFrame: true,
      preferredSystemLanguages: ['en-US'],
      systemLocale: 'en-US',
    });
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);
    await screen.findByText('Terminal 1');
    await waitFor(() => expect(window.noveltea.getAppInfo).toHaveBeenCalled());
    await waitFor(() => expect(terminalMock.keyHandler).not.toBeNull());

    expect(
      terminalMock.keyHandler?.(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })),
    ).toBe(true);
    expect(
      terminalMock.keyHandler?.(new KeyboardEvent('keydown', { key: 'v', metaKey: true })),
    ).toBe(false);
    await waitFor(() => expect(terminalMock.pastes).toContain('pasted'));
  });
});
