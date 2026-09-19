import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Button } from '@/components/ui/button';
import type { TerminalSessionSnapshot } from '../../shared/terminal';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Terminal could not be started.';
}

export function TerminalPanel() {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [session, setSession] = useState<TerminalSessionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 13,
      scrollback: 10_000,
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
      if (event.sessionId !== sessionIdRef.current) return;
      if (event.kind === 'output') {
        terminal.write(event.data);
        return;
      }
      setSession((current) => {
        if (!current || current.id !== event.sessionId) return current;
        if (event.kind === 'exit') {
          return { ...current, status: 'exited', exitCode: event.exitCode };
        }
        return { ...current, status: 'error', error: event.message };
      });
    });

    void window.noveltea
      .ensureTerminalSession()
      .then((snapshot) => {
        if (disposed) return;
        sessionIdRef.current = snapshot.id;
        setSession(snapshot);
        setRequestError(null);
        setLoading(false);
        if (snapshot.output) terminal.write(snapshot.output);
        requestAnimationFrame(() => {
          fitAndResize();
          terminal.focus();
        });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setRequestError(errorMessage(error));
        setLoading(false);
      });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      dataSubscription.dispose();
      removeTerminalListener();
      terminal.dispose();
      terminalRef.current = null;
      sessionIdRef.current = null;
    };
  }, []);

  async function retry() {
    setLoading(true);
    setRequestError(null);
    try {
      const snapshot = await window.noveltea.retryTerminalSession();
      sessionIdRef.current = snapshot.id;
      setSession(snapshot);
      terminalRef.current?.reset();
      if (snapshot.output) terminalRef.current?.write(snapshot.output);
      terminalRef.current?.focus();
    } catch (error) {
      setRequestError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  const failure = requestError ?? (session?.status === 'error' ? session.error : null);

  return (
    <div className="relative h-full min-h-[180px] bg-background" data-terminal-panel>
      <div ref={hostRef} className="h-full min-h-[180px] w-full p-2" data-terminal-viewport />
      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 text-xs text-muted-foreground">
          Starting terminal…
        </div>
      ) : null}
      {failure ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/95 p-6">
          <div className="max-w-xl rounded border bg-card p-4 text-sm shadow-sm">
            <div className="font-medium">Terminal failed to start</div>
            <p className="mt-1 break-words text-xs text-muted-foreground">{failure}</p>
            <Button className="mt-3" size="sm" onClick={() => void retry()}>
              Retry
            </Button>
          </div>
        </div>
      ) : null}
      {session?.status === 'exited' ? (
        <div className="pointer-events-none absolute bottom-2 right-3 rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
          Terminal exited{session.exitCode === null ? '' : ` (${session.exitCode})`}
        </div>
      ) : null}
    </div>
  );
}
