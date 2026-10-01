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
import { AuthoringWebGlShaderProgramError } from '@/authoring-renderer/authoring-webgl-backend';

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
  it('stops Room Edit scene work while its visual pane is hidden and resumes without recreating the backend', () => {
    const clock = manualScheduler();
    const frame = vi.fn((timeSeconds) => ({
      timeSeconds,
      beginTarget: vi.fn(),
      drawMaterial: vi.fn(),
      copyTargetToCanvas: vi.fn(),
    }));
    const backendFactory: AuthoringWebGlBackendFactory = vi.fn(() => ({
      frame,
      invalidateProjectResources: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    }));
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const renderSurface = (visible: boolean) => (
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
              visible={visible}
            />
          </MaterialPreviewGroupProvider>
        </AuthoringWebGlGroupProvider>
      </MaterialPreviewProjectProvider>
    );
    const view = render(renderSurface(false));

    act(() => clock.flush(1000));
    expect(frame).not.toHaveBeenCalled();
    expect(backendFactory).toHaveBeenCalledTimes(1);

    view.rerender(renderSurface(true));
    act(() => clock.flush(2000));
    expect(frame).toHaveBeenCalledTimes(1);
    expect(backendFactory).toHaveBeenCalledTimes(1);

    view.rerender(renderSurface(false));
    act(() => clock.flush(3000));
    expect(frame).toHaveBeenCalledTimes(1);
  });

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
    expect(materialOnlyDraw?.semanticInputs).toMatchObject({
      'engine.time': 2.5,
      'engine.paint_dimensions': [960, 540],
      'engine.reference_to_world_raster_scale': [1, 1],
      'engine.context_logical_to_raster_scale': [1, 1],
      'engine.viewport_pixel_dimensions': [1920, 1080],
    });
  });

  it('keeps Room Material authored geometry facets independent from Edit navigation', async () => {
    const clock = manualScheduler();
    const drawMaterial = vi.fn();
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel', 'engine-2d'),
    };
    const room = defaultRoomData('Foyer');
    room.background.materialApplication = {
      ...emptyMaterialApplication('panel'),
      parameters: {
        u_width: { type: 'float', source: { kind: 'standard-facet', facet: 'paint-width' } },
        u_height: { type: 'float', source: { kind: 'standard-facet', facet: 'paint-height' } },
        u_camera: { type: 'float', source: { kind: 'standard-facet', facet: 'camera-zoom' } },
      },
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
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

    const renderSurface = (navigation: { zoom: number; pan: { x: number; y: number } }) => (
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
              navigation={navigation}
            />
          </MaterialPreviewGroupProvider>
        </AuthoringWebGlGroupProvider>
      </MaterialPreviewProjectProvider>
    );
    const view = render(renderSurface({ zoom: 1, pan: { x: 0, y: 0 } }));

    await waitFor(() => {
      act(() => clock.flush(1000));
      expect(drawMaterial.mock.calls.some(([draw]) => draw.resource.materialId === 'panel')).toBe(
        true,
      );
    });
    const first = drawMaterial.mock.calls
      .map(([draw]) => draw)
      .find((draw) => draw.resource.materialId === 'panel');
    drawMaterial.mockClear();

    view.rerender(renderSurface({ zoom: 2, pan: { x: 100, y: -50 } }));
    act(() => clock.flush(2000));
    const second = drawMaterial.mock.calls
      .map(([draw]) => draw)
      .find((draw) => draw.resource.materialId === 'panel');

    expect(first?.parameterOverrides).toMatchObject({ u_width: 1920, u_height: 1080, u_camera: 1 });
    expect(second?.parameterOverrides).toEqual(first?.parameterOverrides);
    expect(second?.modelViewProjection).not.toEqual(first?.modelViewProjection);
  });

  it('uses occurrence-relative time for Environment UV motion and Material occurrence-time', async () => {
    const clock = manualScheduler();
    const drawMaterial = vi.fn();
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel', 'engine-2d'),
    };
    const room = defaultRoomData('Foyer');
    room.environments = [
      {
        id: 'fog',
        condition: { kind: 'always' },
        asset: null,
        materialApplication: {
          ...emptyMaterialApplication('panel'),
          parameters: {
            u_time: {
              type: 'float',
              source: { kind: 'standard-facet', facet: 'occurrence-time' },
            },
          },
        },
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        plane: 'world-content',
        order: 0,
        clock: 'gameplay',
        scrollPerSecond: { x: 0.25, y: -0.5 },
        opacity: 1,
        visible: true,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
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
    const renderSurface = (value: typeof room) => (
      <MaterialPreviewProjectProvider>
        <AuthoringWebGlGroupProvider backendFactory={backendFactory} scheduler={clock.scheduler}>
          <MaterialPreviewGroupProvider>
            <RoomEditSurface
              project={project}
              roomId="foyer"
              room={value}
              referenceResolution={{ width: 1920, height: 1080 }}
              backgroundImageSize={null}
              roomPropertyValues={{}}
            />
          </MaterialPreviewGroupProvider>
        </AuthoringWebGlGroupProvider>
      </MaterialPreviewProjectProvider>
    );
    const view = render(renderSurface(room));

    await waitFor(() => {
      act(() => clock.flush(10_000_000));
      expect(drawMaterial).toHaveBeenCalled();
    });
    let fogDraw = drawMaterial.mock.calls
      .map(([draw]) => draw)
      .find((draw) => draw.resource.materialId === 'panel');
    expect(fogDraw?.parameterOverrides?.u_time).toBe(0);
    expect(fogDraw?.semanticInputs?.['engine.time']).toBe(0);
    expect(fogDraw?.geometry.uv).toEqual({ x: 0, y: -0, width: 1, height: 1 });

    drawMaterial.mockClear();
    act(() => clock.flush(10_002_500));
    fogDraw = drawMaterial.mock.calls
      .map(([draw]) => draw)
      .find((draw) => draw.resource.materialId === 'panel');
    expect(fogDraw?.parameterOverrides?.u_time).toBeCloseTo(2.5);
    expect(fogDraw?.semanticInputs?.['engine.time']).toBeCloseTo(2.5);
    expect(fogDraw?.geometry.uv).toEqual({ x: 0.625, y: -1.25, width: 1, height: 1 });

    const withoutFog = structuredClone(room);
    withoutFog.environments = [];
    view.rerender(renderSurface(withoutFog));
    act(() => clock.flush(15_000_000));

    drawMaterial.mockClear();
    view.rerender(renderSurface(room));
    act(() => clock.flush(25_000_000));
    fogDraw = drawMaterial.mock.calls
      .map(([draw]) => draw)
      .find((draw) => draw.resource.materialId === 'panel');
    expect(fogDraw?.parameterOverrides?.u_time).toBe(0);
    expect(fogDraw?.semanticInputs?.['engine.time']).toBe(0);
    expect(fogDraw?.geometry.uv).toEqual({ x: 0, y: -0, width: 1, height: 1 });
  });

  it('completes Room draws and copies the frame before reporting a stale shader', async () => {
    const clock = manualScheduler();
    const copyTargetToCanvas = vi.fn();
    let materialDraws = 0;
    const drawMaterial = vi.fn((draw) => {
      if (draw.resource.materialId !== 'panel') return;
      materialDraws += 1;
      if (materialDraws === 1) throw new AuthoringWebGlShaderProgramError(true, 'stale shader');
    });
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel', 'engine-2d'),
    };
    const room = defaultRoomData('Foyer');
    room.background.materialApplication = emptyMaterialApplication('panel');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = [
      {
        id: 'lamp',
        condition: { kind: 'always' },
        placementId: 'desk',
        asset: null,
        materialApplication: emptyMaterialApplication('panel'),
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const backendFactory: AuthoringWebGlBackendFactory = vi.fn(() => ({
      frame: vi.fn((timeSeconds) => ({
        timeSeconds,
        beginTarget: vi.fn(),
        drawMaterial,
        copyTargetToCanvas,
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
      act(() => clock.flush(1000));
      expect(materialDraws).toBeGreaterThanOrEqual(2);
    });
    expect(copyTargetToCanvas).toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="room-edit-renderer-diagnostic"]'),
    ).toHaveTextContent(
      'Room Edit is using the last valid shader program. Current shader error: stale shader',
    );
  });

  it('does not copy a Room frame after a hard shader failure without last-good state', async () => {
    const clock = manualScheduler();
    const renderEvents: string[] = [];
    const copyTargetToCanvas = vi.fn(() => renderEvents.push('copy'));
    const drawMaterial = vi.fn((draw) => {
      if (draw.resource.materialId === 'panel') {
        renderEvents.push('hard-failure');
        throw new AuthoringWebGlShaderProgramError(false, 'hard shader failure');
      }
    });
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel', 'engine-2d'),
    };
    const room = defaultRoomData('Foyer');
    room.background.materialApplication = emptyMaterialApplication('panel');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const backendFactory: AuthoringWebGlBackendFactory = vi.fn(() => ({
      frame: vi.fn((timeSeconds) => ({
        timeSeconds,
        beginTarget: vi.fn(),
        drawMaterial,
        copyTargetToCanvas,
      })),
      invalidateProjectResources: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
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
      await waitFor(() => {
        act(() => clock.flush(1000));
        expect(
          document.querySelector('[data-testid="room-edit-renderer-diagnostic"]'),
        ).toHaveTextContent('Room Edit cannot render the current shader: hard shader failure');
      });
      const hardFailureIndex = renderEvents.indexOf('hard-failure');
      expect(hardFailureIndex).toBeGreaterThanOrEqual(0);
      expect(renderEvents.slice(hardFailureIndex + 1)).not.toContain('copy');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('shows shared authoring renderer availability loss and clears it on recovery', async () => {
    const clock = manualScheduler();
    const callbacks: Array<Parameters<AuthoringWebGlBackendFactory>[0]> = [];
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const backendFactory: AuthoringWebGlBackendFactory = vi.fn((options) => {
      callbacks.push(options);
      return {
        frame: vi.fn((timeSeconds) => ({
          timeSeconds,
          beginTarget: vi.fn(),
          drawMaterial: vi.fn(),
          copyTargetToCanvas: vi.fn(),
        })),
        invalidateProjectResources: vi.fn(),
        reset: vi.fn(),
        dispose: vi.fn(),
      };
    });

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

    await waitFor(() => expect(callbacks).toHaveLength(1));
    act(() => callbacks[0]!.onContextLost());
    expect(
      document.querySelector('[data-testid="room-edit-renderer-diagnostic"]'),
    ).toHaveTextContent('Room Edit rendering is temporarily unavailable while WebGL recovers.');

    act(() => callbacks[0]!.onContextRestored());
    await waitFor(() =>
      expect(document.querySelector('[data-testid="room-edit-renderer-diagnostic"]')).toBeNull(),
    );
  });

  it('shows WebGL2 unavailability through the shared Room Edit renderer status', async () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    render(
      <MaterialPreviewProjectProvider>
        <AuthoringWebGlGroupProvider backendFactory={noWebGlBackend}>
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

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="room-edit-renderer-diagnostic"]'),
      ).toHaveTextContent('Room Edit rendering requires WebGL2.'),
    );
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
