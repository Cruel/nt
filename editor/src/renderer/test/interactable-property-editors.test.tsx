import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  InteractableDefinitionPropertiesEditor,
  InteractableInstancePropertiesEditor,
} from '@/components/properties/InteractablePropertyEditors';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

describe('Interactable Property editors', () => {
  it('keeps inherited rows before subtly styled Instance-local rows in authored order', () => {
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      defaultProperties: [
        {
          id: 'quality',
          label: 'Quality',
          type: 'string',
          nullable: false,
          defaultValue: 'ordinary',
        },
      ],
      data: defaultInteractableData('Key'),
    };
    const instance = defaultInteractableInstanceData('key-instance', 'key');
    instance.localProperties.push(
      { id: 'first-local', label: 'First Local', type: 'boolean', nullable: false, value: true },
      { id: 'second-local', label: 'Second Local', type: 'integer', nullable: false, value: 2 },
    );

    render(
      <InteractableInstancePropertiesEditor
        project={project}
        instanceId="key-instance"
        instance={instance}
        onChange={vi.fn()}
      />,
    );

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Quality')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('First Local')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Second Local')).toBeInTheDocument();
    expect(rows[0]!.className).not.toContain('bg-muted/15');
    expect(rows[1]!.className).toContain('bg-muted/15');
    expect(rows[2]!.className).toContain('bg-muted/15');
  });

  it('treats a compatible formerly-local key as an inherited override and resets it to the inherited Default', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      defaultProperties: [
        {
          id: 'quality',
          label: 'Quality',
          type: 'string',
          nullable: false,
          defaultValue: 'definition',
        },
      ],
      data: defaultInteractableData('Key'),
    };
    const instance = defaultInteractableInstanceData('key-instance', 'key');
    instance.localProperties.push({
      id: 'quality',
      label: 'Old local Quality',
      type: 'string',
      nullable: false,
      value: 'instance',
    });

    render(
      <InteractableInstancePropertiesEditor
        project={project}
        instanceId="key-instance"
        instance={instance}
        onChange={onChange}
      />,
    );

    expect(screen.getByText('"instance"')).toBeInTheDocument();
    expect(screen.getByText('override')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset quality' }));

    expect(onChange).toHaveBeenCalledWith({
      ...instance,
      properties: {},
      localProperties: [],
    });
  });

  it('authors definition contracts without requiring a Default', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
    };

    render(
      <InteractableDefinitionPropertiesEditor
        project={project}
        definitionId="key"
        properties={[]}
        attachedTraits={[]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add Property' }));
    const idInput = screen.getByPlaceholderText('has-key');
    await user.type(idInput, 'condition');
    await user.click(screen.getByRole('switch', { name: 'Has Default' }));
    await user.click(screen.getByRole('button', { name: 'Add Property' }));

    expect(onChange).toHaveBeenCalledWith({
      traits: [],
      properties: [
        {
          id: 'condition',
          type: 'boolean',
          nullable: false,
        },
      ],
    });
  });
});
