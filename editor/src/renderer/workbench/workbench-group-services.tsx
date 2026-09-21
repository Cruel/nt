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
  MaterialPreviewGroupRendererBridge,
  useOptionalMaterialPreviewGroupRenderer,
} from '@/material-preview/material-preview-provider';
import type { MaterialPreviewGroupRenderer } from '@/material-preview/material-preview-renderer';
import {
  PreviewHostPoolBridge,
  usePreviewHostPool,
  type PreviewHostPoolApi,
} from '@/preview/preview-host-pool';

interface PreviewHostPoolRegistration {
  owner: object;
  pool: PreviewHostPoolApi;
}

interface MaterialPreviewRendererRegistration {
  owner: object;
  renderer: MaterialPreviewGroupRenderer;
}

interface WorkbenchGroupServicesRegistry {
  getMaterialPreviewRenderer: (groupId: string) => MaterialPreviewGroupRenderer | null;
  getPreviewHostPool: (groupId: string) => PreviewHostPoolApi | null;
  getVersion: () => number;
  removeMaterialPreviewRenderer: (groupId: string, owner: object) => void;
  removePreviewHostPool: (groupId: string, owner: object) => void;
  setMaterialPreviewRenderer: (
    groupId: string,
    owner: object,
    renderer: MaterialPreviewGroupRenderer,
  ) => void;
  setPreviewHostPool: (groupId: string, owner: object, pool: PreviewHostPoolApi) => void;
  subscribe: (listener: () => void) => () => void;
}

function createWorkbenchGroupServicesRegistry(): WorkbenchGroupServicesRegistry {
  const materialPreviewRenderersByGroupId = new Map<string, MaterialPreviewRendererRegistration>();
  const previewHostPoolsByGroupId = new Map<string, PreviewHostPoolRegistration>();
  const listeners = new Set<() => void>();
  let version = 0;

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  return {
    getMaterialPreviewRenderer: (groupId) =>
      materialPreviewRenderersByGroupId.get(groupId)?.renderer ?? null,
    getPreviewHostPool: (groupId) => previewHostPoolsByGroupId.get(groupId)?.pool ?? null,
    getVersion: () => version,
    removeMaterialPreviewRenderer: (groupId, owner) => {
      if (materialPreviewRenderersByGroupId.get(groupId)?.owner !== owner) return;
      materialPreviewRenderersByGroupId.delete(groupId);
      notify();
    },
    removePreviewHostPool: (groupId, owner) => {
      if (previewHostPoolsByGroupId.get(groupId)?.owner !== owner) return;
      previewHostPoolsByGroupId.delete(groupId);
      notify();
    },
    setMaterialPreviewRenderer: (groupId, owner, renderer) => {
      const current = materialPreviewRenderersByGroupId.get(groupId);
      if (current?.owner === owner && current.renderer === renderer) return;
      materialPreviewRenderersByGroupId.set(groupId, { owner, renderer });
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

export function WorkbenchGroupMaterialPreviewRendererRegistration({
  groupId,
}: {
  groupId: string;
}) {
  const registry = useContext(WorkbenchGroupServicesContext);
  const renderer = useOptionalMaterialPreviewGroupRenderer();
  const ownerRef = useRef<object | null>(null);
  if (!ownerRef.current) ownerRef.current = {};
  const owner = ownerRef.current;

  useLayoutEffect(() => {
    if (!registry || !renderer) return;
    registry.setMaterialPreviewRenderer(groupId, owner, renderer);
  }, [groupId, owner, registry, renderer]);

  useLayoutEffect(() => {
    if (!registry) return undefined;
    return () => registry.removeMaterialPreviewRenderer(groupId, owner);
  }, [groupId, owner, registry]);

  return null;
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

function useGroupMaterialPreviewRenderer(groupId: string | null) {
  const registry = useWorkbenchGroupServicesRegistry();
  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);
  return groupId ? registry.getMaterialPreviewRenderer(groupId) : null;
}

function useGroupPreviewHostPool(groupId: string | null) {
  const registry = useWorkbenchGroupServicesRegistry();
  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);
  return groupId ? registry.getPreviewHostPool(groupId) : null;
}

export function WorkbenchGroupMaterialPreviewRendererBridge({
  groupId,
  children,
}: {
  groupId: string | null;
  children: ReactNode;
}) {
  const renderer = useGroupMaterialPreviewRenderer(groupId);
  const lastRendererRef = useRef<MaterialPreviewGroupRenderer | null>(null);
  if (renderer) lastRendererRef.current = renderer;
  if (!lastRendererRef.current) return null;
  return (
    <MaterialPreviewGroupRendererBridge renderer={renderer ?? lastRendererRef.current}>
      {children}
    </MaterialPreviewGroupRendererBridge>
  );
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
