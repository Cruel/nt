import { useCallback, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '@/project/project-store';
import type { EnginePreviewSession } from '../../shared/preview-protocol';
import type { PreviewWheelPolicy } from '../../shared/preview-wheel-routing';

function appendSessionParams(
  url: string,
  params: Record<string, string | number | boolean | undefined>,
) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) next.searchParams.set(key, String(value));
  }
  return next.toString();
}

interface EnginePreviewHostOptions {
  embedded: boolean;
  wheelPolicy?: PreviewWheelPolicy;
  audioEnabled?: boolean;
}

export function useEnginePreviewHost({
  embedded,
  wheelPolicy = 'preview-input',
  audioEnabled = false,
}: EnginePreviewHostOptions) {
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const [session, setSession] = useState<EnginePreviewSession | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const loadSession = useCallback(
    async (reload = false) => {
      if (!projectSessionId) throw new Error('Engine preview requires an active Project session.');
      const nextSession = reload
        ? await window.noveltea.reloadEnginePreview(projectSessionId)
        : await window.noveltea.getEnginePreviewSession(projectSessionId);
      setSession(nextSession);
      setIframeKey((key) => key + 1);
      return nextSession;
    },
    [projectSessionId],
  );

  const iframeSrc = useMemo(() => {
    if (!session) return null;
    if (!embedded && audioEnabled) return session.url;
    return appendSessionParams(session.url, {
      demo: embedded ? 'none' : undefined,
      noImgui: embedded ? '1' : undefined,
      wheelPolicy: embedded ? wheelPolicy : undefined,
      audio: audioEnabled ? undefined : 0,
    });
  }, [audioEnabled, embedded, session, wheelPolicy]);

  return useMemo(
    () => ({
      iframeRef,
      iframeKey,
      iframeSrc,
      session,
      loadSession,
    }),
    [iframeKey, iframeSrc, loadSession, session],
  );
}
