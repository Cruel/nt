import { describe, expect, it, vi } from 'vite-plus/test';
import {
  resolveDefaultTerminalShell,
  TerminalService,
  type TerminalPtyAdapter,
  type TerminalPtyProcess,
} from '../../main/services/terminal-service';
import { terminalSessionRequiresCloseConfirmation } from '../../shared/terminal';

function fakeProcess() {
  let onData: ((data: string) => void) | null = null;
  let onExit: ((event: { exitCode: number }) => void) | null = null;
  const write = vi.fn<(data: string) => void>();
  const resize = vi.fn<(columns: number, rows: number) => void>();
  const kill = vi.fn<() => void>();
  const process: TerminalPtyProcess = {
    write,
    resize,
    kill,
    onData(callback) {
      onData = callback;
      return { dispose: vi.fn() };
    },
    onExit(callback) {
      onExit = callback;
      return { dispose: vi.fn() };
    },
  };
  return {
    process,
    write,
    resize,
    kill,
    emitData(data: string) {
      onData?.(data);
    },
    emitExit(exitCode: number) {
      onExit?.({ exitCode });
    },
  };
}

type SpawnOptions = Parameters<TerminalPtyAdapter['spawn']>[0];

function serviceOptions(spawn: TerminalPtyAdapter['spawn']) {
  return {
    pty: { spawn },
    resolveProjectRoot: () => null as string | null,
    resolveProjectOrigin: () => null,
    resolveFallbackCwd: async () => null,
    resolveDefaultProjectDirectory: () => '/documents/NovelTea',
    resolveShell: () => '/bin/sh',
    emit: vi.fn(),
  };
}

