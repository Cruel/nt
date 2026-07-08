import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { EnginePreviewHost } from '@/components/engine-preview-host';
import { latestPreviewReplay, previewDocumentTarget, useEnginePreviewStatusBridge } from '@/components/engine-preview-status-bridge';
import { useEnginePreview, type EnginePreviewController } from '@/hooks/use-engine-preview';
import { PRIMARY_PREVIEW_SESSION_ID } from '@/preview/preview-manager';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import type { PreviewConnectionState, PreviewDocument, PreviewMode, PreviewToEditorMessage } from '../../shared/preview-protocol';

export function sanitizePreviewFpsCap(value: number) {
  return Number.isFinite(value) ? Math.min(1000, Math.max(0, Math.trunc(value))) : 0;
}

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
  onPreviewMessage?: (message: PreviewToEditorMessage) => void;
}

export function EnginePreview({ chrome = 'runtime', previewDocument, previewMode = 'runtime', renderControls, onPreviewMessage }: EnginePreviewProps) {
  const embedded = chrome === 'minimal';
  const sessionId = embedded && previewDocument && previewDocument.kind !== 'symbolic'
    ? `${previewDocument.kind}:${previewDocument.recordId}`
    : PRIMARY_PREVIEW_SESSION_ID;
  const ensurePrimaryRuntimeSession = usePreviewManagerStore((s) => s.ensurePrimaryRuntimeSession);
  const setPrimaryTransport = usePreviewManagerStore((s) => s.setPrimaryTransport);
  const setPrimaryRuntimeReplay = usePreviewManagerStore((s) => s.setPrimaryRuntimeReplay);
  const replayDocuments = usePreviewManagerStore((s) => s.replay.documentsBySessionId);
  const replayModes = usePreviewManagerStore((s) => s.replay.modeBySessionId);
  const showPreviewFpsCounter = usePreferencesStore((s) => s.showPreviewFpsCounter);
  const globalConnectionState = useWorkspaceStore((s) => s.previewConnectionState);
  const setGlobalConnectionState = useWorkspaceStore((s) => s.setPreviewConnectionState);
  const activateGroup = useWorkbenchStore((s) => s.activateGroup);
  const {
    handlePreviewMessage: bridgePreviewMessage,
    recordTransportError: bridgeTransportError,
    recordPreviewDiagnostic,
    setSessionStatus,
    setStatusMessage,
  } = useEnginePreviewStatusBridge({ embedded, sessionId, onPreviewMessage });
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [localConnectionState, setLocalConnectionState] = useState<EnginePreviewConnectionState>('loading');
  const [fpsCap, setFpsCap] = useState(0);
  const connectionState = embedded ? localConnectionState : globalConnectionState;
  const setConnectionState = useCallback((next: EnginePreviewConnectionState) => {
    if (embedded) setLocalConnectionState(next);
    else setGlobalConnectionState(next);
  }, [embedded, setGlobalConnectionState]);
  const setSanitizedFpsCap = useCallback((value: number) => setFpsCap(sanitizePreviewFpsCap(value)), []);

  const activateContainingWorkbenchGroup = useCallback((groupId?: string) => {
    const nextGroupId = groupId ?? wrapperRef.current?.closest<HTMLElement>('[data-workbench-group-id]')?.dataset.workbenchGroupId;
    if (nextGroupId) activateGroup(nextGroupId);
  }, [activateGroup]);

  const recordTransportError = useCallback((message: string) => {
    bridgeTransportError(message, setConnectionState);
  }, [bridgeTransportError, setConnectionState]);

  const handlePreviewMessage = useCallback((message: PreviewToEditorMessage) => {
    bridgePreviewMessage(message, {
      activateContainingWorkbenchGroup,
      setConnectionState,
    });
  }, [activateContainingWorkbenchGroup, bridgePreviewMessage, setConnectionState]);

  const controller = useEnginePreview({
    embedded,
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
    iframeSrc,
    loadSession,
    loadPreviewDocument,
    setPreviewMode,
    setEngineSettings,
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

  return (
    <div ref={wrapperRef} className="flex h-full min-h-0 flex-col bg-background">
      {controls}
      <EnginePreviewHost
        iframeRef={iframeRef}
        iframeKey={iframeKey}
        iframeSrc={iframeSrc}
        embedded={embedded}
        connectionState={connectionState}
        onActivateContainingGroup={activateContainingWorkbenchGroup}
        onConnecting={() => {
          setConnectionState('connecting');
          setSessionStatus(sessionId, 'connecting');
        }}
        onError={recordTransportError}
      />
    </div>
  );
}
