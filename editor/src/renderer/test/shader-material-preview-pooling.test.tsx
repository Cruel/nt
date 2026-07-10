import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { WorkbenchGroup } from '@/workbench/WorkbenchGroup';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import type { WorkbenchGroup as WorkbenchGroupModel, WorkbenchTab } from '@/workbench/workbench-types';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

const previewControllers = vi.hoisted(() => ({
  created: 0,
  resetCalls: 0,
  setPreviewModeCalls: [] as string[],
  loadPreviewDocumentCalls: [] as Array<{ kind: string; recordId: string; revision: string; data: Record<string, unknown> }>,
  nextResetPromise: null as Promise<void> | null,
}));

vi.mock('@/hooks/use-engine-preview', () => ({
  useEnginePreview: () => {
    previewControllers.created += 1;
    const hostIndex = previewControllers.created;
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
      loadPreviewDocument: vi.fn((document: { kind: string; recordId: string; revision: string; data: Record<string, unknown> }) => {
        previewControllers.loadPreviewDocumentCalls.push(document);
        return Promise.resolve();
      }),
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
      { language = 'text', value, onChange }: { language?: string; value: string; onChange?: (value: string) => void },
      ref: React.ForwardedRef<{ captureViewState: () => { scroll: { scrollTop: number; scrollLeft: number }; selection: unknown }; restoreViewState: (state: unknown) => void }>,
    ) {
      const editorRef = React.useRef<HTMLTextAreaElement | null>(null);
      React.useImperativeHandle(ref, () => ({
        captureViewState: () => ({
          scroll: {
            scrollTop: editorRef.current?.scrollTop ?? 0,
            scrollLeft: editorRef.current?.scrollLeft ?? 0,
          },
          selection: { ranges: [{ anchor: editorRef.current?.selectionStart ?? 0, head: editorRef.current?.selectionEnd ?? 0 }], main: 0 },
        }),
        restoreViewState: (state) => {
          if (!editorRef.current || typeof state !== 'object' || state === null || !('scroll' in state)) return;
          const scroll = (state as { scroll?: { scrollTop?: number; scrollLeft?: number } }).scroll;
          editorRef.current.scrollTop = scroll?.scrollTop ?? 0;
          editorRef.current.scrollLeft = scroll?.scrollLeft ?? 0;
        },
      }));
      return <textarea ref={editorRef} aria-label={`source-${language}`} value={value} onChange={(event) => onChange?.(event.currentTarget.value)} />;
    }),
  };
});

const shaderTab: WorkbenchTab = {
  id: 'tab:shader-detail:shaders:noise',
  title: 'Noise',
  editorType: 'shader-detail',
  resource: { kind: 'record', stableId: 'record:shaders:noise', collection: 'shaders', entityId: 'noise' },
};

const materialTab: WorkbenchTab = {
  id: 'tab:material-detail:materials:panel',
  title: 'Panel',
  editorType: 'material-detail',
  resource: { kind: 'record', stableId: 'record:materials:panel', collection: 'materials', entityId: 'panel' },
};

const nonPreviewTab: WorkbenchTab = {
  id: 'tab:non-preview',
  title: 'Non Preview',
  editorType: 'missing-test-editor',
  resource: { kind: 'tool', stableId: 'tool:non-preview' },
};

function group(activeTabId: string | null, tabIds: string[] = [shaderTab.id, materialTab.id, nonPreviewTab.id]): WorkbenchGroupModel {
  return { id: 'root', activeTabId, tabIds };
}

function renderGroup(model: WorkbenchGroupModel, tabs: WorkbenchTab[] = [shaderTab, materialTab, nonPreviewTab]) {
  return render(
    <WorkbenchTabDndContext>
      <WorkbenchGroup group={model} tabs={tabs} />
    </WorkbenchTabDndContext>,
  );
}

function rerenderGroup(view: ReturnType<typeof render>, model: WorkbenchGroupModel, tabs: WorkbenchTab[] = [shaderTab, materialTab, nonPreviewTab]) {
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
  previewControllers.nextResetPromise = null;
}

