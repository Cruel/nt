import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SceneEditor } from '@/editors/scenes/SceneEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';

vi.mock('@/preview/DerivedPreviewPane', () => ({
  DerivedPreviewPane: ({ previewDocument }: { previewDocument: { kind: string; data: { selectedStepId?: string | null } } }) => <div data-testid="scene-derived-preview" data-kind={previewDocument.kind} data-selected={previewDocument.data.selectedStepId ?? ''} />,
}));

const tab: WorkbenchTab = {
  id: 'tab:scene-detail:scenes:opening', title: 'Opening', editorType: 'scene-detail',
  resource: { kind: 'record', stableId: 'record:scenes:opening', collection: 'scenes', entityId: 'opening' },
};

beforeEach(() => {
  window.PointerEvent = window.PointerEvent ?? window.MouseEvent;
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
});

describe('SceneEditor', () => {
  it('renders strict scene data and keeps selection out of project data', async () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });
    render(<SceneEditor tab={tab} />);
    expect(screen.getByTestId('scene-derived-preview')).toHaveAttribute('data-kind', 'scene-preview');
    fireEvent.change(screen.getByDisplayValue('Opening'), { target: { value: 'Opening Scene' } });
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({ scenes: { opening: { data: { displayName: 'Opening Scene' } } } }));
    expect((useProjectStore.getState().document as typeof project).scenes.opening!.data).not.toHaveProperty('preview');
  });
});
