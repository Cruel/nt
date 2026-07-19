import { useCallback } from 'react';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import type {
  PreviewConnectionState,
  PreviewDocument,
  PreviewMode,
  PreviewToEditorMessage,
} from '../../shared/preview-protocol';

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
  const setLastPreviewEvent = useWorkspaceStore((s) => s.setLastPreviewEvent);
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
      setLastPreviewEvent,
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
