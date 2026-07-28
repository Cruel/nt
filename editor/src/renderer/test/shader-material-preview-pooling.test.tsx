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
import {
  defaultShaderData,
  shaderCompileInputFingerprint,
} from '../../shared/project-schema/authoring-shaders';
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
  applyFocusedDocumentCalls: [] as Array<{
    kind: string;
    recordId: string;
    revision: string;
    data: Record<string, unknown>;
  }>,
  nextResetPromise: null as Promise<void> | null,
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
        activeShaderVariant: 'glsl-120',
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
      reset: vi.fn(() => {
        previewControllers.resetCalls += 1;
        const pending = previewControllers.nextResetPromise;
        previewControllers.nextResetPromise = null;
        return pending ?? Promise.resolve();
      }),
      setPreviewWheelRouting: vi.fn().mockResolvedValue(undefined),
      setPreviewMode: vi.fn((mode: string) => {
        previewControllers.setPreviewModeCalls.push(mode);
        return Promise.resolve();
      }),
      loadPreviewDocument: vi.fn(
        (document: {
          kind: string;
          recordId: string;
          revision: string;
          data: Record<string, unknown>;
        }) => {
          previewControllers.loadPreviewDocumentCalls.push(document);
          return Promise.resolve();
        },
      ),
      applyFocusedEditorDocument: vi.fn(
        (document: {
          kind: string;
          recordId: string;
          revision: string;
          data: Record<string, unknown>;
        }) => {
          previewControllers.applyFocusedDocumentCalls.push(document);
          return Promise.resolve();
        },
      ),
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

vi.mock('@/components/source/SourceEditor', async () => {
  const React = await import('react');
  return {
    SourceEditor: React.forwardRef(function SourceEditor(
      {
        language = 'text',
        value,
        onChange,
      }: { language?: string; value: string; onChange?: (value: string) => void },
      ref: React.ForwardedRef<{
        captureViewState: () => {
          scroll: { scrollTop: number; scrollLeft: number };
          selection: unknown;
        };
        restoreViewState: (state: unknown) => void;
      }>,
    ) {
      const editorRef = React.useRef<HTMLTextAreaElement | null>(null);
      React.useImperativeHandle(ref, () => ({
        captureViewState: () => ({
          scroll: {
            scrollTop: editorRef.current?.scrollTop ?? 0,
            scrollLeft: editorRef.current?.scrollLeft ?? 0,
          },
          selection: {
            ranges: [
              {
                anchor: editorRef.current?.selectionStart ?? 0,
                head: editorRef.current?.selectionEnd ?? 0,
              },
            ],
            main: 0,
          },
        }),
        restoreViewState: (state) => {
          if (
            !editorRef.current ||
            typeof state !== 'object' ||
            state === null ||
            !('scroll' in state)
          )
            return;
          const scroll = (state as { scroll?: { scrollTop?: number; scrollLeft?: number } }).scroll;
          editorRef.current.scrollTop = scroll?.scrollTop ?? 0;
          editorRef.current.scrollLeft = scroll?.scrollLeft ?? 0;
        },
      }));
      return (
        <textarea
          ref={editorRef}
          aria-label={`source-${language}`}
          value={value}
          onChange={(event) => onChange?.(event.currentTarget.value)}
        />
      );
    }),
  };
});

const shaderTab: WorkbenchTab = {
  id: 'tab:shader-detail:shaders:noise',
  title: 'Noise',
  editorType: 'shader-detail',
  resource: {
    kind: 'record',
    stableId: 'record:shaders:noise',
    collection: 'shaders',
    entityId: 'noise',
  },
};

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

function group(
  activeTabId: string | null,
  tabIds: string[] = [shaderTab.id, materialTab.id, nonPreviewTab.id],
): WorkbenchGroupModel {
  return { id: 'root', activeTabId, tabIds };
}

function renderGroup(
  model: WorkbenchGroupModel,
  tabs: WorkbenchTab[] = [shaderTab, materialTab, nonPreviewTab],
) {
  return render(
    <WorkbenchTabDndContext>
      <WorkbenchGroup group={model} tabs={tabs} />
    </WorkbenchTabDndContext>,
  );
}

function rerenderGroup(
  view: ReturnType<typeof render>,
  model: WorkbenchGroupModel,
  tabs: WorkbenchTab[] = [shaderTab, materialTab, nonPreviewTab],
) {
  view.rerender(
    <WorkbenchTabDndContext>
      <WorkbenchGroup group={model} tabs={tabs} />
    </WorkbenchTabDndContext>,
  );
}

function hostElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-preview-host-id]')];
}

function resetPreviewControllerState() {
  previewControllers.created = 0;
  previewControllers.resetCalls = 0;
  previewControllers.setPreviewModeCalls = [];
  previewControllers.loadPreviewDocumentCalls = [];
  previewControllers.applyFocusedDocumentCalls = [];
  previewControllers.nextResetPromise = null;
}

