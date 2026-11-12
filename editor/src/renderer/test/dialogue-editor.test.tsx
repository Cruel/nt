import { admitNativeRendererCommandFixture } from '../test-support/native-acknowledged-command-fixture';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DialogueEditor } from '@/editors/dialogues/DialogueEditor';
import { projectEdits } from '@/commands/project-editing';
import { saveActiveSaveUnit } from '@/project/project-save-coordinator';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import {
  captureWorkbenchTabState,
  clearWorkbenchTabStates,
  setWorkbenchTabState,
  useWorkbenchTabStateStore,
} from '@/workbench/workbench-tab-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';
import { holdFirstNativeProjectPatch } from '../test-support/native-acknowledged-command-fixture';

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
  usePendingInputStore.getState().resetPendingInputs();
  useDraftDirtyStore.getState().resetDraftDirty();
  clearWorkbenchTabStates();
});

function loadDialogue() {
  const project = createAuthoringProject();
  project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
  admitNativeRendererCommandFixture(project);
}

describe('DialogueEditor', () => {
  it('keeps inline Dialogue source typing and sibling metadata immediate during held native work', async () => {
    loadDialogue();
    const held = holdFirstNativeProjectPatch();
    const view = render(<DialogueEditor tab={tab} />);
    const source = view.container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(source).not.toBeNull();
    fireEvent.change(source, { target: { value: 'Hello' } });
    expect(source).toHaveValue('Hello');
    await waitFor(() => expect(held.isHeld()).toBe(true));

    for (const raw of ['Hello world', 'Hello wor', 'Hello scene!']) {
      fireEvent.change(source, { target: { value: raw } });
      expect(source).toHaveValue(raw);
    }
    const name = screen.getByDisplayValue('Intro');
    fireEvent.change(name, { target: { value: 'Intro renamed' } });
    expect(name).toHaveValue('Intro renamed');
    await act(async () => held.release());
    await waitFor(() => {
      const data = (
        useProjectStore.getState().document as {
          dialogues: { intro: { data: ReturnType<typeof defaultDialogueData> } };
        }
      ).dialogues.intro.data;
      expect(data.displayName).toBe('Intro renamed');
      const segment = data.blocks[0]?.type === 'sequence' ? data.blocks[0].segments[0] : null;
      expect(
        segment?.type === 'line' &&
          segment.text.source.kind === 'inline' &&
          segment.text.source.text,
      ).toBe('Hello scene!');
    });
    expect(source).toHaveValue('Hello scene!');
    await act(async () => expect(await projectEdits.flush('record:dialogues:intro')).toBe(true));
    const result = await saveActiveSaveUnit('record:dialogues:intro');
    expect(result.success).toBe(true);
  });

  it('reuses the native grouped history for Dialogue text Undo and Redo', async () => {
    loadDialogue();
    render(<DialogueEditor tab={tab} />);
    const name = screen.getByDisplayValue('Intro');
    fireEvent.change(name, { target: { value: 'Intro editing' } });
    fireEvent.change(name, { target: { value: 'Intro edited' } });
    await act(async () => expect(await projectEdits.flush('record:dialogues:intro')).toBe(true));
    await act(async () => expect((await projectEdits.undo()).ok).toBe(true));
    expect(name).toHaveValue('Intro');
    await act(async () => expect((await projectEdits.redo()).ok).toBe(true));
    expect(name).toHaveValue('Intro edited');
  });

  it.each([500, 1000])(
    'keeps Dialogue typing and independently edited block label under %i ms held native patch',
    async (delay) => {
      loadDialogue();
      const held = holdFirstNativeProjectPatch();
      render(<DialogueEditor tab={tab} />);
      const name = screen.getByDisplayValue('Intro');
      fireEvent.change(name, { target: { value: 'Intro 1' } });
      await waitFor(() => expect(held.isHeld()).toBe(true));
      for (const text of ['Intro 12', 'Intro 123', 'Intro 12', 'Intro pasted']) {
        fireEvent.change(name, { target: { value: text } });
        expect(name).toHaveValue(text);
      }
      const blockLabel = screen.getByDisplayValue('Sequence');
      fireEvent.change(blockLabel, { target: { value: 'First conversation' } });
      expect(blockLabel).toHaveValue('First conversation');
      await new Promise((resolve) => setTimeout(resolve, delay));
      expect(name).toHaveValue('Intro pasted');
      expect(blockLabel).toHaveValue('First conversation');
      await act(async () => held.release());
      await waitFor(() => {
        const document = useProjectStore.getState().document as {
          dialogues: { intro: { data: ReturnType<typeof defaultDialogueData> } };
        };
        expect(document.dialogues.intro.data.displayName).toBe('Intro pasted');
        expect(document.dialogues.intro.data.blocks[0]?.label).toBe('First conversation');
      });
      const nativePaths = vi
        .mocked(window.noveltea.nativeProjectPatch)
        .mock.calls.flatMap((call) => call[2].map((patch) => patch.path));
      expect(nativePaths).toContain('/dialogues/intro/data/blocks/0/label');
      expect(nativePaths).not.toContain('/dialogues/intro/data/blocks');
      expect(vi.mocked(window.noveltea.nativeProjectPatch).mock.calls.length).toBeLessThanOrEqual(
        4,
      );
    },
    15000,
  );
  it('renders the strict Dialogue graph and preview', () => {
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

    // The native patch is acknowledged before the selected block's local
    // inspector state catches up to the newly added graph node.
    fireEvent.click(screen.getByRole('button', { name: /^Choice$/i }));
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

  it('authors Dialogue Stage and Media Slots plus retained line mutations', async () => {
    loadDialogue();
    render(<DialogueEditor tab={tab} />);

    fireEvent.click(screen.getByText('Add Stage Slot'));
    await waitFor(() =>
      expect(
        (
          useProjectStore.getState().document as {
            dialogues: { intro: { data: ReturnType<typeof defaultDialogueData> } };
          }
        ).dialogues.intro.data.stageSlots,
      ).toHaveLength(1),
    );
    fireEvent.click(screen.getByText('Add Media Slot'));
    await waitFor(() => {
      const document = useProjectStore.getState().document as {
        dialogues: { intro: { data: ReturnType<typeof defaultDialogueData> } };
      };
      expect(document.dialogues.intro.data.stageSlots).toEqual([
        expect.objectContaining({ id: 'stage', speakerSync: true, initial: null }),
      ]);
      expect(document.dialogues.intro.data.mediaSlots).toEqual([
        expect.objectContaining({ id: 'media', visible: true, initial: null }),
      ]);
    });

    fireEvent.click(screen.getByText('Add Stage mutation'));
    await waitFor(() => {
      const data = (
        useProjectStore.getState().document as {
          dialogues: { intro: { data: ReturnType<typeof defaultDialogueData> } };
        }
      ).dialogues.intro.data;
      expect(
        data.blocks[0]?.type === 'sequence' &&
          data.blocks[0].segments[0]?.type === 'line' &&
          data.blocks[0].segments[0].cues.length,
      ).toBe(1);
    });
    fireEvent.click(screen.getByText('Add Media mutation'));
    await waitFor(() => {
      const document = useProjectStore.getState().document as {
        dialogues: { intro: { data: ReturnType<typeof defaultDialogueData> } };
      };
      const block = document.dialogues.intro.data.blocks[0]!;
      if (block.type !== 'sequence' || block.segments[0]?.type !== 'line')
        throw new Error('Expected default Dialogue line.');
      expect(block.segments[0].cues).toEqual([
        expect.objectContaining({
          kind: 'stage',
          mutation: { slotId: 'stage', action: 'update' },
        }),
        expect.objectContaining({
          kind: 'media',
          mutation: { slotId: 'media', action: 'update' },
        }),
      ]);
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('project.applyPatch');
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
      schema: 'noveltea.editor.tab-state.dialogue',
      payload: {
        scroll: { scrollTop: 180, scrollLeft: 8 },
        graphViewport: { x: 25, y: 40, zoom: 1.5 },
        selectedBlockId: 'start',
        graphPositions: { start: { x: 0, y: 0 } },
      },
    });

    view.unmount();
    setWorkbenchTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.dialogue',
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
