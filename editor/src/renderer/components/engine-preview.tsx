import { useCallback, useEffect, useMemo, useState } from 'react';
import { MousePointer2, Play, RefreshCw, RotateCcw, StepForward } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEnginePreview } from '@/hooks/use-engine-preview';
import { PRIMARY_PREVIEW_SESSION_ID } from '@/preview/preview-manager';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import type { PreviewDocument, PreviewMode, PreviewPosition, PreviewToEditorMessage } from '../../shared/preview-protocol';

const BUILD_COMMAND = 'pnpm engine:preview:build';

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function previewDocumentTarget(document: PreviewDocument) {
  if (document.kind === 'symbolic') return document.target;
  const collection = document.kind === 'layout-preview'
    ? 'layouts'
    : document.kind === 'material-preview'
      ? 'materials'
      : document.kind === 'shader-preview'
        ? 'shaders'
        : undefined;
  return { collection, entityId: document.recordId, kind: document.kind.replace('-preview', '') };
}

function latestPreviewReplay(
  documentsBySessionId: Record<string, PreviewDocument>,
  modeBySessionId: Record<string, PreviewMode>,
): { sessionId: string; document: PreviewDocument; mode: PreviewMode } | null {
  const entry = Object.entries(documentsBySessionId).at(-1);
  if (!entry) return null;
  const [sessionId, document] = entry;
  return { sessionId, document, mode: modeBySessionId[sessionId] ?? 'symbolic' };
}

function appendSessionParams(url: string, params: Record<string, string | number | boolean | undefined>) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) next.searchParams.set(key, String(value));
  }
  return next.toString();
}

interface EnginePreviewProps {
  chrome?: 'runtime' | 'minimal';
  previewDocument?: PreviewDocument;
  previewMode?: PreviewMode;
}

