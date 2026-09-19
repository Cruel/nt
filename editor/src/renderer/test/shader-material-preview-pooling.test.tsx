import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { render } from '@testing-library/react';
import { WorkbenchGroup } from '@/workbench/WorkbenchGroup';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import {
  MaterialPreviewGroupProvider,
  MaterialPreviewProjectProvider,
} from '@/material-preview/material-preview-provider';
import type {
  WorkbenchGroup as WorkbenchGroupModel,
  WorkbenchTab,
} from '@/workbench/workbench-types';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

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

const nonPreviewTab: WorkbenchTab = {
  id: 'tab:non-preview',
  title: 'Non Preview',
  editorType: 'missing-test-editor',
  resource: { kind: 'tool', stableId: 'tool:non-preview' },
};

function group(activeTabId: string | null): WorkbenchGroupModel {
  return { id: 'root', activeTabId, tabIds: [materialTab.id, nonPreviewTab.id] };
}

function renderGroup(model: WorkbenchGroupModel) {
  return render(
    <MaterialPreviewProjectProvider>
      <MaterialPreviewGroupProvider backendFactory={noWebGlBackend}>
        <WorkbenchTabDndContext>
          <WorkbenchGroup group={model} tabs={[materialTab, nonPreviewTab]} />
        </WorkbenchTabDndContext>
      </MaterialPreviewGroupProvider>
    </MaterialPreviewProjectProvider>,
  );
}

function rerenderGroup(view: ReturnType<typeof render>, model: WorkbenchGroupModel) {
  view.rerender(
    <MaterialPreviewProjectProvider>
      <MaterialPreviewGroupProvider backendFactory={noWebGlBackend}>
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
});