beforeEach(() => {
  resetPreviewControllerState();
  useCommandStore.getState().resetCommandHistory();
  useWorkbenchStore.getState().resetWorkbench();
  useProjectStore.getState().clearProject();

  const project = createAuthoringProject();
  const shaderData = defaultShaderData('Noise');
  project.shaders.noise = { id: 'noise', label: 'Noise', data: shaderData };
  shaderData.stages.forEach((stage, stageIndex) => {
    stage.compiled['glsl-120'] = {
      path: `project:/shaders/bgfx/glsl-120/noise_${stage.stage}.bin`,
      byteHash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' as const,
      byteSize: 1024,
      compileInputFingerprint: shaderCompileInputFingerprint(
        project,
        'noise',
        stageIndex,
        'glsl-120',
      )!,
    };
  });
  project.materials.panel = {
    id: 'panel',
    label: 'Panel',
    data: defaultMaterialData('Panel', 'noise'),
  };
  useProjectStore.getState().loadProjectDocument({
    document: project,
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
  });
});

describe('Shader and Material pooled previews', () => {
  it('resets and replaces shader preview state when switching Shader to Material', async () => {
    const view = renderGroup(group(shaderTab.id));

    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.at(-1)?.recordId).toBe('noise'),
    );
    const firstHostId = hostElements(view.container)[0]?.dataset.previewHostId;

    rerenderGroup(view, group(materialTab.id));

    await waitFor(() =>
      expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('panel'),
    );
    expect(hostElements(view.container)).toHaveLength(1);
    expect(hostElements(view.container)[0]?.dataset.previewHostId).toBe(firstHostId);
    expect(previewControllers.resetCalls).toBe(1);
    expect(previewControllers.setPreviewModeCalls).toEqual(['material']);
    expect(previewControllers.applyFocusedDocumentCalls.map((call) => call.kind)).toEqual([
      'shader-preview',
    ]);
    expect(previewControllers.loadPreviewDocumentCalls.map((call) => call.kind)).toEqual([
      'material-preview',
    ]);
    expect(previewControllers.loadPreviewDocumentCalls.at(-1)).toMatchObject({
      kind: 'material-preview',
      recordId: 'panel',
      data: expect.objectContaining({
        materialId: 'panel',
        shaderMaterials: expect.objectContaining({ schema: 'noveltea.shader-materials.v1' }),
        preview: expect.objectContaining({ geometry: 'quad', background: 'checker' }),
        diagnostics: [],
      }),
    });
  });

  it('sends a complete shader preview payload when switching Material to Shader', async () => {
    const view = renderGroup(group(materialTab.id));

    await waitFor(() =>
      expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('panel'),
    );

    rerenderGroup(view, group(shaderTab.id));

    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.at(-1)?.recordId).toBe('noise'),
    );
    const payload = previewControllers.applyFocusedDocumentCalls.at(-1);
    expect(payload).toMatchObject({
      kind: 'shader-preview',
      recordId: 'noise',
      data: expect.objectContaining({
        schema: 'noveltea.shader-preview',
        contentMode: 'shader',
        shaderId: 'noise',
        previewMaterialId: 'editor/preview/shader/noise',
        shaderMaterials: expect.objectContaining({ schema: 'noveltea.shader-materials.v1' }),
        templateId: 'shader-square-v1',
      }),
    });
    expect(payload?.revision).toEqual(expect.any(String));
    expect(hostElements(view.container)[0]).toHaveAttribute('data-preview-host-pane-id', 'main');
  });

  it('releases the focused shader lease without invoking the obsolete ABI', async () => {
    const view = renderGroup(group(shaderTab.id));

    await waitFor(() => expect(previewControllers.applyFocusedDocumentCalls).toHaveLength(1));
    expect(previewControllers.loadPreviewDocumentCalls).toHaveLength(0);
    expect(previewControllers.setPreviewModeCalls).toHaveLength(0);

    rerenderGroup(view, group(nonPreviewTab.id));
    await waitFor(() =>
      expect(hostElements(view.container)[0]).not.toHaveAttribute('data-preview-host-claimed'),
    );
    expect(previewControllers.applyFocusedDocumentCalls).toHaveLength(1);
    expect(previewControllers.loadPreviewDocumentCalls).toHaveLength(0);
    expect(previewControllers.setPreviewModeCalls).toHaveLength(0);
  });

  it('keeps preview diagnostics attached to the loaded shader/material document target payloads', async () => {
    const view = renderGroup(group(shaderTab.id));
    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.at(-1)?.recordId).toBe('noise'),
    );

    rerenderGroup(view, group(materialTab.id));
    await waitFor(() =>
      expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('panel'),
    );

    const shaderPayload = previewControllers.applyFocusedDocumentCalls[0];
    const materialPayload = previewControllers.loadPreviewDocumentCalls[0];
    expect(shaderPayload).toMatchObject({
      kind: 'shader-preview',
      recordId: 'noise',
      data: expect.objectContaining({ shaderId: 'noise' }),
    });
    expect(materialPayload).toMatchObject({
      kind: 'material-preview',
      recordId: 'panel',
      data: { materialId: 'panel', diagnostics: [] },
    });
  });
});