export function EnginePreview({ chrome = 'runtime', previewDocument, previewMode = 'runtime' }: EnginePreviewProps) {
  const embedded = chrome === 'minimal';
  const sessionId = embedded && previewDocument && previewDocument.kind !== 'symbolic'
    ? `${previewDocument.kind}:${previewDocument.recordId}`
    : PRIMARY_PREVIEW_SESSION_ID;
  const ensurePrimaryRuntimeSession = usePreviewManagerStore((s) => s.ensurePrimaryRuntimeSession);
  const setSessionStatus = usePreviewManagerStore((s) => s.setSessionStatus);
  const setSessionCapabilities = usePreviewManagerStore((s) => s.setSessionCapabilities);
  const setPrimaryTransport = usePreviewManagerStore((s) => s.setPrimaryTransport);
  const setPrimaryRuntimeReplay = usePreviewManagerStore((s) => s.setPrimaryRuntimeReplay);
  const recordPreviewDiagnostic = usePreviewManagerStore((s) => s.recordPreviewDiagnostic);
  const replayDocuments = usePreviewManagerStore((s) => s.replay.documentsBySessionId);
  const replayModes = usePreviewManagerStore((s) => s.replay.modeBySessionId);
  const previewPosition = useWorkspaceStore((s) => s.previewPosition);
  const globalConnectionState = useWorkspaceStore((s) => s.previewConnectionState);
  const setPreviewPosition = useWorkspaceStore((s) => s.setPreviewPosition);
  const setPreviewRunning = useWorkspaceStore((s) => s.setPreviewRunning);
  const setGlobalConnectionState = useWorkspaceStore((s) => s.setPreviewConnectionState);
  const setSelectedRuntimeObjectId = useWorkspaceStore((s) => s.setSelectedRuntimeObjectId);
  const setLastPreviewEvent = useWorkspaceStore((s) => s.setLastPreviewEvent);
  const setStatusMessage = useWorkspaceStore((s) => s.setStatusMessage);
  const [localConnectionState, setLocalConnectionState] = useState<'loading' | 'connecting' | 'ready' | 'missing' | 'error'>('loading');
  const connectionState = embedded ? localConnectionState : globalConnectionState;
  const setConnectionState = useCallback((next: typeof localConnectionState) => {
    if (embedded) setLocalConnectionState(next);
    else setGlobalConnectionState(next);
  }, [embedded, setGlobalConnectionState]);

  const recordTransportError = useCallback((message: string) => {
    setConnectionState('error');
    setSessionStatus(sessionId, 'error');
    recordPreviewDiagnostic({ sessionId, severity: 'error', source: 'transport', message });
    if (!embedded) setStatusMessage(message);
  }, [embedded, recordPreviewDiagnostic, sessionId, setConnectionState, setSessionStatus, setStatusMessage]);

  const handlePreviewMessage = useCallback((message: PreviewToEditorMessage) => {
    if (!embedded) setLastPreviewEvent(message);
    if (message.type === 'ready' || message.type === 'capabilities') {
      setSessionCapabilities(sessionId, message.capabilities);
    }
    if (message.type === 'preview-diagnostic') {
      recordPreviewDiagnostic({
        sessionId,
        severity: message.diagnostic.severity,
        source: 'runtime',
        message: message.diagnostic.message,
        path: message.diagnostic.path,
        target: message.diagnostic.target,
      });
    }
    if (!embedded && message.type === 'object-clicked' && message.objectId === 'demo-triangle') {
      setSelectedRuntimeObjectId(message.objectId);
      setStatusMessage('Selected demo-triangle from engine preview');
    } else if (message.type === 'runtime-error') {
      setConnectionState('error');
      setSessionStatus(sessionId, 'error');
      recordPreviewDiagnostic({ sessionId, severity: 'error', source: 'runtime', message: message.message });
      if (!embedded) setStatusMessage(message.message);
    }
  }, [embedded, recordPreviewDiagnostic, sessionId, setConnectionState, setLastPreviewEvent, setSelectedRuntimeObjectId, setSessionCapabilities, setSessionStatus, setStatusMessage]);

  const controller = useEnginePreview({
    onReady: () => {
      setConnectionState('ready');
      setSessionStatus(sessionId, 'ready');
      if (!embedded) {
        setStatusMessage('Engine preview ready');
        const replay = usePreviewManagerStore.getState().replay.primaryRuntime;
        void controller.setPosition(replay.position).catch(() => undefined);
        void (replay.running ? controller.play() : controller.stop()).catch(() => undefined);
      }
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
    loadPreviewDocument,
    setPreviewMode,
    play: sendPlay,
    stop: sendStop,
  } = controller;

  useEffect(() => {
    if (!embedded) {
      ensurePrimaryRuntimeSession();
      setPrimaryRuntimeReplay({
        position: useWorkspaceStore.getState().previewPosition,
        running: useWorkspaceStore.getState().previewRunning,
      });
    }
    setConnectionState('loading');
    setSessionStatus(sessionId, 'loading');
    loadSession()
      .then((nextSession) => {
        if (!embedded) setPrimaryTransport(nextSession);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Engine preview build not found.';
        setConnectionState('missing');
        setSessionStatus(sessionId, 'missing');
        recordPreviewDiagnostic({ sessionId, severity: 'error', source: 'transport', message });
        if (!embedded) setStatusMessage(message);
      });
  }, [embedded, ensurePrimaryRuntimeSession, loadSession, recordPreviewDiagnostic, sessionId, setConnectionState, setPrimaryRuntimeReplay, setPrimaryTransport, setSessionStatus, setStatusMessage]);

  useEffect(() => {
    if (connectionState !== 'ready') return;
    if (previewDocument) {
      void setPreviewMode(previewMode)
        .then(() => loadPreviewDocument(previewDocument))
        .catch((error: Error) => {
          recordPreviewDiagnostic({
            sessionId,
            severity: 'warning',
            source: 'runtime',
            message: error.message,
            target: previewDocumentTarget(previewDocument),
          });
        });
      return;
    }
    if (embedded) return;
    const replay = latestPreviewReplay(replayDocuments, replayModes);
    if (!replay) return;
    void setPreviewMode(replay.mode)
      .then(() => loadPreviewDocument(replay.document))
      .catch((error: Error) => {
        recordPreviewDiagnostic({
          sessionId: PRIMARY_PREVIEW_SESSION_ID,
          severity: 'warning',
          source: 'runtime',
          message: error.message,
          target: previewDocumentTarget(replay.document),
        });
      });
  }, [connectionState, embedded, loadPreviewDocument, previewDocument, previewMode, recordPreviewDiagnostic, replayDocuments, replayModes, sessionId, setPreviewMode]);

  useEffect(() => {
    if (embedded) return undefined;
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
  }, [embedded, recordTransportError, sendPlay, sendStop, setPreviewRunning, setPrimaryRuntimeReplay]);

  const updatePosition = useCallback((position: PreviewPosition) => {
    const next = { x: clamp01(position.x), y: clamp01(position.y) };
    setPreviewPosition(next);
    setPrimaryRuntimeReplay({ position: next, running: useWorkspaceStore.getState().previewRunning });
    void setPosition(next).catch((error: Error) => recordTransportError(error.message));
  }, [recordTransportError, setPosition, setPreviewPosition, setPrimaryRuntimeReplay]);

  const reload = () => {
    setConnectionState('loading');
    setSessionStatus(sessionId, 'loading');
    void loadSession(true)
      .then((nextSession) => {
        if (!embedded) setPrimaryTransport(nextSession);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Engine preview build not found.';
        setConnectionState('missing');
        setSessionStatus(sessionId, 'missing');
        recordPreviewDiagnostic({ sessionId, severity: 'error', source: 'transport', message });
        if (!embedded) setStatusMessage(message);
      });
  };

  const sendRuntimeCommand = (command: Promise<void>, label: string) => {
    void command
      .then(() => setStatusMessage(label))
      .catch((error: Error) => recordTransportError(error.message));
  };

  const iframeSrc = useMemo(() => {
    if (!session) return null;
    return embedded
      ? appendSessionParams(session.url, { demo: 'none', noImgui: '1', maxDpr: '1' })
      : session.url;
  }, [embedded, session]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {!embedded ? (
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
      ) : null}
      <div className="relative min-h-0 flex-1 bg-zinc-950">
        {iframeSrc ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            title="NovelTea engine preview"
            src={iframeSrc}
            sandbox="allow-scripts allow-same-origin"
            className="h-full w-full border-0"
            onLoad={() => {
              setConnectionState('connecting');
              setSessionStatus(sessionId, 'connecting');
            }}
            onError={() => recordTransportError('Engine preview iframe failed to load.')}
          />
        ) : connectionState === 'missing' || connectionState === 'error' ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            <div>
              <div className="font-medium">Engine preview build not found</div>
              <div className="mt-1 font-mono text-xs">{BUILD_COMMAND}</div>
            </div>
          </div>
        ) : null}
        {!embedded && connectionState !== 'ready' ? (
          <div className="pointer-events-none absolute left-3 top-3 rounded-sm bg-background/90 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {connectionState}
          </div>
        ) : null}
      </div>
    </div>
  );
}
