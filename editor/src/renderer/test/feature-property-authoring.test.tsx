import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FeatureAuthoringPanel } from '@/components/features/FeatureAuthoringPanel';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { FeatureData } from '../../shared/project-schema/authoring-features';
import { defaultInteractableInstanceData } from '../../shared/project-schema/authoring-interactables';

function feature(): FeatureData {
  return {
    id: 'surface',
    label: 'Surface',
    traits: [],
    localProperties: [],
    defaultProperties: [],
    inventories: [],
  };
}

describe('Feature Property authoring', () => {
  it('uses Value-mode Property authoring for a Room Feature', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const project = createAuthoringProject();
    render(
      <FeatureAuthoringPanel
        project={project}
        features={[feature()]}
        anchorPrefix="room"
        propertyMode="value"
        onChange={onChange}
      />,
    );

    expect(document.querySelector('[data-property-manager-mode="default"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add Property' }));
    await user.type(screen.getByPlaceholderText('has-key'), 'visible-detail');
    await user.click(screen.getByRole('button', { name: 'Add Property' }));

    expect(onChange).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'surface',
          localProperties: [
            { id: 'visible-detail', type: 'boolean', nullable: false, value: false },
          ],
          defaultProperties: [],
        }),
      ],
      'Update Feature Properties',
    );
  });

  it('uses Default-mode Property authoring for an Interactable-definition Feature', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const project = createAuthoringProject();
    render(
      <FeatureAuthoringPanel
        project={project}
        features={[feature()]}
        anchorPrefix="interactable"
        propertyMode="default"
        onChange={onChange}
      />,
    );

    expect(document.querySelector('[data-property-manager-mode="default"]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add Property' }));
    await user.type(screen.getByPlaceholderText('has-key'), 'condition');
    await user.click(screen.getByRole('switch', { name: 'Has Default' }));
    await user.click(screen.getByRole('button', { name: 'Add Property' }));

    expect(onChange).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'surface',
          localProperties: [],
          defaultProperties: [{ id: 'condition', type: 'boolean', nullable: false }],
        }),
      ],
      'Update Feature Traits and Properties',
    );
  });

  it('requires explicit confirmation before deleting a Feature with Instance overrides', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const project = createAuthoringProject();
    const instance = defaultInteractableInstanceData('box-instance', 'box');
    instance.featureOverrides.push({
      featureId: 'surface',
      traits: { add: [], remove: [] },
      properties: [],
    });
    project.interactableInstances['box-instance'] = instance;
    render(
      <FeatureAuthoringPanel
        project={project}
        features={[feature()]}
        anchorPrefix="interactable"
        ownerId="box"
        propertyMode="default"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Delete Feature' }));
    expect(screen.getByText('Delete Feature and dependent overrides?')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete Feature and Overrides' }));
    expect(onChange).toHaveBeenCalledWith([], 'Delete Feature');
  });

  it('blocks Feature deletion until authored references are explicitly cleaned up', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const project = createAuthoringProject();
    render(
      <FeatureAuthoringPanel
        project={project}
        features={[feature()]}
        anchorPrefix="interactable"
        ownerId="box"
        dependentReferenceCountFor={() => 2}
        propertyMode="default"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Delete Feature' }));
    expect(screen.getByText('Remove Feature references first')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Feature and Overrides' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
