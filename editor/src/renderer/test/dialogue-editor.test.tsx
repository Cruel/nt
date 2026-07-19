import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
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
    <div
      data-testid="dialogue-flow"
      data-default-viewport={JSON.stringify(defaultViewport ?? null)}
    >
      <button type="button" onClick={() => onViewportChange?.({ x: 25, y: 40, zoom: 1.5 })}>
        Move Viewport
      </button>
      {nodes.map((node) => (
        <button key={node.id} onClick={() => onNodeClick?.({}, node)}>
          {node.data.label}
        </button>
      ))}
      {children}
    </div>
  ),
}));

vi.mock('@/preview/DerivedPreviewPane', () => ({
  DerivedPreviewPane: ({
    previewDocument,
  }: {
    previewDocument: { kind: string; data: { selectedBlockId?: string | null } };
  }) => (
    <div
      data-kind={previewDocument.kind}
      data-selected-block={previewDocument.data.selectedBlockId ?? ''}
      data-testid="dialogue-derived-preview"
    />
  ),
}));

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({
    value,
    onChange,
    className,
  }: {
    value: string;
    onChange?: (value: string) => void;
    className?: string;
  }) => (
    <textarea
      className={className}
      value={value}
      onChange={(event) => onChange?.(event.currentTarget.value)}
    />
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

function loadDialogue() {
  const project = createAuthoringProject();
  project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
  useProjectStore.getState().loadProjectDocument({
    document: project,
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
  });
}

describe('DialogueEditor', () => {
  it('renders the strict Dialogue V2 graph and preview', () => {
    loadDialogue();
    render(<DialogueEditor tab={tab} />);

    expect(screen.getByText('Branch map')).toBeInTheDocument();
    expect(screen.getByText('Block transcript')).toBeInTheDocument();
    expect(screen.getByText(/Strict Sequence, Choice, Redirect/)).toBeInTheDocument();
    expect(screen.getByTestId('dialogue-derived-preview')).toHaveAttribute(
      'data-kind',
      'dialogue-preview',
    );
  });

  it('uses command-backed block and choice editing without serializing editor selection', async () => {
    loadDialogue();
    render(<DialogueEditor tab={tab} />);

    fireEvent.change(screen.getByDisplayValue('Intro'), {
      target: { value: 'Intro Conversation' },
    });
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        dialogues: { intro: { data: { displayName: 'Intro Conversation' } } },
      }),
    );

    fireEvent.click(screen.getAllByText('Add choice')[0]!);
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        dialogues: {
          intro: {
            data: {
              blocks: [
                expect.anything(),
                expect.objectContaining({ id: 'choice', type: 'choice' }),
              ],
            },
          },
        },
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Choices' })).toBeInTheDocument(),
    );
    expect(screen.getByText('Delete choice 1')).toBeDisabled();
    fireEvent.click(screen.getAllByText('Add choice').at(-1)!);
    await waitFor(() => {
      const projectDocument = useProjectStore.getState().document as {
        dialogues: { intro: { data: ReturnType<typeof defaultDialogueData> } };
      };
      expect(projectDocument.dialogues.intro.data.edges).toHaveLength(2);
      expect(
        projectDocument.dialogues.intro.data.edges.every(
          (edge) => edge.kind === 'choice' && edge.fromBlockId === 'choice',
        ),
      ).toBe(true);
    });

    const blockIdInput = screen.getByLabelText('Block ID');
    fireEvent.change(blockIdInput, { target: { value: 'decision' } });
    fireEvent.blur(blockIdInput);
    await waitFor(() => {
      const projectDocument = useProjectStore.getState().document as {
        dialogues: { intro: { data: ReturnType<typeof defaultDialogueData> } };
      };
      expect(
        projectDocument.dialogues.intro.data.blocks.some((block) => block.id === 'decision'),
      ).toBe(true);
      expect(
        projectDocument.dialogues.intro.data.edges.every((edge) => edge.fromBlockId === 'decision'),
      ).toBe(true);
    });

    const document = useProjectStore.getState().document as {
      dialogues: { intro: { data: Record<string, unknown> } };
    };
    expect(document.dialogues.intro.data).not.toHaveProperty('preview');
    expect(document.dialogues.intro.data).not.toHaveProperty('graph');
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('dialogue.replaceData');
  });

  it('captures and restores graph, selection, preview, and layout state in the editor boundary', async () => {
    loadDialogue();
    const view = render(<DialogueEditor tab={tab} />);
    const scrollContainer = view.container.querySelector<HTMLElement>(
      '[data-dialogue-editor-scroll]',
    )!;
    scrollContainer.scrollTop = 180;
    scrollContainer.scrollLeft = 8;
    fireEvent.click(screen.getByText('Move Viewport'));

    captureWorkbenchTabState(tab.id);
    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toMatchObject({
      schema: 'noveltea.editor.tab-state.dialogue.v2',
      schemaVersion: 2,
      payload: {
        scroll: { scrollTop: 180, scrollLeft: 8 },
        graphViewport: { x: 25, y: 40, zoom: 1.5 },
        selectedBlockId: 'start',
        graphPositions: { start: { x: 0, y: 0 } },
      },
    });

    view.unmount();
    setWorkbenchTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.dialogue.v2',
      schemaVersion: 2,
      payload: {
        scroll: { scrollTop: 72, scrollLeft: 5 },
        graphViewport: { x: 9, y: 12, zoom: 0.75 },
        selectedBlockId: 'start',
        selectedSegmentId: 'line-1',
        graphPositions: { start: { x: 40, y: 60 } },
        previewBackground: 'checker',
      },
    });

    const restored = render(<DialogueEditor tab={tab} />);
    await waitFor(() =>
      expect(screen.getByTestId('dialogue-flow')).toHaveAttribute(
        'data-default-viewport',
        JSON.stringify({ x: 9, y: 12, zoom: 0.75 }),
      ),
    );
    await waitFor(() =>
      expect(
        restored.container.querySelector<HTMLElement>('[data-dialogue-editor-scroll]')?.scrollTop,
      ).toBe(72),
    );
    expect(
      restored.container.querySelector<HTMLElement>('[data-dialogue-editor-scroll]')?.scrollLeft,
    ).toBe(5);
  });
});
