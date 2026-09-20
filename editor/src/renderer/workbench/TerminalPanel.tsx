import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { Plus, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { Button } from '@/components/ui/button';
import { usePreferencesStore } from '@/stores/preferences-store';
import type { TerminalHostSnapshot, TerminalSessionSnapshot } from '../../shared/terminal';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function TerminalPanel() {
  const { t } = useTranslation('workspace');
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const macOSRef = useRef(/^Mac/u.test(navigator.platform));
  const terminalPreferences = usePreferencesStore((state) => state.terminal);
  const [terminalState, setTerminalState] = useState<TerminalHostSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);

  const selectedSession = useMemo(
    () =>
      terminalState?.sessions.find((session) => session.id === terminalState.selectedSessionId) ??
      null,
    [terminalState],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const key = event.key.toLowerCase();
      if (macOSRef.current && event.metaKey && key === 'c') {
        event.preventDefault();
        if (terminal.hasSelection()) void navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }
      if (macOSRef.current && event.metaKey && key === 'v') {
        event.preventDefault();
        void navigator.clipboard.readText().then((text) => terminal.paste(text));
        return false;
      }
      if (!macOSRef.current && event.ctrlKey && key === 'c' && terminal.hasSelection()) {
        event.preventDefault();
        void navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }
      return true;
    });
    void window.noveltea.getAppInfo().then((info) => {
      macOSRef.current = info.platform === 'darwin';
    });

    let disposed = false;
    let lastColumns = 0;
    let lastRows = 0;
    const fitAndResize = () => {
      if (disposed || !sessionIdRef.current) return;
      fitAddon.fit();
      if (terminal.cols === lastColumns && terminal.rows === lastRows) return;
      lastColumns = terminal.cols;
      lastRows = terminal.rows;
      void window.noveltea.resizeTerminal({
        sessionId: sessionIdRef.current,
        columns: terminal.cols,
        rows: terminal.rows,
      });
    };

    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(host);
    const dataSubscription = terminal.onData((data) => {
      const sessionId = sessionIdRef.current;
      if (sessionId) void window.noveltea.writeTerminal(sessionId, data);
    });
    const removeTerminalListener = window.noveltea.onTerminalEvent((event) => {
      if (event.sessionId === sessionIdRef.current && event.kind === 'output') {
        terminal.write(event.data);
      }
      if (event.kind === 'output') return;
      setTerminalState((current) => {
        if (!current) return current;
        return {
          ...current,
          sessions: current.sessions.map((session) => {
            if (session.id !== event.sessionId) return session;
            if (event.kind === 'exit') {
              return {
                ...session,
                status: 'exited',
                commandState: 'idle',
                exitCode: event.exitCode,
              };
            }
            return { ...session, status: 'error', commandState: 'idle', error: event.message };
          }),
        };
      });
    });

    void window.noveltea
      .ensureTerminalState()
      .then((snapshot) => {
        if (disposed) return;
        setTerminalState(snapshot);
        setRequestError(null);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setRequestError(errorMessage(error, t('terminal.failed')));
        setLoading(false);
      });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      dataSubscription.dispose();
      removeTerminalListener();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      sessionIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    const sessionId = sessionIdRef.current;
    if (!terminal || !sessionId) return;
    terminal.options.fontFamily = terminalPreferences.fontFamily;
    terminal.options.fontSize = terminalPreferences.fontSize;
    terminal.options.scrollback = terminalPreferences.scrollback;
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      void window.noveltea.resizeTerminal({
        sessionId,
        columns: terminal.cols,
        rows: terminal.rows,
      });
    });
  }, [
    terminalPreferences.fontFamily,
    terminalPreferences.fontSize,
    terminalPreferences.scrollback,
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !selectedSession) return;
    sessionIdRef.current = selectedSession.id;
    terminal.reset();
    if (selectedSession.output) terminal.write(selectedSession.output);
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      void window.noveltea.resizeTerminal({
        sessionId: selectedSession.id,
        columns: terminal.cols,
        rows: terminal.rows,
      });
      terminal.focus();
    });
  }, [selectedSession?.id]);

  async function selectSession(sessionId: string) {
    if (sessionId === terminalState?.selectedSessionId) {
      terminalRef.current?.focus();
      return;
    }
    setRequestError(null);
    try {
      setTerminalState(await window.noveltea.selectTerminalSession(sessionId));
    } catch (error) {
      setRequestError(errorMessage(error, t('terminal.failed')));
    }
  }

  async function createSession() {
    setRequestError(null);
    try {
      setTerminalState(await window.noveltea.createTerminalSession());
    } catch (error) {
      setRequestError(errorMessage(error, t('terminal.failed')));
    }
  }

  async function closeSession(session: TerminalSessionSnapshot) {
    setRequestError(null);
    try {
      let result = await window.noveltea.closeTerminalSession({
        sessionId: session.id,
        force: false,
      });
      if (result.requiresConfirmation) {
        const confirmed = window.confirm(t('terminal.closeRisk', { label: session.label }));
        if (!confirmed) return;
        result = await window.noveltea.closeTerminalSession({ sessionId: session.id, force: true });
      }
      setTerminalState(result.state);
    } catch (error) {
      setRequestError(errorMessage(error, t('terminal.failed')));
    }
  }

  async function relaunch() {
    if (!selectedSession) return;
    setLoading(true);
    setRequestError(null);
    try {
      setTerminalState(await window.noveltea.relaunchTerminalSession(selectedSession.id));
      terminalRef.current?.focus();
    } catch (error) {
      setRequestError(errorMessage(error, t('terminal.failed')));
    } finally {
      setLoading(false);
    }
  }

  async function retryFailure() {
    setLoading(true);
    setRequestError(null);
    try {
      const nextState = selectedSession
        ? await window.noveltea.relaunchTerminalSession(selectedSession.id)
        : await window.noveltea.ensureTerminalState();
      setTerminalState(nextState);
      terminalRef.current?.focus();
    } catch (error) {
      setRequestError(errorMessage(error, t('terminal.failed')));
    } finally {
      setLoading(false);
    }
  }

  const failure =
    requestError ?? (selectedSession?.status === 'error' ? selectedSession.error : null);

  return (
    <div className="flex h-full min-h-[180px] flex-col bg-background" data-terminal-panel>
      <div
        className="flex h-9 shrink-0 items-center gap-1 border-b px-1"
        data-terminal-tabs
        role="tablist"
        aria-label={t('bottomPanel.labels.terminal')}
      >
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {terminalState?.sessions.map((session) => {
            const selected = session.id === terminalState.selectedSessionId;
            return (
              <div
                key={session.id}
                className={
                  selected
                    ? 'flex h-7 shrink-0 items-center rounded-sm bg-muted text-foreground'
                    : 'flex h-7 shrink-0 items-center rounded-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }
                data-terminal-tab={session.id}
                data-selected={selected ? 'true' : 'false'}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="h-full px-2 text-xs"
                  onClick={() => void selectSession(session.id)}
                >
                  {session.label}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mr-0.5 size-6"
                  aria-label={t('terminal.close', { label: session.label })}
                  onClick={() => void closeSession(session)}
                >
                  <X className="size-3" />
                </Button>
              </div>
            );
          })}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={t('terminal.new')}
          onClick={() => void createSession()}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full w-full p-2" data-terminal-viewport />
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 text-xs text-muted-foreground">
            {t('terminal.starting')}
          </div>
        ) : null}
        {failure ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/95 p-6">
            <div className="max-w-xl rounded border bg-card p-4 text-sm shadow-sm">
              <div className="font-medium">{t('terminal.failed')}</div>
              <p className="mt-1 break-words text-xs text-muted-foreground">{failure}</p>
              <Button className="mt-3" size="sm" onClick={() => void retryFailure()}>
                {t('terminal.retry')}
              </Button>
            </div>
          </div>
        ) : null}
        {selectedSession?.status === 'exited' ? (
          <div className="absolute bottom-2 right-3 flex items-center gap-2 rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
            <span>
              {selectedSession.exitCode === null
                ? t('terminal.exited')
                : t('terminal.exitedWithCode', { code: selectedSession.exitCode })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => void relaunch()}
            >
              {t('terminal.relaunch')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
