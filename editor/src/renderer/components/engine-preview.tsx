import { useCallback, useEffect } from 'react';
import { MousePointer2, Play, RefreshCw, RotateCcw, StepForward } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEnginePreview } from '@/hooks/use-engine-preview';
import { PRIMARY_PREVIEW_SESSION_ID } from '@/preview/preview-manager';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import type { PreviewPosition, PreviewToEditorMessage } from '../../shared/preview-protocol';

const BUILD_COMMAND = 'pnpm engine:preview:build';

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function EnginePreview() {
  const ensurePrimaryRuntimeSession = usePreviewManagerStore((s) => s.ensurePrimaryRuntimeSession);
  const setSessionStatus = usePreviewManagerStore((s) => s.setSessionStatus);
  const setSessionCapabilities = usePreviewManagerStore((s) => s.setSessionCapabilities);
  const setPrimaryTransport = usePreviewManagerStore((s) => s.setPrimaryTransport);
  const setPrimaryRuntimeReplay = usePreviewManagerStore((s) => s.setPrimaryRuntimeReplay);
  const recordPreviewDiagnostic = usePreviewManagerStore((s) => s.recordPreviewDiagnostic);
  const previewPosition = useWorkspaceStore((s) => s.previewPosition);
  const connectionState = useWorkspaceStore((s) => s.previewConnectionState);
  const setPreviewPosition = useWorkspaceStore((s) => s.setPreviewPosition);
  const setPreviewRunning = useWorkspaceStore((s) => s.setPreviewRunning);
  const setConnectionState = useWorkspaceStore((s) => s.setPreviewConnectionState);
  const setSelectedRuntimeObjectId = useWorkspaceStore((s) => s.setSelectedRuntimeObjectId);
  const setLastPreviewEvent = useWorkspaceStore((s) => s.setLastPreviewEvent);
  const setStatusMessage = useWorkspaceStore((s) => s.setStatusMessage);

  const recordTransportError = useCallback((message: string) => {
    setConnectionState('error');
    setSessionStatus(PRIMARY_PREVIEW_SESSION_ID, 'error');
    recordPreviewDiagnostic({ sessionId: PRIMARY_PREVIEW_SESSION_ID, severity: 'error', source: 'transport', message });
    setStatusMessage(message);
  }, [recordPreviewDiagnostic, setConnectionState, setSessionStatus, setStatusMessage]);

  const handlePreviewMessage = useCallback((message: PreviewToEditorMessage) => {
    setLastPreviewEvent(message);
    if (message.type === 'ready' || message.type === 'capabilities') {
      setSessionCapabilities(PRIMARY_PREVIEW_SESSION_ID, message.capabilities);
    }
    if (message.type === 'preview-diagnostic') {
      recordPreviewDiagnostic({
        sessionId: PRIMARY_PREVIEW_SESSION_ID,
        severity: message.diagnostic.severity,
        source: 'runtime',
        message: message.diagnostic.message,
        path: message.diagnostic.path,
        target: message.diagnostic.target,
      });
    }
    if (message.type === 'object-clicked' && message.objectId === 'demo-triangle') {
      setSelectedRuntimeObjectId(message.objectId);
      setStatusMessage('Selected demo-triangle from engine preview');
    } else if (message.type === 'runtime-error') {
      setConnectionState('error');
      setSessionStatus(PRIMARY_PREVIEW_SESSION_ID, 'error');
      recordPreviewDiagnostic({ sessionId: PRIMARY_PREVIEW_SESSION_ID, severity: 'error', source: 'runtime', message: message.message });
      setStatusMessage(message.message);
    }
  }, [recordPreviewDiagnostic, setConnectionState, setLastPreviewEvent, setSelectedRuntimeObjectId, setSessionCapabilities, setSessionStatus, setStatusMessage]);

  const controller = useEnginePreview({
    onReady: () => {
      setConnectionState('ready');
      setSessionStatus(PRIMARY_PREVIEW_SESSION_ID, 'ready');
      setStatusMessage('Engine preview ready');
      const replay = usePreviewManagerStore.getState().replay.primaryRuntime;
      void controller.setPosition(replay.position).catch(() => undefined);
      void (replay.running ? controller.play() : controller.stop()).catch(() => undefined);
    },
    onMessage: handlePreviewMessage,
    onError: recordTransportError,
  });
  const {
    iframeRef,
    iframeKey,
    session,
    loadSession,
    setPosition,
    runtimeReset,
    continueRuntime,
    selectDialogueOption,
    navigateRuntime,
    selectRuntimeObject,
    clearRuntimeObjectSelection,
    runRuntimeAction,
    play: sendPlay,
    stop: sendStop,
  } = controller;

  useEffect(() => {
    ensurePrimaryRuntimeSession();
    setPrimaryRuntimeReplay({
      position: useWorkspaceStore.getState().previewPosition,
      running: useWorkspaceStore.getState().previewRunning,
    });
    setConnectionState('loading');
    setSessionStatus(PRIMARY_PREVIEW_SESSION_ID, 'loading');
    loadSession()
      .then((nextSession) => setPrimaryTransport(nextSession))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Engine preview build not found.';
        setConnectionState('missing');
        setSessionStatus(PRIMARY_PREVIEW_SESSION_ID, 'missing');
        recordPreviewDiagnostic({ sessionId: PRIMARY_PREVIEW_SESSION_ID, severity: 'error', source: 'transport', message });
        setStatusMessage(message);
      });
  }, [ensurePrimaryRuntimeSession, loadSession, recordPreviewDiagnostic, setConnectionState, setPrimaryRuntimeReplay, setPrimaryTransport, setSessionStatus, setStatusMessage]);

  useEffect(() => {
    const handlePlay = () => {
      setPreviewRunning(true);
      setPrimaryRuntimeReplay({ position: useWorkspaceStore.getState().previewPosition, running: true });
      void sendPlay().catch((error: Error) => recordTransportError(error.message));
    };
    const handleStop = () => {
      setPreviewRunning(false);
      setPrimaryRuntimeReplay({ position: useWorkspaceStore.getState().previewPosition, running: false });
      void sendStop().catch((error: Error) => recordTransportError(error.message));
    };
    window.addEventListener('noveltea-preview-toolbar-play', handlePlay);
    window.addEventListener('noveltea-preview-toolbar-stop', handleStop);
    return () => {
      window.removeEventListener('noveltea-preview-toolbar-play', handlePlay);
      window.removeEventListener('noveltea-preview-toolbar-stop', handleStop);
    };
  }, [recordTransportError, sendPlay, sendStop, setPreviewRunning, setPrimaryRuntimeReplay]);

  const updatePosition = useCallback((position: PreviewPosition) => {
    const next = { x: clamp01(position.x), y: clamp01(position.y) };
    setPreviewPosition(next);
    setPrimaryRuntimeReplay({ position: next, running: useWorkspaceStore.getState().previewRunning });
    void setPosition(next).catch((error: Error) => recordTransportError(error.message));
  }, [recordTransportError, setPosition, setPreviewPosition, setPrimaryRuntimeReplay]);

  const reload = () => {
    setConnectionState('loading');
    setSessionStatus(PRIMARY_PREVIEW_SESSION_ID, 'loading');
    void loadSession(true)
      .then((nextSession) => setPrimaryTransport(nextSession))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Engine preview build not found.';
        setConnectionState('missing');
        setSessionStatus(PRIMARY_PREVIEW_SESSION_ID, 'missing');
        recordPreviewDiagnostic({ sessionId: PRIMARY_PREVIEW_SESSION_ID, severity: 'error', source: 'transport', message });
        setStatusMessage(message);
      });
  };

  const sendRuntimeCommand = (command: Promise<void>, label: string) => {
    void command
      .then(() => setStatusMessage(label))
      .catch((error: Error) => recordTransportError(error.message));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Button size="sm" variant="ghost" onClick={reload} aria-label="Reload engine preview">
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => sendRuntimeCommand(runtimeReset(), 'Runtime reset')} aria-label="Reset runtime">
          <RotateCcw className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(continueRuntime(), 'Continue input sent')}>
          <StepForward className="h-4 w-4" />
          Continue
        </Button>
        <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(navigateRuntime(0), 'Navigate 0 sent')}>Nav 0</Button>
        <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(selectDialogueOption(0), 'Dialogue option 0 sent')}>Choice 0</Button>
        <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(selectRuntimeObject('lamp'), 'Object selection sent')}>
          <MousePointer2 className="h-4 w-4" />
          Select
        </Button>
        <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(clearRuntimeObjectSelection(), 'Object selection cleared')}>Clear</Button>
        <Button size="sm" variant="outline" onClick={() => sendRuntimeCommand(runRuntimeAction('look', []), 'Action input sent')}>
          <Play className="h-4 w-4" />
          Action
        </Button>
        <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          Demo X
          <Input className="h-7 w-16" type="number" min="0" max="1" step="0.01" value={previewPosition.x.toFixed(2)} onChange={(event) => updatePosition({ x: Number(event.target.value), y: previewPosition.y })} />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Y
          <Input className="h-7 w-16" type="number" min="0" max="1" step="0.01" value={previewPosition.y.toFixed(2)} onChange={(event) => updatePosition({ x: previewPosition.x, y: Number(event.target.value) })} />
        </label>
      </div>
      <div className="relative min-h-0 flex-1 bg-zinc-950">
        {session ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            title="NovelTea engine preview"
            src={session.url}
            sandbox="allow-scripts allow-same-origin"
            className="h-full w-full border-0"
            onLoad={() => {
              setConnectionState('connecting');
              setSessionStatus(PRIMARY_PREVIEW_SESSION_ID, 'connecting');
            }}
            onError={() => recordTransportError('Engine preview iframe failed to load.')}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            <div>
              <div className="font-medium">Engine preview build not found</div>
              <div className="mt-1 font-mono text-xs">{BUILD_COMMAND}</div>
            </div>
          </div>
        )}
        {connectionState !== 'ready' ? (
          <div className="pointer-events-none absolute left-3 top-3 rounded-sm bg-background/90 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {connectionState}
          </div>
        ) : null}
      </div>
    </div>
  );
}
