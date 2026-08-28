import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  InteractableDefinitionPropertiesEditor,
  InteractableInstancePropertiesEditor,
} from '@/components/properties/InteractablePropertyEditors';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
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
      localProperties: [],
    });
  });

  it('counts/navigates exact Instance references and reports standalone rename repair metadata', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
    };
    const instance = defaultInteractableInstanceData('key-instance', 'key');
    instance.localProperties.push({
      id: 'condition',
      label: 'Condition',
      type: 'string',
      nullable: false,
      value: 'ready',
    });
    project.interactableInstances['key-instance'] = instance;
    project.scenes.references = {
      id: 'references',
      label: 'References',
      data: {
        operation: {
          kind: 'set-property',
          owner: {
            kind: 'interactable',
            interactable: { $ref: { registry: 'interactableInstances', id: 'key-instance' } },
          },
          property: { key: 'condition' },
          value: 'used',
        },
      } as never,
    };
    useEntityUsagesStore.getState().clearUsages();

    render(
      <InteractableInstancePropertiesEditor
        project={project}
        instanceId="key-instance"
        instance={instance}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: '1 usage for condition' }));
    expect(useEntityUsagesStore.getState().result).toEqual(
      expect.objectContaining({
        displayLabel: 'interactable-instance/key-instance · condition',
        usages: [
          expect.objectContaining({
            sourceCollection: 'scenes',
            sourceId: 'references',
            path: '/scenes/references/data/operation/property/key',
          }),
        ],
      }),
    );

    await user.click(screen.getByText('Condition'));
    const idInput = screen.getByDisplayValue('condition');
    await user.clear(idInput);
    await user.type(idInput, 'state');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onChange).toHaveBeenCalledWith(
      {
        ...instance,
        localProperties: [
          {
            id: 'state',
            label: 'Condition',
            type: 'string',
            nullable: false,
            value: 'ready',
          },
        ],
      },
      { kind: 'rename', fromId: 'condition', toId: 'state' },
    );
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

  it('treats an Archetype Property schema as inherited and resets a definition Default override', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const project = createAuthoringProject();
    project.archetypes.base = {
      id: 'base',
      label: 'Base Prop',
      data: {
        kind: 'archetype',
        instanceKind: 'interactable',
        base: null,
        overrides: {
          '/defaultProperties': [
            {
              id: 'quality',
              label: 'Quality',
              type: 'string',
              nullable: false,
              defaultValue: 'base',
            },
          ],
        },
      },
    };
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      archetype: { $ref: { collection: 'archetypes', id: 'base' } },
      archetypeOverrides: {},
      traits: [],
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

    render(
      <InteractableDefinitionPropertiesEditor
        project={project}
        definitionId="key"
        properties={project.interactables.key.defaultProperties!}
        attachedTraits={[]}
        onChange={onChange}
      />,
    );

    expect(screen.getByText('"definition"')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset quality' }));
    expect(onChange).toHaveBeenCalledWith({ properties: [], traits: [] });
  });

  it('preserves an inherited Archetype Trait when specializing a definition Default', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const project = createAuthoringProject();
    project.traits.inspectable = {
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['interactable'],
      properties: [
        { id: 'clue', label: 'Clue', type: 'string', nullable: false, defaultValue: 'base' },
      ],
    };
    project.archetypes.base = {
      id: 'base',
      label: 'Base Prop',
      data: {
        kind: 'archetype',
        instanceKind: 'interactable',
        base: null,
        overrides: { '/traits': ['inspectable'] },
      },
    };
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      archetype: { $ref: { collection: 'archetypes', id: 'base' } },
      archetypeOverrides: {},
      traits: [],
      data: defaultInteractableData('Key'),
    };

    render(
      <InteractableDefinitionPropertiesEditor
        project={project}
        definitionId="key"
        properties={[]}
        attachedTraits={['inspectable']}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Set Default' }));
    const value = screen.getByDisplayValue('base');
    await user.clear(value);
    await user.type(value, 'specific');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onChange).toHaveBeenCalledWith({
      traits: ['inspectable'],
      properties: [
        {
          id: 'clue',
          label: 'Clue',
          type: 'string',
          nullable: false,
          defaultValue: 'specific',
        },
      ],
    });
  });
});
