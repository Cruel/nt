import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TerminalEvent, TerminalSessionSnapshot } from '../../shared/terminal';

const MAX_BUFFER_CHARS = 1_000_000;

export interface TerminalPtyProcess {
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface TerminalPtyAdapter {
  spawn(options: {
    shell: string;
    cwd: string;
    env: Record<string, string>;
    columns: number;
    rows: number;
  }): TerminalPtyProcess | Promise<TerminalPtyProcess>;
}

interface TerminalSession {
  id: string;
  initialCwd: string;
  output: string;
  status: 'running' | 'exited' | 'error';
  error: string | null;
  exitCode: number | null;
  process: TerminalPtyProcess | null;
  disposables: Array<{ dispose(): void }>;
}

export interface TerminalServiceOptions {
  pty: TerminalPtyAdapter;
  resolveProjectRoot(): string | null;
  resolveFallbackCwd(): Promise<string | null>;
  resolveDefaultProjectDirectory(): string;
  resolveShell(): string;
  env?: NodeJS.ProcessEnv;
  emit(event: TerminalEvent): void;
  sessionId?: () => string;
}

export class TerminalService {
  private session: TerminalSession | null = null;
  private sessionCreation: Promise<TerminalSession> | null = null;
  private lifecycleGeneration = 0;

  constructor(private readonly options: TerminalServiceOptions) {}

  async ensureSession(): Promise<TerminalSessionSnapshot> {
    if (this.session) return snapshot(this.session);
    if (!this.sessionCreation) {
      const generation = this.lifecycleGeneration;
      const creation = this.createSession(generation);
      this.sessionCreation = creation;
      const clearCreation = () => {
        if (this.sessionCreation === creation) this.sessionCreation = null;
      };
      void creation.then(clearCreation, clearCreation);
    }
    return snapshot(await this.sessionCreation);
  }

  async retrySession(): Promise<TerminalSessionSnapshot> {
    if (this.session?.status === 'running') return snapshot(this.session);
    const cwd = this.session?.initialCwd ?? (await this.resolveNewSessionCwd());
    this.disposeSession(this.session);
    this.session = await this.spawnSession(randomSessionId(this.options.sessionId), cwd);
    return snapshot(this.session);
  }

  write(sessionId: string, data: string): void {
    const session = this.requireSession(sessionId);
    if (!session.process || session.status !== 'running') {
      throw new Error('Terminal session is not running.');
    }
    session.process.write(data);
  }

  resize(sessionId: string, columns: number, rows: number): void {
    const session = this.requireSession(sessionId);
    if (!session.process || session.status !== 'running') return;
    session.process.resize(columns, rows);
  }

  dispose(): void {
    this.lifecycleGeneration += 1;
    this.sessionCreation = null;
    this.disposeSession(this.session);
    this.session = null;
  }

  private requireSession(sessionId: string): TerminalSession {
    if (!this.session || this.session.id !== sessionId) {
      throw new Error('Terminal session is stale or unknown.');
    }
    return this.session;
  }

  private async createSession(generation: number): Promise<TerminalSession> {
    const cwd = await this.resolveNewSessionCwd();
    const session = await this.spawnSession(randomSessionId(this.options.sessionId), cwd);
    if (generation !== this.lifecycleGeneration) {
      this.disposeSession(session);
      throw new Error('Terminal session creation was cancelled.');
    }
    this.session = session;
    return session;
  }

  private async resolveNewSessionCwd(): Promise<string> {
    const projectRoot = this.options.resolveProjectRoot();
    if (projectRoot) return projectRoot;
    const fallback = await this.options.resolveFallbackCwd();
    return fallback ?? this.options.resolveDefaultProjectDirectory();
  }

  private async spawnSession(id: string, cwd: string): Promise<TerminalSession> {
    const session: TerminalSession = {
      id,
      initialCwd: cwd,
      output: '',
      status: 'running',
      error: null,
      exitCode: null,
      process: null,
      disposables: [],
    };
    try {
      const process = await this.options.pty.spawn({
        shell: this.options.resolveShell(),
        cwd,
        env: normalizedEnvironment(this.options.env ?? processEnv()),
        columns: 80,
        rows: 24,
      });
      session.process = process;
      session.disposables.push(
        process.onData((data) => {
          session.output = appendBuffer(session.output, data);
          this.options.emit({ kind: 'output', sessionId: session.id, data });
        }),
        process.onExit(({ exitCode }) => {
          session.status = 'exited';
          session.exitCode = Number.isInteger(exitCode) ? exitCode : null;
          session.process = null;
          this.options.emit({ kind: 'exit', sessionId: session.id, exitCode: session.exitCode });
        }),
      );
    } catch (error) {
      session.status = 'error';
      session.error = error instanceof Error ? error.message : 'Terminal shell failed to start.';
      session.process = null;
      this.options.emit({ kind: 'error', sessionId: session.id, message: session.error });
    }
    return session;
  }

  private disposeSession(session: TerminalSession | null): void {
    if (!session) return;
    for (const disposable of session.disposables.splice(0)) disposable.dispose();
    try {
      session.process?.kill();
    } catch {
      // Window teardown is best-effort; later lifecycle work owns richer shutdown policy.
    }
    session.process = null;
  }
}

export function resolveDefaultTerminalShell(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  if (platform === 'win32') {
    for (const directory of (env.PATH ?? '').split(path.win32.delimiter).filter(Boolean)) {
      const candidate = path.win32.join(directory, 'pwsh.exe');
      if (exists(candidate)) return candidate;
    }
    const systemRoot = env.SystemRoot ?? env.WINDIR;
    if (systemRoot) {
      const candidate = path.win32.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      if (exists(candidate)) return candidate;
    }
    return 'powershell.exe';
  }

  if (env.SHELL && path.isAbsolute(env.SHELL) && exists(env.SHELL)) return env.SHELL;
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (exists(candidate)) return candidate;
  }
  return 'sh';
}

export function createNodePtyAdapter(): TerminalPtyAdapter {
  return {
    async spawn(options) {
      const nodePty = await import('node-pty');
      return nodePty.spawn(options.shell, [], {
        cwd: options.cwd,
        env: options.env,
        cols: options.columns,
        rows: options.rows,
        name: 'xterm-256color',
      });
    },
  };
}

function snapshot(session: TerminalSession): TerminalSessionSnapshot {
  return {
    id: session.id,
    status: session.status,
    initialCwd: session.initialCwd,
    output: session.output,
    error: session.error,
    exitCode: session.exitCode,
  };
}

function normalizedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function appendBuffer(existing: string, data: string): string {
  const combined = existing + data;
  return combined.length > MAX_BUFFER_CHARS ? combined.slice(-MAX_BUFFER_CHARS) : combined;
}

function randomSessionId(factory?: () => string): string {
  return factory?.() ?? randomUUID();
}

function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}
