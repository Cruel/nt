import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
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
});

describe('InteractableEditor', () => {
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
