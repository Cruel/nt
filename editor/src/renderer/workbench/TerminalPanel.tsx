import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { Button } from '@/components/ui/button';
import type { TerminalSessionSnapshot } from '../../shared/terminal';
import { useTerminalAttentionStore } from './terminal-attention-store';
import {
  attachTerminalSessionView,
  closeWindowTerminalSession,
  createWindowTerminalSession,
  ensureTerminalWindowState,
  fitTerminalSessionView,
  focusTerminalSessionView,
  getTerminalWindowState,
  relaunchWindowTerminalSession,
  selectWindowTerminalSession,
  subscribeTerminalWindowState,
} from './terminal-window-host';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function TerminalPanel() {
  const { t } = useTranslation('workspace');
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalState = useSyncExternalStore(
    subscribeTerminalWindowState,
    getTerminalWindowState,
    getTerminalWindowState,
  );
  const [loading, setLoading] = useState(terminalState === null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const attentionBySession = useTerminalAttentionStore((state) => state.attentionBySession);
  const selectedSession =
    terminalState?.sessions.find((session) => session.id === terminalState.selectedSessionId) ??
    null;
  const selectedSessionId = selectedSession?.id ?? null;

  useEffect(() => {
    if (!terminalState) return;
    const attentionStore = useTerminalAttentionStore.getState();
    attentionStore.setSelectedSessionId(terminalState.selectedSessionId);
    attentionStore.removeSessions(terminalState.sessions.map((session) => session.id));
  }, [terminalState]);

  useEffect(() => {
    let disposed = false;
    void ensureTerminalWindowState()
      .then(() => {
        if (disposed) return;
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
    };
  }, [t]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !selectedSessionId) return;
    const detach = attachTerminalSessionView(selectedSessionId, host);
    const resizeObserver = new ResizeObserver(() => fitTerminalSessionView(selectedSessionId));
    resizeObserver.observe(host);
    return () => {
      resizeObserver.disconnect();
      detach();
    };
  }, [selectedSessionId]);

  async function selectSession(sessionId: string) {
    if (sessionId === terminalState?.selectedSessionId) {
      useTerminalAttentionStore.getState().acknowledgeSelectionChange(sessionId);
      focusTerminalSessionView(sessionId);
      return;
    }
    useTerminalAttentionStore.getState().acknowledgeSelectionChange(sessionId);
    setRequestError(null);
    try {
      await selectWindowTerminalSession(sessionId);
    } catch (error) {
      setRequestError(errorMessage(error, t('terminal.failed')));
    }
  }

  async function createSession() {
    setRequestError(null);
    try {
      const nextState = await createWindowTerminalSession();
      useTerminalAttentionStore.getState().acknowledgeSelectionChange(nextState.selectedSessionId);
    } catch (error) {
      setRequestError(errorMessage(error, t('terminal.failed')));
    }
  }

  async function closeSession(session: TerminalSessionSnapshot) {
    setRequestError(null);
    try {
      let result = await closeWindowTerminalSession(session.id, false);
      if (result.requiresConfirmation) {
        const confirmed = window.confirm(t('terminal.closeRisk', { label: session.label }));
        if (!confirmed) return;
        result = await closeWindowTerminalSession(session.id, true);
      }
      useTerminalAttentionStore
        .getState()
        .removeSessions(result.state.sessions.map((item) => item.id));
    } catch (error) {
      setRequestError(errorMessage(error, t('terminal.failed')));
    }
  }

  async function relaunch() {
    if (!selectedSession) return;
    setLoading(true);
    setRequestError(null);
    try {
      await relaunchWindowTerminalSession(selectedSession.id);
      focusTerminalSessionView(selectedSession.id);
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
      if (selectedSession) {
        await relaunchWindowTerminalSession(selectedSession.id);
        focusTerminalSessionView(selectedSession.id);
      } else {
        await ensureTerminalWindowState();
      }
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
            const attention = attentionBySession[session.id];
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
                  <span>{session.label}</span>
                  {attention ? (
                    <span
                      className={`ml-1 inline-block size-1.5 rounded-full bg-current transition-opacity duration-300 ${attention.state === 'fading' ? 'opacity-0' : 'opacity-100'}`}
                      aria-label={t('terminal.tabNeedsAttention', { label: session.label })}
                      data-terminal-unread-state={attention.state}
                    />
                  ) : session.commandState === 'running' ? (
                    <span
                      className="ml-1 inline-block size-1.5 rounded-full border border-current"
                      aria-label={t('terminal.tabRunning', { label: session.label })}
                      data-terminal-running
                    />
                  ) : null}
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
