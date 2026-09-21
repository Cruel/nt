import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useProjectSourceStore } from '@/project/project-source-store';
import { useProjectStore } from '@/project/project-store';
import { useShaderCompileStore } from '@/shaders/shader-compile-store';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  MaterialPreviewProjectResources,
  materialPreviewDefaultDecodeImage,
  type MaterialPreviewResource,
} from './material-preview-resources';
import {
  MaterialPreviewGroupRenderer,
  type MaterialPreviewBackendFactory,
  type MaterialPreviewGroupRendererStatus,
  type MaterialPreviewScheduler,
} from './material-preview-renderer';

interface MaterialPreviewProjectContextValue {
  resources: MaterialPreviewProjectResources;
  generation: number;
  scopeKey: string | null;
}

const ProjectResourcesContext = createContext<MaterialPreviewProjectContextValue | null>(null);
const GroupRendererContext = createContext<MaterialPreviewGroupRenderer | null>(null);

export async function resolveMaterialPreviewAssetUrl(assetId: string): Promise<string | null> {
  const sessionId = useProjectStore.getState().projectSessionId;
  if (!sessionId) return null;
  const response = await window.noveltea.resolveProjectOriginalAssetUrl(sessionId, assetId);
  return response.ok ? (response.url ?? null) : null;
}

export function MaterialPreviewProjectProvider({ children }: { children: ReactNode }) {
  const document = useProjectStore((state) => state.document);
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const projectInstanceId = useProjectStore((state) => state.projectInstanceId);
  const projectRevision = useProjectStore((state) => state.projectRevision);
  const shaderSources = useProjectSourceStore((state) => state.files).filter(
    (file) => file.kind === 'shader',
  );
  const resourcesRef = useRef<MaterialPreviewProjectResources | null>(null);
  if (!resourcesRef.current) {
    resourcesRef.current = new MaterialPreviewProjectResources({
      compileShaders: async (compilation) => {
        if (Object.keys((compilation as { programs?: object }).programs ?? {}).length === 0)
          return [];
        return useShaderCompileStore
          .getState()
          .runCompile(compilation, undefined, { shaderVariants: ['essl-300'] });
      },
      resolveAssetUrl: resolveMaterialPreviewAssetUrl,
      decodeImage: materialPreviewDefaultDecodeImage,
    });
  }
  const resources = resourcesRef.current;
  const project = isAuthoringProject(document) ? document : null;
  const shaderSourceRevision = shaderSources
    .map((file) => `${file.id}:${file.contentHash ?? 'absent'}`)
    .sort()
    .join('|');
  resources.updateProject(
    project,
    `${projectInstanceId ?? projectSessionId ?? 'none'}:${projectRevision}|${shaderSourceRevision}`,
    {
      scopeKey: projectSessionId,
    },
  );
  const generation = resources.generation;
  const scopeKey = projectSessionId;
  const value = useMemo(
    () => ({ resources, generation, scopeKey }),
    [generation, resources, scopeKey],
  );
  return (
    <ProjectResourcesContext.Provider value={value}>{children}</ProjectResourcesContext.Provider>
  );
}

function useMaterialPreviewProjectContext() {
  const context = useContext(ProjectResourcesContext);
  if (!context) throw new Error('Material preview Project resources are not available.');
  return context;
}

export function useMaterialPreviewProjectResources() {
  return useMaterialPreviewProjectContext().resources;
}

export function useMaterialPreviewResource(materialId: string | null) {
  const { resources, generation } = useMaterialPreviewProjectContext();
  const [state, setState] = useState<{
    materialId: string;
    generation: number;
    value: MaterialPreviewResource | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    if (!materialId) {
      setState(null);
      return () => {
        active = false;
      };
    }
    void resources.getMaterial(materialId).then((value) => {
      if (active) setState({ materialId, generation, value });
    });
    return () => {
      active = false;
    };
  }, [generation, materialId, resources]);

  if (!state || state.materialId !== materialId || state.generation !== generation) return null;
  return state.value;
}

export function MaterialPreviewGroupProvider({
  children,
  backendFactory,
  scheduler,
}: {
  children: ReactNode;
  backendFactory?: MaterialPreviewBackendFactory;
  scheduler?: MaterialPreviewScheduler;
}) {
  const { resources, generation, scopeKey } = useMaterialPreviewProjectContext();
  const renderer = useMemo(() => {
    void scopeKey;
    return new MaterialPreviewGroupRenderer(resources, backendFactory, scheduler);
  }, [backendFactory, resources, scheduler, scopeKey]);
  const disposalTokensRef = useRef(new WeakMap<MaterialPreviewGroupRenderer, object>());
  useEffect(() => {
    renderer.invalidateProjectResources();
  }, [generation, renderer]);
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
  return <GroupRendererContext.Provider value={renderer}>{children}</GroupRendererContext.Provider>;
}

export function MaterialPreviewGroupRendererBridge({
  renderer,
  children,
}: {
  renderer: MaterialPreviewGroupRenderer;
  children: ReactNode;
}) {
  return <GroupRendererContext.Provider value={renderer}>{children}</GroupRendererContext.Provider>;
}

export function useOptionalMaterialPreviewGroupRenderer() {
  return useContext(GroupRendererContext);
}

export function useMaterialPreviewGroupRenderer() {
  const renderer = useOptionalMaterialPreviewGroupRenderer();
  if (!renderer) throw new Error('Material preview group renderer is not available.');
  return renderer;
}

export function useMaterialPreviewGroupStatus(): MaterialPreviewGroupRendererStatus {
  const renderer = useMaterialPreviewGroupRenderer();
  return useSyncExternalStore(
    (listener) => renderer.subscribe(listener),
    () => renderer.status,
    () => renderer.status,
  );
}