describe('TerminalService', () => {
  it('creates the first terminal lazily with immutable trusted creation metadata and routes PTY I/O', async () => {
    const pty = fakeProcess();
    const spawn = vi.fn((_options: SpawnOptions) => pty.process);
    const events: unknown[] = [];
    const options = serviceOptions(spawn);
    const service = new TerminalService({
      ...options,
      resolveProjectRoot: () => '/project/root',
      resolveProjectOrigin: () => ({ id: 'story', name: 'Story' }),
      resolveShell: () => '/bin/bash',
      env: { PATH: '/usr/bin', HOME: '/home/test' },
      emit: (event) => events.push(event),
      sessionId: () => 'terminal-1',
      now: () => new Date('2026-09-19T12:00:00.000Z'),
    });

    const state = await service.ensureState();
    expect(state).toMatchObject({
      selectedSessionId: 'terminal-1',
      sessions: [
        {
          id: 'terminal-1',
          label: 'Terminal 1',
          sequence: 1,
          initialCwd: '/project/root',
          lastKnownCwd: '/project/root',
          createdAt: '2026-09-19T12:00:00.000Z',
          originProject: { id: 'story', name: 'Story' },
          status: 'running',
          commandState: 'unknown',
        },
      ],
    });
    expect(spawn).toHaveBeenCalledWith({
      shell: '/bin/bash',
      cwd: '/project/root',
      env: { PATH: '/usr/bin', HOME: '/home/test' },
      columns: 80,
      rows: 24,
    });

    service.write('terminal-1', 'echo hello\r');
    service.resize('terminal-1', 120, 40);
    expect(pty.write).toHaveBeenCalledWith('echo hello\r');
    expect(pty.resize).toHaveBeenCalledWith(120, 40);

    pty.emitData('hello\r\n');
    expect(events).toContainEqual({ kind: 'output', sessionId: 'terminal-1', data: 'hello\r\n' });
    expect((await service.ensureState()).sessions[0]?.output).toBe('hello\r\n');
  });

  it('coalesces concurrent first use into one PTY', async () => {
    const pty = fakeProcess();
    const deferred: { resolve?: (process: TerminalPtyProcess) => void } = {};
    const spawn = vi.fn(
      (_options: SpawnOptions) =>
        new Promise<TerminalPtyProcess>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const service = new TerminalService({
      ...serviceOptions(spawn),
      sessionId: () => 'terminal-1',
    });

    const first = service.ensureState();
    const second = service.ensureState();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    deferred.resolve?.(pty.process);
    await expect(first).resolves.toMatchObject({ selectedSessionId: 'terminal-1' });
    await expect(second).resolves.toMatchObject({ selectedSessionId: 'terminal-1' });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('keeps sessions across Project switches and gives new sessions monotonic labels and current origins', async () => {
    const processes = [fakeProcess(), fakeProcess(), fakeProcess()];
    let spawnIndex = 0;
    const spawn = vi.fn((_options: SpawnOptions) => processes[spawnIndex++]!.process);
    let projectRoot: string | null = '/project/one';
    let origin = { id: 'one', name: 'One' };
    let nextId = 0;
    const service = new TerminalService({
      ...serviceOptions(spawn),
      resolveProjectRoot: () => projectRoot,
      resolveProjectOrigin: () => (projectRoot ? origin : null),
      sessionId: () => `terminal-${++nextId}`,
    });

    const first = await service.ensureState();
    expect(first.sessions[0]).toMatchObject({
      label: 'Terminal 1',
      initialCwd: '/project/one',
      originProject: { id: 'one', name: 'One' },
    });

    projectRoot = '/project/two';
    origin = { id: 'two', name: 'Two' };
    const second = await service.createSession();
    expect(second.sessions).toHaveLength(2);
    expect(second.selectedSessionId).toBe('terminal-2');
    expect(second.sessions[0]).toMatchObject({ initialCwd: '/project/one', label: 'Terminal 1' });
    expect(second.sessions[1]).toMatchObject({
      initialCwd: '/project/two',
      label: 'Terminal 2',
      originProject: { id: 'two', name: 'Two' },
    });

    service.selectSession('terminal-1');
    projectRoot = null;
    const selected = await service.ensureState();
    expect(selected.selectedSessionId).toBe('terminal-1');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('retains exited scrollback, relaunches in place, and replaces the final closed session', async () => {
    const first = fakeProcess();
    const relaunched = fakeProcess();
    const replacement = fakeProcess();
    const processes = [first, relaunched, replacement];
    let spawnIndex = 0;
    let nextId = 0;
    const service = new TerminalService({
      ...serviceOptions(() => processes[spawnIndex++]!.process),
      sessionId: () => `terminal-${++nextId}`,
    });

    await service.ensureState();
    first.emitData('done\r\n');
    first.emitExit(7);
    const exited = await service.ensureState();
    expect(exited.sessions[0]).toMatchObject({
      id: 'terminal-1',
      status: 'exited',
      commandState: 'idle',
      exitCode: 7,
      output: 'done\r\n',
    });

    const relaunchedState = await service.relaunchSession('terminal-1');
    expect(relaunchedState.sessions[0]).toMatchObject({
      id: 'terminal-1',
      label: 'Terminal 1',
      status: 'running',
      output: 'done\r\n',
    });

    relaunched.emitExit(0);
    const closeResult = await service.closeSession('terminal-1', false);
    expect(closeResult.requiresConfirmation).toBe(false);
    expect(closeResult.state).toMatchObject({
      selectedSessionId: 'terminal-2',
      sessions: [{ id: 'terminal-2', label: 'Terminal 2', sequence: 2 }],
    });
  });

  it('requires confirmation for running/unknown sessions and kills all owned PTYs on confirmed teardown', async () => {
    const first = fakeProcess();
    const second = fakeProcess();
    const nextWindow = fakeProcess();
    const processes = [first, second, nextWindow];
    let spawnIndex = 0;
    let nextId = 0;
    const service = new TerminalService({
      ...serviceOptions(() => processes[spawnIndex++]!.process),
      sessionId: () => `terminal-${++nextId}`,
    });

    await service.ensureState();
    await service.createSession();
    expect(service.shutdownRiskCount()).toBe(2);

    const guarded = await service.closeSession('terminal-1', false);
    expect(guarded.requiresConfirmation).toBe(true);
    expect(guarded.state.sessions).toHaveLength(2);
    expect(first.kill).not.toHaveBeenCalled();

    const forced = await service.closeSession('terminal-1', true);
    expect(forced.requiresConfirmation).toBe(false);
    expect(first.kill).toHaveBeenCalledOnce();
    expect(forced.state.sessions).toHaveLength(1);

    service.dispose();
    expect(second.kill).toHaveBeenCalledOnce();

    const nextWindowState = await service.ensureState();
    expect(nextWindowState.sessions).toMatchObject([{ label: 'Terminal 1', sequence: 1 }]);
  });

  it('retains spawn failures as actionable sessions and relaunches the same identity', async () => {
    const healthy = fakeProcess();
    const spawn = vi
      .fn(
        (_options: SpawnOptions): TerminalPtyProcess | Promise<TerminalPtyProcess> =>
          healthy.process,
      )
      .mockRejectedValueOnce(new Error('native PTY unavailable'));
    const service = new TerminalService({
      ...serviceOptions(spawn),
      sessionId: () => 'terminal-1',
    });

    expect((await service.ensureState()).sessions[0]).toMatchObject({
      id: 'terminal-1',
      status: 'error',
      commandState: 'idle',
      error: 'native PTY unavailable',
    });
    expect(service.shutdownRiskCount()).toBe(0);

    expect((await service.relaunchSession('terminal-1')).sessions[0]).toMatchObject({
      id: 'terminal-1',
      label: 'Terminal 1',
      status: 'running',
    });
  });

  it('uses configured fallback without a Project, then the default Project directory', async () => {
    const first = fakeProcess();
    const firstSpawn = vi.fn((_options: SpawnOptions) => first.process);
    const fallbackService = new TerminalService({
      ...serviceOptions(firstSpawn),
      resolveFallbackCwd: async () => '/terminal/fallback',
      sessionId: () => 'fallback',
    });
    await fallbackService.ensureState();
    expect(firstSpawn.mock.calls[0]?.[0].cwd).toBe('/terminal/fallback');

    const second = fakeProcess();
    const secondSpawn = vi.fn((_options: SpawnOptions) => second.process);
    const defaultService = new TerminalService({
      ...serviceOptions(secondSpawn),
      sessionId: () => 'default',
    });
    await defaultService.ensureState();
    expect(secondSpawn.mock.calls[0]?.[0].cwd).toBe('/documents/NovelTea');
  });
});

describe('terminal close confirmation policy', () => {
  it('allows idle/exited sessions to close immediately and protects running/unknown work', () => {
    expect(
      terminalSessionRequiresCloseConfirmation({ status: 'running', commandState: 'idle' }),
    ).toBe(false);
    expect(
      terminalSessionRequiresCloseConfirmation({ status: 'running', commandState: 'running' }),
    ).toBe(true);
    expect(
      terminalSessionRequiresCloseConfirmation({ status: 'running', commandState: 'unknown' }),
    ).toBe(true);
    expect(
      terminalSessionRequiresCloseConfirmation({ status: 'exited', commandState: 'idle' }),
    ).toBe(false);
    expect(
      terminalSessionRequiresCloseConfirmation({ status: 'error', commandState: 'idle' }),
    ).toBe(false);
  });
});

describe('resolveDefaultTerminalShell', () => {
  it('uses the normal configured POSIX shell when it exists', () => {
    expect(
      resolveDefaultTerminalShell(
        'linux',
        { SHELL: '/usr/bin/fish' },
        (value) => value === '/usr/bin/fish',
      ),
    ).toBe('/usr/bin/fish');
  });

  it('prefers pwsh on Windows and falls back to Windows PowerShell', () => {
    expect(
      resolveDefaultTerminalShell(
        'win32',
        { PATH: 'C:\\Tools;C:\\Other', SystemRoot: 'C:\\Windows' },
        (value) => value === 'C:\\Tools\\pwsh.exe',
      ),
    ).toContain('pwsh.exe');
    expect(
      resolveDefaultTerminalShell('win32', { PATH: '', SystemRoot: 'C:\\Windows' }, (value) =>
        value.toLowerCase().endsWith('powershell.exe'),
      ),
    ).toContain('powershell.exe');
  });
});
