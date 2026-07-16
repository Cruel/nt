import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import {
  PREVIEW_PROTOCOL_VERSION,
  type EditorToPreviewMessage,
  type EnginePreviewSettings,
  type EnginePreviewSession,
  type PreviewDocument,
  type PreviewDisplayProfile,
  type PreviewMode,
  type PreviewPosition,
  type PreviewToEditorMessage,
  type RuntimeFastForwardResult,
  isPreviewToEditorMessage,
  validatePreviewHandshake,
} from '../../shared/preview-protocol';
import type { PreviewWheelPolicy } from '../../shared/preview-wheel-routing';

type EditorCommandWithoutRequest = EditorToPreviewMessage extends infer Message
  ? Message extends EditorToPreviewMessage
    ? Omit<Message, 'version' | 'requestId'>
    : never
  : never;

interface PendingRequest {
  resolve: (value?: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
}

interface PreviewTransportOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  session: EnginePreviewSession | null;
  onReady: () => void;
  onMessage: (message: PreviewToEditorMessage) => void;
  onError: (message: string) => void;
  timeoutMs?: number;
}

export function usePreviewTransport({
  iframeRef,
  session,
  onReady,
  onMessage,
  onError,
  timeoutMs = 5000,
}: PreviewTransportOptions) {
  const portRef = useRef<MessagePort | null>(null);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const onReadyRef = useRef(onReady);
  const onMessageRef = useRef(onMessage);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onMessageRef.current = onMessage;
  onErrorRef.current = onError;

  const cleanupPort = useCallback(() => {
    for (const pending of pendingRef.current.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error('Preview disconnected before command completed.'));
    }
    pendingRef.current.clear();
    portRef.current?.close();
    portRef.current = null;
  }, []);

  useEffect(() => cleanupPort, [cleanupPort]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(() => {
      onErrorRef.current('Engine preview handshake timed out.');
    }, timeoutMs);

    const handleMessage = (event: MessageEvent) => {
      if (!validatePreviewHandshake(event, iframeRef.current?.contentWindow ?? null, session)) {
        return;
      }
      window.clearTimeout(timer);
      cleanupPort();
      const channel = new MessageChannel();
      portRef.current = channel.port1;
      channel.port1.onmessage = (portEvent) => {
        const message = portEvent.data;
        if (!isPreviewToEditorMessage(message)) {
          onErrorRef.current('Preview sent an unsupported protocol message.');
          return;
        }
        if (message.type === 'command-result' || message.type === 'runtime-fast-forward-result') {
          const pending = pendingRef.current.get(message.requestId);
          if (pending) {
            window.clearTimeout(pending.timeout);
            pendingRef.current.delete(message.requestId);
            if (message.type === 'runtime-fast-forward-result') {
              pending.resolve(message.result);
            } else if (message.ok) {
              pending.resolve();
            } else {
              pending.reject(new Error(message.error ?? 'Preview command failed.'));
            }
          }
        }
        if (message.type === 'ready') {
          onReadyRef.current();
        }
        onMessageRef.current(message);
      };
      channel.port1.start();
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'noveltea-preview-connect', version: PREVIEW_PROTOCOL_VERSION, sessionToken: session.sessionToken },
        session.origin,
        [channel.port2],
      );
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', handleMessage);
    };
  }, [cleanupPort, iframeRef, session, timeoutMs]);

  const send = useCallback(<TResult = void>(message: EditorCommandWithoutRequest) => {
    const port = portRef.current;
    if (!port) {
      return Promise.reject(new Error('Engine preview is not connected.'));
    }
    const requestId = crypto.randomUUID();
    const payload = { ...message, version: PREVIEW_PROTOCOL_VERSION, requestId } as EditorToPreviewMessage;
    return new Promise<TResult>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRef.current.delete(requestId);
        reject(new Error(`Preview command timed out: ${payload.type}`));
      }, timeoutMs);
      pendingRef.current.set(requestId, { resolve: resolve as (value?: unknown) => void, reject, timeout });
      port.postMessage(payload);
    });
  }, [timeoutMs]);

  return useMemo(() => ({
    cleanupPort,
    setPosition: (position: PreviewPosition) => send({ type: 'set-demo-position', position }),
    reset: () => send({ type: 'reset-demo' }),
    runtimeReset: () => send({ type: 'runtime-reset' }),
    loadCompiledProject: (
      compiledProject: unknown,
      assets?: Array<{ sourcePath: string; runtimePath: string }>,
      shaderMaterialMetadata?: unknown,
    ) => send({ type: 'runtime-load-compiled-project', compiledProject, assets, shaderMaterialMetadata }),
    startRuntime: () => send({ type: 'runtime-start' }),
    stopRuntime: () => send({ type: 'runtime-stop' }),
    stepRuntime: (deltaSeconds?: number) => send(deltaSeconds === undefined ? { type: 'runtime-step' } : { type: 'runtime-step', deltaSeconds }),
    continueRuntime: () => send({ type: 'runtime-continue' }),
    fastForwardRuntimeToInput: () => send<RuntimeFastForwardResult>({ type: 'runtime-fast-forward-to-input' }),
    selectDialogueOption: (optionIndex: number) => send({ type: 'runtime-dialogue-option', optionIndex }),
    navigateRuntime: (direction: number) => send({ type: 'runtime-navigate', direction }),
    selectRuntimeSubjects: (subjects: import('../../shared/preview-protocol').PreviewInteractionSubject[]) => send({ type: 'runtime-select-subjects', subjects }),
    clearRuntimeSubjectSelection: () => send({ type: 'runtime-clear-subject-selection' }),
    runRuntimeInteraction: (verbId: string, operands: import('../../shared/preview-protocol').PreviewInteractionSubject[]) => send({ type: 'runtime-run-interaction', verbId, operands }),
    requestRuntimeDebugSnapshot: () => send({ type: 'runtime-request-debug-snapshot' }),
    setRuntimeVariable: (variableId: string, value: unknown) => send({ type: 'runtime-set-variable', variableId, value }),
    resetRuntimeVariable: (variableId: string) => send({ type: 'runtime-reset-variable', variableId }),
    giveRuntimeObject: (objectId: string) => send({ type: 'runtime-give-object', objectId }),
    removeRuntimeInventoryObject: (objectId: string) => send({ type: 'runtime-remove-inventory-object', objectId }),
    teleportRuntimeRoom: (roomId: string) => send({ type: 'runtime-teleport-room', roomId }),
    play: () => send({ type: 'play' }),
    stop: () => send({ type: 'stop' }),
    requestState: () => send({ type: 'request-state' }),
    loadPreviewDocument: (document: PreviewDocument) => send({ type: 'load-preview-document', document }),
    updatePreviewDocument: (document: PreviewDocument) => send({ type: 'update-preview-document', document }),
    setPreviewMode: (mode: PreviewMode) => send({ type: 'set-preview-mode', mode }),
    setEngineSettings: (settings: EnginePreviewSettings) => send({ type: 'set-engine-settings', settings }),
    setPreviewDisplayProfile: (profile: PreviewDisplayProfile | null, scaling: { mode: 'responsive' | 'reference'; logicalSize: { width: number; height: number } | null }) => send({ type: 'set-preview-display-profile', profile, scaling }),
    setPreviewActivity: (active: boolean, visible?: boolean) => (
      visible === undefined
        ? send({ type: 'set-preview-activity', active })
        : send({ type: 'set-preview-activity', active, visible })
    ),
    setPreviewWheelRouting: (policy: PreviewWheelPolicy, routeId: string) => (
      send({ type: 'set-preview-wheel-routing', policy, routeId })
    ),
    requestPreviewState: () => send({ type: 'request-preview-state' }),
    requestPreviewSnapshot: (snapshotId: string) => send({ type: 'request-preview-snapshot', snapshotId }),
  }), [cleanupPort, send]);
}
