import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SceneEditor } from '@/editors/scenes/SceneEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultSceneData, defaultSceneStep } from '../../shared/project-schema/authoring-scenes';

vi.mock('@/components/engine-preview', () => ({
  EnginePreview: ({ previewDocument }: { previewDocument: { kind: string; data: { selectedStepId?: string | null } } }) => (
    <div data-kind={previewDocument.kind} data-selected-step={previewDocument.data.selectedStepId ?? ''} data-testid="scene-engine-preview" />
  ),
}));

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({ value, onChange, className }: { value: string; onChange?: (value: string) => void; className?: string }) => (
    <textarea className={className} value={value} onChange={(event) => onChange?.(event.currentTarget.value)} />
  ),
}));

const tab: WorkbenchTab = {
  id: 'tab:scene-detail:scenes:opening',
  title: 'Opening',
  editorType: 'scene-detail',
  resource: {
    kind: 'record',
    stableId: 'record:scenes:opening',
    collection: 'scenes',
    entityId: 'opening',
  },
};

beforeEach(() => {
  window.PointerEvent = window.PointerEvent ?? window.MouseEvent;
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
});

describe('SceneEditor', () => {
  it('renders typed scene defaults and scene preview', () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data: defaultSceneData('Opening') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<SceneEditor tab={tab} />);

    expect(screen.getByText('Scene steps')).toBeInTheDocument();
    expect(screen.getByText('Selected step')).toBeInTheDocument();
    expect(screen.getByTestId('scene-engine-preview')).toHaveAttribute('data-kind', 'scene-preview');
  });

  it('dispatches command-backed display, step, reorder, and payload updates', async () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data: defaultSceneData('Opening') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<SceneEditor tab={tab} />);

    fireEvent.change(screen.getByDisplayValue('Opening'), { target: { value: 'Opening Scene' } });
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({ scenes: { opening: { data: { displayName: 'Opening Scene' } } } });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('scene.replaceData');

    fireEvent.click(screen.getAllByText('Wait')[0]!);
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({ scenes: { opening: { data: { steps: [expect.anything(), expect.objectContaining({ id: 'wait' })] } } } });
    });

    fireEvent.click(screen.getByText('Up'));
    await waitFor(() => {
      const document = useProjectStore.getState().document as { scenes: { opening: { data: ReturnType<typeof defaultSceneData> } } };
      expect(document.scenes.opening.data.steps[0]?.id).toBe('wait');
    });

    fireEvent.click(screen.getAllByText('Script')[0]!);
    await waitFor(() => {
      const document = useProjectStore.getState().document as { scenes: { opening: { data: ReturnType<typeof defaultSceneData> } } };
      expect(document.scenes.opening.data.preview.selectedStepId).toBe('script');
    });
    const textareas = screen.getAllByRole('textbox');
    fireEvent.change(textareas.at(-1)!, { target: { value: 'print("hi")' } });
    await waitFor(() => {
      const document = useProjectStore.getState().document as { scenes: { opening: { data: ReturnType<typeof defaultSceneData> } } };
      expect(document.scenes.opening.data.steps.find((step) => step.id === 'script')?.script.source).toBe('print("hi")');
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('scene.replaceData');
  });

  it('edits refined scene fields exposed by the V1 inspector', async () => {
    const project = createAuthoringProject();
    const data = defaultSceneData('Opening');
    data.steps = [
      { ...defaultSceneStep('character'), id: 'character', label: 'Character' },
      { ...defaultSceneStep('branch'), id: 'branch', label: 'Branch', branch: { choices: [{ id: 'choice', label: 'Choice', targetStepId: 'character', condition: { enabled: false, source: '' }, order: 0 }] } },
    ];
    data.preview.selectedStepId = 'character';
    project.materials.glow = { id: 'glow', label: 'Glow', tags: [], data: { kind: 'material', role: 'surface', shader: null, parameters: {}, textures: {}, states: {}, preview: { background: 'checker' } } };
    project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<SceneEditor tab={tab} />);

    fireEvent.change(screen.getByDisplayValue('#0f172a'), { target: { value: '#111111' } });
    await waitFor(() => {
      const document = useProjectStore.getState().document as { scenes: { opening: { data: ReturnType<typeof defaultSceneData> } } };
      expect(document.scenes.opening.data.defaults.background.color).toBe('#111111');
    });

    fireEvent.click(screen.getByLabelText('Can skip'));
    await waitFor(() => {
      const document = useProjectStore.getState().document as { scenes: { opening: { data: ReturnType<typeof defaultSceneData> } } };
      expect(document.scenes.opening.data.steps[0]?.timing.canSkip).toBe(false);
    });

    fireEvent.change(screen.getByLabelText('Character offset x'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Character offset y'), { target: { value: '-4' } });
    await waitFor(() => {
      const document = useProjectStore.getState().document as { scenes: { opening: { data: ReturnType<typeof defaultSceneData> } } };
      expect(document.scenes.opening.data.steps[0]?.character.offset).toEqual({ x: 12, y: -4 });
    });

    fireEvent.click(screen.getAllByText('Branch')[1]!);
    await waitFor(() => {
      const document = useProjectStore.getState().document as { scenes: { opening: { data: ReturnType<typeof defaultSceneData> } } };
      expect(document.scenes.opening.data.preview.selectedStepId).toBe('branch');
    });
    fireEvent.click(screen.getByLabelText('Condition choice'));
    const textareas = screen.getAllByRole('textbox');
    fireEvent.change(textareas.at(-1)!, { target: { value: 'return flag' } });
    await waitFor(() => {
      const document = useProjectStore.getState().document as { scenes: { opening: { data: ReturnType<typeof defaultSceneData> } } };
      expect(document.scenes.opening.data.steps[1]?.branch.choices[0]?.condition).toEqual({ enabled: true, source: 'return flag' });
    });
  });
});
