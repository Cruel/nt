import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  terminalSessionRequiresCloseConfirmation,
  type TerminalCloseResult,
  type TerminalCommandState,
  type TerminalEvent,
  type TerminalHostSnapshot,
  type TerminalProjectOrigin,
  type TerminalSessionSnapshot,
} from '../../shared/terminal';

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
  label: string;
  sequence: number;
  initialCwd: string;
  lastKnownCwd: string | null;
  createdAt: string;
  originProject: TerminalProjectOrigin | null;
  output: string;
  status: 'running' | 'exited' | 'error';
  commandState: TerminalCommandState;
  error: string | null;
  exitCode: number | null;
  process: TerminalPtyProcess | null;
  disposables: Array<{ dispose(): void }>;
}

export interface TerminalServiceOptions {
  pty: TerminalPtyAdapter;
  resolveProjectRoot(): string | null;
  resolveProjectOrigin(): TerminalProjectOrigin | null;
  resolveFallbackCwd(): Promise<string | null>;
  resolveDefaultProjectDirectory(): string;
  resolveShell(): string;
  env?: NodeJS.ProcessEnv;
  emit(event: TerminalEvent): void;
  sessionId?: () => string;
  now?: () => Date;
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>();
  private selectedSessionId: string | null = null;
  private firstSessionCreation: Promise<TerminalSession> | null = null;
  private nextSequence = 1;
  private lifecycleGeneration = 0;
  private used = false;

  constructor(private readonly options: TerminalServiceOptions) {}

  async ensureState(): Promise<TerminalHostSnapshot> {
    this.used = true;
    if (this.sessions.size === 0) await this.ensureFirstSession();
    return this.snapshotState();
  }

  async createSession(): Promise<TerminalHostSnapshot> {
    this.used = true;
    const session = await this.createNewSession(this.lifecycleGeneration);
    this.selectedSessionId = session.id;
    return this.snapshotState();
  }

  selectSession(sessionId: string): TerminalHostSnapshot {
    this.requireSession(sessionId);
    this.selectedSessionId = sessionId;
    return this.snapshotState();
  }

  async closeSession(sessionId: string, force: boolean): Promise<TerminalCloseResult> {
    const session = this.requireSession(sessionId);
    if (!force && terminalSessionRequiresCloseConfirmation(session)) {
      return { state: this.snapshotState(), requiresConfirmation: true };
    }

    const wasSelected = this.selectedSessionId === sessionId;
    this.disposeSession(session);
    this.sessions.delete(sessionId);

    if (this.sessions.size === 0 && this.used) {
      const replacement = await this.createNewSession(this.lifecycleGeneration);
      this.selectedSessionId = replacement.id;
    } else if (wasSelected) {
      this.selectedSessionId = this.sessions.keys().next().value ?? null;
    }

    return { state: this.snapshotState(), requiresConfirmation: false };
  }

