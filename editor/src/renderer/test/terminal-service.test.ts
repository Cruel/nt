import { describe, expect, it, vi } from 'vite-plus/test';
import {
  resolveDefaultTerminalShell,
  TerminalService,
  type TerminalPtyAdapter,
  type TerminalPtyProcess,
} from '../../main/services/terminal-service';

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

describe('TerminalService', () => {
  it('uses Project root authority first and routes PTY I/O without renderer cwd/shell input', async () => {
    const pty = fakeProcess();
    const spawn = vi.fn((_options: SpawnOptions) => pty.process);
    const events: unknown[] = [];
    const service = new TerminalService({
      pty: { spawn },
      resolveProjectRoot: () => '/project/root',
      resolveFallbackCwd: vi.fn(async () => '/fallback'),
      resolveDefaultProjectDirectory: () => '/documents/NovelTea',
      resolveShell: () => '/bin/bash',
      env: { PATH: '/usr/bin', HOME: '/home/test' },
      emit: (event) => events.push(event),
      sessionId: () => 'terminal-1',
    });

    const session = await service.ensureSession();
    expect(session).toMatchObject({
      id: 'terminal-1',
      initialCwd: '/project/root',
      status: 'running',
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
    expect((await service.ensureSession()).output).toBe('hello\r\n');
  });

  it('coalesces concurrent first-use creation into one PTY session', async () => {
    const pty = fakeProcess();
    const deferred: { resolve?: (process: TerminalPtyProcess) => void } = {};
    const spawn = vi.fn(
      (_options: SpawnOptions) =>
        new Promise<TerminalPtyProcess>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const service = new TerminalService({
      pty: { spawn },
      resolveProjectRoot: () => '/project/root',
      resolveFallbackCwd: async () => null,
      resolveDefaultProjectDirectory: () => '/documents/NovelTea',
      resolveShell: () => '/bin/sh',
      emit: () => {},
      sessionId: () => 'terminal-1',
    });

    const first = service.ensureSession();
    const second = service.ensureSession();
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledOnce();

    deferred.resolve?.(pty.process);
    await expect(first).resolves.toMatchObject({ id: 'terminal-1' });
    await expect(second).resolves.toMatchObject({ id: 'terminal-1' });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('uses configured fallback without a Project, then the default Project directory', async () => {
    const first = fakeProcess();
    const firstSpawn = vi.fn((_options: SpawnOptions) => first.process);
    const fallbackService = new TerminalService({
      pty: { spawn: firstSpawn },
      resolveProjectRoot: () => null,
      resolveFallbackCwd: async () => '/terminal/fallback',
      resolveDefaultProjectDirectory: () => '/documents/NovelTea',
      resolveShell: () => '/bin/sh',
      emit: () => {},
      sessionId: () => 'fallback',
    });
    await fallbackService.ensureSession();
    expect(firstSpawn.mock.calls[0]?.[0].cwd).toBe('/terminal/fallback');

    const second = fakeProcess();
    const secondSpawn = vi.fn((_options: SpawnOptions) => second.process);
    const defaultService = new TerminalService({
      pty: { spawn: secondSpawn },
      resolveProjectRoot: () => null,
      resolveFallbackCwd: async () => null,
      resolveDefaultProjectDirectory: () => '/documents/NovelTea',
      resolveShell: () => '/bin/sh',
      emit: () => {},
      sessionId: () => 'default',
    });
    await defaultService.ensureSession();
    expect(secondSpawn.mock.calls[0]?.[0].cwd).toBe('/documents/NovelTea');
  });

  it('retains spawn failures as an actionable session and retries', async () => {
    const healthy = fakeProcess();
    const spawn = vi
      .fn(
        (_options: SpawnOptions): TerminalPtyProcess | Promise<TerminalPtyProcess> =>
          healthy.process,
      )
      .mockRejectedValueOnce(new Error('native PTY unavailable'));
    const events: unknown[] = [];
    let next = 0;
    const service = new TerminalService({
      pty: { spawn },
      resolveProjectRoot: () => null,
      resolveFallbackCwd: async () => null,
      resolveDefaultProjectDirectory: () => '/documents/NovelTea',
      resolveShell: () => '/bin/sh',
      emit: (event) => events.push(event),
      sessionId: () => `terminal-${++next}`,
    });

    expect(await service.ensureSession()).toMatchObject({
      id: 'terminal-1',
      status: 'error',
      error: 'native PTY unavailable',
    });
    expect(events).toContainEqual({
      kind: 'error',
      sessionId: 'terminal-1',
      message: 'native PTY unavailable',
    });

    expect(await service.retrySession()).toMatchObject({
      id: 'terminal-2',
      status: 'running',
      initialCwd: '/documents/NovelTea',
    });
  });

  it('keeps a session independent of Project changes and kills it only when disposed', async () => {
    const pty = fakeProcess();
    let projectRoot: string | null = '/project/one';
    const spawn = vi.fn((_options: SpawnOptions) => pty.process);
    const service = new TerminalService({
      pty: { spawn },
      resolveProjectRoot: () => projectRoot,
      resolveFallbackCwd: async () => null,
      resolveDefaultProjectDirectory: () => '/documents/NovelTea',
      resolveShell: () => '/bin/sh',
      emit: () => {},
      sessionId: () => 'terminal-1',
    });

    await service.ensureSession();
    projectRoot = '/project/two';
    expect(await service.ensureSession()).toMatchObject({ initialCwd: '/project/one' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(pty.kill).not.toHaveBeenCalled();

    service.dispose();
    expect(pty.kill).toHaveBeenCalledOnce();
  });

  it('retains exited output and status for later remounts', async () => {
    const pty = fakeProcess();
    const service = new TerminalService({
      pty: { spawn: () => pty.process },
      resolveProjectRoot: () => null,
      resolveFallbackCwd: async () => null,
      resolveDefaultProjectDirectory: () => '/documents/NovelTea',
      resolveShell: () => '/bin/sh',
      emit: () => {},
      sessionId: () => 'terminal-1',
    });
    await service.ensureSession();
    pty.emitData('done\r\n');
    pty.emitExit(7);

    expect(await service.ensureSession()).toMatchObject({
      status: 'exited',
      exitCode: 7,
      output: 'done\r\n',
    });
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
