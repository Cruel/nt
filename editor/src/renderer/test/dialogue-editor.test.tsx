import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DialogueEditor } from '@/editors/dialogues/DialogueEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import {
  captureWorkbenchTabState,
  clearWorkbenchTabStates,
  setWorkbenchTabState,
  useWorkbenchTabStateStore,
} from '@/workbench/workbench-tab-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';

vi.mock('@xyflow/react', () => ({
  Background: () => <div data-testid="xyflow-background" />,
  Controls: () => <div data-testid="xyflow-controls" />,
  ReactFlow: ({
    nodes,
    children,
    defaultViewport,
    onNodeClick,
    onViewportChange,
  }: {
    nodes: Array<{ id: string; data: { label: string } }>;
    children: React.ReactNode;
    defaultViewport?: { x: number; y: number; zoom: number };
    onNodeClick?: (event: unknown, node: { id: string }) => void;
    onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;
  }) => (
    <div data-testid="dialogue-flow" data-default-viewport={JSON.stringify(defaultViewport ?? null)}>
      <button type="button" onClick={() => onViewportChange?.({ x: 25, y: 40, zoom: 1.5 })}>Move Viewport</button>
      {nodes.map((node) => <button key={node.id} onClick={() => onNodeClick?.({}, node)}>{node.data.label}</button>)}
      {children}
    </div>
  ),
}));

vi.mock('@/preview/DerivedPreviewPane', () => ({
  DerivedPreviewPane: ({ previewDocument }: { previewDocument: { kind: string; data: { selectedBlockId?: string | null } } }) => (
    <div data-kind={previewDocument.kind} data-selected-block={previewDocument.data.selectedBlockId ?? ''} data-testid="dialogue-derived-preview" />
  ),
}));

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({ value, onChange, className }: { value: string; onChange?: (value: string) => void; className?: string }) => (
    <textarea className={className} value={value} onChange={(event) => onChange?.(event.currentTarget.value)} />
  ),
}));

const tab: WorkbenchTab = {
  id: 'tab:dialogue-detail:dialogues:intro',
  title: 'Intro',
  editorType: 'dialogue-detail',
  resource: {
    kind: 'record',
    stableId: 'record:dialogues:intro',
    collection: 'dialogues',
    entityId: 'intro',
  },
};

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  clearWorkbenchTabStates();
});

describe('DialogueEditor', () => {
  it('renders typed dialogue defaults and dialogue preview', () => {
    const project = createAuthoringProject();
    project.dialogues.intro = { id: 'intro', label: 'Intro', tags: [], data: defaultDialogueData('Intro') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<DialogueEditor tab={tab} />);

    expect(screen.getByText('Branch map')).toBeInTheDocument();
    expect(screen.getByText('Block transcript')).toBeInTheDocument();
    expect(screen.getByTestId('dialogue-derived-preview')).toHaveAttribute('data-kind', 'dialogue-preview');
  });

  it('dispatches command-backed display, block, segment, and choice updates', async () => {
    const project = createAuthoringProject();
    project.dialogues.intro = { id: 'intro', label: 'Intro', tags: [], data: defaultDialogueData('Intro') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<DialogueEditor tab={tab} />);

    fireEvent.change(screen.getByDisplayValue('Intro'), { target: { value: 'Intro Scene' } });
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        dialogues: { intro: { data: { displayName: 'Intro Scene' } } },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('dialogue.replaceData');

    fireEvent.click(screen.getByText('Add Block'));
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        dialogues: { intro: { data: { blocks: [expect.anything(), expect.objectContaining({ id: 'block' })] } } },
      });
    });

    fireEvent.click(screen.getByText('Add Line'));
    await waitFor(() => {
      const document = useProjectStore.getState().document as { dialogues: { intro: { data: ReturnType<typeof defaultDialogueData> } } };
      expect(document.dialogues.intro.data.blocks.at(-1)?.segments.length).toBe(2);
    });

    fireEvent.click(screen.getByText('Add Choice'));
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        dialogues: { intro: { data: { edges: [expect.objectContaining({ kind: 'choice' })] } } },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('dialogue.replaceData');
  });

  it('captures and restores tab state for scroll and graph viewport', async () => {
    const project = createAuthoringProject();
    project.dialogues.intro = { id: 'intro', label: 'Intro', tags: [], data: defaultDialogueData('Intro') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    const view = render(<DialogueEditor tab={tab} />);
    const scrollContainer = view.container.querySelector<HTMLElement>('[data-dialogue-editor-scroll]')!;
    scrollContainer.scrollTop = 180;
    scrollContainer.scrollLeft = 8;
    fireEvent.click(screen.getByText('Move Viewport'));

    captureWorkbenchTabState(tab.id);

    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toMatchObject({
      schema: 'noveltea.editor.tab-state.dialogue',
      payload: {
        scroll: { scrollTop: 180, scrollLeft: 8 },
        graphViewport: { x: 25, y: 40, zoom: 1.5 },
      },
    });

    view.unmount();
    setWorkbenchTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.dialogue',
      schemaVersion: 1,
      payload: {
        scroll: { scrollTop: 72, scrollLeft: 5 },
        graphViewport: { x: 9, y: 12, zoom: 0.75 },
      },
    });

    const restoredView = render(<DialogueEditor tab={tab} />);

    await waitFor(() => expect(screen.getByTestId('dialogue-flow')).toHaveAttribute('data-default-viewport', JSON.stringify({ x: 9, y: 12, zoom: 0.75 })));
    await waitFor(() => expect(restoredView.container.querySelector<HTMLElement>('[data-dialogue-editor-scroll]')?.scrollTop).toBe(72));
    expect(restoredView.container.querySelector<HTMLElement>('[data-dialogue-editor-scroll]')?.scrollLeft).toBe(5);
  });
});