beforeEach(() => {
  resetPreviewControllerState();
  useCommandStore.getState().resetCommandHistory();
  useWorkbenchStore.getState().resetWorkbench();
  useProjectStore.getState().clearProject();

  const project = createAuthoringProject();
  project.shaders.noise = { id: 'noise', label: 'Noise', tags: [], data: defaultShaderData('Noise') };
  project.materials.panel = { id: 'panel', label: 'Panel', tags: [], data: defaultMaterialData('Panel', 'noise') };
  useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });
});

describe('Shader and Material pooled previews', () => {
  it('resets and replaces shader preview state when switching Shader to Material', async () => {
    const view = renderGroup(group(shaderTab.id));

    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('noise'));
    const firstHostId = hostElements(view.container)[0]?.dataset.previewHostId;

    rerenderGroup(view, group(materialTab.id));

    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('panel'));
    expect(hostElements(view.container)).toHaveLength(1);
    expect(hostElements(view.container)[0]?.dataset.previewHostId).toBe(firstHostId);
    expect(previewControllers.resetCalls).toBe(2);
    expect(previewControllers.setPreviewModeCalls).toEqual(['material', 'material']);
    expect(previewControllers.loadPreviewDocumentCalls.map((call) => call.kind)).toEqual(['shader-preview', 'material-preview']);
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

    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('panel'));

    rerenderGroup(view, group(shaderTab.id));

    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('noise'));
    const payload = previewControllers.loadPreviewDocumentCalls.at(-1);
    expect(payload).toMatchObject({
      kind: 'shader-preview',
      recordId: 'noise',
      data: expect.objectContaining({
        schema: 'noveltea.shader-preview.v1',
        shaderId: 'noise',
        previewMaterialId: 'editor/preview/shader/noise',
        shaderMaterials: expect.objectContaining({ schema: 'noveltea.shader-materials.v1' }),
        template: expect.objectContaining({ materialPlaceholder: '__NT_PREVIEW_MATERIAL_ID__' }),
      }),
    });
    expect(payload?.revision).toEqual(expect.any(String));
    expect(hostElements(view.container)[0]).toHaveAttribute('data-preview-host-pane-id', 'main');
  });

  it('ignores stale shader sends after the shader preview releases its lease', async () => {
    const releaseShaderResetRef: { current: (() => void) | null } = { current: null };
    previewControllers.nextResetPromise = new Promise<void>((resolve) => {
      releaseShaderResetRef.current = resolve;
    });
    const view = renderGroup(group(shaderTab.id));

    await waitFor(() => expect(previewControllers.resetCalls).toBe(1));
    expect(previewControllers.loadPreviewDocumentCalls).toHaveLength(0);
    expect(previewControllers.setPreviewModeCalls).toHaveLength(0);

    rerenderGroup(view, group(nonPreviewTab.id));
    await waitFor(() => expect(hostElements(view.container)[0]).not.toHaveAttribute('data-preview-host-claimed'));
    releaseShaderResetRef.current?.();

    await Promise.resolve();
    expect(previewControllers.loadPreviewDocumentCalls).toHaveLength(0);
    expect(previewControllers.setPreviewModeCalls).toHaveLength(0);
  });

  it('keeps preview diagnostics attached to the loaded shader/material document target payloads', async () => {
    const view = renderGroup(group(shaderTab.id));
    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('noise'));

    rerenderGroup(view, group(materialTab.id));
    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('panel'));

    const [shaderPayload, materialPayload] = previewControllers.loadPreviewDocumentCalls;
    expect(shaderPayload).toMatchObject({ kind: 'shader-preview', recordId: 'noise', data: { shaderId: 'noise', diagnostics: [] } });
    expect(materialPayload).toMatchObject({ kind: 'material-preview', recordId: 'panel', data: { materialId: 'panel', diagnostics: [] } });
  });
});
