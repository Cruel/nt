import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EnginePreviewHost } from '@/components/engine-preview-host';
import {
  latestPreviewReplay,
  previewDocumentTarget,
  useEnginePreviewStatusBridge,
} from '@/components/engine-preview-status-bridge';
import { useEnginePreview, type EnginePreviewController } from '@/hooks/use-engine-preview';
import { PRIMARY_PREVIEW_SESSION_ID } from '@/preview/preview-manager';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { normalizePreviewFpsCap, usePreferencesStore } from '@/stores/preferences-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useProjectStore } from '@/project/project-store';
import { useOptionalWorkbenchEditorLocation } from '@/workbench/workbench-editor-location';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import type {
  PreviewConnectionState,
  PreviewDocument,
  PreviewMode,
  PreviewToEditorMessage,
} from '../../shared/preview-protocol';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import { authoredPreviewEnvironment, effectivePreviewDisplay } from '../../shared/preview-display';

export function sanitizePreviewFpsCap(value: number) {
  return normalizePreviewFpsCap(value);
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
  previewActivityRefreshOnVisible?: 'none' | 'preview-state' | 'runtime-debug';
  renderControls?: (context: EnginePreviewControlsContext) => ReactNode;
  onControlsContextChange?: (context: EnginePreviewControlsContext | null) => void;
  onPreviewMessage?: (message: PreviewToEditorMessage) => void;
}

function isPreviewWrapperVisible(wrapper: HTMLDivElement | null) {
  const pane = wrapper?.closest<HTMLElement>('[data-workbench-editor-pane]');
  if (!pane) return true;
  return pane.dataset.hidden !== 'true' && pane.getAttribute('aria-hidden') !== 'true';
}

