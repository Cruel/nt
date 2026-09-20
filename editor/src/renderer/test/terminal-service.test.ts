import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import { prepareTerminalShell } from '../../main/services/terminal-shell-integration';
import {
  resolveDefaultTerminalShell,
  terminateTerminalProcessTree,
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
    pid: 4242,
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
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: '/bin/bash',
        cwd: '/project/root',
        env: expect.objectContaining({ PATH: '/usr/bin', HOME: '/home/test' }),
        columns: 80,
        rows: 24,
      }),
    );

    service.write('terminal-1', 'echo hello\r');
    service.resize('terminal-1', 120, 40);
    expect(pty.write).toHaveBeenCalledWith('echo hello\r');
    expect(pty.resize).toHaveBeenCalledWith(120, 40);

    pty.emitData('hello\r\n');
    expect(events).toContainEqual({ kind: 'output', sessionId: 'terminal-1', data: 'hello\r\n' });
  });

  it('tracks integrated command lifecycle, cwd, exit status, long-command attention, and BEL', async () => {
    const pty = fakeProcess();
    const events: unknown[] = [];
    let now = new Date('2026-09-19T12:00:00.000Z');
    const service = new TerminalService({
      ...serviceOptions(() => pty.process),
      resolveShell: () => '/bin/bash',
      emit: (event) => events.push(event),
      sessionId: () => 'terminal-1',
      now: () => now,
    });

    expect((await service.ensureState()).sessions[0]).toMatchObject({
      commandState: 'unknown',
      lastKnownCwd: '/documents/NovelTea',
    });

    pty.emitData('\u001b]633;A\u0007');
    expect((await service.ensureState()).sessions[0]).toMatchObject({ commandState: 'idle' });

    pty.emitData('\u001b]7;file://localhost/work/story%20project\u0007');
    expect((await service.ensureState()).sessions[0]).toMatchObject({
      lastKnownCwd: '/work/story project',
    });
    pty.emitData('\u001b]7;file://localhost/work/project%23draft%2520\u0007');
    expect((await service.ensureState()).sessions[0]).toMatchObject({
      lastKnownCwd: '/work/project#draft%20',
    });

    now = new Date('2026-09-19T12:00:01.000Z');
    pty.emitData('\u001b]633;C\u0007');
    expect((await service.ensureState()).sessions[0]).toMatchObject({
      commandState: 'running',
      currentCommandStartedAt: '2026-09-19T12:00:01.000Z',
    });

    now = new Date('2026-09-19T12:00:04.500Z');
    pty.emitData('\u001b]633;D;7\u0007');
    expect((await service.ensureState()).sessions[0]).toMatchObject({
      commandState: 'idle',
      currentCommandStartedAt: null,
      latestCommand: {
        startedAt: '2026-09-19T12:00:01.000Z',
        completedAt: '2026-09-19T12:00:04.500Z',
        durationMs: 3500,
        exitCode: 7,
      },
      latestAttention: {
        kind: 'command-completed',
        occurredAt: '2026-09-19T12:00:04.500Z',
      },
    });
    expect(events).toContainEqual({
      kind: 'attention',
      sessionId: 'terminal-1',
      attention: {
        kind: 'command-completed',
        occurredAt: '2026-09-19T12:00:04.500Z',
      },
    });

    now = new Date('2026-09-19T12:00:05.000Z');
    pty.emitData('\u0007');
    expect(events).toContainEqual({
      kind: 'attention',
      sessionId: 'terminal-1',
      attention: { kind: 'bell', occurredAt: '2026-09-19T12:00:05.000Z' },
    });
    expect((await service.ensureState()).sessions[0]).toMatchObject({
      latestAttention: { kind: 'bell', occurredAt: '2026-09-19T12:00:05.000Z' },
    });
  });

  it('preserves a split OSC prefix instead of emitting a false BEL or losing command state', async () => {
    const pty = fakeProcess();
    const events: unknown[] = [];
    const service = new TerminalService({
      ...serviceOptions(() => pty.process),
      resolveShell: () => '/bin/bash',
      emit: (event) => events.push(event),
      sessionId: () => 'terminal-1',
    });

    await service.ensureState();
    pty.emitData('\u001b');
    expect(events).not.toContainEqual({ kind: 'output', sessionId: 'terminal-1', data: '\u001b' });
    pty.emitData(']633;C\u0007');
    expect((await service.ensureState()).sessions[0]).toMatchObject({ commandState: 'running' });
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'attention',
        attention: expect.objectContaining({ kind: 'bell' }),
      }),
    );
  });

  it('keeps command state unknown when shell integration is unavailable while still surfacing BEL', async () => {
    const pty = fakeProcess();
    const events: unknown[] = [];
    const service = new TerminalService({
      ...serviceOptions(() => pty.process),
      resolveShell: () => '/usr/bin/fish',
      emit: (event) => events.push(event),
      sessionId: () => 'terminal-1',
    });

    await service.ensureState();
    pty.emitData('\u001b]633;C\u0007\u001b]7;file:///tmp/other\u0007\u001b]633;D;0\u0007');
    expect((await service.ensureState()).sessions[0]).toMatchObject({
      commandState: 'unknown',
      lastKnownCwd: '/documents/NovelTea',
    });

    pty.emitData('\u0007');
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'attention',
        sessionId: 'terminal-1',
        attention: expect.objectContaining({ kind: 'bell' }),
      }),
    );
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

  it('retains exited session identity, relaunches in place, and replaces the final closed session', async () => {
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
    });

    const relaunchedState = await service.relaunchSession('terminal-1');
    expect(relaunchedState.sessions[0]).toMatchObject({
      id: 'terminal-1',
      label: 'Terminal 1',
      status: 'running',
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
    const terminateProcessTree = vi.fn();
    const service = new TerminalService({
      ...serviceOptions(() => processes[spawnIndex++]!.process),
      sessionId: () => `terminal-${++nextId}`,
      terminateProcessTree,
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
    expect(terminateProcessTree).toHaveBeenCalledWith(first.process.pid);
    expect(first.kill).toHaveBeenCalledOnce();
    expect(forced.state.sessions).toHaveLength(1);

    service.dispose();
    expect(terminateProcessTree).toHaveBeenCalledWith(second.process.pid);
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
      resolveDefaultProjectDirectory: async () => '/configured/projects',
      sessionId: () => 'default',
    });
    await defaultService.ensureState();
    expect(secondSpawn.mock.calls[0]?.[0].cwd).toBe('/configured/projects');
  });
});

