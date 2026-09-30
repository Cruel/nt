import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, render, waitFor } from '@testing-library/react';
import { WorkbenchGroup } from '@/workbench/WorkbenchGroup';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import {
  MaterialPreviewGroupProvider,
  MaterialPreviewProjectProvider,
} from '@/material-preview/material-preview-provider';
import { MaterialPreview } from '@/material-preview/MaterialPreview';
import { MaterialPreviewProjectResources } from '@/material-preview/material-preview-resources';
import { WorkbenchEditorLocationProvider } from '@/workbench/workbench-editor-location';
import {
  AuthoringWebGlGroupProvider,
  AuthoringWebGlGroupRendererBridge,
} from '@/authoring-renderer/authoring-webgl-provider';
import {
  AuthoringWebGlGroupRenderer,
  type AuthoringWebGlBackendFactory,
  type AuthoringWebGlScheduler,
} from '@/authoring-renderer/authoring-webgl-renderer';
import type {
  WorkbenchGroup as WorkbenchGroupModel,
  WorkbenchTab,
} from '@/workbench/workbench-types';
import {
  defaultMaterialData,
  resolveMaterialData,
} from '../../shared/project-schema/authoring-materials';
import { emptyMaterialApplication } from '../../shared/project-schema/authoring-material-applications';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { RoomEditSurface } from '@/editors/rooms/RoomEditSurface';

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div data-testid="resize-separator" />,
}));

const materialTab: WorkbenchTab = {
  id: 'tab:material-detail:materials:panel',
  title: 'Panel',
  editorType: 'material-detail',
  resource: {
    kind: 'record',
    stableId: 'record:materials:panel',
    collection: 'materials',
    entityId: 'panel',
  },
};

const noWebGlBackend = () => null;

function manualScheduler() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const scheduler: AuthoringWebGlScheduler = {
    request: vi.fn((callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    }),
    cancel: vi.fn((id) => callbacks.delete(id)),
  };
  return {
    scheduler,
    flush(timestamp = 1000) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(timestamp);
    },
  };
}

const nonPreviewTab: WorkbenchTab = {
  id: 'tab:non-preview',
  title: 'Non Preview',
  editorType: 'missing-test-editor',
  resource: { kind: 'tool', stableId: 'tool:non-preview' },
};

function group(activeTabId: string | null): WorkbenchGroupModel {
  return { id: 'root', activeTabId, tabIds: [materialTab.id, nonPreviewTab.id] };
}

function renderGroup(
  model: WorkbenchGroupModel,
  backendFactory: AuthoringWebGlBackendFactory = noWebGlBackend,
) {
  return render(
    <MaterialPreviewProjectProvider>
      <MaterialPreviewGroupProvider backendFactory={backendFactory}>
        <WorkbenchTabDndContext>
          <WorkbenchGroup group={model} tabs={[materialTab, nonPreviewTab]} />
        </WorkbenchTabDndContext>
      </MaterialPreviewGroupProvider>
    </MaterialPreviewProjectProvider>,
  );
}

function rerenderGroup(
  view: ReturnType<typeof render>,
  model: WorkbenchGroupModel,
  backendFactory: AuthoringWebGlBackendFactory = noWebGlBackend,
) {
  view.rerender(
    <MaterialPreviewProjectProvider>
      <MaterialPreviewGroupProvider backendFactory={backendFactory}>
        <WorkbenchTabDndContext>
          <WorkbenchGroup group={model} tabs={[materialTab, nonPreviewTab]} />
        </WorkbenchTabDndContext>
      </MaterialPreviewGroupProvider>
    </MaterialPreviewProjectProvider>,
  );
}

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useWorkbenchStore.getState().resetWorkbench();
  useProjectStore.getState().clearProject();

  const project = createAuthoringProject();
  project.materials.panel = {
    id: 'panel',
    label: 'Panel',
    data: defaultMaterialData('Panel', 'engine-2d'),
  };
  useProjectStore.getState().loadProjectDocument({
    document: project,
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
    projectSessionId: 'session:material-preview',
  });
});

