import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { usePreferencesStore } from '@/stores/preferences-store';
import type {
  TerminalCloseResult,
  TerminalEvent,
  TerminalHostSnapshot,
  TerminalSessionSnapshot,
} from '../../shared/terminal';

interface TerminalView {
  readonly sessionId: string;
  readonly container: HTMLDivElement;
  readonly terminal: Terminal;
  readonly fitAddon: FitAddon;
  readonly disposeInput: { dispose(): void };
  lastColumns: number;
  lastRows: number;
}

let state: TerminalHostSnapshot | null = null;
let initialization: Promise<TerminalHostSnapshot> | null = null;
let removeTerminalListener: (() => void) | null = null;
let removePreferencesListener: (() => void) | null = null;
let platformInitialized = false;
let macOS = navigator.platform.startsWith('Mac');
const listeners = new Set<() => void>();
const views = new Map<string, TerminalView>();
const pendingOutput = new Map<string, string[]>();

export function subscribeTerminalWindowState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTerminalWindowState(): TerminalHostSnapshot | null {
  return state;
}

export async function ensureTerminalWindowState(): Promise<TerminalHostSnapshot> {
  ensureRuntime();
  if (state) return state;
  if (!initialization) {
    const request = window.noveltea.ensureTerminalState().then((snapshot) => {
      applySnapshot(snapshot);
      return snapshot;
    });
    initialization = request;
    const clearInitialization = () => {
      if (initialization === request) initialization = null;
    };
    void request.then(clearInitialization, clearInitialization);
  }
  return initialization;
}

export async function createWindowTerminalSession(): Promise<TerminalHostSnapshot> {
  ensureRuntime();
  const snapshot = await window.noveltea.createTerminalSession();
  applySnapshot(snapshot);
  return snapshot;
}

export async function selectWindowTerminalSession(
  sessionId: string,
): Promise<TerminalHostSnapshot> {
  await ensureTerminalWindowState();
  const snapshot = await window.noveltea.selectTerminalSession(sessionId);
  applySnapshot(snapshot);
  return snapshot;
}

export async function closeWindowTerminalSession(
  sessionId: string,
  force: boolean,
): Promise<TerminalCloseResult> {
  ensureRuntime();
  const result = await window.noveltea.closeTerminalSession({ sessionId, force });
  applySnapshot(result.state);
  return result;
}

export async function relaunchWindowTerminalSession(
  sessionId: string,
): Promise<TerminalHostSnapshot> {
  ensureRuntime();
  const snapshot = await window.noveltea.relaunchTerminalSession(sessionId);
  applySnapshot(snapshot);
  return snapshot;
}

export function attachTerminalSessionView(sessionId: string, host: HTMLElement): () => void {
  ensureRuntime();
  const view = requireView(sessionId);
  host.replaceChildren(view.container);
  fitAndResize(view);
  view.terminal.focus();
  return () => {
    if (view.container.parentElement === host) view.container.remove();
  };
}

export function fitTerminalSessionView(sessionId: string): void {
  const view = views.get(sessionId);
  if (view?.container.isConnected) fitAndResize(view);
}

export function focusTerminalSessionView(sessionId: string): void {
  views.get(sessionId)?.terminal.focus();
}

function ensureRuntime(): void {
  if (!removeTerminalListener)
    removeTerminalListener = window.noveltea.onTerminalEvent(handleEvent);
  if (!removePreferencesListener) {
    removePreferencesListener = usePreferencesStore.subscribe((next, previous) => {
      if (next.terminal === previous.terminal) return;
      for (const view of views.values()) applyPreferences(view);
    });
  }
  if (!platformInitialized) {
    platformInitialized = true;
    void window.noveltea.getAppInfo().then((info) => {
      macOS = info.platform === 'darwin';
    });
  }
}

function handleEvent(event: TerminalEvent): void {
  if (event.kind === 'output') {
    const view = views.get(event.sessionId);
    if (view) {
      view.terminal.write(event.data);
    } else {
      const chunks = pendingOutput.get(event.sessionId) ?? [];
      chunks.push(event.data);
      pendingOutput.set(event.sessionId, chunks);
    }
    return;
  }
  if (!state) return;
  let changed = false;
  const sessions = state.sessions.map((session) => {
    if (session.id !== event.sessionId) return session;
    changed = true;
    return updateSessionFromEvent(session, event);
  });
  if (changed) setState({ ...state, sessions });
}

