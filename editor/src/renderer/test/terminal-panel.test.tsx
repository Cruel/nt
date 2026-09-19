import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { BottomPanel } from '@/workbench/BottomPanel';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { TerminalEvent } from '../../shared/terminal';

const terminalMock = vi.hoisted(() => ({
  onData: null as ((data: string) => void) | null,
  writes: [] as string[],
  resetCount: 0,
  focusCount: 0,
  fitCount: 0,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
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

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}));

const runningSession = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'running' as const,
  initialCwd: '/mock/project',
  output: '',
  error: null,
  exitCode: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  terminalMock.onData = null;
  terminalMock.writes = [];
  terminalMock.resetCount = 0;
  terminalMock.focusCount = 0;
  terminalMock.fitCount = 0;
  useProjectStore.getState().clearProject();
  useBottomPanelStore.getState().hydrate({
    visible: true,
    activePanelId: 'output',
    sizePercent: 30,
  });
  vi.mocked(window.noveltea.ensureTerminalSession).mockResolvedValue(runningSession);
  vi.mocked(window.noveltea.retryTerminalSession).mockResolvedValue({
    ...runningSession,
    id: '00000000-0000-4000-8000-000000000002',
  });
  vi.mocked(window.noveltea.onTerminalEvent).mockReturnValue(() => {});
});

describe('Terminal bottom panel', () => {
  it('is globally available but creates the first PTY lazily only when selected', async () => {
    render(<BottomPanel />);

    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument();
    expect(window.noveltea.ensureTerminalSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => expect(window.noveltea.ensureTerminalSession).toHaveBeenCalledOnce());
    expect(document.querySelector('[data-terminal-viewport]')).toBeInTheDocument();
  });

  it('routes xterm input/output and fitted viewport dimensions through terminal IPC', async () => {
    let terminalEvent: ((event: TerminalEvent) => void) | null = null;
    vi.mocked(window.noveltea.onTerminalEvent).mockImplementation((callback) => {
      terminalEvent = callback;
      return () => {};
    });
    useBottomPanelStore.getState().setActivePanelId('terminal');

    render(<BottomPanel />);
    await waitFor(() => expect(window.noveltea.ensureTerminalSession).toHaveBeenCalledOnce());

    act(() => terminalMock.onData?.('echo hello\r'));
    expect(window.noveltea.writeTerminal).toHaveBeenCalledWith(runningSession.id, 'echo hello\r');

    act(() => terminalEvent?.({ kind: 'output', sessionId: runningSession.id, data: 'hello\r\n' }));
    expect(terminalMock.writes).toContain('hello\r\n');

    await waitFor(() =>
      expect(window.noveltea.resizeTerminal).toHaveBeenCalledWith({
        sessionId: runningSession.id,
        columns: 100,
        rows: 30,
      }),
    );
  });

  it('keeps the selected terminal alive across Project context changes', async () => {
    useBottomPanelStore.getState().setActivePanelId('terminal');
    const view = render(<BottomPanel />);
    await waitFor(() => expect(window.noveltea.ensureTerminalSession).toHaveBeenCalledOnce());

    const project = createAuthoringProject();
    act(() => {
      useProjectStore.getState().loadProjectDocument({
        document: project,
        projectPath: '/mock/second-project',
        projectFilePath: '/mock/second-project/project.json',
      });
    });
    view.rerender(<BottomPanel />);
    expect(window.noveltea.ensureTerminalSession).toHaveBeenCalledOnce();

    act(() => useProjectStore.getState().clearProject());
    view.rerender(<BottomPanel />);
    expect(window.noveltea.ensureTerminalSession).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-terminal-viewport]')).toBeInTheDocument();
  });

  it('reconstructs buffered output after panel remount without requesting PTY termination', async () => {
    vi.mocked(window.noveltea.ensureTerminalSession).mockResolvedValue({
      ...runningSession,
      output: 'background output\r\n',
    });
    useBottomPanelStore.getState().setActivePanelId('terminal');
    render(<BottomPanel />);
    await waitFor(() => expect(terminalMock.writes).toContain('background output\r\n'));

    act(() => useBottomPanelStore.getState().setActivePanelId('output'));
    act(() => useBottomPanelStore.getState().setActivePanelId('terminal'));

    await waitFor(() => expect(window.noveltea.ensureTerminalSession).toHaveBeenCalledTimes(2));
    expect(terminalMock.writes.filter((entry) => entry === 'background output\r\n')).toHaveLength(
      2,
    );
  });

  it('keeps spawn failures visible and retries from the same surface', async () => {
    vi.mocked(window.noveltea.ensureTerminalSession).mockResolvedValue({
      ...runningSession,
      status: 'error',
      error: 'native PTY unavailable',
    });
    useBottomPanelStore.getState().setActivePanelId('terminal');

    render(<BottomPanel />);
    expect(await screen.findByText('native PTY unavailable')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(window.noveltea.retryTerminalSession).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByText('native PTY unavailable')).not.toBeInTheDocument(),
    );
  });
});