describe('terminal shell integration', () => {
  it('preserves normal zsh login and interactive startup files while injecting hooks', () => {
    const prepared = prepareTerminalShell('/bin/zsh', {
      HOME: '/home/test',
      ZDOTDIR: '/home/test/custom-zdotdir',
    });
    const generatedZdotdir = prepared.env.ZDOTDIR!;
    try {
      expect(prepared.args).toEqual(['-il']);
      expect(generatedZdotdir).not.toBe('/home/test/custom-zdotdir');
      expect(fs.readFileSync(path.join(generatedZdotdir, '.zshenv'), 'utf8')).toContain(
        '/home/test/custom-zdotdir/.zshenv',
      );
      for (const filename of ['.zprofile', '.zshrc', '.zlogin']) {
        const contents = fs.readFileSync(path.join(generatedZdotdir, filename), 'utf8');
        expect(contents).toContain(`$ZDOTDIR/${filename}`);
        expect(contents).toContain('__NOVELTEA_USER_ZDOTDIR');
      }
      expect(fs.readFileSync(path.join(generatedZdotdir, '.zshrc'), 'utf8')).toContain(
        '__noveltea_preexec',
      );
    } finally {
      prepared.dispose();
    }
    expect(fs.existsSync(generatedZdotdir)).toBe(false);
  });

  it('loads ordinary zsh startup files without recursively sourcing integration wrappers', () => {
    if (!fs.existsSync('/bin/zsh')) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-zsh-normal-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.zshenv'), 'typeset -gx NOVELTEA_ENV_SEEN=env\n');
    fs.writeFileSync(path.join(home, '.zprofile'), 'typeset -gx NOVELTEA_PROFILE_SEEN=profile\n');
    fs.writeFileSync(path.join(home, '.zshrc'), 'typeset -gx NOVELTEA_RC_SEEN=rc\n');
    fs.writeFileSync(path.join(home, '.zlogin'), 'typeset -gx NOVELTEA_LOGIN_SEEN=login\n');
    const prepared = prepareTerminalShell('/bin/zsh', { HOME: home, PATH: '/usr/bin:/bin' });
    try {
      const probe = spawnSync(
        '/bin/zsh',
        [
          ...prepared.args,
          '-c',
          'print -r -- "$NOVELTEA_ENV_SEEN|$NOVELTEA_PROFILE_SEEN|$NOVELTEA_RC_SEEN|$NOVELTEA_LOGIN_SEEN"',
        ],
        { env: prepared.env, encoding: 'utf8' },
      );
      expect(probe.status).toBe(0);
      expect(probe.stdout).toContain('env|profile|rc|login');
      expect(probe.stderr).not.toMatch(/recursion|maximum nested|too many levels/iu);
    } finally {
      prepared.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows ZDOTDIR changes made by .zshenv when sourcing later startup files', () => {
    if (!fs.existsSync('/bin/zsh')) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-zsh-zdotdir-'));
    const home = path.join(root, 'home');
    const relocated = path.join(root, 'relocated');
    fs.mkdirSync(home);
    fs.mkdirSync(relocated);
    fs.writeFileSync(
      path.join(home, '.zshenv'),
      `typeset -gx ZDOTDIR=${JSON.stringify(relocated)}\ntypeset -gx NOVELTEA_ENV_SEEN=env\n`,
    );
    fs.writeFileSync(
      path.join(relocated, '.zprofile'),
      'typeset -gx NOVELTEA_PROFILE_SEEN=profile\n',
    );
    fs.writeFileSync(
      path.join(relocated, '.zshrc'),
      'typeset -gx NOVELTEA_RC_SEEN=rc\ntypeset -gx PATH="/relocated/bin:$PATH"\n',
    );
    fs.writeFileSync(path.join(relocated, '.zlogin'), 'typeset -gx NOVELTEA_LOGIN_SEEN=login\n');
    const prepared = prepareTerminalShell('/bin/zsh', { HOME: home, PATH: '/usr/bin:/bin' });
    try {
      const probe = spawnSync(
        '/bin/zsh',
        [
          ...prepared.args,
          '-c',
          'print -r -- "$NOVELTEA_ENV_SEEN|$NOVELTEA_PROFILE_SEEN|$NOVELTEA_RC_SEEN|$NOVELTEA_LOGIN_SEEN|$PATH"',
        ],
        { env: prepared.env, encoding: 'utf8' },
      );
      expect(probe.status).toBe(0);
      expect(probe.stdout).toContain('env|profile|rc|login|/relocated/bin:');
    } finally {
      prepared.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fully URL-encodes cwd paths in bash and zsh OSC 7 markers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-terminal-cwd-'));
    const cwd = path.join(root, "project #draft%20? ü '[]");
    fs.mkdirSync(cwd);
    try {
      for (const shell of ['/bin/bash', '/bin/zsh']) {
        if (!fs.existsSync(shell)) continue;
        const home = path.join(root, path.basename(shell));
        fs.mkdirSync(home, { recursive: true });
        const prepared = prepareTerminalShell(shell, { HOME: home, PATH: '/usr/bin:/bin' });
        try {
          const hook = shell.endsWith('bash') ? '__noveltea_prompt_command' : '__noveltea_precmd';
          const probe = spawnSync(
            shell,
            [...prepared.args, '-c', `cd ${JSON.stringify(cwd)}; ${hook}`],
            {
              env: prepared.env,
              encoding: 'utf8',
            },
          );
          expect(probe.status).toBe(0);
          const markerPrefix = '\u001b]7;';
          const markerStart = probe.stdout.indexOf(markerPrefix);
          expect(markerStart).toBeGreaterThanOrEqual(0);
          const markerEnd = probe.stdout.indexOf('\u0007', markerStart + markerPrefix.length);
          expect(markerEnd).toBeGreaterThan(markerStart);
          const marker = probe.stdout.slice(markerStart + markerPrefix.length, markerEnd);
          const encodedPath = new URL(marker).pathname;
          expect(encodedPath).toContain('%20%23draft%2520%3F%20%C3%BC%20%27%5B%5D');
          expect(decodeURIComponent(encodedPath)).toBe(cwd);
        } finally {
          prepared.dispose();
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses PowerShell 5.1-compatible character escapes for lifecycle markers', () => {
    const prepared = prepareTerminalShell('powershell.exe', {});
    const command = prepared.args.join(' ');
    expect(command).toContain('[char]27');
    expect(command).toContain('[char]7');
    expect(command).not.toContain('`e');
  });
});

describe('terminal process-tree cleanup', () => {
  it('terminates a detached Linux shell and its nohup descendant', async () => {
    if (process.platform !== 'linux') return;
    const shell = spawn('/bin/bash', ['-c', 'nohup sleep 30 >/dev/null 2>&1 & echo $!; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [chunk] = await once(shell.stdout, 'data');
    const childPid = Number(String(chunk).trim());
    expect(Number.isInteger(childPid)).toBe(true);
    try {
      terminateTerminalProcessTree(shell.pid!, 'linux');
      await vi.waitFor(
        () => {
          const childState = spawnSync('ps', ['-o', 'stat=', '-p', String(childPid)], {
            encoding: 'utf8',
          }).stdout.trim();
          const shellState = spawnSync('ps', ['-o', 'stat=', '-p', String(shell.pid)], {
            encoding: 'utf8',
          }).stdout.trim();
          expect(shellState === '' || shellState.startsWith('Z')).toBe(true);
          expect(childState === '' || childState.startsWith('Z')).toBe(true);
        },
        { timeout: 2_000, interval: 50 },
      );
    } finally {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {}
      try {
        process.kill(-shell.pid!, 'SIGKILL');
      } catch {}
    }
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