describe('Material lightweight previews', () => {
  it('shares one group GPU authority between Material Preview and Room Edit', async () => {
    const clock = manualScheduler();
    const drawMaterial = vi.fn();
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel', 'engine-2d'),
    };
    const room = defaultRoomData('Foyer');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
      projectSessionId: 'session:material-preview',
    });
    const backendFactory: AuthoringWebGlBackendFactory = vi.fn(() => ({
      frame: vi.fn((timeSeconds) => ({
        timeSeconds,
        beginTarget: vi.fn(),
        drawMaterial,
        copyTargetToCanvas: vi.fn(),
      })),
      invalidateProjectResources: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    }));

    render(
      <MaterialPreviewProjectProvider>
        <AuthoringWebGlGroupProvider backendFactory={backendFactory} scheduler={clock.scheduler}>
          <MaterialPreviewGroupProvider>
            <MaterialPreview materialId="panel" />
            <RoomEditSurface
              project={project}
              roomId="foyer"
              room={room}
              referenceResolution={{ width: 1920, height: 1080 }}
              backgroundImageSize={null}
              roomPropertyValues={{}}
            />
          </MaterialPreviewGroupProvider>
        </AuthoringWebGlGroupProvider>
      </MaterialPreviewProjectProvider>,
    );

    await waitFor(() => expect(backendFactory).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      act(() => clock.flush(2500));
      expect(backendFactory).toHaveBeenCalledTimes(1);
    });
    expect(backendFactory).toHaveBeenCalledTimes(1);
  });

  it('renders Room color through projected geometry and binds white for Material-only visuals', async () => {
    const clock = manualScheduler();
    const beginTarget = vi.fn();
    const drawMaterial = vi.fn();
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel', 'engine-2d'),
    };
    const room = defaultRoomData('Foyer');
    room.background.color = '#336699';
    room.background.materialApplication = emptyMaterialApplication('panel');
    room.presentationSpace.defaultView = {
      center: { x: 960, y: 540 },
      zoom: 0.5,
      rotationDegrees: 15,
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
      projectSessionId: 'session:material-preview',
    });
    const backendFactory: AuthoringWebGlBackendFactory = vi.fn(() => ({
      frame: vi.fn((timeSeconds) => ({
        timeSeconds,
        beginTarget,
        drawMaterial,
        copyTargetToCanvas: vi.fn(),
      })),
      invalidateProjectResources: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    }));

    render(
      <MaterialPreviewProjectProvider>
        <AuthoringWebGlGroupProvider backendFactory={backendFactory} scheduler={clock.scheduler}>
          <MaterialPreviewGroupProvider>
            <RoomEditSurface
              project={project}
              roomId="foyer"
              room={room}
              referenceResolution={{ width: 1920, height: 1080 }}
              backgroundImageSize={null}
              roomPropertyValues={{}}
            />
          </MaterialPreviewGroupProvider>
        </AuthoringWebGlGroupProvider>
      </MaterialPreviewProjectProvider>,
    );

    await waitFor(() => {
      act(() => clock.flush(2500));
      expect(drawMaterial.mock.calls.some(([draw]) => draw.resource.materialId === 'panel')).toBe(
        true,
      );
    });

    expect(beginTarget).toHaveBeenCalledWith(1920, 1080, [0, 0, 0, 0]);
    const colorDraw = drawMaterial.mock.calls
      .map(([draw]) => draw)
      .find((draw) => draw.resource.materialId === '__room-edit-default-engine-2d');
    expect(colorDraw?.rendererTextures?.s_texColor?.fallbackColor).toEqual([0.2, 0.4, 0.6, 1]);
    expect(colorDraw?.modelViewProjection).not.toEqual(
      new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    );
    const materialOnlyDraw = drawMaterial.mock.calls
      .map(([draw]) => draw)
      .find((draw) => draw.resource.materialId === 'panel');
    expect(materialOnlyDraw?.rendererTextures?.s_texColor?.fallbackColor).toEqual([1, 1, 1, 1]);
  });

  it('refreshes prepared Room Edit resources when the Project resource generation changes', async () => {
    const clock = manualScheduler();
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel', 'engine-2d'),
    };
    const room = defaultRoomData('Foyer');
    room.background.materialApplication = emptyMaterialApplication('panel');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
      projectSessionId: 'session:material-preview',
    });
    const getMaterial = vi
      .spyOn(MaterialPreviewProjectResources.prototype, 'getMaterial')
      .mockResolvedValue({
        materialId: 'panel',
        revision: 'test',
        resolved: resolveMaterialData(project, 'panel').data!,
        derivedInterface: null,
        vertexShaderSource: null,
        fragmentShaderSource: null,
        textures: {},
        diagnostics: [],
        compileDiagnostics: [],
        stale: false,
      });
    const backendFactory: AuthoringWebGlBackendFactory = vi.fn(() => ({
      frame: vi.fn((timeSeconds) => ({
        timeSeconds,
        beginTarget: vi.fn(),
        drawMaterial: vi.fn(),
        copyTargetToCanvas: vi.fn(),
      })),
      invalidateProjectResources: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    }));

    try {
      render(
        <MaterialPreviewProjectProvider>
          <AuthoringWebGlGroupProvider backendFactory={backendFactory} scheduler={clock.scheduler}>
            <MaterialPreviewGroupProvider>
              <RoomEditSurface
                project={project}
                roomId="foyer"
                room={room}
                referenceResolution={{ width: 1920, height: 1080 }}
                backgroundImageSize={null}
                roomPropertyValues={{}}
              />
            </MaterialPreviewGroupProvider>
          </AuthoringWebGlGroupProvider>
        </MaterialPreviewProjectProvider>,
      );

      await waitFor(() => expect(getMaterial).toHaveBeenCalled());
      const initialCalls = getMaterial.mock.calls.length;
      const nextProject = structuredClone(project);
      act(() => {
        useProjectStore.getState().loadProjectDocument({
          document: nextProject,
          projectPath: '/mock',
          projectFilePath: '/mock/project.json',
          projectSessionId: 'session:material-preview',
        });
      });

      await waitFor(() => expect(getMaterial.mock.calls.length).toBeGreaterThan(initialCalls));
    } finally {
      getMaterial.mockRestore();
    }
  });

  it('keeps the group renderer alive through React StrictMode effect replay', async () => {
    const renderFrame = vi.fn();
    const dispose = vi.fn();
    const backendFactory: AuthoringWebGlBackendFactory = vi.fn(() => ({
      frame: vi.fn((timeSeconds) => ({
        timeSeconds,
        beginTarget: vi.fn(),
        drawMaterial: renderFrame,
        copyTargetToCanvas: vi.fn(),
      })),
      invalidateProjectResources: vi.fn(),
      reset: vi.fn(),
      dispose,
    }));
    const authority = new AuthoringWebGlGroupRenderer(backendFactory);
    const authoringSubscriptions = () =>
      (authority as unknown as { listeners: Set<() => void> }).listeners.size;

    try {
      const { unmount } = render(
        <StrictMode>
          <MaterialPreviewProjectProvider>
            <AuthoringWebGlGroupRendererBridge renderer={authority}>
              <MaterialPreviewGroupProvider>
                <MaterialPreview materialId="panel" />
              </MaterialPreviewGroupProvider>
            </AuthoringWebGlGroupRendererBridge>
          </MaterialPreviewProjectProvider>
        </StrictMode>,
      );

      await waitFor(() => expect(renderFrame).toHaveBeenCalled());
      expect(dispose).not.toHaveBeenCalled();
      expect(authoringSubscriptions()).toBe(1);

      unmount();
      await waitFor(() => expect(authoringSubscriptions()).toBe(0));
    } finally {
      authority.dispose();
    }
  });

  it('does not let IntersectionObserver suppress a full editor preview', async () => {
    class NeverIntersectingObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ isIntersecting: false, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];
    }
    vi.stubGlobal('IntersectionObserver', NeverIntersectingObserver);
    try {
      const project = createAuthoringProject();
      project.materials.panel = {
        id: 'panel',
        label: 'Panel',
        data: defaultMaterialData('Panel', 'engine-2d'),
      };
      const resources = new MaterialPreviewProjectResources({
        compileShaders: vi.fn().mockResolvedValue([]),
        resolveAssetUrl: vi.fn().mockResolvedValue(null),
        decodeImage: vi.fn().mockResolvedValue(null),
      });
      resources.updateProject(project);
      const getMaterial = vi.spyOn(resources, 'getMaterial');

      render(
        <MaterialPreviewProjectProvider>
          <MaterialPreviewGroupProvider backendFactory={noWebGlBackend}>
            <WorkbenchEditorLocationProvider
              location={{
                tabId: 'material',
                groupId: 'root',
                isActiveInGroup: true,
                isVisible: true,
              }}
            >
              <MaterialPreview materialId="panel" resources={resources} />
            </WorkbenchEditorLocationProvider>
          </MaterialPreviewGroupProvider>
        </MaterialPreviewProjectProvider>,
      );

      await waitFor(() => expect(getMaterial).toHaveBeenCalled());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('suspends a preview retained inside a hidden persistent editor host', async () => {
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel', 'engine-2d'),
    };
    const resources = new MaterialPreviewProjectResources({
      compileShaders: vi.fn().mockResolvedValue([]),
      resolveAssetUrl: vi.fn().mockResolvedValue(null),
      decodeImage: vi.fn().mockResolvedValue(null),
    });
    resources.updateProject(project);
    const getMaterial = vi.spyOn(resources, 'getMaterial');
    const renderPreview = (isVisible: boolean) => (
      <MaterialPreviewProjectProvider>
        <MaterialPreviewGroupProvider backendFactory={noWebGlBackend}>
          <WorkbenchEditorLocationProvider
            location={{ tabId: 'source', groupId: 'root', isActiveInGroup: isVisible, isVisible }}
          >
            <MaterialPreview materialId="panel" resources={resources} />
          </WorkbenchEditorLocationProvider>
        </MaterialPreviewGroupProvider>
      </MaterialPreviewProjectProvider>
    );

    const view = render(renderPreview(false));
    await Promise.resolve();
    expect(getMaterial).not.toHaveBeenCalled();

    view.rerender(renderPreview(true));
    await waitFor(() => expect(getMaterial).toHaveBeenCalled());
  });

  it('uses a reusable lightweight Material canvas instead of an engine-preview iframe', () => {
    const view = renderGroup(group(materialTab.id));

    expect(view.container.querySelector('[data-material-preview="panel"]')).not.toBeNull();
    expect(view.container.querySelector('[data-preview-host-id]')).toBeNull();
    expect(view.container.querySelector('iframe')).toBeNull();
  });

  it('registers only while the Material preview surface is mounted', () => {
    const view = renderGroup(group(materialTab.id));
    expect(view.container.querySelector('[data-material-preview="panel"]')).not.toBeNull();

    rerenderGroup(view, group(nonPreviewTab.id));
    expect(view.container.querySelector('[data-material-preview="panel"]')).toBeNull();

    rerenderGroup(view, group(materialTab.id));
    expect(view.container.querySelector('[data-material-preview="panel"]')).not.toBeNull();
  });

  it('recreates the group renderer when the active Project session changes', async () => {
    const disposals: Array<ReturnType<typeof vi.fn>> = [];
    const backendFactory: AuthoringWebGlBackendFactory = vi.fn(() => {
      const dispose = vi.fn();
      disposals.push(dispose);
      return {
        frame: vi.fn((timeSeconds) => ({
          timeSeconds,
          beginTarget: vi.fn(),
          drawMaterial: vi.fn(),
          copyTargetToCanvas: vi.fn(),
        })),
        invalidateProjectResources: vi.fn(),
        reset: vi.fn(),
        dispose,
      };
    });
    renderGroup(group(materialTab.id), backendFactory);
    await waitFor(() => expect(backendFactory).toHaveBeenCalledTimes(1));

    const nextProject = createAuthoringProject();
    nextProject.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel', 'engine-2d'),
    };
    act(() => {
      expect(
        useProjectStore.getState().loadProjectDocument({
          document: nextProject,
          projectPath: '/mock/next',
          projectFilePath: '/mock/next/project.json',
          projectSessionId: 'session:material-preview:next',
        }),
      ).toBe(true);
    });

    await waitFor(() => expect(backendFactory).toHaveBeenCalledTimes(2));
    expect(disposals[0]).toHaveBeenCalledTimes(1);
  });
});
