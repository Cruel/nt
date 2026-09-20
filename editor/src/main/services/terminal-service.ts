import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  terminalSessionRequiresCloseConfirmation,
  type TerminalAttentionEvent,
  type TerminalCloseResult,
  type TerminalCommandMetadata,
  type TerminalCommandState,
  type TerminalEvent,
  type TerminalHostSnapshot,
  type TerminalProjectOrigin,
  type TerminalSessionSnapshot,
} from '../../shared/terminal';
import { prepareTerminalShell, type PreparedTerminalShell } from './terminal-shell-integration';

export interface TerminalPtyProcess {
  readonly pid: number;
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
    args: string[];
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
  status: 'running' | 'exited' | 'error';
  commandState: TerminalCommandState;
  currentCommandStartedAt: string | null;
  latestCommand: TerminalCommandMetadata | null;
  latestAttention: TerminalAttentionEvent | null;
  parser: TerminalOutputParser | null;
  preparedShell: PreparedTerminalShell | null;
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
  resolveDefaultProjectDirectory(): string | Promise<string>;
  resolveShell(): string;
  env?: NodeJS.ProcessEnv;
  emit(event: TerminalEvent): void;
  terminateProcessTree?: (pid: number) => void;
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

  sessionLabel(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.label ?? null;
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
      status: 'running',
      commandState: 'unknown',
      currentCommandStartedAt: null,
      latestCommand: null,
      latestAttention: null,
      parser: null,
      preparedShell: null,
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
      cwd: fallback ?? (await this.options.resolveDefaultProjectDirectory()),
      originProject: null,
    };
  }

  private async spawnIntoSession(session: TerminalSession, cwd: string): Promise<void> {
    session.status = 'running';
    session.commandState = 'unknown';
    session.currentCommandStartedAt = null;
    session.error = null;
    session.exitCode = null;
    session.lastKnownCwd = cwd;
    try {
      const shell = this.options.resolveShell();
      const preparedShell = prepareTerminalShell(
        shell,
        normalizedEnvironment(this.options.env ?? processEnv()),
      );
      session.preparedShell = preparedShell;
      session.parser = new TerminalOutputParser(preparedShell.integrationExpected, {
        onPrompt: () => this.handlePrompt(session),
        onCommandStart: () => this.handleCommandStart(session),
        onCommandComplete: (exitCode) => this.handleCommandComplete(session, exitCode),
        onCwd: (nextCwd) => this.handleCwd(session, nextCwd),
        onBell: () => this.handleBell(session),
      });
      const process = await this.options.pty.spawn({
        shell,
        cwd,
        env: preparedShell.env,
        args: preparedShell.args,
        columns: 80,
        rows: 24,
      });
      session.process = process;
      session.disposables.push(
        process.onData((data) => {
          const visibleData = session.parser?.push(data) ?? data;
          if (!visibleData) return;
          this.options.emit({ kind: 'output', sessionId: session.id, data: visibleData });
        }),
        process.onExit(({ exitCode }) => {
          session.status = 'exited';
          session.commandState = 'idle';
          session.currentCommandStartedAt = null;
          session.exitCode = Number.isInteger(exitCode) ? exitCode : null;
          session.process = null;
          session.parser = null;
          session.preparedShell?.dispose();
          session.preparedShell = null;
          this.emitMetadata(session);
          this.options.emit({ kind: 'exit', sessionId: session.id, exitCode: session.exitCode });
        }),
      );
    } catch (error) {
      session.preparedShell?.dispose();
      session.preparedShell = null;
      session.parser = null;
      session.status = 'error';
      session.commandState = 'idle';
      session.currentCommandStartedAt = null;
      session.error = error instanceof Error ? error.message : 'Terminal shell failed to start.';
      session.process = null;
      this.emitMetadata(session);
      this.options.emit({ kind: 'error', sessionId: session.id, message: session.error });
    }
  }

  private handlePrompt(session: TerminalSession): void {
    if (session.status !== 'running' || session.commandState === 'running') return;
    session.commandState = 'idle';
    this.emitMetadata(session);
  }

  private handleCommandStart(session: TerminalSession): void {
    if (session.status !== 'running') return;
    session.commandState = 'running';
    session.currentCommandStartedAt = this.nowIso();
    this.emitMetadata(session);
  }

  private handleCommandComplete(session: TerminalSession, exitCode: number | null): void {
    if (session.status !== 'running') return;
    const completedAt = this.options.now?.() ?? new Date();
    const startedAt = session.currentCommandStartedAt;
    session.commandState = 'idle';
    session.currentCommandStartedAt = null;
    if (startedAt) {
      const durationMs = Math.max(0, completedAt.getTime() - new Date(startedAt).getTime());
      session.latestCommand = {
        startedAt,
        completedAt: completedAt.toISOString(),
        durationMs,
        exitCode,
      };
      if (durationMs >= 3_000) {
        this.emitAttention(session, 'command-completed', completedAt.toISOString());
      }
    }
    this.emitMetadata(session);
  }

  private handleCwd(session: TerminalSession, cwd: string): void {
    if (session.status !== 'running') return;
    session.lastKnownCwd = cwd;
    this.emitMetadata(session);
  }

  private handleBell(session: TerminalSession): void {
    if (session.status !== 'running') return;
    this.emitAttention(session, 'bell', this.nowIso());
  }

  private emitAttention(
    session: TerminalSession,
    kind: TerminalAttentionEvent['kind'],
    occurredAt: string,
  ): void {
    const attention = { kind, occurredAt } satisfies TerminalAttentionEvent;
    session.latestAttention = attention;
    this.options.emit({ kind: 'attention', sessionId: session.id, attention: { ...attention } });
  }

  private emitMetadata(session: TerminalSession): void {
    this.options.emit({
      kind: 'metadata',
      sessionId: session.id,
      commandState: session.commandState,
      currentCommandStartedAt: session.currentCommandStartedAt,
      latestCommand: session.latestCommand ? { ...session.latestCommand } : null,
      lastKnownCwd: session.lastKnownCwd,
    });
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
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
    const terminalProcess = session.process;
    if (terminalProcess) {
      try {
        (this.options.terminateProcessTree ?? terminateTerminalProcessTree)(terminalProcess.pid);
      } catch {
        // Explicit descendant cleanup is best-effort before node-pty closes the PTY itself.
      }
      try {
        terminalProcess.kill();
      } catch {
        // PTY cleanup is best-effort during close and application teardown.
      }
    }
    session.process = null;
    session.parser = null;
    session.preparedShell?.dispose();
    session.preparedShell = null;
  }

  private disposeSession(session: TerminalSession): void {
    this.disposeProcess(session);
  }
}

