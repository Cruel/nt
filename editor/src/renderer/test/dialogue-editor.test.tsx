import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DialogueEditor } from '@/editors/dialogues/DialogueEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';

vi.mock('@xyflow/react', () => ({
  Background: () => <div data-testid="xyflow-background" />,
  Controls: () => <div data-testid="xyflow-controls" />,
  ReactFlow: ({ nodes, children, onNodeClick }: { nodes: Array<{ id: string; data: { label: string } }>; children: React.ReactNode; onNodeClick?: (event: unknown, node: { id: string }) => void }) => (
    <div data-testid="dialogue-flow">
      {nodes.map((node) => <button key={node.id} onClick={() => onNodeClick?.({}, node)}>{node.data.label}</button>)}
      {children}
    </div>
  ),
}));

vi.mock('@/components/engine-preview', () => ({
  EnginePreview: ({ previewDocument }: { previewDocument: { kind: string; data: { selectedBlockId?: string | null } } }) => (
    <div data-kind={previewDocument.kind} data-selected-block={previewDocument.data.selectedBlockId ?? ''} data-testid="dialogue-engine-preview" />
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
});

describe('DialogueEditor', () => {
  it('renders typed dialogue defaults and dialogue preview', () => {
    const project = createAuthoringProject();
    project.dialogues.intro = { id: 'intro', label: 'Intro', tags: [], data: defaultDialogueData('Intro') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<DialogueEditor tab={tab} />);

    expect(screen.getByText('Branch map')).toBeInTheDocument();
    expect(screen.getByText('Block transcript')).toBeInTheDocument();
    expect(screen.getByTestId('dialogue-engine-preview')).toHaveAttribute('data-kind', 'dialogue-preview');
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
});
