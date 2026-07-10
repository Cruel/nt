import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  PreviewHostPoolBridge,
  usePreviewHostPool,
  type PreviewHostPoolApi,
} from '@/preview/preview-host-pool';

interface PreviewHostPoolRegistration {
  owner: object;
  pool: PreviewHostPoolApi;
}

interface WorkbenchGroupServicesRegistry {
  getPreviewHostPool: (groupId: string) => PreviewHostPoolApi | null;
  getVersion: () => number;
  removePreviewHostPool: (groupId: string, owner: object) => void;
  setPreviewHostPool: (groupId: string, owner: object, pool: PreviewHostPoolApi) => void;
  subscribe: (listener: () => void) => () => void;
}

function createWorkbenchGroupServicesRegistry(): WorkbenchGroupServicesRegistry {
  const previewHostPoolsByGroupId = new Map<string, PreviewHostPoolRegistration>();
  const listeners = new Set<() => void>();
  let version = 0;

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  return {
    getPreviewHostPool: (groupId) => previewHostPoolsByGroupId.get(groupId)?.pool ?? null,
    getVersion: () => version,
    removePreviewHostPool: (groupId, owner) => {
      if (previewHostPoolsByGroupId.get(groupId)?.owner !== owner) return;
      previewHostPoolsByGroupId.delete(groupId);
      notify();
    },
    setPreviewHostPool: (groupId, owner, pool) => {
      const current = previewHostPoolsByGroupId.get(groupId);
      if (current?.owner === owner && current.pool === pool) return;
      previewHostPoolsByGroupId.set(groupId, { owner, pool });
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const WorkbenchGroupServicesContext = createContext<WorkbenchGroupServicesRegistry | null>(null);

function useWorkbenchGroupServicesRegistry() {
  const registry = useContext(WorkbenchGroupServicesContext);
  if (!registry) {
    throw new Error('Workbench group services are not available.');
  }
  return registry;
}

export function WorkbenchGroupServicesProvider({ children }: { children: ReactNode }) {
  const registryRef = useRef<WorkbenchGroupServicesRegistry | null>(null);
  if (!registryRef.current) registryRef.current = createWorkbenchGroupServicesRegistry();
  const value = useMemo(() => registryRef.current!, []);
  return (
    <WorkbenchGroupServicesContext.Provider value={value}>
      {children}
    </WorkbenchGroupServicesContext.Provider>
  );
}

export function WorkbenchGroupPreviewHostPoolRegistration({ groupId }: { groupId: string }) {
  const registry = useContext(WorkbenchGroupServicesContext);
  const pool = usePreviewHostPool();
  const ownerRef = useRef<object | null>(null);
  if (!ownerRef.current) ownerRef.current = {};
  const owner = ownerRef.current;

  useLayoutEffect(() => {
    if (!registry) return;
    registry.setPreviewHostPool(groupId, owner, pool);
  }, [groupId, owner, pool, registry]);

  useLayoutEffect(() => {
    if (!registry) return undefined;
    return () => registry.removePreviewHostPool(groupId, owner);
  }, [groupId, owner, registry]);

  return null;
}

function useGroupPreviewHostPool(groupId: string | null) {
  const registry = useWorkbenchGroupServicesRegistry();
  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);
  return groupId ? registry.getPreviewHostPool(groupId) : null;
}

export function WorkbenchGroupPreviewHostPoolBridge({
  groupId,
  children,
}: {
  groupId: string | null;
  children: ReactNode;
}) {
  const pool = useGroupPreviewHostPool(groupId);
  return <PreviewHostPoolBridge pool={pool}>{children}</PreviewHostPoolBridge>;
}
