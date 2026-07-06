import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useEnginePreview } from '@/hooks/use-engine-preview';
import { PRIMARY_PREVIEW_SESSION_ID } from '@/preview/preview-manager';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import type { PreviewConnectionState, PreviewDocument, PreviewMode, PreviewToEditorMessage } from '../../shared/preview-protocol';

const BUILD_COMMAND = 'pnpm engine:preview:build';

function previewDocumentTarget(document: PreviewDocument) {
  if (document.kind === 'symbolic') return document.target;
  const collection = document.kind === 'layout-preview'
    ? 'layouts'
    : document.kind === 'material-preview'
      ? 'materials'
      : document.kind === 'shader-preview'
        ? 'shaders'
        : document.kind === 'character-preview'
          ? 'characters'
          : document.kind === 'room-preview'
            ? 'rooms'
            : document.kind === 'dialogue-preview'
              ? 'dialogues'
              : document.kind === 'scene-preview'
                ? 'scenes'
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

export function sanitizePreviewFpsCap(value: number) {
  return Number.isFinite(value) ? Math.min(1000, Math.max(0, Math.trunc(value))) : 0;
}

export type EnginePreviewController = ReturnType<typeof useEnginePreview>;

export type EnginePreviewConnectionState = PreviewConnectionState;

export interface EnginePreviewControlsContext {
  controller: EnginePreviewController;
  connectionState: EnginePreviewConnectionState;
  fpsCap: number;
  setFpsCap: (value: number) => void;
  reload: () => void;
  sendRuntimeCommand: (command: Promise<void>, label: string) => void;
}

interface EnginePreviewProps {
  chrome?: 'runtime' | 'minimal';
  previewDocument?: PreviewDocument;
  previewMode?: PreviewMode;
  renderControls?: (context: EnginePreviewControlsContext) => ReactNode;
}

export function EnginePreview({ chrome = 'runtime', previewDocument, previewMode = 'runtime', renderControls }: EnginePreviewProps) {
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
  const showPreviewFpsCounter = usePreferencesStore((s) => s.showPreviewFpsCounter);
  const globalConnectionState = useWorkspaceStore((s) => s.previewConnectionState);
  const setGlobalConnectionState = useWorkspaceStore((s) => s.setPreviewConnectionState);
  const setSelectedRuntimeObjectId = useWorkspaceStore((s) => s.setSelectedRuntimeObjectId);
  const setLastPreviewEvent = useWorkspaceStore((s) => s.setLastPreviewEvent);
  const setStatusMessage = useWorkspaceStore((s) => s.setStatusMessage);
  const activateGroup = useWorkbenchStore((s) => s.activateGroup);
  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const [localConnectionState, setLocalConnectionState] = useState<EnginePreviewConnectionState>('loading');
  const [fpsCap, setFpsCap] = useState(0);
  const connectionState = embedded ? localConnectionState : globalConnectionState;
  const setConnectionState = useCallback((next: EnginePreviewConnectionState) => {
    if (embedded) setLocalConnectionState(next);
    else setGlobalConnectionState(next);
  }, [embedded, setGlobalConnectionState]);
  const setSanitizedFpsCap = useCallback((value: number) => setFpsCap(sanitizePreviewFpsCap(value)), []);

  const activateContainingWorkbenchGroup = useCallback(() => {
    // Iframe focus does not reliably bubble to React, so activate the owning workbench group explicitly.
    const groupElement = previewHostRef.current?.closest<HTMLElement>('[data-workbench-group-id]');
    const groupId = groupElement?.dataset.workbenchGroupId;
    if (groupId) activateGroup(groupId);
  }, [activateGroup]);

  const scheduleContainingWorkbenchGroupActivation = useCallback(() => {
    window.setTimeout(activateContainingWorkbenchGroup, 0);
  }, [activateContainingWorkbenchGroup]);

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
    if (message.type === 'preview-interacted') {
      // Handles iframe-to-iframe focus changes that parent DOM pointer/focus events cannot observe.
      activateContainingWorkbenchGroup();
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
  }, [activateContainingWorkbenchGroup, embedded, recordPreviewDiagnostic, sessionId, setConnectionState, setLastPreviewEvent, setSelectedRuntimeObjectId, setSessionCapabilities, setSessionStatus, setStatusMessage]);

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
    loadPreviewDocument,
    setPreviewMode,
    setEngineSettings,
  } = controller;

  useEffect(() => {
    function handleWindowBlur() {
      window.setTimeout(() => {
        // Parent window blur is the browser-level signal for focus moving into the iframe.
        if (document.activeElement === iframeRef.current) activateContainingWorkbenchGroup();
      }, 0);
    }
    window.addEventListener('blur', handleWindowBlur);
    return () => window.removeEventListener('blur', handleWindowBlur);
  }, [activateContainingWorkbenchGroup, iframeRef]);

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
    void setEngineSettings({ showFpsCounter: showPreviewFpsCounter, fpsCap }).catch((error: Error) => recordTransportError(error.message));
  }, [connectionState, fpsCap, recordTransportError, setEngineSettings, showPreviewFpsCounter]);

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

  const reload = useCallback(() => {
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
  }, [embedded, loadSession, recordPreviewDiagnostic, sessionId, setConnectionState, setPrimaryTransport, setSessionStatus, setStatusMessage]);

  const sendRuntimeCommand = useCallback((command: Promise<void>, label: string) => {
    void command
      .then(() => setStatusMessage(label))
      .catch((error: Error) => recordTransportError(error.message));
  }, [recordTransportError, setStatusMessage]);

  const controls = !embedded && renderControls
    ? renderControls({
        controller,
        connectionState,
        fpsCap,
        setFpsCap: setSanitizedFpsCap,
        reload,
        sendRuntimeCommand,
      })
    : null;

  const iframeSrc = useMemo(() => {
    if (!session) return null;
    return embedded
      ? appendSessionParams(session.url, { demo: 'none', noImgui: '1', maxDpr: '1' })
      : session.url;
  }, [embedded, session]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {controls}
      <div ref={previewHostRef} className="relative min-h-0 flex-1 bg-zinc-950">
        {iframeSrc ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            title="NovelTea engine preview"
            src={iframeSrc}
            sandbox="allow-scripts allow-same-origin"
            className="h-full w-full border-0"
            onPointerDown={scheduleContainingWorkbenchGroupActivation}
            onFocus={scheduleContainingWorkbenchGroupActivation}
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
