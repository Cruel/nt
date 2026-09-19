import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EngineShaderSourceEditor } from '@/editors/source/EngineShaderSourceEditor';
import { useProjectSourceStore } from '@/project/project-source-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import type { WorkbenchTab } from '@/workbench/workbench-types';

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({ value, readOnly }: { value: string; readOnly?: boolean }) => (
    <pre data-testid="source-editor" data-read-only={String(Boolean(readOnly))}>
      {value}
    </pre>
  ),
}));

const realMutate = useProjectSourceStore.getState().mutate;

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useProjectSourceStore.getState().clear();
  useProjectSourceStore.setState({ mutate: realMutate });
  useWorkbenchStore.getState().resetWorkbench();
  const project = createAuthoringProject();
  project.materials.panel = {
    id: 'panel',
    label: 'Panel',
    data: defaultMaterialData('Panel', 'engine-2d'),
  };
  useProjectStore.getState().loadUnsavedProjectDocument(project);
});

describe('built-in Material shader source editor', () => {
  it('shows preset source read-only outside the Project Files tree', () => {
    const tab: WorkbenchTab = {
      id: 'tab:engine-source',
      title: 'vs_quad.sc',
      editorType: 'engine-shader-source',
      resource: {
        kind: 'tool',
        stableId: 'engine-shader-source:engine:/vs_quad.sc:material:panel',
        sourceId: 'engine:/vs_quad.sc',
        collection: 'materials',
        entityId: 'panel',
      },
    };

    render(<EngineShaderSourceEditor tab={tab} />);

    expect(screen.getByTestId('source-editor')).toHaveAttribute('data-read-only', 'true');
    expect(screen.getByTestId('source-editor')).toHaveTextContent('u_modelViewProj');
    expect(useProjectSourceStore.getState().files).toEqual([]);
  });

  it('customizes the inspected stage through the atomic source operation and opens its source tab', async () => {
    const mutate = vi.fn(async () => {
      useProjectSourceStore.setState({
        files: [
          {
            id: 'shaders/materials/panel/vs.sc',
            displayPath: 'shaders/materials/panel/vs.sc',
            projectRelativePath: 'shaders/materials/panel/vs.sc',
            kind: 'shader',
            text: true,
          },
        ],
      });
      return {
        ok: true,
        success: true,
        createdSourceIds: ['shaders/materials/panel/vs.sc'],
        changedPaths: ['shaders/materials/panel/vs.sc'],
      };
    });
    useProjectSourceStore.setState({ mutate });
    const tab: WorkbenchTab = {
      id: 'tab:engine-source',
      title: 'vs_quad.sc',
      editorType: 'engine-shader-source',
      resource: {
        kind: 'tool',
        stableId: 'engine-shader-source:engine:/vs_quad.sc:material:panel',
        sourceId: 'engine:/vs_quad.sc',
        collection: 'materials',
        entityId: 'panel',
      },
    };

    render(<EngineShaderSourceEditor tab={tab} />);
    fireEvent.click(screen.getByRole('button', { name: 'Customize Shader' }));

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        kind: 'material-shader-copy',
        materialId: 'panel',
        stage: 'vertex',
        sourceIdentity: 'engine:/vs_quad.sc',
      }),
    );
    expect(
      useWorkbenchStore.getState().tabsById['tab:source-file:shaders/materials/panel/vs.sc'],
    ).toMatchObject({ editorType: 'source-file' });
  });
});