interface TerminalOutputParserCallbacks {
  onPrompt(): void;
  onCommandStart(): void;
  onCommandComplete(exitCode: number | null): void;
  onCwd(cwd: string): void;
  onBell(): void;
}

class TerminalOutputParser {
  private pending = '';

  constructor(
    private readonly integrationExpected: boolean,
    private readonly callbacks: TerminalOutputParserCallbacks,
  ) {}

  push(data: string): string {
    const input = this.pending + data;
    this.pending = '';
    let output = '';
    let index = 0;
    while (index < input.length) {
      const oscStart = input.indexOf('\u001b]', index);
      const bell = input.indexOf('\u0007', index);
      if (bell !== -1 && (oscStart === -1 || bell < oscStart)) {
        output += input.slice(index, bell + 1);
        this.callbacks.onBell();
        index = bell + 1;
        continue;
      }
      if (oscStart === -1) {
        const remainder = input.slice(index);
        if (this.integrationExpected && remainder.endsWith('\u001b')) {
          output += remainder.slice(0, -1);
          this.pending = '\u001b';
        } else {
          output += remainder;
        }
        break;
      }
      output += input.slice(index, oscStart);
      const terminator = findOscTerminator(input, oscStart + 2);
      if (!terminator) {
        this.pending = input.slice(oscStart);
        if (this.pending.length > 8_192) {
          output += this.pending;
          this.pending = '';
        }
        break;
      }
      const content = input.slice(oscStart + 2, terminator.contentEnd);
      if (!this.handleOsc(content)) {
        output += input.slice(oscStart, terminator.sequenceEnd);
      }
      index = terminator.sequenceEnd;
    }
    return output;
  }

  private handleOsc(content: string): boolean {
    if (!this.integrationExpected) return false;
    if (content === '633;A') {
      this.callbacks.onPrompt();
      return true;
    }
    if (content === '633;C') {
      this.callbacks.onCommandStart();
      return true;
    }
    if (content.startsWith('633;D')) {
      const rawExitCode = content.split(';')[2];
      const parsedExitCode =
        rawExitCode === undefined || rawExitCode === '' ? null : Number(rawExitCode);
      this.callbacks.onCommandComplete(Number.isInteger(parsedExitCode) ? parsedExitCode : null);
      return true;
    }
    if (content.startsWith('7;')) {
      const cwd = cwdFromOsc7(content.slice(2));
      if (cwd) this.callbacks.onCwd(cwd);
      return true;
    }
    return false;
  }
}

function findOscTerminator(
  value: string,
  start: number,
): { contentEnd: number; sequenceEnd: number } | null {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === '\u0007') return { contentEnd: index, sequenceEnd: index + 1 };
    if (value[index] === '\u001b' && value[index + 1] === '\\') {
      return { contentEnd: index, sequenceEnd: index + 2 };
    }
  }
  return null;
}

function cwdFromOsc7(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return null;
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//u.test(pathname)) pathname = pathname.slice(1);
    return pathname || null;
  } catch {
    return null;
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
      return nodePty.spawn(options.shell, options.args, {
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
    currentCommandStartedAt: session.currentCommandStartedAt,
    latestCommand: session.latestCommand ? { ...session.latestCommand } : null,
    latestAttention: session.latestAttention ? { ...session.latestAttention } : null,
    initialCwd: session.initialCwd,
    lastKnownCwd: session.lastKnownCwd,
    createdAt: session.createdAt,
    originProject: cloneOrigin(session.originProject),
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

export function terminateTerminalProcessTree(pid: number, platform = process.platform): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }

  const listing = spawnSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' });
  if (listing.status === 0 && typeof listing.stdout === 'string') {
    const childrenByParent = new Map<number, number[]>();
    for (const line of listing.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
      if (!match) continue;
      const childPid = Number(match[1]);
      const parentPid = Number(match[2]);
      const children = childrenByParent.get(parentPid) ?? [];
      children.push(childPid);
      childrenByParent.set(parentPid, children);
    }
    const descendants: number[] = [];
    const visit = (parentPid: number) => {
      for (const childPid of childrenByParent.get(parentPid) ?? []) {
        visit(childPid);
        descendants.push(childPid);
      }
    };
    visit(pid);
    for (const descendantPid of descendants) {
      try {
        process.kill(descendantPid, 'SIGTERM');
      } catch {
        // Descendants may exit concurrently while the tree is being traversed.
      }
    }
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // forkpty normally creates a process group, but explicit descendants above are the fallback.
  }
}

function randomSessionId(factory?: () => string): string {
  return factory?.() ?? randomUUID();
}

function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}
