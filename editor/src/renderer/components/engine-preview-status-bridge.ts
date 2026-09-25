import { useCallback } from 'react';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import type {
  PreviewConnectionState,
  PreviewDocument,
  PreviewMode,
  PreviewToEditorMessage,
} from '../../shared/preview-protocol';

function runtimeEventFromPreviewMessage(message: PreviewToEditorMessage) {
  if (message.type === 'runtime-debug-event') {
    const detail = [
      message.event.kind,
      message.event.target?.id,
      message.event.oldValue !== undefined ? `old=${JSON.stringify(message.event.oldValue)}` : null,
      message.event.newValue !== undefined ? `new=${JSON.stringify(message.event.newValue)}` : null,
      message.event.message,
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      label: message.event.label,
      detail: detail || undefined,
      severity: message.event.rejected ? ('warning' as const) : ('info' as const),
    };
  }
  if (message.type === 'runtime-fast-forward-result') {
    const detail = [
      `reason=${message.result.reason}`,
      `steps=${message.result.stepsApplied}`,
      `ticks=${message.result.ticksApplied}`,
      message.result.lastInput ? `last=${message.result.lastInput}` : null,
      message.result.diagnostic,
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      label: 'Fast-forward stopped',
      detail,
      severity:
        message.result.reason === 'error'
          ? ('error' as const)
          : message.result.reason === 'budget-exhausted' ||
              message.result.reason === 'stabilization-limit'
            ? ('warning' as const)
            : ('info' as const),
    };
  }
  if (message.type === 'runtime-error') {
    return { label: message.message, severity: 'error' as const };
  }
  return null;
}

export function previewDocumentTarget(document: PreviewDocument) {
  if (document.kind === 'symbolic') return document.target;
  const collection =
    document.kind === 'layout-preview'
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

export function latestPreviewReplay(
  documentsBySessionId: Record<string, PreviewDocument>,
  modeBySessionId: Record<string, PreviewMode>,
): { sessionId: string; document: PreviewDocument; mode: PreviewMode } | null {
  const entry = Object.entries(documentsBySessionId).at(-1);
  if (!entry) return null;
  const [sessionId, document] = entry;
  return { sessionId, document, mode: modeBySessionId[sessionId] ?? 'symbolic' };
}

export function useEnginePreviewStatusBridge({
  embedded,
  sessionId,
  onPreviewMessage,
}: {
  embedded: boolean;
  sessionId: string;
  onPreviewMessage?: (message: PreviewToEditorMessage) => void;
}) {
  const setSessionStatus = usePreviewManagerStore((s) => s.setSessionStatus);
  const setSessionCapabilities = usePreviewManagerStore((s) => s.setSessionCapabilities);
  const recordPreviewDiagnostic = usePreviewManagerStore((s) => s.recordPreviewDiagnostic);
  const setSelectedRuntimeObjectId = useWorkspaceStore((s) => s.setSelectedRuntimeObjectId);
  const addRuntimeEvent = useWorkspaceStore((s) => s.addRuntimeEvent);
  const setStatusMessage = useWorkspaceStore((s) => s.setStatusMessage);

  const recordTransportError = useCallback(
    (message: string, setConnectionState: (next: PreviewConnectionState) => void) => {
      setConnectionState('error');
      setSessionStatus(sessionId, 'error');
      recordPreviewDiagnostic({ sessionId, severity: 'error', source: 'transport', message });
      if (!embedded) setStatusMessage(message);
    },
    [embedded, recordPreviewDiagnostic, sessionId, setSessionStatus, setStatusMessage],
  );

  const handlePreviewMessage = useCallback(
    (
      message: PreviewToEditorMessage,
      options: {
        activateContainingWorkbenchGroup: () => void;
        setConnectionState: (next: PreviewConnectionState) => void;
      },
    ) => {
      onPreviewMessage?.(message);
      if (!embedded) {
        const runtimeEvent = runtimeEventFromPreviewMessage(message);
        if (runtimeEvent) addRuntimeEvent(runtimeEvent);
      }
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
      if (message.type === 'runtime-debug-snapshot') {
        for (const diagnostic of message.snapshot.diagnostics) {
          recordPreviewDiagnostic({
            sessionId,
            severity: diagnostic.severity,
            source: 'runtime',
            message: diagnostic.message,
            path: diagnostic.path,
            target: diagnostic.source
              ? {
                  collection: diagnostic.source.collection,
                  entityId: diagnostic.source.id,
                  kind: diagnostic.source.type,
                  label: diagnostic.source.label,
                }
              : undefined,
          });
        }
      }
      if (message.type === 'preview-interacted') {
        // Handles iframe-to-iframe focus changes that parent DOM pointer/focus events cannot observe.
        options.activateContainingWorkbenchGroup();
      }
      if (!embedded && message.type === 'object-clicked' && message.objectId === 'demo-triangle') {
        setSelectedRuntimeObjectId(message.objectId);
        setStatusMessage('Selected demo-triangle from engine preview');
      } else if (message.type === 'runtime-error') {
        options.setConnectionState('error');
        setSessionStatus(sessionId, 'error');
        recordPreviewDiagnostic({
          sessionId,
          severity: 'error',
          source: 'runtime',
          message: message.message,
        });
        if (!embedded) setStatusMessage(message.message);
      }
    },
    [
      embedded,
      onPreviewMessage,
      recordPreviewDiagnostic,
      sessionId,
      addRuntimeEvent,
      setSelectedRuntimeObjectId,
      setSessionCapabilities,
      setSessionStatus,
      setStatusMessage,
    ],
  );

  return {
    handlePreviewMessage,
    recordTransportError,
    recordPreviewDiagnostic,
    setSessionStatus,
    setStatusMessage,
  };
}
