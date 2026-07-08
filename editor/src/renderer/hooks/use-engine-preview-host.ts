import { useCallback, useMemo, useRef, useState } from 'react';
import type { EnginePreviewSession } from '../../shared/preview-protocol';

function appendSessionParams(url: string, params: Record<string, string | number | boolean | undefined>) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) next.searchParams.set(key, String(value));
  }
  return next.toString();
}

interface EnginePreviewHostOptions {
  embedded: boolean;
}

export function useEnginePreviewHost({ embedded }: EnginePreviewHostOptions) {
  const [session, setSession] = useState<EnginePreviewSession | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const loadSession = useCallback(async (reload = false) => {
    const nextSession = reload
      ? await window.noveltea.reloadEnginePreview()
      : await window.noveltea.getEnginePreviewSession();
    setSession(nextSession);
    setIframeKey((key) => key + 1);
    return nextSession;
  }, []);

  const iframeSrc = useMemo(() => {
    if (!session) return null;
    return embedded
      ? appendSessionParams(session.url, { demo: 'none', noImgui: '1', maxDpr: '1' })
      : session.url;
  }, [embedded, session]);

  return useMemo(() => ({
    iframeRef,
    iframeKey,
    iframeSrc,
    session,
    loadSession,
  }), [iframeKey, iframeSrc, loadSession, session]);
}
