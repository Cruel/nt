import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useProjectStore } from '@/project/project-store';
import { createWebGlAuthoringBackend } from './authoring-webgl-backend';
import {
  AuthoringWebGlGroupRenderer,
  type AuthoringWebGlBackendFactory,
  type AuthoringWebGlRendererStatus,
  type AuthoringWebGlScheduler,
} from './authoring-webgl-renderer';

const AuthoringWebGlGroupContext = createContext<AuthoringWebGlGroupRenderer | null>(null);

export function AuthoringWebGlGroupProvider({
  children,
  backendFactory = createWebGlAuthoringBackend,
  scheduler,
}: {
  children: ReactNode;
  backendFactory?: AuthoringWebGlBackendFactory;
  scheduler?: AuthoringWebGlScheduler;
}) {
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const renderer = useMemo(() => {
    void projectSessionId;
    return new AuthoringWebGlGroupRenderer(backendFactory, scheduler);
  }, [backendFactory, projectSessionId, scheduler]);
  const disposalTokensRef = useRef(new WeakMap<AuthoringWebGlGroupRenderer, object>());

  useEffect(() => {
    const token = {};
    const disposalTokens = disposalTokensRef.current;
    disposalTokens.set(renderer, token);
    return () => {
      queueMicrotask(() => {
        if (disposalTokens.get(renderer) !== token) return;
        disposalTokens.delete(renderer);
        renderer.dispose();
      });
    };
  }, [renderer]);

  return (
    <AuthoringWebGlGroupContext.Provider value={renderer}>
      {children}
    </AuthoringWebGlGroupContext.Provider>
  );
}

export function AuthoringWebGlGroupRendererBridge({
  renderer,
  children,
}: {
  renderer: AuthoringWebGlGroupRenderer;
  children: ReactNode;
}) {
  return (
    <AuthoringWebGlGroupContext.Provider value={renderer}>
      {children}
    </AuthoringWebGlGroupContext.Provider>
  );
}

export function useOptionalAuthoringWebGlGroupRenderer() {
  return useContext(AuthoringWebGlGroupContext);
}

export function useAuthoringWebGlGroupRenderer() {
  const renderer = useOptionalAuthoringWebGlGroupRenderer();
  if (!renderer) throw new Error('Authoring WebGL group renderer is not available.');
  return renderer;
}

export function useAuthoringWebGlGroupStatus(): AuthoringWebGlRendererStatus {
  const renderer = useAuthoringWebGlGroupRenderer();
  return useSyncExternalStore(
    (listener) => renderer.subscribe(listener),
    () => renderer.status,
    () => renderer.status,
  );
}