export function EnginePreview({
  chrome = 'runtime',
  previewDocument,
  previewMode = 'runtime',
  previewActivityRefreshOnVisible = 'none',
  renderControls,
  onControlsContextChange,
  onPreviewMessage,
}: EnginePreviewProps) {
  const embedded = chrome === 'minimal';
  const sessionId =
    embedded && previewDocument && previewDocument.kind !== 'symbolic'
      ? `${previewDocument.kind}:${previewDocument.recordId}`
      : PRIMARY_PREVIEW_SESSION_ID;
  const ensurePrimaryRuntimeSession = usePreviewManagerStore((s) => s.ensurePrimaryRuntimeSession);
  const setPrimaryTransport = usePreviewManagerStore((s) => s.setPrimaryTransport);
  const setPrimaryRuntimeReplay = usePreviewManagerStore((s) => s.setPrimaryRuntimeReplay);
  const replayDocuments = usePreviewManagerStore((s) => s.replay.documentsBySessionId);
  const replayModes = usePreviewManagerStore((s) => s.replay.modeBySessionId);
  const showPreviewFpsCounter = usePreferencesStore((s) => s.showPreviewFpsCounter);
  const fpsCap = usePreferencesStore((s) => s.previewFpsCap);
  const previewDisplay = usePreferencesStore((s) => s.previewDisplay);
  const projectDocument = useProjectStore((s) => s.document);
  const projectSettings = useMemo(
    () =>
      isAuthoringProject(projectDocument) ? projectSettingsFromProject(projectDocument) : undefined,
    [projectDocument],
  );
  const effectiveDisplay = useMemo(
    () => effectivePreviewDisplay(previewDisplay, projectSettings?.display),
    [previewDisplay, projectSettings?.display],
  );
  const environmentFor = useCallback(
    (document: PreviewDocument) =>
      document.kind === 'layout-preview'
        ? authoredPreviewEnvironment(
            document,
            effectiveDisplay,
            projectSettings?.display,
            projectSettings?.accessibility,
          )
        : undefined,
    [effectiveDisplay, projectSettings?.accessibility, projectSettings?.display],
  );
  const setFpsCap = usePreferencesStore((s) => s.setPreviewFpsCap);
  const globalConnectionState = useWorkspaceStore((s) => s.previewConnectionState);
  const setGlobalConnectionState = useWorkspaceStore((s) => s.setPreviewConnectionState);
  const editorLocation = useOptionalWorkbenchEditorLocation();
  const activateGroup = useWorkbenchStore((s) => s.activateGroup);
  const {
    handlePreviewMessage: bridgePreviewMessage,
    recordTransportError: bridgeTransportError,
    recordPreviewDiagnostic,
    setSessionStatus,
    setStatusMessage,
  } = useEnginePreviewStatusBridge({ embedded, sessionId, onPreviewMessage });
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [localConnectionState, setLocalConnectionState] =
    useState<EnginePreviewConnectionState>('loading');
  const [previewVisible, setPreviewVisible] = useState(true);
  const connectionState = embedded ? localConnectionState : globalConnectionState;
  const setConnectionState = useCallback(
    (next: EnginePreviewConnectionState) => {
      if (embedded) setLocalConnectionState(next);
      else setGlobalConnectionState(next);
    },
    [embedded, setGlobalConnectionState],
  );
  const setSanitizedFpsCap = useCallback((value: number) => setFpsCap(value), [setFpsCap]);

  const activateContainingWorkbenchGroup = useCallback(
    (groupId?: string) => {
      const nextGroupId =
        groupId ??
        editorLocation?.groupId ??
        wrapperRef.current?.closest<HTMLElement>('[data-workbench-group-id]')?.dataset
          .workbenchGroupId;
      if (nextGroupId) activateGroup(nextGroupId);
    },
    [activateGroup, editorLocation?.groupId],
  );

  const recordTransportError = useCallback(
    (message: string) => {
      bridgeTransportError(message, setConnectionState);
    },
    [bridgeTransportError, setConnectionState],
  );

  const handlePreviewMessage = useCallback(
    (message: PreviewToEditorMessage) => {
      bridgePreviewMessage(message, {
        activateContainingWorkbenchGroup,
        setConnectionState,
      });
    },
    [activateContainingWorkbenchGroup, bridgePreviewMessage, setConnectionState],
  );

  const controller = useEnginePreview({
    embedded,
    onReady: () => {
      setConnectionState('ready');
      setSessionStatus(sessionId, 'ready');
      if (!embedded) {
        setStatusMessage('Engine preview ready');
        const replay = usePreviewManagerStore.getState().replay.primaryRuntime;
        void controller.setPosition(replay.position).catch(() => undefined);
        void controller.play().catch(() => undefined);
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
    const updateVisibility = () => setPreviewVisible(isPreviewWrapperVisible(wrapperRef.current));
    updateVisibility();
    const pane = wrapperRef.current?.closest<HTMLElement>('[data-workbench-editor-pane]');
    if (!pane) return undefined;
    const observer = new MutationObserver(updateVisibility);
    observer.observe(pane, {
      attributes: true,
      attributeFilter: ['data-hidden', 'aria-hidden', 'class', 'inert'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!embedded) {
      ensurePrimaryRuntimeSession();
      setPrimaryRuntimeReplay({ position: useWorkspaceStore.getState().previewPosition });
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
  }, [
    embedded,
    ensurePrimaryRuntimeSession,
    loadSession,
    recordPreviewDiagnostic,
    sessionId,
    setConnectionState,
    setPrimaryRuntimeReplay,
    setPrimaryTransport,
    setSessionStatus,
    setStatusMessage,
  ]);

  useEffect(() => {
    if (connectionState !== 'ready') return;
    void setEngineSettings({ showFpsCounter: showPreviewFpsCounter, fpsCap }).catch(
      (error: Error) => recordTransportError(error.message),
    );
  }, [connectionState, fpsCap, recordTransportError, setEngineSettings, showPreviewFpsCounter]);

  useEffect(() => {
    if (connectionState !== 'ready') return;
    const sendActivity = async () => {
      await controller.setPreviewActivity(previewVisible, previewVisible);
      if (!previewVisible) return;
      if (previewActivityRefreshOnVisible === 'runtime-debug') {
        await controller.requestRuntimeDebugSnapshot();
      } else if (previewActivityRefreshOnVisible === 'preview-state') {
        await controller.requestPreviewState();
      }
    };
    void sendActivity().catch((error: Error) => recordTransportError(error.message));
  }, [
    connectionState,
    controller,
    previewActivityRefreshOnVisible,
    previewVisible,
    recordTransportError,
  ]);

  useEffect(() => {
    if (connectionState !== 'ready') return;
    if (previewDocument) {
      const environment = environmentFor(previewDocument);
      void setPreviewMode(previewMode)
        .then(() =>
          environment === undefined
            ? loadPreviewDocument(previewDocument)
            : loadPreviewDocument(previewDocument, environment),
        )
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
    const environment = environmentFor(replay.document);
    void setPreviewMode(replay.mode)
      .then(() =>
        environment === undefined
          ? loadPreviewDocument(replay.document)
          : loadPreviewDocument(replay.document, environment),
      )
      .catch((error: Error) => {
        recordPreviewDiagnostic({
          sessionId: PRIMARY_PREVIEW_SESSION_ID,
          severity: 'warning',
          source: 'runtime',
          message: error.message,
          target: previewDocumentTarget(replay.document),
        });
      });
  }, [
    connectionState,
    embedded,
    environmentFor,
    loadPreviewDocument,
    previewDocument,
    previewMode,
    recordPreviewDiagnostic,
    replayDocuments,
    replayModes,
    sessionId,
    setPreviewMode,
  ]);

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
  }, [
    embedded,
    loadSession,
    recordPreviewDiagnostic,
    sessionId,
    setConnectionState,
    setPrimaryTransport,
    setSessionStatus,
    setStatusMessage,
  ]);

  const sendRuntimeCommand = useCallback(
    (command: Promise<void>, label: string) => {
      void command
        .then(() => setStatusMessage(label))
        .catch((error: Error) => recordTransportError(error.message));
    },
    [recordTransportError, setStatusMessage],
  );

  const controlsContext = useMemo<EnginePreviewControlsContext>(
    () => ({
      controller,
      connectionState,
      fpsCap,
      setFpsCap: setSanitizedFpsCap,
      reload,
      sendRuntimeCommand,
    }),
    [connectionState, controller, fpsCap, reload, sendRuntimeCommand, setSanitizedFpsCap],
  );

  useEffect(() => {
    onControlsContextChange?.(controlsContext);
  }, [controlsContext, onControlsContextChange]);

  useEffect(
    () => () => {
      onControlsContextChange?.(null);
    },
    [onControlsContextChange],
  );

  const controls = !embedded && renderControls ? renderControls(controlsContext) : null;

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
