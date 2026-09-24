import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  MaterialSelector,
  transferMaterialSelectorOverrides,
} from '@/components/materials/MaterialSelector';
import {
  MaterialPreviewGroupProvider,
  MaterialPreviewProjectProvider,
} from '@/material-preview/material-preview-provider';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import type { MaterialPreviewResource } from '@/material-preview/material-preview-resources';

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
  it('counts previewable parameters and author-owned textures while excluding renderer-owned texture sources', () => {
    const resource = {
      resolved: { role: 'engine-2d' },
      derivedInterface: {
        uniforms: {
          u_literal: { type: 'float' },
          u_time: { type: 'float' },
        },
        samplers: {
          s_texColor: { type: 'texture2d', stage: 0, binding: null },
          s_noise: { type: 'texture2d', stage: 3, binding: null },
        },
      },
    } as unknown as MaterialPreviewResource;

    const transfer = transferMaterialSelectorOverrides(resource, {
      parameters: {
        u_literal: { type: 'float', value: 0.5 },
        u_time: { type: 'float', standardFacet: 'occurrence-time' },
        u_missing: { type: 'float', value: 1 },
      },
      textures: {
        s_noise: { assetId: 'noise' },
        s_texColor: { assetId: 'wrong-source' },
      },
    });

    expect(transfer.values).toEqual({
      u_literal: 0.5,
      u_time: { kind: 'standard-facet', facet: 'occurrence-time' },
    });
    expect(transfer.textures).toEqual({ s_noise: 'noise' });
    expect(transfer.appliedCount).toBe(3);
    expect(transfer.totalCount).toBe(5);
  });

  it('does not preview obsolete renderer-owned Engine2D overrides as authored parameters', async () => {
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
      expect(collapsedCanvas).not.toHaveAttribute('data-material-preview-parameter-overrides'),
    );
    await user.click(screen.getByRole('button', { name: 'Choose Material' }));

    const candidate = screen.getByRole('button', { name: /Alternate/ });
    expect(screen.queryByRole('button', { name: /Post FX/ })).not.toBeInTheDocument();
    await waitFor(() => expect(candidate).toHaveAttribute('data-applied-overrides', '0'));
    expect(candidate).toHaveAttribute('data-total-overrides', '2');
    expect(screen.queryByText('1 of 2 overrides apply')).not.toBeInTheDocument();

    const candidateCanvas = document.querySelector(
      '[data-material-selector-candidate="alternate"] [data-material-preview="alternate"]',
    );
    expect(candidateCanvas).not.toHaveAttribute('data-material-preview-parameter-overrides');
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
