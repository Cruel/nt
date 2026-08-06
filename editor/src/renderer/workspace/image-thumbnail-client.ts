import { useEffect, useState, useSyncExternalStore } from 'react';
import type {
  EditorCacheEpochEvent,
  ImageThumbnailRequest,
  ImageThumbnailResult,
} from '../../shared/image-thumbnails';

const pendingRequests = new Map<string, Promise<ImageThumbnailResult>>();
const epochListeners = new Set<() => void>();
let cacheEpoch = 0;
let subscribedEpochMethod: typeof window.noveltea.onEditorCacheEpoch | null = null;
let unsubscribeEpoch: (() => void) | null = null;

function ensureEpochSubscription() {
  if (
    typeof window === 'undefined' ||
    subscribedEpochMethod === window.noveltea.onEditorCacheEpoch
  ) {
    return;
  }
  unsubscribeEpoch?.();
  subscribedEpochMethod = window.noveltea.onEditorCacheEpoch;
  unsubscribeEpoch = window.noveltea.onEditorCacheEpoch((event: EditorCacheEpochEvent) => {
    if (event.cacheEpoch <= cacheEpoch) return;
    cacheEpoch = event.cacheEpoch;
    pendingRequests.clear();
    for (const listener of epochListeners) listener();
  });
}

export function requestImageThumbnail(
  request: ImageThumbnailRequest,
): Promise<ImageThumbnailResult> {
  ensureEpochSubscription();
  const key = JSON.stringify(request);
  const existing = pendingRequests.get(key);
  if (existing) return existing;
  const pending = window.noveltea.requestImageThumbnail(request);
  pendingRequests.set(key, pending);
  void pending.finally(() => {
    if (pendingRequests.get(key) === pending) pendingRequests.delete(key);
  });
  return pending;
}

export function useEditorCacheEpoch(): number {
  ensureEpochSubscription();
  return useSyncExternalStore(
    (listener) => {
      epochListeners.add(listener);
      return () => epochListeners.delete(listener);
    },
    () => cacheEpoch,
    () => cacheEpoch,
  );
}

export function useImageThumbnail(request: ImageThumbnailRequest | null): {
  status: 'deferred' | 'loading' | 'ready' | 'error';
  result: ImageThumbnailResult | null;
} {
  const epoch = useEditorCacheEpoch();
  const [state, setState] = useState<{
    status: 'deferred' | 'loading' | 'ready' | 'error';
    result: ImageThumbnailResult | null;
  }>({ status: request ? 'loading' : 'deferred', result: null });

  useEffect(() => {
    let active = true;
    if (!request) {
      setState({ status: 'deferred', result: null });
      return () => {
        active = false;
      };
    }
    setState({ status: 'loading', result: null });
    void requestImageThumbnail(request).then(
      (result) => {
        if (!active) return;
        setState({ status: result.ok ? 'ready' : 'error', result });
      },
      () => {
        if (active) setState({ status: 'error', result: null });
      },
    );
    return () => {
      active = false;
    };
  }, [request, epoch]);

  return state;
}
