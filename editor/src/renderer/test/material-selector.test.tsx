import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { MaterialSelector } from '@/components/materials/MaterialSelector';
import {
  MaterialPreviewGroupProvider,
  MaterialPreviewProjectProvider,
} from '@/material-preview/material-preview-provider';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';

const noWebGlBackend = () => null;

function renderSelector(props: Partial<React.ComponentProps<typeof MaterialSelector>> = {}) {
  const project = useProjectStore.getState().document!;
  return render(
    <MaterialPreviewProjectProvider>
      <MaterialPreviewGroupProvider backendFactory={noWebGlBackend}>
        <MaterialSelector
          project={project as React.ComponentProps<typeof MaterialSelector>['project']}
          value="panel"
          expectedRole="engine-2d"
          onValueChange={vi.fn()}
          {...props}
        />
      </MaterialPreviewGroupProvider>
    </MaterialPreviewProjectProvider>,
  );
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  const project = createAuthoringProject();
  project.materials.panel = {
    id: 'panel',
    label: 'Panel',
    data: defaultMaterialData('Panel', 'engine-2d'),
  };
  project.materials.alternate = {
    id: 'alternate',
    label: 'Alternate',
    data: defaultMaterialData('Alternate', 'engine-2d'),
  };
  project.materials.post = {
    id: 'post',
    label: 'Post FX',
    data: defaultMaterialData('Post FX', 'postprocess-tint'),
  };
  useProjectStore.getState().loadProjectDocument({
    document: project,
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
    projectSessionId: '11111111-1111-4111-8111-111111111111',
  });
});

describe('MaterialSelector', () => {
  it('previews compatible Materials and occurrence overrides without mutating until selection', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const view = renderSelector({
      onValueChange,
      occurrenceOverrides: {
        parameters: {
          u_useTexture: { type: 'float', value: 0.25 },
          u_missing: { type: 'float', value: 0.5 },
        },
      },
    });

    const collapsedCanvas = view.container.querySelector('[data-material-preview="panel"]');
    await waitFor(() =>
      expect(collapsedCanvas).toHaveAttribute(
        'data-material-preview-parameter-overrides',
        'u_useTexture',
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Choose Material' }));

    const candidate = screen.getByRole('button', { name: /Alternate/ });
    expect(screen.queryByRole('button', { name: /Post FX/ })).not.toBeInTheDocument();
    await waitFor(() => expect(candidate).toHaveAttribute('data-applied-overrides', '1'));
    expect(candidate).toHaveAttribute('data-total-overrides', '2');
    expect(screen.getAllByText('1 of 2 overrides apply').length).toBeGreaterThan(0);

    const candidateCanvas = document.querySelector(
      '[data-material-selector-candidate="alternate"] [data-material-preview="alternate"]',
    );
    expect(candidateCanvas).toHaveAttribute(
      'data-material-preview-parameter-overrides',
      'u_useTexture',
    );
    await user.click(screen.getByRole('checkbox', { name: 'Preview occurrence overrides' }));
    await waitFor(() =>
      expect(candidateCanvas).not.toHaveAttribute('data-material-preview-parameter-overrides'),
    );

    await user.click(screen.getByRole('checkbox', { name: 'Show incompatible' }));
    expect(screen.getByRole('button', { name: /Post FX/ })).toBeDisabled();
    expect(screen.getByText(/requires engine-2d/i)).toBeInTheDocument();

    await user.hover(candidate);
    expect(onValueChange).not.toHaveBeenCalled();
    await user.click(candidate);

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('alternate');
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: 'Show incompatible' })).not.toBeInTheDocument(),
    );
  });
});
