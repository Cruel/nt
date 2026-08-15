import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { InteractableEditor } from '@/editors/interactables/InteractableEditor';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import {
  captureWorkbenchTabState,
  clearWorkbenchTabStates,
  useWorkbenchTabStateStore,
} from '@/workbench/workbench-tab-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { invokeWorkbenchTargetHandler } from '@/workbench/workbench-navigation';

const tab: WorkbenchTab = {
  id: 'tab:interactable-detail:interactables:door',
  title: 'Door',
  editorType: 'interactable-detail',
  resource: {
    kind: 'record',
    stableId: 'record:interactables:door',
    collection: 'interactables',
    entityId: 'door',
  },
};

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  clearWorkbenchTabStates();
  vi.mocked(window.noveltea.resolveProjectOriginalAssetUrl).mockReset();
  vi.mocked(window.noveltea.resolveProjectOriginalAssetUrl).mockResolvedValue({
    ok: false,
    code: 'stale-or-unknown',
    boundaryCode: 'stale-project-session',
  });
});

describe('InteractableEditor', () => {
  it('loads hotspot geometry from the full-resolution bounded Asset source', async () => {
    const project = createAuthoringProject();
    project.assets.sprite = {
      id: 'sprite',
      label: 'Door Sprite',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/door.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1234,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 2048, height: 1024, hasAlpha: true, orientation: 1 },
      },
    };
    const data = defaultInteractableData('Door');
    data.presentation.sprite = { $ref: { collection: 'assets', id: 'sprite' } };
    project.interactables.door = {
      id: 'door',
      label: 'Door',
      extends: null,
      properties: {},
      data,
    };
    vi.mocked(window.noveltea.resolveProjectOriginalAssetUrl).mockResolvedValue({
      ok: true,
      url: 'noveltea-asset://source/11111111-1111-4111-8111-111111111111/sprite',
    });
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: '11111111-1111-4111-8111-111111111111',
    });

    const view = render(<InteractableEditor tab={tab} />);

    await waitFor(() =>
      expect(window.noveltea.resolveProjectOriginalAssetUrl).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        'sprite',
      ),
    );
    expect(window.noveltea.resolveProjectOriginalAssetUrl).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[data-image-layer] img')).toHaveAttribute(
      'src',
      'noveltea-asset://source/11111111-1111-4111-8111-111111111111/sprite',
    );
  });

  it('fails closed for unavailable or non-image hotspot sources without thumbnail fallback', async () => {
    const project = createAuthoringProject();
    project.assets.sound = {
      id: 'sound',
      label: 'Door Sound',
      data: {
        kind: 'audio',
        source: { type: 'project-file', path: 'assets/audio/door.ogg' },
        aliases: [],
        byteSize: 12,
        contentHash: `sha256:${'b'.repeat(64)}`,
        imageMetadata: null,
      },
    };
    const data = defaultInteractableData('Door');
    data.presentation.sprite = { $ref: { collection: 'assets', id: 'sound' } };
    project.interactables.door = {
      id: 'door',
      label: 'Door',
      extends: null,
      properties: {},
      data,
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: '11111111-1111-4111-8111-111111111111',
    });

    const view = render(<InteractableEditor tab={tab} />);
    await Promise.resolve();

    expect(window.noveltea.resolveProjectOriginalAssetUrl).not.toHaveBeenCalled();
    expect(window.noveltea.requestImageThumbnail).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-image-layer] img')).toBeNull();
  });
  it('captures the shared version-1 hotspot view state in its owner tab state', () => {
    const project = createAuthoringProject();
    project.interactables.door = {
      id: 'door',
      label: 'Door',
      extends: null,
      properties: {},
      data: defaultInteractableData('Door'),
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    render(<InteractableEditor tab={tab} />);
    captureWorkbenchTabState(tab.id);
    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toMatchObject({
      schema: 'noveltea.editor.tab-state.interactable',
      schemaVersion: 1,
      payload: {
        hotspotView: {
          schema: 'noveltea.editor.hotspot-view',
          schemaVersion: 1,
          tool: 'select',
          selectedHotspotId: null,
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
    });
  });

  it('selects an exact hotspot when workbench diagnostic navigation targets it', () => {
    const project = createAuthoringProject();
    const data = defaultInteractableData('Door');
    data.presentation.hotspots = {
      kind: 'custom',
      hotspots: [
        {
          id: 'handle',
          label: 'Handle',
          condition: { kind: 'always' },
          inputOrder: 0,
          highlight: { kind: 'none' },
          activation: { kind: 'verb', verb: null },
          shape: { kind: 'rect', bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
        },
      ],
    };
    project.interactables.door = {
      id: 'door',
      label: 'Door',
      extends: null,
      properties: {},
      data,
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    render(<InteractableEditor tab={tab} />);

    act(() => {
      invokeWorkbenchTargetHandler(tab.id, {
        id: 'interactable.hotspot.handle',
        requestId: 1,
        block: 'center',
        flash: true,
      });
    });
    captureWorkbenchTabState(tab.id);

    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]?.payload).toMatchObject({
      hotspotView: { selectedHotspotId: 'handle' },
    });
  });
});
