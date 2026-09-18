import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { render, waitFor } from '@testing-library/react';
import { WorkbenchGroup } from '@/workbench/WorkbenchGroup';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import type {
  WorkbenchGroup as WorkbenchGroupModel,
  WorkbenchTab,
} from '@/workbench/workbench-types';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { PreviewToEditorMessage } from '../../shared/preview-protocol';

const previewControllers = vi.hoisted(() => ({
  created: 0,
  resetCalls: 0,
  setPreviewModeCalls: [] as string[],
  loadPreviewDocumentCalls: [] as Array<{
    kind: string;
    recordId: string;
    revision: string;
    data: Record<string, unknown>;
  }>,
}));

vi.mock('@/hooks/use-engine-preview', () => ({
  useEnginePreview: (
    options: {
      onReady?: () => void;
      onMessage?: (message: PreviewToEditorMessage) => void;
    } = {},
  ) => {
    previewControllers.created += 1;
    const hostIndex = previewControllers.created;
    queueMicrotask(() => {
      options.onReady?.();
      options.onMessage?.({
        version: 1,
        type: 'ready',
        capabilities: [],
        hostGeneration: 1,
        transportGeneration: 1,
        activeShaderVariant: 'glsl-330',
      });
    });
    return {
      iframeRef: { current: null },
      iframeKey: hostIndex,
      iframeSrc: `http://127.0.0.1:5000/?sessionToken=test-token-${hostIndex}`,
      session: null,
      loadSession: vi.fn().mockResolvedValue({
        url: `http://127.0.0.1:5000/?sessionToken=test-token-${hostIndex}`,
        origin: 'http://127.0.0.1:5000',
        sessionToken: `test-token-${hostIndex}`,
      }),
      reset: vi.fn(async () => {
        previewControllers.resetCalls += 1;
      }),
      setEngineSettings: vi.fn().mockResolvedValue(undefined),
      setPreviewWheelRouting: vi.fn().mockResolvedValue(undefined),
      setPreviewMode: vi.fn(async (mode: string) => {
        previewControllers.setPreviewModeCalls.push(mode);
      }),
      loadPreviewDocument: vi.fn(
        async (document: {
          kind: string;
          recordId: string;
          revision: string;
          data: Record<string, unknown>;
        }) => {
          previewControllers.loadPreviewDocumentCalls.push(document);
        },
      ),
      applyFocusedEditorDocument: vi.fn().mockResolvedValue(undefined),
    };
  },
}));

vi.mock('@/components/engine-preview-host', () => ({
  EnginePreviewHost: ({ iframeSrc }: { iframeSrc: string | null }) => (
    <iframe title="NovelTea engine preview" src={iframeSrc ?? undefined} />
  ),
}));

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
    <WorkbenchTabDndContext>
      <WorkbenchGroup group={model} tabs={[materialTab, nonPreviewTab]} />
    </WorkbenchTabDndContext>,
  );
}

function rerenderGroup(view: ReturnType<typeof render>, model: WorkbenchGroupModel) {
  view.rerender(
    <WorkbenchTabDndContext>
      <WorkbenchGroup group={model} tabs={[materialTab, nonPreviewTab]} />
    </WorkbenchTabDndContext>,
  );
}

function hostElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-preview-host-id]')];
}

beforeEach(() => {
  previewControllers.created = 0;
  previewControllers.resetCalls = 0;
  previewControllers.setPreviewModeCalls = [];
  previewControllers.loadPreviewDocumentCalls = [];
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
  });
});

describe('Material persistent previews', () => {
  it('loads the canonical preset-backed Material preview payload', async () => {
    const view = renderGroup(group(materialTab.id));

    await waitFor(() =>
      expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('panel'),
    );
    expect(previewControllers.loadPreviewDocumentCalls.at(-1)).toMatchObject({
      kind: 'material-preview',
      recordId: 'panel',
      data: expect.objectContaining({
        schema: 'noveltea.shader-preview',
        material: 'panel',
        shaderMaterials: expect.objectContaining({ schema: 'noveltea.shader-materials' }),
        diagnostics: [],
      }),
    });
    expect(previewControllers.setPreviewModeCalls).toContain('material');
    expect(hostElements(view.container)).toHaveLength(1);
  });

  it('releases and reclaims the warm Material preview host without creating a Shader-record host', async () => {
    const view = renderGroup(group(materialTab.id));
    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls).toHaveLength(1));
    const host = hostElements(view.container)[0]!;
    const iframe = host.querySelector('iframe');

    rerenderGroup(view, group(nonPreviewTab.id));
    await waitFor(() => expect(host).not.toHaveAttribute('data-preview-host-claimed'));

    rerenderGroup(view, group(materialTab.id));
    await waitFor(() => expect(host).toHaveAttribute('data-preview-host-claimed', 'true'));
    expect(host.querySelector('iframe')).toBe(iframe);
  });
});