  async relaunchSession(sessionId: string): Promise<TerminalHostSnapshot> {
    const session = this.requireSession(sessionId);
    if (session.status === 'running') return this.snapshotState();
    const cwd = session.lastKnownCwd ?? session.initialCwd;
    this.disposeProcess(session);
    await this.spawnIntoSession(session, cwd);
    this.selectedSessionId = session.id;
    return this.snapshotState();
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

  shutdownRiskCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (terminalSessionRequiresCloseConfirmation(session)) count += 1;
    }
    return count;
  }

  dispose(): void {
    this.lifecycleGeneration += 1;
    this.firstSessionCreation = null;
    for (const session of this.sessions.values()) this.disposeSession(session);
    this.sessions.clear();
    this.selectedSessionId = null;
    this.nextSequence = 1;
    this.used = false;
  }

  private async ensureFirstSession(): Promise<TerminalSession> {
    if (this.sessions.size > 0) return this.requireSession(this.selectedSessionId ?? '');
    if (!this.firstSessionCreation) {
      const generation = this.lifecycleGeneration;
      const creation = this.createNewSession(generation);
      this.firstSessionCreation = creation;
      const clearCreation = () => {
        if (this.firstSessionCreation === creation) this.firstSessionCreation = null;
      };
      void creation.then(clearCreation, clearCreation);
    }
    const session = await this.firstSessionCreation;
    this.selectedSessionId ??= session.id;
    return session;
  }

  private requireSession(sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Terminal session is stale or unknown.');
    return session;
  }

  private async createNewSession(generation: number): Promise<TerminalSession> {
    const sequence = this.nextSequence++;
    const creationContext = await this.resolveNewSessionContext();
    const session: TerminalSession = {
      id: randomSessionId(this.options.sessionId),
      label: `Terminal ${sequence}`,
      sequence,
      initialCwd: creationContext.cwd,
      lastKnownCwd: creationContext.cwd,
      createdAt: (this.options.now?.() ?? new Date()).toISOString(),
      originProject: creationContext.originProject,
      output: '',
      status: 'running',
      commandState: 'unknown',
      error: null,
      exitCode: null,
      process: null,
      disposables: [],
    };
    await this.spawnIntoSession(session, creationContext.cwd);
    if (generation !== this.lifecycleGeneration) {
      this.disposeSession(session);
      throw new Error('Terminal session creation was cancelled.');
    }
    this.sessions.set(session.id, session);
    return session;
  }

  private async resolveNewSessionContext(): Promise<{
    cwd: string;
    originProject: TerminalProjectOrigin | null;
  }> {
    const projectRoot = this.options.resolveProjectRoot();
    if (projectRoot) {
      return {
        cwd: projectRoot,
        originProject: cloneOrigin(this.options.resolveProjectOrigin()),
      };
    }
    const fallback = await this.options.resolveFallbackCwd();
    return {
      cwd: fallback ?? this.options.resolveDefaultProjectDirectory(),
      originProject: null,
    };
  }

  private async spawnIntoSession(session: TerminalSession, cwd: string): Promise<void> {
    session.status = 'running';
    session.commandState = 'unknown';
    session.error = null;
    session.exitCode = null;
    session.lastKnownCwd = cwd;
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
          session.commandState = 'idle';
          session.exitCode = Number.isInteger(exitCode) ? exitCode : null;
          session.process = null;
          this.options.emit({ kind: 'exit', sessionId: session.id, exitCode: session.exitCode });
        }),
      );
    } catch (error) {
      session.status = 'error';
      session.commandState = 'idle';
      session.error = error instanceof Error ? error.message : 'Terminal shell failed to start.';
      session.process = null;
      this.options.emit({ kind: 'error', sessionId: session.id, message: session.error });
    }
  }

  private snapshotState(): TerminalHostSnapshot {
    if (this.sessions.size === 0 || !this.selectedSessionId) {
      throw new Error('Terminal host has no active session.');
    }
    return {
      sessions: [...this.sessions.values()].map(snapshot),
      selectedSessionId: this.selectedSessionId,
    };
  }

  private disposeProcess(session: TerminalSession): void {
    for (const disposable of session.disposables.splice(0)) disposable.dispose();
    try {
      session.process?.kill();
    } catch {
      // PTY/process-tree cleanup is best-effort during close and application teardown.
    }
    session.process = null;
  }

  private disposeSession(session: TerminalSession): void {
    this.disposeProcess(session);
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
    label: session.label,
    sequence: session.sequence,
    status: session.status,
    commandState: session.commandState,
    initialCwd: session.initialCwd,
    lastKnownCwd: session.lastKnownCwd,
    createdAt: session.createdAt,
    originProject: cloneOrigin(session.originProject),
    output: session.output,
    error: session.error,
    exitCode: session.exitCode,
  };
}

function cloneOrigin(origin: TerminalProjectOrigin | null): TerminalProjectOrigin | null {
  return origin ? { id: origin.id, name: origin.name } : null;
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
