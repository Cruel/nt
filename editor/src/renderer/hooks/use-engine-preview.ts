import { useCallback, useMemo } from 'react';
import { useEnginePreviewHost } from '@/hooks/use-engine-preview-host';
import { usePreviewTransport } from '@/hooks/use-preview-transport';
import type { PreviewToEditorMessage } from '../../shared/preview-protocol';

export function useEnginePreview({
  embedded = false,
  onReady,
  onMessage,
  onError,
  timeoutMs = 5000,
}: {
  embedded?: boolean;
  onReady: () => void;
  onMessage: (message: PreviewToEditorMessage) => void;
  onError: (message: string) => void;
  timeoutMs?: number;
}) {
  const host = useEnginePreviewHost({ embedded });
  const { iframeRef, iframeKey, iframeSrc, session, loadSession: loadHostSession } = host;
  const transport = usePreviewTransport({
    iframeRef,
    session,
    onReady,
    onMessage,
    onError,
    timeoutMs,
  });
  const loadSession = useCallback((reload = false) => {
    transport.cleanupPort();
    return loadHostSession(reload);
  }, [loadHostSession, transport]);

  return useMemo(() => ({
    ...transport,
    iframeRef,
    iframeKey,
    iframeSrc,
    session,
    loadSession,
    cleanupPort: transport.cleanupPort,
  }), [iframeKey, iframeRef, iframeSrc, loadSession, session, transport]);
}

export type EnginePreviewController = ReturnType<typeof useEnginePreview>;