function updateSessionFromEvent(
  session: TerminalSessionSnapshot,
  event: Exclude<TerminalEvent, { kind: 'output' }>,
): TerminalSessionSnapshot {
  if (event.kind === 'attention') return { ...session, latestAttention: event.attention };
  if (event.kind === 'metadata') {
    return {
      ...session,
      commandState: event.commandState,
      currentCommandStartedAt: event.currentCommandStartedAt,
      latestCommand: event.latestCommand,
      lastKnownCwd: event.lastKnownCwd,
    };
  }
  if (event.kind === 'exit') {
    return {
      ...session,
      status: 'exited',
      commandState: 'idle',
      currentCommandStartedAt: null,
      exitCode: event.exitCode,
    };
  }
  return {
    ...session,
    status: 'error',
    commandState: 'idle',
    currentCommandStartedAt: null,
    error: event.message,
  };
}

function applySnapshot(snapshot: TerminalHostSnapshot): void {
  const liveIds = new Set(snapshot.sessions.map((session) => session.id));
  for (const session of snapshot.sessions) ensureView(session.id);
  for (const [sessionId, view] of views) {
    if (liveIds.has(sessionId)) continue;
    view.disposeInput.dispose();
    view.terminal.dispose();
    view.container.remove();
    views.delete(sessionId);
    pendingOutput.delete(sessionId);
  }
  setState(snapshot);
}

function ensureView(sessionId: string): TerminalView {
  const existing = views.get(sessionId);
  if (existing) return existing;
  const preferences = usePreferencesStore.getState().terminal;
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: preferences.fontFamily,
    fontSize: preferences.fontSize,
    scrollback: preferences.scrollback,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault();
      void window.noveltea.openExternal(uri);
    }),
  );
  const container = document.createElement('div');
  container.className = 'h-full w-full';
  terminal.open(container);
  terminal.attachCustomKeyEventHandler((event) => handleKeyEvent(terminal, event));
  const disposeInput = terminal.onData((data) => {
    void window.noveltea.writeTerminal(sessionId, data);
  });
  const view: TerminalView = {
    sessionId,
    container,
    terminal,
    fitAddon,
    disposeInput,
    lastColumns: 0,
    lastRows: 0,
  };
  views.set(sessionId, view);
  for (const chunk of pendingOutput.get(sessionId) ?? []) terminal.write(chunk);
  pendingOutput.delete(sessionId);
  return view;
}

function handleKeyEvent(terminal: Terminal, event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return true;
  const key = event.key.toLowerCase();
  if (macOS && event.metaKey && key === 'c') {
    event.preventDefault();
    if (terminal.hasSelection()) void navigator.clipboard.writeText(terminal.getSelection());
    return false;
  }
  if (macOS && event.metaKey && key === 'v') {
    event.preventDefault();
    void navigator.clipboard.readText().then((text) => terminal.paste(text));
    return false;
  }
  if (!macOS && event.ctrlKey && key === 'c' && terminal.hasSelection()) {
    event.preventDefault();
    void navigator.clipboard.writeText(terminal.getSelection());
    return false;
  }
  return true;
}

function applyPreferences(view: TerminalView): void {
  const preferences = usePreferencesStore.getState().terminal;
  view.terminal.options.fontFamily = preferences.fontFamily;
  view.terminal.options.fontSize = preferences.fontSize;
  view.terminal.options.scrollback = preferences.scrollback;
  if (view.container.isConnected) fitAndResize(view);
}

function fitAndResize(view: TerminalView): void {
  view.fitAddon.fit();
  const columns = view.terminal.cols;
  const rows = view.terminal.rows;
  if (columns === view.lastColumns && rows === view.lastRows) return;
  view.lastColumns = columns;
  view.lastRows = rows;
  void window.noveltea.resizeTerminal({ sessionId: view.sessionId, columns, rows });
}

function requireView(sessionId: string): TerminalView {
  return views.get(sessionId) ?? ensureView(sessionId);
}

function setState(next: TerminalHostSnapshot): void {
  state = next;
  for (const listener of listeners) listener();
}

export function resetTerminalWindowHostForTests(): void {
  removeTerminalListener?.();
  removeTerminalListener = null;
  removePreferencesListener?.();
  removePreferencesListener = null;
  initialization = null;
  state = null;
  platformInitialized = false;
  macOS = navigator.platform.startsWith('Mac');
  listeners.clear();
  pendingOutput.clear();
  for (const view of views.values()) {
    view.disposeInput.dispose();
    view.terminal.dispose();
    view.container.remove();
  }
  views.clear();
}
