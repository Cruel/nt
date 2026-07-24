import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import {
  PREVIEW_PROTOCOL_VERSION,
  type EditorToPreviewMessage,
  type EnginePreviewSettings,
  type EnginePreviewSession,
  type AuthoredPreviewEnvironment,
  type PreviewDocument,
  type PreviewMode,
  type PreviewPosition,
  type PreviewToEditorMessage,
  type RuntimeFastForwardResult,
  isPreviewToEditorMessage,
  validatePreviewHandshake,
} from '../../shared/preview-protocol';
import type { AssetProfilerWirePayload } from '../../shared/asset-profiler-protocol';
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
  expectedPayload?: 'asset-profiler';
  payload?: AssetProfilerWirePayload;
}

export class PreviewCommandError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'PreviewCommandError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
        if (
          isRecord(message) &&
          message.type === 'runtime-asset-profiler' &&
          typeof message.requestId === 'string' &&
          !isPreviewToEditorMessage(message)
        ) {
          const pending = pendingRef.current.get(message.requestId);
          const code =
            isRecord(message.payload) &&
            Object.hasOwn(message.payload, 'schemaVersion') &&
            message.payload.schemaVersion !== 3
              ? 'asset-profiler.unsupported-schema'
              : 'asset-profiler.invalid-payload';
          if (pending?.expectedPayload === 'asset-profiler') {
            window.clearTimeout(pending.timeout);
            pendingRef.current.delete(message.requestId);
            pending.reject(
              new PreviewCommandError('Preview sent an invalid asset profiler payload.', code),
            );
          }
          onErrorRef.current('Preview sent an invalid asset profiler payload.');
          return;
        }
        if (!isPreviewToEditorMessage(message)) {
          onErrorRef.current('Preview sent an unsupported protocol message.');
          return;
        }
        if (message.type === 'runtime-asset-profiler') {
          const pending = pendingRef.current.get(message.requestId);
          if (!pending || pending.expectedPayload !== 'asset-profiler' || pending.payload) {
            onErrorRef.current('Preview sent an unmatched asset profiler payload.');
            if (pending?.expectedPayload === 'asset-profiler') {
              window.clearTimeout(pending.timeout);
              pendingRef.current.delete(message.requestId);
              pending.reject(
                new PreviewCommandError(
                  'Preview sent more than one asset profiler payload for a request.',
                  'asset-profiler.duplicate-payload',
                ),
              );
            }
          } else {
            pending.payload = message.payload;
          }
        }
        if (message.type === 'command-result' || message.type === 'runtime-fast-forward-result') {
          const pending = pendingRef.current.get(message.requestId);
          if (pending) {
            window.clearTimeout(pending.timeout);
            pendingRef.current.delete(message.requestId);
            if (message.type === 'runtime-fast-forward-result') {
              pending.resolve(message.result);
            } else if (message.ok) {
              if (pending.expectedPayload === 'asset-profiler' && !pending.payload) {
                pending.reject(
                  new PreviewCommandError(
                    'Preview acknowledged an asset profiler request without a payload.',
                    'asset-profiler.missing-payload',
                  ),
                );
              } else {
                pending.resolve(pending.payload);
              }
            } else {
              pending.reject(
                new PreviewCommandError(
                  message.error ?? 'Preview command failed.',
                  message.errorCode,
                ),
              );
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
        {
          type: 'noveltea-preview-connect',
          version: PREVIEW_PROTOCOL_VERSION,
          sessionToken: session.sessionToken,
        },
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

  const send = useCallback(
    <TResult = void>(
      message: EditorCommandWithoutRequest,
      options?: { expectedPayload?: PendingRequest['expectedPayload'] },
    ) => {
      const port = portRef.current;
      if (!port) {
        return Promise.reject(new Error('Engine preview is not connected.'));
      }
      const requestId = crypto.randomUUID();
      const payload = {
        ...message,
        version: PREVIEW_PROTOCOL_VERSION,
        requestId,
      } as EditorToPreviewMessage;
      return new Promise<TResult>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pendingRef.current.delete(requestId);
          reject(new Error(`Preview command timed out: ${payload.type}`));
        }, timeoutMs);
        pendingRef.current.set(requestId, {
          resolve: resolve as (value?: unknown) => void,
          reject,
          timeout,
          expectedPayload: options?.expectedPayload,
        });
        port.postMessage(payload);
      });
    },
    [timeoutMs],
  );

  return useMemo(
    () => ({
      cleanupPort,
      setPosition: (position: PreviewPosition) => send({ type: 'set-demo-position', position }),
      reset: () => send({ type: 'reset-demo' }),
      runtimeReset: () => send({ type: 'runtime-reset' }),
      loadCompiledProject: (
        compiledProject: unknown,
        assets?: Array<{ sourcePath: string; runtimePath: string }>,
        shaderMaterialMetadata?: unknown,
      ) =>
        send({
          type: 'runtime-load-compiled-project',
          compiledProject,
          assets,
          shaderMaterialMetadata,
        }),
      startRuntime: () => send({ type: 'runtime-start' }),
      stopRuntime: () => send({ type: 'runtime-stop' }),
      stepRuntime: (deltaSeconds?: number) =>
        send(
          deltaSeconds === undefined
            ? { type: 'runtime-step' }
            : { type: 'runtime-step', deltaSeconds },
        ),
      continueRuntime: () => send({ type: 'runtime-continue' }),
      fastForwardRuntimeToInput: () =>
        send<RuntimeFastForwardResult>({ type: 'runtime-fast-forward-to-input' }),
      selectDialogueOption: (optionIndex: number) =>
        send({ type: 'runtime-dialogue-option', optionIndex }),
      navigateRuntime: (direction: number) => send({ type: 'runtime-navigate', direction }),
      selectRuntimeSubjects: (
        subjects: import('../../shared/preview-protocol').PreviewInteractionSubject[],
      ) => send({ type: 'runtime-select-subjects', subjects }),
      clearRuntimeSubjectSelection: () => send({ type: 'runtime-clear-subject-selection' }),
      runRuntimeInteraction: (
        verbId: string,
        operands: import('../../shared/preview-protocol').PreviewInteractionSubject[],
      ) => send({ type: 'runtime-run-interaction', verbId, operands }),
      requestRuntimeDebugSnapshot: () => send({ type: 'runtime-request-debug-snapshot' }),
      requestAssetProfiler: (cursor?: { sessionId: bigint; afterSequence: bigint }) =>
        send<AssetProfilerWirePayload>(
          cursor
            ? {
                type: 'runtime-request-asset-profiler',
                mode: 'delta',
                sessionId: cursor.sessionId.toString(),
                afterSequence: cursor.afterSequence.toString(),
              }
            : { type: 'runtime-request-asset-profiler', mode: 'full' },
          { expectedPayload: 'asset-profiler' },
        ),
      setRuntimeVariable: (variableId: string, value: unknown) =>
        send({ type: 'runtime-set-variable', variableId, value }),
      resetRuntimeVariable: (variableId: string) =>
        send({ type: 'runtime-reset-variable', variableId }),
      giveRuntimeObject: (objectId: string) => send({ type: 'runtime-give-object', objectId }),
      removeRuntimeInventoryObject: (objectId: string) =>
        send({ type: 'runtime-remove-inventory-object', objectId }),
      teleportRuntimeRoom: (roomId: string) => send({ type: 'runtime-teleport-room', roomId }),
      play: () => send({ type: 'play' }),
      stop: () => send({ type: 'stop' }),
      requestState: () => send({ type: 'request-state' }),
      loadPreviewDocument: (document: PreviewDocument, environment?: AuthoredPreviewEnvironment) =>
        environment === undefined
          ? send({ type: 'load-preview-document', document })
          : send({ type: 'load-preview-document', document, environment }),
      updatePreviewDocument: (
        document: PreviewDocument,
        environment?: AuthoredPreviewEnvironment,
      ) =>
        environment === undefined
          ? send({ type: 'update-preview-document', document })
          : send({ type: 'update-preview-document', document, environment }),
      setPreviewMode: (mode: PreviewMode) => send({ type: 'set-preview-mode', mode }),
      setEngineSettings: (settings: EnginePreviewSettings) =>
        send({ type: 'set-engine-settings', settings }),
      setPreviewActivity: (active: boolean, visible?: boolean) =>
        visible === undefined
          ? send({ type: 'set-preview-activity', active })
          : send({ type: 'set-preview-activity', active, visible }),
      setPreviewWheelRouting: (policy: PreviewWheelPolicy, routeId: string) =>
        send({ type: 'set-preview-wheel-routing', policy, routeId }),
      requestPreviewState: () => send({ type: 'request-preview-state' }),
      requestPreviewSnapshot: (snapshotId: string) =>
        send({ type: 'request-preview-snapshot', snapshotId }),
    }),
    [cleanupPort, send],
  );
}
